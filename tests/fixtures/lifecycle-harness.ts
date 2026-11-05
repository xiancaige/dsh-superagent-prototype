/**
 * Phase 2 C/D lifecycle regression harness: the real Engine over the real broker and `TicketedEnvironment`, with
 * the host's facts injected so a test can fail the editor stop, deny the acceptance, put a foreign Session in the
 * environment, and read every event the Engine raised. It never launches an editor or signals a real process.
 */
import { Engine, MemoryRepositories, type Assessor, type Candidate, type DomainEvent, type EngineOptions, type Executor, type Outcome,
  type Policy, type Ticket } from '../../src/core/index.ts'
import { TicketedEnvironment, environmentPort } from '../../src/app/ticketed-environment.ts'
import type { EnvironmentExclusivity } from '../../src/app/environment-exclusive.ts'
import { broker, TP } from './environment.ts'
import { trigger } from './engine-harness.ts'

export const HOST = 'test-host'
/** This deployment's own Session process. */
export const SELF_PID = 100

export interface StopAttempt { ticketId: string; failed: boolean; holdsAtStop: boolean }

export function lifecycleHarness(directory: string) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) }, release: () => {} }
  const launches: [Ticket, string][] = []
  const executor: Executor = { start: (ticket, assignment) => { launches.push([ticket, assignment.id]) }, deliver: () => {}, stop: () => {} }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const outbox: EngineOptions['outbox'] = { send: () => {}, status: () => undefined, withdraw: () => {} }
  /** The PID table every broker of this harness shares: a PID listed here is a living Session process on this machine. */
  const alive = new Set<number>([SELF_PID])
  const instance = broker(HOST, SELF_PID, pid => alive.has(pid), directory)
  const events: DomainEvent[] = []
  const hosts = {
    acceptance: (_ticket: Ticket) => true,
    /** The TP editors the host "started", by ticket. */
    editors: new Set<string>(),
    directories: new Map<string, string>(),
    /** Set to make the next stops fail, as a kill script that exits non-zero does. */
    stopFailure: undefined as Error | undefined,
    /** Every stop the ticket side asked of the host, whether it succeeded or not. */
    stops: [] as StopAttempt[],
  }
  const tickets = new TicketedEnvironment(instance, TP, {
    stopEditor: async (ticketId: string) => {
      const failed = !!hosts.stopFailure
      hosts.stops.push({ ticketId, failed, holdsAtStop: instance.owns('ticket', ticketId) })
      if (hosts.stopFailure) throw hosts.stopFailure
      hosts.editors.delete(ticketId)
    },
    ownsEditor: (ticketId: string) => hosts.editors.has(ticketId),
    directory: (ticketId: string) => hosts.directories.get(ticketId),
  })
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor, outbox,
    environments: environmentPort(tickets)!, acceptance: ticket => hosts.acceptance(ticket), emit: event => { events.push(event) } })
  const settle = () => { let next = launches.shift(); while (next) { engine.assignmentStarted(next[0].id, next[1]); next = launches.shift() } }
  const accept = (id: string) => {
    engine.receive(trigger(id)); engine.evaluateDue()
    const candidate = requests.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: `Fix ${id}`, scope: 'small', reason: 'requested', acknowledgement: 'ok', evalId: candidate.evalId } as Outcome)
    return decision.ticketId!
  }
  /** Another Session process on the same state directory: a living PID of this machine (or another machine's) that owns its own broker. */
  const foreign = (pid: number, host = HOST): EnvironmentExclusivity => { alive.add(pid); return broker(host, pid, candidate => alive.has(candidate), directory) }
  /** The ticket's worker reports ready; the host's acceptance decides whether that completes it. */
  const ready = (ticketId: string) => engine.report(ticketId, { state: 'ready', summary: 'done' })
  /** The events of one type the Engine raised. */
  const raised = <K extends DomainEvent['type']>(type: K) => events.filter(event => event.type === type) as Extract<DomainEvent, { type: K }>[]
  return { repo, engine, tickets, broker: instance, hosts, launches, events, alive, accept, settle, ready, foreign, raised, directory }
}

/** `Engine.ensureEnvironment`, called through `any` so a build without it fails with a clear message instead of a type error. */
export function ensureEnvironment(engine: Engine, ticketId: string): void {
  const call = (engine as unknown as { ensureEnvironment?: (id: string) => void }).ensureEnvironment
  if (typeof call !== 'function') throw new Error('Engine.ensureEnvironment is not implemented')
  call.call(engine, ticketId)
}

/** `Engine.acquireEnvironment`, called through `any` for the same reason. */
export function acquireEnvironment(engine: Engine, ticketId: string): { held: true } {
  const call = (engine as unknown as { acquireEnvironment?: (id: string) => { held: true } }).acquireEnvironment
  if (typeof call !== 'function') throw new Error('Engine.acquireEnvironment is not implemented')
  return call.call(engine, ticketId)
}
