/** Phase 2 D. Host-only grants, fail-closed version checks and a durable at-most-once dispatch ledger.
 * A running/uncertain attempt is NEVER automatically retried, even with a different request id. The target
 * must reconcile its receipt using operationKey; there is no general exactly-once transaction with a remote.
 * This is a workflow boundary, not an OS sandbox against code running as the host user.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { fingerprintWorkspace } from '../validation.ts'
import { assertTicketValidated } from './validation.ts'
import { latestAssignment, type Ticket } from './model.ts'
import { EnginePart } from './part.ts'

export const DELIVERY_LEVELS = ['commit', 'push', 'release'] as const
export type DeliveryLevel = typeof DELIVERY_LEVELS[number]
export interface DeliveryGrant {
  ticketId: string; assignmentId: string; workspace: string; level: DeliveryLevel; target: string; by: string; at: string; expiresAt: string; fingerprint: string; version: string; evidenceDigest: string
}
export interface DeliveryAttempt {
  requestId: string; operationKey: string; ticketId: string; assignmentId: string; workspace: string
  level: DeliveryLevel; target: string; fingerprint: string; version: string; at: string
  state: 'running' | 'delivered' | 'uncertain'; detail?: string; receipt?: string
}
export interface DeliveryState {
  grants?: Partial<Record<DeliveryLevel, DeliveryGrant>>
  attempts?: DeliveryAttempt[]
  /** Every accepted transport id, including aliases of a previously delivered operation. */
  requests?: { requestId: string; operationKey: string; assignmentId: string }[]
  /** Attempts an operator discarded after confirming the target never did the effect. */
  reconciled?: { operationKey: string; by: string; at: string; reason: string }[]
  refusals?: { at: string; assignmentId: string; level: DeliveryLevel; requestId: string; reasons: string[] }[]
}
/** Host-configured target; workers supply neither command, channel nor completion facts. Success means the
 * target durably accepted this operationKey. It must cover sub-effects (e.g. push AND PR) under that key. */
export interface DeliveryTarget {
  readonly id: string
  /** Exact immutable payload/commit identity; changing HEAD/index must change this value for Git targets. */
  version(workspace: string): string
  execute(attempt: Readonly<DeliveryAttempt>): Promise<{ receipt: string; detail?: string }>
}
export type DeliveryResult = { attempt: DeliveryAttempt; repeated: boolean } | { refused: true; reasons: string[] }
const EVIDENCE_MAX_AGE_MS = 3_600_000
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Shared by direct host entry and worker tools: there is intentionally no host bypass. */
export class Deliveries extends EnginePart {
  private level(value: DeliveryLevel): void {
    if (!DELIVERY_LEVELS.includes(value)) throw new Error('Delivery: unknown level')
  }
  grant(ticketId: string, level: DeliveryLevel, granted: boolean, by: string): DeliveryState {
    this.level(level)
    const ticket = this.require(ticketId)
    if (!by.trim()) throw new Error('Delivery: the operator attribution is required')
    const assignment = latestAssignment(ticket)
    if (!assignment || !ticket.execution?.directory) throw new Error('Delivery: no assignment/workspace')
    if (ticket.ended && ticket.ended.outcome !== 'completed') throw new Error('Delivery: ticket stopped or ended without completing; grants need an active or completed ticket')
    const state = ticket.deliveryAuthorization ??= {}
    state.grants ??= {}
    if (!granted) delete state.grants[level]
    else {
      const target = this.options.deliveryTarget
      if (!target) throw new Error('Delivery: no host delivery target configured')
      const workspace = realpathSync(ticket.execution.directory)
      const at = this.now()
      const version = target.version(workspace)
      if (!version.trim()) throw new Error('Delivery: target supplied no immutable version identity')
      state.grants[level] = { ticketId, assignmentId: assignment.id, workspace, target: target.id, level, by, at,
        expiresAt: new Date(Date.parse(at) + 3_600_000).toISOString(), fingerprint: fingerprintWorkspace(workspace),
        version, evidenceDigest: sha(ticket.designApproval ? { validation: ticket.validation ?? null, review: ticket.review ?? null, designApproval: ticket.designApproval } : ticket.review ? { validation: ticket.validation ?? null, review: ticket.review } : ticket.validation ?? null) }
    }
    this.repo.tickets.save(ticket)
    return state
  }
  view(ticketId: string): DeliveryState { return this.require(ticketId).deliveryAuthorization ?? {} }

