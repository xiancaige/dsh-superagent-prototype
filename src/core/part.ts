/** Shared base class and configuration for Engine domain parts. */
import { UserError } from './errors.ts'
import { followupOwners, reached, threadKey } from './model.ts'
import type { Thread, ThreadRef, Ticket, Trigger } from './model.ts'
import { assertTicketValidated } from './validation.ts'
import type { AcceptanceFacts, Assessor, AssessmentOutcome, DomainEvent, DomainEvents, Environments, Executor, Outbox, Policy, Repositories,
  SourceScope } from './ports.ts'


export interface EngineOptions {
  repo: Repositories
  policy: () => Policy
  /** Decides whether a Source listens to a trigger; one it does not listen to is stored with a `filtered` disposition. */
  scope: SourceScope
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  /** Explicit trusted adapter. Absent by default: no command or real channel is assumed. */
  deliveryTarget?: import('./delivery.ts').DeliveryTarget
  /**
   * Phase 2 C: the shared environment a ticket takes when it is accepted and gives back only when its
   * acceptance passed, a person hands it over, or its work ends. Omitted, no ticket holds anything.
   */
  environments?: Environments
  /** Phase 2 C completion fact: whether the strict acceptance this ticket requires actually passed. */
  acceptance?: AcceptanceFacts
  prepareTicket?: (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>) => Ticket
  now?: () => string
  emit?: (event: DomainEvent) => void
}

/**
 * Base class for Intake, Evals, Tickets, Assignments, and Replies providing shared access to repositories, policy, clock, and event emission.
 * Each subclass mutates its own domain aggregates and delegates cross-aggregate changes to sibling parts within the transaction opened by Engine.
 */
export abstract class EnginePart {
  protected readonly repo: Repositories
  constructor(protected readonly options: EngineOptions) { this.repo = options.repo }
  protected now(): string { return this.options.now?.() ?? new Date().toISOString() }
  protected policy(): Policy { return this.options.policy() }
  /** The tickets whose worker decides a person's follow-up: see `followupOwners`. */
  protected owners(trigger: Trigger): string[] { return followupOwners(trigger, this.repo) }
  /** Refuse a main-Session routing of a follow-up a ticket's worker still decides. */
  protected leftToWorkers(trigger: Trigger): void {
    const owners = this.owners(trigger)
    if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
  }
  /**
   * Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when the
   * ticket decided it and no other ticket still does. One the ticket did not decide, such as a bot's, one a person sent to
   * Eval or one on a Thread it follows for context, went to Eval without it.
   * @returns whether it was queued.
   */
  protected handBack(ticketId: string, trigger: Trigger, reason: string): boolean {
    const decided = this.owners(trigger).includes(ticketId)
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const handbacks = [...disposition.handbacks ?? [], { ticketId, reason, at: this.now() }]
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, handbacks })
    return decided && !this.owners(trigger).length && this.queueForEval(trigger)
  }
  /** Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it. */
  protected takeUp(ticketId: string, triggerId: string): void {
    const disposition = this.repo.triggers.disposition(triggerId)
    if (disposition && !disposition.acked?.includes(ticketId)) {
      this.repo.triggers.saveDisposition(triggerId, { ...disposition, acked: [...disposition.acked ?? [], ticketId] })
    }
  }
  /** Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it. */
  protected queueForEval(trigger: Trigger): boolean {
    const primary = this.thread(trigger.threads[0]!)
    if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) return false
    primary.pending.push(trigger.id)
    this.repo.threads.save(primary)
    return true
  }
  protected emit<K extends keyof DomainEvents>(type: K, data: DomainEvents[K]): void {
    this.options.emit?.({ type, at: this.now(), data } as DomainEvent)
  }
  protected require(ticketId: string): Ticket { const ticket = this.repo.tickets.get(ticketId); if (!ticket) throw new UserError('unknownTicket'); return ticket }
  /** The environment port, when the deployment has one; a ticket holds nothing otherwise. */
  protected environments(): Environments | undefined { return this.options.environments }
  /**
   * Whether the ticket's own strict acceptance passed. A ticket without strict acceptance is judged by
   * what it recorded, exactly as before; one with it needs the host's own check, never a report.
   */
  protected acceptancePassed(ticket: Ticket): boolean {
    // Review/design are independently opt-in, including on tickets without strict tests.
    try { assertTicketValidated(ticket); return true } catch { return false }
  }
  /** Whether this deployment can confirm the ticket's acceptance (see `EngineOptions.acceptance`). */
  protected acceptanceKnown(): boolean { return !!this.options.acceptance }
  /**
   * Whether the ticket may be completed: a deployment that shows its acceptance requires the host to confirm
   * it; one that does not — unless it holds the environment, which is released only on an acceptance — is
   * judged by the records it requires to be complete, exactly as before.
   */
  protected completion(ticket: Ticket): boolean {
    if (!this.acceptanceKnown()) return this.environments() ? false : this.acceptancePassed(ticket)
    return this.options.acceptance!(ticket)
  }
  /** Returns the stored Thread or an unsaved empty Thread aggregate. */
  protected thread(ref: ThreadRef): Thread {
    const k = threadKey(ref)
    return this.repo.threads.get(k) ?? { key: k, ref: { source: ref.source, id: ref.id }, createdAt: this.now(), subscriptions: [], correlated: [], pending: [], meta: {} }
  }
  protected ticketsOnThread(thread: Thread): Ticket[] {
    return thread.subscriptions.flatMap(id => { const ticket = this.repo.tickets.get(id); return ticket ? [ticket] : [] })
  }
  protected source(ticket: Ticket): Trigger | undefined { return this.repo.triggers.get(ticket.origin.triggerId) }
  protected reaches(ticket: Ticket, trigger: Trigger, context = true): boolean {
    return reached(ticket, trigger, k => this.repo.threads.get(k), context)
  }
}
