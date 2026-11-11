/** The domain Engine: the single entry point of the core, and the role interfaces its callers receive. */
import { UserError } from './errors.ts'
import { DesignConfigurationRequest, DesignApprovalRequest, designBinding, type DesignConfiguration, type DesignApprovalInput } from './design.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import * as nodePath from 'node:path'
import { createValidationContract, runValidation, type ValidationContractInput } from '../validation.ts'
import { validationBinding, type VisualFrame } from './validation.ts'
import { assertAdapterForRole } from './acceptance.ts'
import { ReviewConfigurationRequest, ReviewDecisionRequest, reviewBinding, type ReviewConfiguration, type ReviewDecisionInput } from './review.ts'
import { isoTime, liveTicket } from './model.ts'
import type { ChannelRef, Decision, PolicyEffect, ThreadRef, Ticket, TicketEndBy, TicketOutcome, Trigger } from './model.ts'
import type { Candidate, DomainEvent, DomainEvents, Repositories } from './ports.ts'
import type { EngineOptions } from './part.ts'
import { Assignments, type WorkerReport } from './assignments.ts'
import { Evals, type Outcome } from './evals.ts'
import { Intake, type ReceiveResult } from './intake.ts'
import { Replies, type Reply, type ReplyRequest } from './replies.ts'
import { Tickets } from './tickets.ts'
import { Deliveries, type DeliveryLevel } from './delivery.ts'

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './intake.ts'
export type { Reply, ReplyRequest } from './replies.ts'

/** What a worker says about the visual acceptance it performed; the host records, it does not judge. */
export interface VisualRecordInput {
  verdict: 'passed' | 'failed'
  reason: string
  frames: readonly { path: string; sha256: string }[]
}

/**
 * Accept only a frame that really exists and whose bytes still hash to the digest the worker read.
 * The path may be workspace-relative or absolute; `..` outside the workspace is refused so a
 * conclusion cannot point at arbitrary files.
 */
function verifyVisualFrame(workspace: string, frame: { path: string; sha256: string }): VisualFrame {
  const resolved = nodePath.isAbsolute(frame.path) ? frame.path : nodePath.resolve(workspace, frame.path)
  const relativePath = nodePath.relative(nodePath.resolve(workspace), nodePath.resolve(resolved))
  if (relativePath.startsWith('..') || nodePath.isAbsolute(relativePath)) throw new Error(`Visual acceptance: frame ${frame.path} is outside the workspace`)
  const bytes = existsSync(resolved) ? readFileSync(resolved) : undefined
  if (!bytes) throw new Error(`Visual acceptance: frame ${frame.path} does not exist`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== frame.sha256.toLowerCase()) throw new Error(`Visual acceptance: frame ${frame.path} does not match its sha256 (disk ${actual})`)
  return { path: relativePath.split(nodePath.sep).join('/'), sha256: actual, bytes: bytes.length }
}

/**
 * `realpath` of `target`, or `undefined` when it is missing or unreadable. Path separators are
 * normalized because a persisted directory may be stored with forward slashes (`F:/TP`) while
 * `realpathSync` answers with the platform form (`F:\TP`); comparing the two raw strings refused
 * every source-mode ticket (TODO72, 2026-11-05).
 */
function normalizedRealPath(target: string | undefined): string | undefined {
  if (!target) return undefined
  try { return realpathSync(target).replace(/\\/g, '/') } catch { return undefined }
}
/** Whether `directory` exists and is already its own real path (symlink-free), ignoring separator form. */
function isRealDirectory(directory: string | undefined): boolean {
  const real = normalizedRealPath(directory)
  return real !== undefined && real === directory!.replace(/\\/g, '/')
}
/** Whether two paths name the same real directory, ignoring separator form. */
function samePath(left: string | undefined, right: string | undefined): boolean {
  const real = normalizedRealPath(left)
  return real !== undefined && real === right?.replace(/\\/g, '/')
}

