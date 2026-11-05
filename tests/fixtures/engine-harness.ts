/** Phase 2 C: the Engine over in-memory repositories, holding the real environment broker, for engine-level tests. */
import { Engine, MemoryRepositories, type Assessor, type Candidate, type EngineOptions, type Executor, type Outcome, type Policy, type Ticket,
  type Trigger } from '../../src/core/index.ts'
import { TicketedEnvironment, environmentPort } from '../../src/app/ticketed-environment.ts'
import { broker, TP } from './environment.ts'

const member = { source: 'chat', id: 'alice' }
export const trigger = (id: string): Trigger => ({ id, source: 'chat', threads: [{ source: 'chat', id: `t${id}` }], actor: member, human: true,
  at: `2026-11-03T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`, channel: { source: 'chat', thread: `t${id}`, address: { message: id } }, meta: {} })

export function phase2cHarness(directory: string) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) }, release: () => {} }
  const launches: [Ticket, string][] = []
  const executor: Executor = { start: (ticket, assignment) => { launches.push([ticket, assignment.id]) }, deliver: () => {}, stop: () => {} }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const outbox: EngineOptions['outbox'] = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const instance = broker('test-host', 100, pid => pid === 100, directory)
  /** The host's own facts: its acceptance check, the editor it started, and where each ticket works. */
  const hosts = { acceptance: (_ticket: Ticket) => true, editors: new Set<string>(), directories: new Map<string, string>() }
  // The broker is created before the ticket side, whose port reads the acceptance through it.
  let engine!: Engine
  const tickets = new TicketedEnvironment(instance, TP, {
    stopEditor: async (ticketId: string) => { hosts.editors.delete(ticketId) },
    ownsEditor: (ticketId: string) => hosts.editors.has(ticketId),
    directory: (ticketId: string) => hosts.directories.get(ticketId),
  })
  engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor, outbox,
    environments: environmentPort(tickets)!, acceptance: ticket => hosts.acceptance(ticket) })
  const settle = () => { let next = launches.shift(); while (next) { engine.assignmentStarted(next[0].id, next[1]); next = launches.shift() } }
  const accept = (id: string) => {
    engine.receive(trigger(id)); engine.evaluateDue()
    const candidate = requests.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: `Fix ${id}`, scope: 'small', reason: 'requested', acknowledgement: 'ok', evalId: candidate.evalId } as Outcome)
    return decision.ticketId!
  }
  return { repo, engine, tickets, broker: instance, hosts, launches, accept, settle, directory }
}
