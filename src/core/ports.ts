/** Ports the core depends on. Sources, policies, assessors, executors, and channels are project-specific. */
import type { Assignment, ChannelRef, Decision, DecisionKind, Mandate, MandateBasis, Strength, Thread, Ticket, TicketEndBy, TicketOutcome, Trigger }
  from './model.ts'
import type { Reason } from './reasons.ts'

/** Gate admission result: either inadmissible with a reason code, or admissible with strength and MandateBasis. */
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** Whether a Source receives a Trigger; `observed` when it also receives messages not addressed to the agent, and `row` the receiving scope the Policy's admission table names, such as a chat. */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis. */
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy. */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** Re-check a mandate's gate-layer basis under this policy, such as before an ended ticket resumes. */
  revalidate(mandate: Mandate): boolean
  /** Whether an inferred candidate may be accepted on the rules its assessment matched: assessments accept, and each rule is enabled. */
  admitsInferred(rules: readonly string[]): boolean
  /** How long an assessor may take before an eval is recorded as unavailable. */
  evalTimeoutMs: number
}

/** What the assessor receives: bounded facts, never authority. */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** Every ticket on the thread, including ended ones, for duplicate judgement. */
  tickets: Ticket[]
}

export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /** An accept: `rules` the assessment matched, `name` the ticket's requested short name, and `note` a routing note for its worker. */
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; note?: string }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** Semantic judgement. `request` queues the assessment, idempotently per `evalId`; the outcome returns through `Engine.decide`. */
export interface Assessor {
  request(candidate: Candidate): void
  /** Called whenever an eval ends, decided or not, so the assessor drops what it kept for it. */
  release?(evalId: string): void
}

/**
 * Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
 * commands, so each method only queues work, which reports back through the Engine's callbacks.
 */
export interface Executor {
  /** Queue a pending assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * Queue delivery of the ticket's waiting Inputs to its running assignment; reports back through `Engine.inputsDelivered`
   * or `Engine.deliveryFailed`, and through `Engine.inputsRead` once its worker's Session takes them into a step.
   */
  deliver(ticket: Ticket, assignment: Assignment): void
  /** End an assignment's work, such as cancelling its Session's turn; called after the ticket or assignment has already ended in the domain. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}

/** A message for a Channel; `ticketId` names the Ticket it is for, when there is one. */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }
/** A queued message waits (`pending`), went out (`sent`), or was dropped because its conversation can never receive it (`dropped`). */
export type ReplyStatus = 'pending' | 'sent' | 'dropped'
/** The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later. */
export interface Outbox {
  /** Queue a message idempotently; an id queued before keeps its first message. */
  send(message: OutboundMessage): void
  /** Whether a message was queued, and what became of it. */
  status(id: string): ReplyStatus | undefined
  /** Withdraw a message that has not gone out. */
  withdraw(id: string): void
}

/**
 * Phase 2 C: a ticket's hold on the shared environment it changes. The host owns the facts (the lock,
 * its heartbeat, the handover export); the engine only asks, and never trusts the record for whether a
 * ticket may be called done.
 */
export interface Environments {
  /**
   * Take the environment for a newly accepted ticket, before its directory or editor exists; a holder
   * that has it throws `EnvironmentHeld` naming that holder. A restarted host resumes its own lease.
   */
  acquire(ticketId: string, title: string, purpose?: 'delivery'): void
  /** The ticket's hold as the host recorded it, or undefined when it holds nothing. */
  describe(ticketId: string): TicketHold | undefined
  /** Whether the ticket holds the environment now: the engine's own line of defence beside the host's lock. */
  holds(ticketId: string): boolean
  /** A person's explicit handover: export the scene, then release, or refuse and keep holding. */
  handover(ticketId: string): Promise<{ handedOver: boolean; export?: string; files: number; error?: string }>
  /** The ticket's work ended; the host releases only for the facts the contract names. */
  end(ticketId: string, ended: { by: TicketEndBy; outcome: TicketOutcome }, acceptancePassed: boolean): Promise<boolean>
}
/** A ticket's hold, as the host recorded it. */
export interface TicketHold { ticketId: string; held?: { at: string } }
/** Whether the ticket itself passed the acceptance the host requires before it may be called done. */
export type AcceptanceFacts = (ticket: Ticket) => boolean

/** What the Engine reports after a change, by event type. */
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  /** A person dropped every ticket's Subscription, or a ticket's Executor its own, for `reason`. */
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** A person's follow-up that reached tickets and that an earlier version also queued for Eval left the queue. */
  'trigger.followup': { triggerId: string }
  'policy.changed': { from: string; to: string }
  /** Phase 2 C: the ticket took the environment, or was refused it because `holder` has it. */
  'ticket.exclusive': { ticketId: string; action: 'acquired' | 'refused'; holder?: string; reason?: string }
  /** Phase 2 C: a person handed the ticket's environment over, or the handover was refused with why. */
  'ticket.handover': { ticketId: string; handedOver: boolean; export?: string; error?: string }
}
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/** Durable state. Every method is synchronous so `atomic` can wrap a unit of work. */
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): import('./model.ts').TriggerDisposition | undefined
    saveDisposition(id: string, value: import('./model.ts').TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** Threads with Triggers queued for Eval or an Eval in progress. */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** Tickets with undelivered Inputs or a pending or running Assignment, which is always the latest. */
    active(): Ticket[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
}