/**
 * Single transactional entry point for mutating Triggers, Threads, Decisions, Tickets, and Assignments.
 * Coordinates Intake, Evals, Tickets, Assignments, and Replies inside synchronous repository transactions while queuing side
 * effects through ports. Callers receive role-scoped `Pick` interfaces rather than the full engine.
 */
export class Engine {
  private readonly testRuns = new Map<string, AbortController>()
  private readonly repo: Repositories
  private readonly replies: Replies
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly evals: Evals
  private readonly intake: Intake
  private readonly deliveries: Deliveries
  constructor(private readonly options: EngineOptions) {
    this.repo = options.repo
    this.deliveries = new Deliveries(options)
    this.replies = new Replies(options)
    this.tickets = new Tickets(options, this.replies)
    this.assignments = new Assignments(options, this.tickets, this.replies)
    this.evals = new Evals(options, this.tickets)
    this.intake = new Intake(options, this.tickets)
  }

  // Sources

  /**
   * A Source's request to take in a Trigger: store it once, fan it out to the tickets that subscribe to its Threads (to an
   * ended one only a person's message, which resumes it at once unless processing is paused, and to none a person stopped),
   * and queue it for Eval on its primary Thread unless a ticket's worker decides it (see `followupOwners`).
   * Triggers that arrive while an Eval of that Thread runs wait together for the next one.
   */
  receive(trigger: Trigger): ReceiveResult { return this.repo.atomic(() => this.intake.receive(trigger)) }
  /**
   * A Source's request to make an open ticket follow one of its Threads, such as a pull request's, `own` when the ticket
   * opened it: the ticket subscribes to it, and a ready report ends it only once `followsDone` holds (see `Tickets.followsDone`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own))
  }
  /**
   * A Source's fact that a Thread closed, such as its pull request's merge, at the time it happened. An open ticket that
   * follows it ends once it is done with the Threads it follows, unless work resumed since the close has not finished, or
   * its worker took up a person's message the ticket decides after its latest report.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    this.repo.atomic(() => { this.tickets.threadClosed(thread, outcome, isoTime(at)) })
  }

  // The clock

  /**
   * Requeues overdue Evals up to `REQUEUES` times before recording `unavailable` (undelivered Evals never expire), starts the
   * Evals of Threads whose queued Triggers wait, and resumes ended tickets a person's message reached while processing was
   * paused. While processing is paused, nothing expires: each Eval in progress notes when the pause began, and its deadline
   * moves forward by the pause's length once processing resumes. Each Eval and each ticket update takes one transaction.
   */
  evaluateDue(): void {
    const policy = this.options.policy()
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.repo.atomic(() => { this.evals.due(thread, policy) })
    if (policy.paused) return
    for (const ticket of this.repo.tickets.active()) {
      if (!liveTicket(ticket) && ticket.undelivered.length) this.repo.atomic(() => { this.tickets.wake(ticket.id) })
    }
    for (const thread of this.repo.threads.active()) {
      if (thread.pending.length && !thread.evaluating) this.repo.atomic(() => { this.evals.start(thread.key, policy) })
    }
  }

  // The main Session

