/**
 * Phase 2 C+D independent host process (demo/verification only; never part of the product).
 *
 *   node --experimental-transform-types scripts/phase2cd-host.ts --state <absolute dir>
 *
 * A REAL Engine over a REAL SQLite Store (<state>/orchestrator.sqlite), a REAL file-backed EnvironmentExclusivity
 * (<state>/tp-environment.lock, real PIDs, real liveness), the real TicketedEnvironment and SimulatedDelivery
 * (<state>/delivery-simulation). Only the executor and the TP editor are recording stubs: no editor, git push, PR,
 * package or upload is ever performed. Line protocol: stdin `{id,cmd,args}` -> stdout `{id,ok,result|error}`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Store } from '../src/app/store.ts'
import { EnvironmentExclusivity } from '../src/app/environment-exclusive.ts'
import { TicketedEnvironment, environmentPort } from '../src/app/ticketed-environment.ts'
import { SimulatedDelivery } from '../src/app/simulated-delivery.ts'
import { Engine, type Candidate, type Outcome, type Policy } from '../src/core/index.ts'
import type { DeliveryAttempt, DeliveryLevel, DeliveryTarget } from '../src/core/delivery.ts'

console.log = (...items: unknown[]) => { process.stderr.write(`${items.join(' ')}\n`) } // stdout is the protocol channel only.

const argument = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined }
const state = argument('--state')
if (!state || !path.isAbsolute(state)) { process.stderr.write('usage: phase2cd-host.ts --state <absolute directory>\n'); process.exit(2) }
mkdirSync(state, { recursive: true })

const python = execFileSync('python', ['-I', '-S', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
const receipts = path.join(state, 'delivery-simulation')
const store = new Store(path.join(state, 'orchestrator.sqlite'))
const broker = new EnvironmentExclusivity(state)

// ---- recording stubs ------------------------------------------------------------------------------------------
const executorLog: string[] = []
const editors = new Set<string>()
const stubs = { failNextEditorStop: false, failTargetAfterEffect: false, targetExecutions: 0, editorStops: [] as string[], fakeEditors: 0 }
let pendingDirectory = ''
if (process.argv.includes('--fail-target-after-effect')) stubs.failTargetAfterEffect = true

const tickets = new TicketedEnvironment(broker, { projectFile: path.join(state, 'fake-tp', 'TP.uproject'), port: 55255 }, {
  stopEditor: async (ticketId: string) => {
    if (stubs.failNextEditorStop) { stubs.failNextEditorStop = false; stubs.editorStops.push(`FAILED:${ticketId}`); throw new Error('injected editor stop failure') }
    editors.delete(ticketId); stubs.editorStops.push(`stopped:${ticketId}`)
  },
  ownsEditor: (ticketId: string) => editors.has(ticketId),
  directory: (ticketId: string) => store.tickets.get(ticketId)?.execution?.directory,
})

const simulation = new SimulatedDelivery(receipts)
const target: DeliveryTarget = {
  id: simulation.id,
  version: workspace => simulation.version(workspace),
  async execute(attempt: Readonly<DeliveryAttempt>) {
    stubs.targetExecutions++
    const result = await simulation.execute(attempt)
    if (stubs.failTargetAfterEffect) { stubs.failTargetAfterEffect = false; throw new Error('injected: connection lost AFTER the target wrote its receipt') }
    return result
  },
}

const requests: Candidate[] = []
const policy: Policy = { version: 'phase2cd', paused: false, evalTimeoutMs: 60_000,
  gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
const engine = new Engine({
  repo: store, policy: () => policy,
  scope: { scope: () => ({ listened: true, observed: false }) },
  assessor: { request: candidate => { requests.push(candidate) }, release: () => {} },
  executor: { start: (ticket, assignment) => { executorLog.push(`start:${ticket.id}:${assignment.id}`) },
    deliver: (ticket) => { executorLog.push(`deliver:${ticket.id}`) }, stop: (ticket, _assignment, reason) => { executorLog.push(`stop:${ticket.id}:${reason}`) } },
  outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
  prepareTicket: ticket => ({ ...ticket, execution: { name: 'phase2cd', directory: pendingDirectory, assignment: 'Phase 2 C+D demo work' } }),
  deliveryTarget: target,
  environments: environmentPort(tickets)!,
  acceptance: () => true, // `ready` still passes the Engine's strict-evidence check; it never grants delivery.
})

// ---- startup: the same restart behaviour as runtime.resumeEnvironment (host, not product, code) ------------------
broker.wake()
const resumed: { holder?: string; action: string; error?: string }[] = []
{
  const record = broker.held()
  if (record) {
    const ticket = store.tickets.get(record.holder.id)
    const live = !!ticket && !ticket.ended
    if (record.holder.kind === 'ticket' && ticket && (live || (ticket.ended && record.facts?.purpose === 'delivery'))) {
      try { tickets.acquire(ticket.id, ticket.title); resumed.push({ holder: ticket.id, action: 'resumed' }) }
      catch (error) { resumed.push({ holder: ticket.id, action: 'refused', error: String(error instanceof Error ? error.message : error) }) }
    } else resumed.push({ holder: record.holder.id, action: 'left-alone' })
  }
}
tickets.beat()
setInterval(() => tickets.beat(), 30_000).unref()

// ---- commands ---------------------------------------------------------------------------------------------------
const need = (id: string) => { const ticket = store.tickets.get(id); if (!ticket) throw new Error(`unknown ticket ${id}`); return ticket }
const assignmentOf = (id: string) => need(id).assignments.at(-1)!.id
const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
const receiptFiles = () => existsSync(receipts) ? readdirSync(receipts).sort() : []
let sequence = 0

function summary(id: string) {
  const ticket = need(id)
  const evidence = ticket.validation?.evidence
  return { id, title: ticket.title, directory: ticket.execution?.directory, ended: ticket.ended ?? null,
    assignments: ticket.assignments.map(item => ({ id: item.id, state: item.state, report: item.report?.state ?? null })),
    validation: ticket.validation ? { enabled: !!ticket.validation.enabled, blocked: ticket.validation.blocked ?? null, hasContract: !!ticket.validation.contract,
      evidence: evidence ? { passed: evidence.passed, finishedAt: evidence.finishedAt } : null } : null,
    holds: tickets.holds(id), delivery: engine.deliveryState(id), receipts: receiptFiles(), targetExecutions: stubs.targetExecutions }
}
function leaseView() {
  const record = broker.read()
  return { held: !!broker.held(), selfPid: process.pid, record: record ? { holder: record.holder, acquiredAt: record.acquiredAt, token: record.token,
    pid: record.pid, host: record.host, heartbeat: record.heartbeat, facts: record.facts ?? null } : null }
}
function afterEntering(id: string) {
  // A ticket that (re-)entered the environment starts its (stub) editor and its assignment, as the executor would.
  const ticket = need(id)
  if (ticket.ended || !tickets.holds(id)) return
  if (!tickets.recordedPid(id)) { editors.add(id); tickets.recordStarted(id, 4_000_000 + ++stubs.fakeEditors) }
  const last = ticket.assignments.at(-1)
  if (last && last.state !== 'running' && last.state !== 'ended') engine.assignmentStarted(id, last.id)
}

const commands: Record<string, (args: any) => unknown | Promise<unknown>> = {
  info: () => ({ pid: process.pid, state, python, node: process.version, resumed, receipts }),
  accept: (a: { title: string; dir: string }) => {
    pendingDirectory = a.dir; requests.length = 0
    const seq = ++sequence, id = `p2cd-${process.pid}-${seq}`
    engine.receive({ id, source: 'chat', threads: [{ source: 'chat', id }], actor: { source: 'chat', id: 'operator' }, human: true,
      at: new Date().toISOString(), text: a.title, meta: {} })
    engine.evaluateDue()
    const candidate = requests.at(-1)
    if (!candidate) throw new Error('no evaluation candidate was produced')
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', evalId: candidate.evalId, title: a.title, scope: 'fixture', reason: 'requested' } as Outcome)
    const ticketId = decision.ticketId!
    const blocked = need(ticketId).validation?.blocked ?? null
    if (!blocked) afterEntering(ticketId)
    return { ticketId, blocked, holds: tickets.holds(ticketId), lease: leaseView() }
  },
  'attempt-acquire': (a: { ticketId: string; kind?: 'ticket' | 'session'; label?: string }) => {
    const lease = broker.acquireHolder({ kind: a.kind ?? 'ticket', id: a.ticketId, label: a.label ?? a.ticketId, resources: [] })
    return { acquired: true, token: lease.token, lease: leaseView() }
  },
  report: async (a: { ticketId: string; state: any; summary?: string }) => {
    engine.report(a.ticketId, { state: a.state, summary: a.summary ?? `report ${a.state}` })
    await settle() // completion releases the environment asynchronously (editor stop first)
    return summary(a.ticketId)
  },
  'configure-tests': (a: { ticketId: string; requiredTestIds?: string[]; timeoutMs?: number }) => {
    const workspace = realpathSync(need(a.ticketId).execution!.directory)
    engine.configureValidation(a.ticketId, { adapter: 'python-unittest', executable: python, workspace,
      requiredTestIds: a.requiredTestIds ?? ['test_delivery.Delivery.test_answer'], timeoutMs: a.timeoutMs ?? 30_000 })
    return { workspace, python }
  },
  'run-tests': async (a: { ticketId: string }) => {
    const evidence: any = await engine.runTicketTests(a.ticketId, assignmentOf(a.ticketId))
    return { passed: evidence.passed, completed: evidence.completed, exitCode: evidence.exitCode, testsRun: evidence.testsRun, failures: evidence.failures,
      errors: evidence.errors, skipped: evidence.skipped, successfulTestIds: evidence.successfulTestIds, finishedAt: evidence.finishedAt, binding: evidence.binding }
  },
  handover: async (a: { ticketId: string }) => engine.handOverEnvironment(a.ticketId),
  retry: (a: { ticketId: string }) => {
    engine.retryTicket(a.ticketId)
    engine.assignmentStarted(a.ticketId, assignmentOf(a.ticketId))
    return summary(a.ticketId)
  },
  'ensure-env': (a: { ticketId: string }) => { engine.ensureEnvironment(a.ticketId); afterEntering(a.ticketId); return { holds: tickets.holds(a.ticketId), lease: leaseView() } },
  'acquire-env': (a: { ticketId: string }) => { const result = engine.acquireEnvironment(a.ticketId); return { ...result, holds: tickets.holds(a.ticketId), lease: leaseView() } },
  'release-ended': async (a: { ticketId: string }) => ({ ...await engine.releaseEndedEnvironment(a.ticketId), lease: leaseView() }),
  grant: (a: { ticketId: string; level?: DeliveryLevel; by?: string }) => {
    const level = a.level ?? 'push'
    const result = engine.configureDelivery(a.ticketId, level, true, a.by ?? 'operator-demo')
    return result.grants?.[level]
  },
  deliver: async (a: { ticketId: string; level?: DeliveryLevel; requestId: string }) => {
    const result: any = await engine.deliverTicket(a.ticketId, assignmentOf(a.ticketId), a.level ?? 'push', a.requestId)
    return { ...result, targetExecutions: stubs.targetExecutions, receipts: receiptFiles() }
  },
  state: (a: { ticketId: string }) => summary(a.ticketId),
  lease: () => leaseView(),
  stubs: () => ({ ...stubs, executorLog, editors: [...editors] }),
  'fail-next-editor-stop': () => { stubs.failNextEditorStop = true; return { armed: true } },
  'set-target-fail-after-effect': () => { stubs.failTargetAfterEffect = true; return { armed: true } },
  shutdown: () => {
    broker.halt() // no heartbeat is written once stopping: the persisted lease is left for a restarted host
    store.close()
    return { closed: true, pid: process.pid }
  },
}

let chain: Promise<void> = Promise.resolve()
const lines = createInterface({ input: process.stdin })
const write = (value: unknown) => new Promise<void>(resolve => process.stdout.write(`${JSON.stringify(value)}\n`, () => resolve()))
lines.on('line', line => {
  chain = chain.then(async () => {
    let request: { id?: unknown; cmd?: string; args?: unknown } = {}
    try {
      request = JSON.parse(line)
      const handler = commands[String(request.cmd)]
      if (!handler) throw new Error(`unknown command ${String(request.cmd)}`)
      const result = await handler(request.args ?? {})
      await write({ id: request.id, ok: true, result })
      if (request.cmd === 'shutdown') process.exit(0)
    } catch (error) {
      const e = error as Error & { record?: any }
      await write({ id: request.id, ok: false, error: { name: e?.name ?? 'Error', message: e?.message ?? String(error),
        ...e?.record ? { holder: e.record.holder, holderPid: e.record.pid, acquiredAt: e.record.acquiredAt } : {} } })
    }
  })
})
lines.on('close', () => { chain.then(() => { try { store.close() } catch { /* already closed */ } process.exit(0) }) })
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, resumed })}\n`)