  private refuse(ticket: Ticket, assignmentId: string, level: DeliveryLevel, requestId: string, reasons: string[]): DeliveryResult {
    const state = ticket.deliveryAuthorization ??= {}
    const fact = { at: this.now(), assignmentId, level, requestId, reasons }
    // Identical transport retries keep one refusal; a changed reason is a new auditable fact.
    if (!state.refusals?.some(item => item.assignmentId === assignmentId && item.level === level && item.requestId === requestId
      && JSON.stringify(item.reasons) === JSON.stringify(reasons))) state.refusals = [...state.refusals ?? [], fact]
    this.repo.tickets.save(ticket)
    return { refused: true, reasons }
  }

  /** Checks persisted host evidence, including the stronger on-disk visual validator, never report text.
   * Strict unit evidence is mandatory for push/release, with configured visual checks in addition. Missing exclusivity fails closed. */
  private check(ticket: Ticket, assignmentId: string, level: DeliveryLevel): { reasons: string[]; fingerprint?: string; workspace?: string; version?: string } {
    const reasons: string[] = []
    const assignment = latestAssignment(ticket)
    const target = this.options.deliveryTarget
    const grant = ticket.deliveryAuthorization?.grants?.[level]
    if (!grant) reasons.push(`Delivery ${level}: no independent operator grant (ready grants nothing)`)
    // A completed ticket's latest assignment ended with it; delivery after the acceptance names that same assignment.
    const completed = ticket.ended?.outcome === 'completed'
    if (!assignment || assignment.id !== assignmentId || (assignment.state === 'ended' && !completed)) reasons.push('Delivery: stale/ended assignment')
    if (ticket.ended && !completed) reasons.push('Delivery: ticket stopped/dropped/closed')
    if (!target) reasons.push('Delivery: no trusted target configured')
    let workspace: string | undefined
    let fingerprint: string | undefined
    let version: string | undefined
    try {
      if (!ticket.execution?.directory) throw new Error('missing workspace')
      workspace = realpathSync(ticket.execution.directory)
      fingerprint = fingerprintWorkspace(workspace)
      version = target?.version(workspace)
      if (target && !version?.trim()) throw new Error('target supplied no immutable version identity')
    } catch (error) { reasons.push(`Delivery: workspace unreadable: ${String(error)}`) }
    if (grant && (grant.ticketId !== ticket.id || grant.assignmentId !== assignmentId || grant.level !== level
      || grant.workspace !== workspace || grant.target !== target?.id)) reasons.push('Delivery: grant ticket/assignment/workspace/target binding changed')
    if (grant && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.parse(this.now()))) reasons.push('Delivery: grant expired')
    if (grant && (grant.fingerprint !== fingerprint || grant.version !== version || grant.evidenceDigest !== sha(ticket.designApproval ? { validation: ticket.validation ?? null, review: ticket.review ?? null, designApproval: ticket.designApproval } : ticket.review ? { validation: ticket.validation ?? null, review: ticket.review } : ticket.validation ?? null))) {
      reasons.push('Delivery: authorized contents/version/acceptance evidence changed; revalidate and obtain a new grant')
    }
    // Every level needs the ticket's exclusive environment: a commit is a change in the ticket's work tree, and a ticket
    // that lost it (a handover, a lost lease) delivers nothing until it has taken it again.
    // Never re-acquire silently here. A person handing the environment over revokes this fact, even if nobody else took it.
    if (!this.options.environments?.holds(ticket.id)) reasons.push('Delivery: ticket does not hold environment exclusivity; re-acquire before delivery')
    // Commit is independently granted and needs no strict acceptance of its own, but a ticket that does require it must
    // still have it valid; push and release always require it.
    // Review must also protect a non-strict commit, including a revoked approval under an old grant.
    try { assertTicketValidated(ticket) } catch (error) { reasons.push(`Delivery: acceptance invalid: ${String(error)}`) }
    const strict = !!ticket.validation?.enabled
    if (level !== 'commit' || strict) {
      if (!ticket.validation?.enabled || !ticket.validation.contract || !ticket.validation.evidence) reasons.push('Delivery: strict test acceptance is required')
      else {
        try {
          assertTicketValidated(ticket)
          const now = Date.parse(this.now())
          const fresh = (finishedAt: string) => {
            const time = Date.parse(finishedAt)
            if (!Number.isFinite(time) || time > now + 300_000 || now - time >= EVIDENCE_MAX_AGE_MS) {
              throw new Error('acceptance evidence expired or has an invalid/future timestamp; run acceptance again')
            }
          }
          fresh(ticket.validation.evidence.finishedAt)
          // Visual acceptance is the worker's recorded conclusion; a delivery requires it to say
          // `passed` and its frames to still be on disk (a changed frame voids the conclusion).
          const visual = ticket.validation.visual
          if (visual) {
            if (visual.verdict !== 'passed') throw new Error(`visual acceptance recorded as ${visual.verdict}`)
            for (const frame of visual.frames) {
              const filename = isAbsolute(frame.path) ? frame.path : join(workspace!, frame.path)
              if (!existsSync(filename) || createHash('sha256').update(readFileSync(filename)).digest('hex') !== frame.sha256) {
                throw new Error(`visual evidence frame ${frame.path} no longer matches its sha256`)
              }
            }
          }
        } catch (error) { reasons.push(`Delivery: acceptance invalid: ${String(error)}`) }
      }
    }
    return { reasons, workspace, fingerprint, version }
  }

  /**
   * A restarted host cannot know whether the target finished an attempt that was `running`: it is now `uncertain`, which
   * blocks every new delivery of the ticket until an operator reconciles it against the target's own receipt.
   * @returns how many attempts were marked.
   */
  markInterrupted(): number {
    let marked = 0
    this.repo.atomic(() => {
      for (const ticket of this.repo.tickets.list()) {
        const running = ticket.deliveryAuthorization?.attempts?.filter(item => item.state === 'running') ?? []
        if (!running.length) continue
        for (const attempt of running) {
          attempt.state = 'uncertain'
          attempt.detail = 'The host stopped while this attempt ran; whether the target finished it is unknown. No automatic retry; reconcile with the target receipt.'
          marked++
        }
        this.repo.tickets.save(ticket)
      }
    })
    return marked
  }

  /**
   * An operator's reconciliation of an unresolved attempt against the target's own receipt: `delivered` (the target holds the
   * receipt named here) or `discarded` (the operator confirmed the effect did not happen). Nothing resends: a discarded
   * attempt only frees the ticket for a new request, which needs a fresh grant that still matches.
   * @throws Error when the attempt is unknown or already delivered.
   */
  reconcile(ticketId: string, operationKey: string, outcome: { result: 'delivered'; receipt: string } | { result: 'discarded'; reason: string }, by: string): DeliveryAttempt {
    if (!by.trim()) throw new Error('Delivery: the operator attribution is required')
    return this.repo.atomic(() => {
      const ticket = this.require(ticketId)
      const attempts = ticket.deliveryAuthorization?.attempts ?? []
      const attempt = attempts.find(item => item.operationKey === operationKey)
      if (!attempt) throw new Error('Delivery: unknown attempt')
      if (attempt.state === 'delivered') throw new Error('Delivery: this attempt is already delivered')
      if (outcome.result === 'delivered') {
        if (!outcome.receipt.trim()) throw new Error('Delivery: a delivered reconciliation names the target receipt')
        attempt.state = 'delivered'; attempt.receipt = outcome.receipt; attempt.detail = `Reconciled by ${by}: the target holds the receipt`
      } else {
        if (!outcome.reason.trim()) throw new Error('Delivery: a discarded reconciliation says why')
        const state = ticket.deliveryAuthorization!
        state.attempts = attempts.filter(item => item.operationKey !== operationKey)
        state.requests = (state.requests ?? []).filter(item => item.operationKey !== operationKey)
        // The operator's grant covered the effect they have now discarded: a new delivery needs a new grant, never the old one.
        if (state.grants) delete state.grants[attempt.level]
        state.reconciled = [...state.reconciled ?? [], { operationKey, by, at: this.now(), reason: outcome.reason }]
      }
      this.repo.tickets.save(ticket)
      return attempt
    })
  }

  /** Reserve in the same transaction as all checks, commit BEFORE any side effect. Only the reserving call dispatches.
   * Identical content+level+target stays one operation across assignments and caller-supplied request ids. */
  async execute(ticketId: string, assignmentId: string, level: DeliveryLevel, requestId: string): Promise<DeliveryResult> {
    this.level(level)
    if (!requestId.trim() || requestId.length > 200) throw new Error('Delivery: stable request id required (1..200 chars)')
    const prepared = this.repo.atomic((): DeliveryResult => {
      const ticket = this.require(ticketId)
      const checked = this.check(ticket, assignmentId, level)
      if (checked.reasons.length) return this.refuse(ticket, assignmentId, level, requestId, checked.reasons)
      const state = ticket.deliveryAuthorization ??= {}
      const target = this.options.deliveryTarget!
      const operationKey = sha([ticketId, checked.workspace, level, target.id, checked.fingerprint, checked.version])
      const priorRequest = state.requests?.find(item => item.requestId === requestId)
        ?? state.attempts?.find(item => item.requestId === requestId)
      if (priorRequest && (priorRequest.operationKey !== operationKey || priorRequest.assignmentId !== assignmentId)) {
        return this.refuse(ticket, assignmentId, level, requestId, ['Delivery: request id already bound to another version/assignment/level'])
      }
      const previous = state.attempts?.find(item => item.operationKey === operationKey)
      if (previous) {
        if (!priorRequest) state.requests = [...state.requests ?? [], { requestId, operationKey, assignmentId }]
        this.repo.tickets.save(ticket)
        return { attempt: previous, repeated: true }
      }
      if (state.attempts?.some(item => item.state !== 'delivered')) {
        return this.refuse(ticket, assignmentId, level, requestId, ['Delivery: unresolved running/uncertain attempt; reconcile the target receipt, do not retry side effects'])
      }
      const attempt: DeliveryAttempt = { ticketId, assignmentId, workspace: checked.workspace!, level, target: target.id,
        fingerprint: checked.fingerprint!, version: checked.version!, operationKey, requestId, at: this.now(), state: 'running' }
      state.attempts = [...state.attempts ?? [], attempt]
      state.requests = [...state.requests ?? [], { requestId, operationKey, assignmentId }]
      this.repo.tickets.save(ticket)
      return { attempt, repeated: false }
    })
    if ('refused' in prepared || prepared.repeated) return prepared
    const attempt = prepared.attempt
    // Synchronous reservation above is the last preflight; no worker/host privilege or report can bypass it.
    let outcome: Pick<DeliveryAttempt, 'state' | 'detail' | 'receipt'>
    try {
      const result = await this.options.deliveryTarget!.execute(Object.freeze({ ...attempt }))
      if (!result.receipt.trim()) throw new Error('target returned no durable receipt')
      outcome = { state: 'delivered', receipt: result.receipt, detail: result.detail }
    } catch (error) {
      // A nonzero/timeout/transport error does NOT prove no remote side effect happened.
      outcome = { state: 'uncertain', detail: `Target outcome uncertain; no automatic retry: ${String(error)}` }
    }
    const recorded = this.repo.atomic(() => {
      const ticket = this.require(ticketId)
      const current = ticket.deliveryAuthorization?.attempts?.find(item => item.operationKey === attempt.operationKey)
      if (!current) throw new Error('Delivery: durable reservation missing; target receipt must be reconciled')
      Object.assign(current, outcome)
      this.repo.tickets.save(ticket)
      return current
    })
    // Development lifecycle is unchanged: delivery never manufactures ready, completes work, or grants another level.
    return { attempt: recorded, repeated: false }
  }
}