  /** The candidate of the Eval that holds a Trigger, as its assessor sees it; undefined while no Eval holds it. */
  candidate(triggerId: string): Candidate | undefined { return this.evals.candidate(triggerId) }
  /**
   * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does, such as a person's explicit
   * request the main Session routes. A proactive candidate is accepted only in `auto` mode with enabled rules its assessment
   * matched, and a Trigger that already started a ticket returns that ticket's Decision. An invalid stop is recorded as
   * `ignore`; one judged under an older Policy as `unavailable`.
   * @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
   * ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
   * mode or without enabled matching rules.
   */
  decide(triggerId: string, outcome: Outcome): Decision { return this.repo.atomic(() => this.evals.decide(triggerId, outcome)) }
  /**
   * Attach a Trigger to a ticket that the message points at: the ticket follows the Trigger's Threads and receives it as an
   * Input with the routing note, and the Eval that holds the Trigger ends, since the ticket has it now; the other Triggers of
   * its batch wait for a fresh Eval. A note for an Input the worker already received goes out as a new Input, and so does a
   * message the ticket let go, read for context only, or had before it ended. An ended ticket resumes under its Mandate, at
   * once unless processing is paused.
   * @throws UserError for a ticket a person stopped, which withdrew its Mandate, or one whose Mandate the Policy no longer holds.
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.repo.atomic(() => {
      // A message this ticket's worker handed back is not its work: attached here, no worker would decide it, and it could not be handed back again.
      const handedBack = this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)
      if (handedBack) throw new UserError('handedBackHere')
      const trigger = this.tickets.attachable(ticketId, triggerId)
      this.evals.withdraw(trigger)
      this.tickets.attach(ticketId, trigger, note)
      this.evals.routed(triggerId, ticketId)
      this.tickets.wake(ticketId)
      return this.repo.tickets.get(ticketId)!
    })
  }
  /**
   * Ask a running worker that waits in `waiting` state for its status; any other worker is left alone.
   * @returns whether the worker was asked.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean { return this.repo.atomic(() => this.tickets.requestStatus(ticketId)) }
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where the person's message was
   * written, attention where the message that raised the question was, else, like a result, to the conversation the ticket
   * started in. A message queued before is not queued again (see `Replies.reply`).
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket that
   * is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply { return this.repo.atomic(() => this.replies.reply(request)) }

  // People, through the panel or the main Session

  /** The assessor delivered an Eval's candidate to its Session: the Eval's deadline counts from now. */
  candidateDelivered(evalId: string): void { this.repo.atomic(() => { this.evals.delivered(evalId, this.options.policy()) }) }
  /**
   * Queue a stored Trigger for a fresh Eval, such as a person's replay; returns false while an Eval holds it.
   * @throws UserError when the trigger is unknown.
   */
  reevaluate(triggerId: string): boolean { return this.repo.atomic(() => this.evals.reevaluate(triggerId)) }
  /**
   * A person dismisses the problem an unavailable Decision shows: the overview lists it no more.
   * @throws UserError for a Decision that is unknown or not unavailable.
   */
  dismiss(decisionId: string): Decision { return this.repo.atomic(() => this.evals.dismiss(decisionId)) }
  /**
   * Drop every ticket's Subscription to a Thread, until a new Decision subscribes one again.
   * @returns whether a Subscription was dropped.
   */
  unsubscribe(thread: string): boolean { return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, 'person')) }
  /**
   * A person stops a ticket, which withdraws its Mandate: it ends and receives nothing more.
   * @throws UserError when the ticket is unknown.
   */
  stopTicket(ticketId: string, reason?: string): Ticket {
    const ticket = this.repo.atomic(() => this.tickets.stop(ticketId, reason))
    this.testRuns.get(ticketId)?.abort()
    // Phase 2 C: a stopped ticket is one of the facts that gives the environment back; the host stops
    // the editor it started before the lock goes to the next holder.
    this.releaseEnvironment(ticket, { by: 'human', outcome: 'stopped' })
    return ticket
  }
  /**
   * Phase 2 C: a person hands a ticket's environment back. The host exports the scene first and refuses
   * the handover when it cannot, so the ticket keeps the lock instead of losing uncommitted work.
   * @throws UserError when the ticket is unknown or does not hold the environment.
   */
  async handOverEnvironment(ticketId: string): Promise<{ handedOver: boolean; export?: string; files: number; error?: string }> {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket) throw new UserError('unknownTicket')
    const environments = this.options.environments
    if (!environments) throw new UserError('noEnvironment')
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (!environments.holds(ticketId)) throw new UserError('notHolding')
    const result = await environments.handover(ticketId)
    // A handed-over environment is free for the tickets that were refused it at acceptance.
    if (result.handedOver) this.tickets.resumeEnvironmentWaiter()
    this.raise('ticket.handover', { ticketId, handedOver: result.handedOver, ...result.export ? { export: result.export } : {},
      ...result.error ? { error: result.error } : {} })
    return result
  }
  /** Whether the ticket holds the TP environment now; a deployment without one holds nothing, so nothing queues on it. */
  holdsEnvironment(ticketId: string): boolean {
    return !!this.options.environments?.holds(ticketId)
  }
  /**
   * Phase 2 C: a launch was refused the environment another holder has. The ticket goes back to waiting for it, so the
   * holder's release starts that same Assignment instead of a person having to retry work nothing was wrong with.
   */
  environmentRefused(ticketId: string, assignmentId: string, error: unknown, reason?: string): Ticket | undefined {
    return this.tickets.environmentRefused(ticketId, assignmentId, error, reason)
  }
  /**
   * Phase 2 C: a worker may only continue (launch again, take a new message, run a host tool) while its ticket holds the
   * environment. After a person's handover or a lost lease it takes the lock again here, which resumes its own record or
   * is refused naming the new holder; it never takes a lock another holder has.
   * @throws Error naming the holder when the environment is held by someone else.
   */
  ensureEnvironment(ticketId: string): void {
    const environments = this.options.environments
    const ticket = this.repo.tickets.get(ticketId)
    if (!environments || !ticket || !liveTicket(ticket) || environments.holds(ticketId)) return
    try { environments.acquire(ticketId, ticket.title) } catch (error) {
      this.raise('ticket.exclusive', { ticketId, action: 'refused', reason: error instanceof Error ? error.message : String(error) })
      throw error
    }
    this.raise('ticket.exclusive', { ticketId, action: 'acquired' })
  }
  /**
   * Phase 2 C/D: an operator's explicit request to take the environment for a ticket that gave it back, for example a
   * ticket completed by its acceptance whose delivery now needs it. Never taken by the delivery itself, never from a
   * stopped or dropped ticket, and refused naming the holder while someone else has it.
   * @throws Error when the ticket ended without completing, or another holder has the environment.
   */
  acquireEnvironment(ticketId: string): { held: true } {
    const environments = this.options.environments
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket) throw new UserError('unknownTicket')
    if (!environments) throw new UserError('noEnvironment')
    if (ticket.ended && ticket.ended.outcome !== 'completed') throw new UserError('ticketEnded')
    if (!environments.holds(ticketId)) {
      try { environments.acquire(ticketId, ticket.title, ticket.ended ? 'delivery' : undefined) } catch (error) {
        this.raise('ticket.exclusive', { ticketId, action: 'refused', reason: error instanceof Error ? error.message : String(error) })
        throw error
      }
      this.raise('ticket.exclusive', { ticketId, action: 'acquired' })
      // An operator took the environment for a ticket that waited for it at acceptance: it starts now.
      this.tickets.resumeBlocked(ticketId)
    }
    return { held: true }
  }
  /**
   * Phase 2 C/D: give back the environment an ended ticket still holds: the editor it started is stopped first and a failed
   * stop keeps the lock. This is the exit for a completion whose cleanup failed, and for a completed ticket an operator took
   * the environment for again to deliver it, once the delivery is done. A live ticket is handed over or stopped instead.
   * @returns whether the environment was released.
   * @throws UserError when the ticket is unknown, still live, or holds nothing.
   */
  async releaseEndedEnvironment(ticketId: string): Promise<{ released: boolean; error?: string }> {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket) throw new UserError('unknownTicket')
    const environments = this.options.environments
    if (!environments) throw new UserError('noEnvironment')
    if (liveTicket(ticket) || !ticket.ended) throw new UserError('ticketLive')
    if (!environments.holds(ticketId)) throw new UserError('notHolding')
    try {
      const released = await environments.end(ticketId, { by: ticket.ended.by, outcome: ticket.ended.outcome }, ticket.ended.outcome === 'completed')
      if (released) this.tickets.resumeEnvironmentWaiter()
      return { released }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.raise('ticket.handover', { ticketId, handedOver: false, error: `The environment release failed: ${message}` })
      return { released: false, error: message }
    }
  }
  /** A host tool for a ticket runs only while the ticket holds the environment. */
  private requireHolding(ticketId: string): void {
    const environments = this.options.environments
    if (environments && !environments.holds(ticketId)) throw new UserError('notHolding')
  }
  /** Report a phase 2 C event; the Engine is no EnginePart, so it raises the event itself. */
  private raise<K extends 'ticket.handover' | 'ticket.exclusive'>(type: K, data: DomainEvents[K]): void {
    this.options.emit?.({ type, at: new Date().toISOString(), data } as DomainEvent)
  }
  /** Give the environment back after a person stopped the ticket: `TicketedEnvironment.end` decides the reason from that fact. */
  private releaseEnvironment(ticket: Ticket, fallback: { by: TicketEndBy; outcome: TicketOutcome }): void {
    const environments = this.options.environments
    if (!environments?.end) return
    const ended = ticket.ended ? { by: ticket.ended.by, outcome: ticket.ended.outcome } : fallback
    void environments.end(ticket.id, ended, false)
      .then(released => { if (released) this.tickets.resumeEnvironmentWaiter() },
        error => this.raise('ticket.handover', { ticketId: ticket.id, handedOver: false,
          error: `The environment release failed: ${error instanceof Error ? error.message : String(error)}` }))
  }
  /**
   * A person retries a ticket whose worker reported failed or blocked (or whose input delivery failed): the stalled
   * Assignment ends and a new one starts under the same Mandate.
   * @throws UserError when the ticket is unknown, has ended, or is not retryable.
   */
  retryTicket(ticketId: string): Ticket {
    const ticket = this.repo.atomic(() => this.tickets.retry(ticketId))
    this.testRuns.get(ticketId)?.abort()
    // A retried ticket reworks under the same Mandate and keeps its environment; nothing is released here.
    return ticket
  }

  /** Executor-only durable continuation when design confirmation suspends a transient retry. */
  deferDesignResume(ticketId: string, assignmentId: string, requestId: string, text: string): void {
    this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || ticket.assignments.at(-1)?.id !== assignmentId) return
      this.tickets.addInput(ticket, { id: requestId, kind: 'text', text, at: this.options.now?.() ?? new Date().toISOString() })
    })
  }

  /** Trusted contract; configuring a planned assignment must still prevent its later launch. */
  configureDesign(ticketId: string, raw: DesignConfiguration): Ticket {
    const input = DesignConfigurationRequest.parse(raw)
    return this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) throw new Error('Design confirmation: ticket missing or ended')
      ticket.designApproval = { ...input, revision: randomUUID() }
      if (input.required) designBinding(ticket)
      ticket.updatedAt = this.options.now?.() ?? new Date().toISOString()
      this.repo.tickets.save(ticket)
      return ticket
    })
  }
  /** Management alone records current document bytes; callers cannot submit a digest or approval object. */
  approveDesign(ticketId: string, raw: DesignApprovalInput): Ticket {
    const input = DesignApprovalRequest.parse(raw)
    return this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || !ticket.designApproval?.required) throw new Error('Design confirmation: required contract missing on open ticket')
      const binding = designBinding(ticket)
      if (input.assignmentId !== binding.assignmentId || ticket.assignments.at(-1)?.state === 'ended') throw new Error('Design confirmation: stale assignment')
      const at = this.options.now?.() ?? new Date().toISOString()
      ticket.designApproval.approval = { ...binding, operatorId: input.operatorId, revision: ticket.designApproval.revision, at, recordedBy: 'management-operator' }
      delete ticket.designApproval.blocked
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
      // Wake the same pending assignment; retrying would replace it and invalidate this signature.
      const assignment = ticket.assignments.at(-1)!
      if (assignment.state === 'pending') this.options.executor.start(ticket, assignment)
      else if (assignment.state === 'running' && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
      return ticket
    })
  }

  /** Trusted operator configures workflow identities; changing policy clears the previous signature. */
  configureReview(ticketId: string, raw: ReviewConfiguration): Ticket {
    const input = ReviewConfigurationRequest.parse(raw)
    if (input.required && input.implementerId === input.reviewerId) throw new Error('Independent review: implementer cannot self-sign')
    return this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) throw new Error('Independent review: ticket missing or ended')
      ticket.review = { ...input, revision: randomUUID() }
      ticket.updatedAt = this.options.now?.() ?? new Date().toISOString()
      this.repo.tickets.save(ticket)
      return ticket
    })
  }

  /** Operator transcribes a review, never a worker assertion. Host alone binds it to current bytes. */
  recordReview(ticketId: string, raw: ReviewDecisionInput): Ticket {
    const input = ReviewDecisionRequest.parse(raw)
    return this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || !ticket.review?.required) throw new Error('Independent review: required review not configured on an open ticket')
      const review = ticket.review
      if (input.reviewerId !== review.reviewerId || input.reviewerId === review.implementerId) throw new Error('Independent review: unauthorized reviewer or self-sign')
      const binding = reviewBinding(ticket)
      if (binding.assignmentId !== input.assignmentId || ticket.assignments.at(-1)?.state !== 'running') throw new Error('Independent review: stale assignment')
      const at = this.options.now?.() ?? new Date().toISOString()
      review.decision = { ...input, ...binding, revision: review.revision, at, recordedBy: 'management-operator' }
      delete review.blocked
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
      return ticket
    })
  }

  /** Operator-only management entry. Once enabled strict acceptance cannot be disabled by a worker. */
  configureValidation(ticketId: string, input?: Omit<ValidationContractInput, 'revision'>): Ticket {
    return this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) throw new Error('Strict validation: ticket missing or ended')
      // A live run's evidence is invalidated by a revision change but not its subprocess; refuse
      // while this host runs tests. The persisted marker stays replaceable only to recover a crash.
      if (this.testRuns.has(ticketId)) throw new Error('Strict validation: a test run is in progress; wait for it before changing the contract')
      // The adapter must fit the ticket's role: an ops ticket never starts the editor, so a CQTest contract could never be met.
      if (input) assertAdapterForRole(ticket, input.adapter)
      const contract = input ? createValidationContract({ ...input, revision: randomUUID() }) : undefined
      if (contract && !samePath(ticket.execution?.directory, contract.workspace)) {
        throw new Error('Strict validation: contract workspace must be the ticket workspace')
      }
      ticket.validation = { enabled: true, ...(contract ? { contract } : {}) }
      this.repo.tickets.save(ticket)
      return ticket
    })
  }

  /** Worker may request only the tests in the trusted contract, never supply commands or result assertions. */
  async runTicketTests(ticketId: string, assignmentId: string, signal?: AbortSignal) {
    this.requireHolding(ticketId)
    const runId = randomUUID()
    const { contract, binding } = this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || !ticket.validation?.enabled) throw new Error('Strict validation not enabled on an open ticket')
      if (!ticket.validation.contract) throw new Error('Strict validation: no unittest contract is configured for this ticket')
      const binding = validationBinding(ticket)
      if (binding.assignmentId !== assignmentId || ticket.assignments.at(-1)?.state !== 'running') throw new Error('Strict validation: stale assignment')
      if (ticket.validation.running) throw new Error('Strict validation: tests already running; operator must reset contract after interrupted run')
      const contract = ticket.validation.contract!
      delete ticket.validation.evidence
      ticket.validation.running = runId
      this.repo.tickets.save(ticket)
      return { contract, binding }
    })
    const controller = new AbortController()
    this.testRuns.set(ticketId, controller)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const evidence = await runValidation(contract, binding)
      combined.throwIfAborted()
      return this.repo.atomic(() => {
        const ticket = this.repo.tickets.get(ticketId)
        if (!ticket || !liveTicket(ticket) || ticket.validation?.running !== runId
          || ticket.validation.contract?.revision !== contract.revision
          || ticket.assignments.at(-1)?.id !== assignmentId) throw new Error('Strict validation: run no longer belongs to current ticket/assignment/contract')
        ticket.validation.evidence = evidence
        delete ticket.validation.running
        delete ticket.validation.blocked
        this.repo.tickets.save(ticket)
        return evidence
      })
    } catch (error) {
      this.repo.atomic(() => {
        const ticket = this.repo.tickets.get(ticketId)
        if (ticket?.validation?.running === runId) { delete ticket.validation.running; this.repo.tickets.save(ticket) }
      })
      throw error
    } finally {
      if (this.testRuns.get(ticketId) === controller) this.testRuns.delete(ticketId)
    }
  }

  // Visual acceptance: the project editor owns screenshots and the worker performs the acceptance.
  // The host only records the worker's conclusion with the frames it was drawn from, so a later
  // reader knows what was judged and whether those frames still match the disk (TODO72).

  /**
   * Record the worker's own visual acceptance for this ticket. Frames must exist and their sha256
   * must match what the caller says, so a conclusion cannot be attached to bytes nobody hashed.
   */
  recordVisual(ticketId: string, assignmentId: string, input: VisualRecordInput): Ticket {
    return this.repo.atomic(() => {
      const ticket = this.repo.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) throw new Error('Visual acceptance: ticket missing or ended')
      if (!ticket.validation?.enabled) throw new Error('Visual acceptance: enable strict acceptance first')
      const assignment = ticket.assignments.at(-1)
      if (assignment?.id !== assignmentId || assignment.state !== 'running') throw new Error('Visual acceptance: stale assignment')
      const workspace = ticket.execution?.directory
      if (!workspace) throw new Error('Visual acceptance: the ticket has no workspace')
      const frames = input.frames.map(frame => verifyVisualFrame(workspace, frame))
      if (input.verdict === 'passed' && !frames.length) throw new Error('Visual acceptance: a passing verdict needs at least one frame')
      ticket.validation.visual = { verdict: input.verdict, reason: input.reason, frames,
        recordedBy: `${assignment.id}`, at: isoTime(this.options.now?.() ?? new Date().toISOString()) }
      this.repo.tickets.save(ticket)
      return ticket
    })
  }

  // The Executor

  /**
   * The Executor's fact that an Assignment runs; the Inputs that wait for it go out.
   * @throws UserError when the ticket is unknown.
   */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.started(ticketId, assignmentId) })
  }
  /**
   * The Executor's fact that Inputs reached the Assignment that runs the ticket, which clears a failed delivery. A fact about
   * an Assignment that no longer runs is dropped. Its worker reads each once its Session takes it into a step (`inputsRead`).
   */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.delivered(ticketId, assignmentId, inputIds) })
  }
  /**
   * The Executor's fact that the worker's Session of an open ticket took the messages that carried Inputs into a step, from
   * which its model reads them: a report or the end of a turn after that counts them as read at the ticket's end.
   * @throws UserError when the ticket is unknown.
   */
  inputsRead(ticketId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.read(ticketId, inputIds) })
  }
  /** The Executor's fact that a turn of the worker of the Assignment that runs the ticket ended, after a report too. */
  turnEnded(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.turnEnded(ticketId, assignmentId) })
  }
  /** The Executor's fact that delivering Inputs to the Assignment that runs the ticket failed; the ticket shows it until a delivery succeeds. */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.repo.atomic(() => { this.assignments.deliveryFailed(ticketId, assignmentId, error) })
  }
  /**
   * A worker's request, through its Executor, to mark a Thread attached to its ticket unrelated, for `reason`: only that
   * ticket's Subscription drops, until a new Decision subscribes it again.
   * @throws UserError when the ticket is unknown, or for the Thread the ticket started on, one a Source bound it to (such as
   * its pull request's), or one it does not follow.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.repo.atomic(() => { this.tickets.markUnrelated(ticketId, thread, reason) })
  }
  /**
   * An Executor's Subscription to a Thread it found related, for context: see `Tickets.followForContext` and `Thread.context`.
   * @returns false when the ticket already follows the Thread.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread))
  }
  /**
   * A fact the main Session gives an open ticket's Executor: see `Tickets.note`.
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket { return this.repo.atomic(() => this.tickets.note(ticketId, text)) }
  /**
   * An Executor's hand-back of a message that reached its ticket but asks for more than it: see `Evals.handback`.
   * @returns whether it was queued for Eval: false while another ticket still decides it, and for one this ticket did not decide (see `Evals.handback`).
   * @throws UserError when the ticket or trigger is unknown, the trigger did not reach the ticket, or the ticket already handed it back.
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason))
  }
  /**
   * Record a report on an open ticket's current Assignment. Its question for a person (`attention`) is asked, kept, or
   * cleared (`null` or a `ready` report), and a replaced attention question whose reply has not been sent yet is withdrawn
   * from the outbox. A `blocked` or `failed` report holds back automated inputs until a human message arrives. A `dropped`
   * report ends the ticket, and a `ready` report ends it: `completed` without followed Threads, else with the `followsDone`
   * outcome once `followsDone` holds.
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question that comes with a ready result or an
   * answer, or a question or answer that names a message that is not a person's or did not reach the ticket.
   */
  report(ticketId: string, report: WorkerReport): Ticket { return this.repo.atomic(() => this.assignments.report(ticketId, report)) }
  /**
   * Handles an assignment that was running when the host stopped: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no Input reached its worker after that report, in which case it keeps its
   * Session and state and gets the Inputs that wait for it.
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.interrupted(ticketId, assignmentId) })
    this.testRuns.get(ticketId)?.abort()
  }

  /** Operator-only grant/revoke. Never exposed to an executor or inferred from ready. */
  configureDelivery(ticketId: string, level: DeliveryLevel, granted: boolean, by: string) {
    return this.repo.atomic(() => this.deliveries.grant(ticketId, level, granted, by))
  }
  /** Operator-only: settle an uncertain/interrupted attempt against the target's own receipt. */
  reconcileDelivery(ticketId: string, operationKey: string, outcome: { result: 'delivered'; receipt: string } | { result: 'discarded'; reason: string }, by: string) {
    return this.deliveries.reconcile(ticketId, operationKey, outcome, by)
  }
  /** Host start: an attempt left `running` by a stopped host becomes `uncertain`. */
  recoverDeliveries(): number { return this.deliveries.markInterrupted() }
  deliveryState(ticketId: string) { return this.deliveries.view(ticketId) }
  /** A shared guarded dispatch path, even when called by the host. */
  deliverTicket(ticketId: string, assignmentId: string, level: DeliveryLevel, requestId: string) {
    return this.deliveries.execute(ticketId, assignmentId, level, requestId)
  }

  // Settings

  /**
   * The Policy changed: each open ticket in `effects` is told how the change bears on it, and Evals in progress start again
   * under the new version.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void {
    this.repo.atomic(() => { this.tickets.policyChanged(from, to, effects); this.evals.policyChanged(from, to) })
  }
}

/** What Sources ask and tell the Engine. */
export type EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>
/** What the main Session asks of the Engine. */
export type EngineForMainSession = Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'>
/** What people ask of the Engine, through the panel or the main Session. */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss' | 'configureValidation'
  | 'configureDesign' | 'approveDesign' | 'configureReview' | 'recordReview' | 'handOverEnvironment' | 'acquireEnvironment' | 'releaseEndedEnvironment' | 'configureDelivery' | 'reconcileDelivery' | 'recoverDeliveries' | 'deliveryState' | 'deliverTicket'>
/** What Settings tells the Engine. */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** What the Executor tells the Engine, and what its workers ask of it. */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
  | 'deferDesignResume' | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply' | 'runTicketTests'
  | 'recordVisual' | 'deliverTicket' | 'ensureEnvironment' | 'holdsEnvironment' | 'environmentRefused'>
