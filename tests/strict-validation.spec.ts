import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { Engine, MemoryRepositories, type Candidate, type OutboundMessage, type Policy, type Repositories, type Ticket, type WorkerReport } from '../src/core/index.ts'
import { CQTEST_PASSING_ID, writeCqtestReport } from './fixtures/cqtest-report.ts'

/** A trusted validator outside every workspace (the CQTest report validator's role). */
const executable = realpathSync(process.execPath)
const roots: string[] = []
const stores = new Set<Store>()
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const testSource = 'export const answer = () => 42\n'
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-strict-engine-')))
  roots.push(root)
  writeFileSync(join(root, 'source.ts'), testSource)
  writeCqtestReport(root)
  return root
}
function openStore(path: string) {
  const store = new Store(path)
  stores.add(store)
  return store
}
function closeStore(store: Store) { store.close(); stores.delete(store) }
function harness(repo: Repositories = new MemoryRepositories(), directory = workspace()) {
  const requests: Candidate[] = []
  const outbox: OutboundMessage[] = []
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true, admitsInferred: () => true,
  }
  let clock = 0
  const engine = new Engine({
    repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: candidate => { requests.push(candidate) }, release: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: {
      send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
      status: id => outbox.some(item => item.id === id) ? 'pending' : undefined, withdraw: vi.fn(),
    },
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'strict-fixture', directory, assignment: 'Run the trusted tests' } }),
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)).toISOString(),
  })
  function accept(id = 'request-1') {
    engine.receive({ id, source: 'chat', threads: [{ source: 'chat', id }], actor: { source: 'chat', id: 'alice' },
      human: true, at: '2026-11-02T00:00:00.000Z', text: 'Fix answer', meta: {},
      channel: { source: 'chat', thread: id, address: { message: id } } })
    engine.evaluateDue()
    const decision = engine.decide(id, { kind: 'accept', evalId: requests.at(-1)!.evalId, title: 'Fix answer', scope: 'fixture', reason: 'requested' })
    const ticket = repo.tickets.get(decision.ticketId!)!
    engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    return ticket.id
  }
  const current = (id: string) => repo.tickets.get(id)!
  const contract = { adapter: 'cqtest-report' as const, executable, workspace: directory,
    requiredTestIds: [CQTEST_PASSING_ID], timeoutMs: 10_000 }
  const enable = (id: string) => engine.configureValidation(id, contract)
  const run = (id: string) => engine.runTicketTests(id, current(id).assignments.at(-1)!.id)
  const ready = (id: string) => engine.report(id, { state: 'ready', summary: 'All tests pass' })
  const result = (id: string) => engine.reply({ purpose: 'result', ticketId: id, text: 'All tests pass' })
  // Explicit repository tampering is reserved for negative binding tests, never used to manufacture a passing run.
  const tamper = (id: string, change: (ticket: Ticket) => void) => {
    const ticket: Ticket = JSON.parse(JSON.stringify(current(id)))
    change(ticket); repo.tickets.save(ticket)
  }
  return { repo, engine, outbox, directory, accept, current, contract, enable, run, ready, result, tamper }
}

describe('strict validation at Engine acceptance boundaries', () => {
  it('runs CQTest through ready/SQLite restore/result guards and rejects old assignments', async () => {
    const directory = workspace()
    const database = join(workspace(), 'cqtest.sqlite'), store = openStore(database)
    const h = harness(store, directory), id = h.accept()
    h.enable(id)
    expect(() => h.ready(id)).toThrow(/validation/i)
    const old = h.current(id).assignments.at(-1)!.id
    const evidence = await h.run(id)
    expect(evidence.passed).toBe(true)
    h.engine.report(id, { state: 'failed', summary: 'retry' }); h.engine.retryTicket(id)
    h.engine.assignmentStarted(id, h.current(id).assignments.at(-1)!.id)
    await expect(h.engine.runTicketTests(id, old)).rejects.toThrow(/assignment/i)
    expect(() => h.ready(id)).toThrow(/validation/i)
    await h.run(id)
    closeStore(store)
    const restored = harness(openStore(database), directory)
    expect(restored.ready(id).ended?.outcome).toBe('completed')
    expect(restored.result(id).status).toBe('pending')
    writeCqtestReport(directory, { passing: [], failing: [CQTEST_PASSING_ID], at: new Date(Date.now() + 1_000) })
    expect(() => restored.result(id)).toThrow(/validation|stale|changed/i)
    const failed = harness(undefined, directory), failedId = failed.accept()
    failed.enable(failedId)
    expect((await failed.run(failedId)).passed).toBe(false)
    expect(() => failed.ready(failedId)).toThrow(/validation/i)
  })

  it('preserves a delayed completed notification across resumption and SQLite restore without approving new work', async () => {
    const database = join(workspace(), 'resumed.sqlite'), store = openStore(database)
    const h = harness(store), id = h.accept()
    h.enable(id)
    expect((await h.run(id)).passed).toBe(true)
    h.ready(id)
    const finishedAssignment = h.current(id).assignments.at(-1)!.id
    h.engine.receive({ id: 'follow-up', source: 'chat', threads: [{ source: 'chat', id: 'request-1' }],
      actor: { source: 'chat', id: 'alice' }, human: true, at: '2026-11-02T01:00:00.000Z', text: 'Status?', meta: {},
      channel: { source: 'chat', thread: 'request-1', address: { message: 'follow-up' } } })
    const resumedAssignment = h.current(id).assignments.at(-1)!.id
    expect(resumedAssignment).not.toBe(finishedAssignment)
    h.engine.assignmentStarted(id, resumedAssignment)
    closeStore(store)
    const restored = harness(openStore(database), h.directory)
    expect(restored.current(id).result).toMatchObject({ assignmentId: finishedAssignment, outcome: 'completed' })
    expect(restored.result(id).status).toBe('pending')
    expect(() => restored.ready(id)).toThrow(/validation|assignment/i)
    writeFileSync(join(h.directory, 'source.ts'), 'export const answer = () => 0\n')
    expect(() => restored.result(id)).toThrow(/validation|stale|changed/i)
  })

  it('keeps legacy tickets without validation backward compatible, including after SQLite restore', () => {
    const path = join(workspace(), 'legacy.sqlite')
    const store = openStore(path)
    const h = harness(store)
    const id = h.accept()
    expect(h.current(id).validation).toBeUndefined()
    closeStore(store)
    const restored = harness(openStore(path), h.directory)
    expect(restored.ready(id).ended?.outcome).toBe('completed')
    expect(restored.result(id).status).toBe('pending')
  })

  it.each(['missing contract', 'missing evidence'])('rejects ready with %s, without saving a ready report', async kind => {
    const h = harness(), id = h.accept()
    if (kind === 'missing contract') h.engine.configureValidation(id)
    else h.enable(id)
    expect(() => h.ready(id)).toThrow(/validation/i)
    // Each acceptance failure names its own cause, so a reader cannot mistake "no contract" for "no evidence".
    expect(() => h.ready(id)).toThrow(kind === 'missing contract' ? /neither a test contract nor a recorded visual verdict/ : /no passing test evidence/)
    expect(h.current(id).ended).toBeUndefined()
    expect(h.current(id).assignments.at(-1)?.report).toBeUndefined()
    expect(() => h.result(id)).toThrow()
    if (kind === 'missing contract') await expect(h.run(id)).rejects.toThrow(/contract/i)
  })

  it('ignores forged worker report counts and evidence instead of treating them as a host run', () => {
    const h = harness(), id = h.accept()
    h.enable(id)
    const forged = { state: 'ready', summary: 'Ran 900 tests: OK', passed: true, testsRun: 900,
      failures: 0, errors: 0, skipped: 0, validation: { enabled: false }, evidence: { passed: true } } as WorkerReport
    expect(() => h.engine.report(id, forged)).toThrow(/validation/i)
    expect(h.current(id).validation).toMatchObject({ enabled: true })
    expect(h.current(id).validation?.evidence).toBeUndefined()
    expect(h.outbox).toEqual([])
  })

  it('runs current real Python tests, persists host evidence, and permits ready and result', async () => {
    const h = harness(), id = h.accept()
    h.enable(id)
    const evidence = await h.run(id)
    expect(evidence).toMatchObject({ passed: true, completed: true, exitCode: 0, testsRun: 1, failures: 0, errors: 0,
      skipped: 0, successfulTestIds: [CQTEST_PASSING_ID], binding: { ticketId: id, assignmentId: h.current(id).assignments.at(-1)!.id, workspace: h.directory } })
    expect(h.current(id).validation?.evidence).toEqual(evidence)
    expect(h.current(id).validation?.running).toBeUndefined()
    expect(h.ready(id).ended?.outcome).toBe('completed')
    expect(h.result(id).status).toBe('pending')
    expect(h.outbox).toHaveLength(1)
  })

  it('does not accept a worker success summary when the CQTest report records a failure', async () => {
    const h = harness(), id = h.accept()
    h.enable(id)
    // A fresh report that simply fails. Stamping it in the future would be rejected for being from the
    // future and would hide the point of this case.
    writeCqtestReport(h.directory, { passing: [], failing: [CQTEST_PASSING_ID], at: new Date() })
    const evidence = await h.run(id)
    // A report holding a failure is refused as evidence outright (the run must be clean), so it carries
    // its concrete reason rather than a partial result.
    expect(evidence.passed).toBe(false)
    expect(evidence.reasons.join('; ')).toMatch(/CQTest not clean/)
    expect(h.current(id).validation?.evidence).toEqual(evidence)
    expect(() => h.ready(id)).toThrow(/validation/i)
    expect(() => h.result(id)).toThrow()
    expect(h.outbox).toEqual([])
  })

  it('refuses a trusted contract for a different workspace', () => {
    const h = harness(), id = h.accept()
    expect(() => h.engine.configureValidation(id, { ...h.contract, workspace: workspace() })).toThrow(/workspace/i)
    expect(h.current(id).validation).toBeUndefined()
  })

  it('restores contract and green evidence from actual SQLite and still checks current files', async () => {
    const database = join(workspace(), 'strict.sqlite'), store = openStore(database)
    const h = harness(store), id = h.accept()
    h.enable(id)
    await h.run(id)
    const saved = h.current(id).validation
    closeStore(store)
    const restored = harness(openStore(database), h.directory)
    expect(restored.current(id).validation).toEqual(saved)
    expect(restored.ready(id).ended?.outcome).toBe('completed')
    writeFileSync(join(h.directory, 'source.ts'), 'export const answer = () => 0\n')
    expect(() => restored.result(id)).toThrow(/validation|fingerprint|changed/i)
    expect(restored.outbox).toEqual([])
  })

  it.each(['source.ts', 'notes.txt'] as const)('restores strict missing-evidence state and cannot accept %s changes as proof', filename => {
    const database = join(workspace(), 'missing.sqlite'), store = openStore(database)
    const h = harness(store), id = h.accept()
    h.enable(id)
    closeStore(store)
    const restored = harness(openStore(database), h.directory)
    writeFileSync(join(h.directory, filename), '# worker says tests passed\n')
    expect(() => restored.ready(id)).toThrow(/validation/i)
  })

  it.each([
    ['source', 'added'], ['source', 'deleted'], ['source', 'modified'],
    ['test', 'added'], ['test', 'deleted'], ['test', 'modified'],
  ] as const)('expires green evidence when %s files are %s', async (kind, operation) => {
    const h = harness(), id = h.accept()
    h.enable(id)
    // A deletion must remove a file the run actually fingerprinted: the CQTest report is generated
    // output and excluded, so 'test' targets a second source file instead.
    const filename = kind === 'source' ? 'source.ts' : 'notes.txt'
    writeFileSync(join(h.directory, 'notes.txt'), 'note before the run\n')
    await h.run(id)
    const target = join(h.directory, operation === 'added' ? `${kind}_additional.ts` : filename)
    if (operation === 'deleted') unlinkSync(target)
    else writeFileSync(target, operation === 'modified' ? `${testSource}\n// changed after run\n` : '// newly added\n')
    expect(() => h.ready(id)).toThrow(/validation|fingerprint|changed/i)
    expect(h.current(id).ended).toBeUndefined()
  })

  it.each(['ticketId', 'assignmentId', 'workspace', 'contractRevision'] as const)('rejects repository-tampered evidence bound to the wrong %s', async field => {
    const h = harness(), id = h.accept()
    h.enable(id)
    await h.run(id)
    h.tamper(id, ticket => {
      const evidence = ticket.validation!.evidence!
      ticket.validation!.evidence = { ...evidence, binding: { ...evidence.binding, [field]: field === 'workspace' ? workspace() : 'another-binding' } }
    })
    expect(() => h.ready(id)).toThrow(/validation|binding/i)
    expect(h.current(id).ended).toBeUndefined()
  })

  it('rejects a changed ticket execution workspace despite otherwise valid host evidence', async () => {
    const h = harness(), id = h.accept()
    h.enable(id); await h.run(id)
    h.tamper(id, ticket => { ticket.execution!.directory = workspace() })
    expect(() => h.ready(id)).toThrow(/validation|workspace|binding/i)
  })

  it('invalidates green evidence on retry and rejects a run requested by the old assignment', async () => {
    const h = harness(), id = h.accept()
    h.enable(id); await h.run(id)
    const oldAssignment = h.current(id).assignments.at(-1)!.id
    h.engine.report(id, { state: 'failed', summary: 'Retry needed' })
    h.engine.retryTicket(id)
    const nextAssignment = h.current(id).assignments.at(-1)!.id
    expect(nextAssignment).not.toBe(oldAssignment)
    h.engine.assignmentStarted(id, nextAssignment)
    await expect(h.engine.runTicketTests(id, oldAssignment)).rejects.toThrow(/assignment/i)
    expect(() => h.ready(id)).toThrow(/validation|binding/i)
    await h.run(id)
    expect(h.ready(id).ended?.outcome).toBe('completed')
  })

  it('generates a fresh host revision and invalidates evidence when reconfigured', async () => {
    const h = harness(), id = h.accept()
    h.enable(id); await h.run(id)
    const revision = h.current(id).validation!.contract!.revision
    h.enable(id)
    expect(h.current(id).validation!.contract!.revision).not.toBe(revision)
    expect(h.current(id).validation!.evidence).toBeUndefined()
    expect(() => h.ready(id)).toThrow(/validation/i)
  })

  it('requires valid evidence for ready even while a followed thread remains open', async () => {
    const h = harness(), id = h.accept(), thread = { source: 'github', id: 'pull-1' }
    h.enable(id); h.engine.bindThread(id, thread, true)
    expect(() => h.ready(id)).toThrow(/validation/i)
    await h.run(id)
    expect(h.ready(id).ended).toBeUndefined()
    expect(h.result(id).status).toBe('pending')
    h.engine.threadClosed(thread, 'merged', '2026-11-02T01:00:00.000Z')
    expect(h.current(id).ended?.outcome).toBe('merged')
  })

  it.each(['merged', 'closed'] as const)('rejects threadClosed(%s) as a validation bypass', outcome => {
    const h = harness(), id = h.accept(), thread = { source: 'github', id: 'pull-2' }
    h.enable(id); h.engine.bindThread(id, thread, true)
    expect(() => h.engine.threadClosed(thread, outcome, '2026-11-02T01:00:00.000Z')).not.toThrow()
    expect(h.current(id).ended).toBeUndefined()
    expect(h.current(id).follows?.[0]?.closed).toEqual({ outcome, at: '2026-11-02T01:00:00.000Z' })
    expect(h.current(id).validation?.blocked).toMatch(/validation/i)
    expect(() => h.result(id)).toThrow()
  })

  it('rejects a dropped report that would adopt a previously deferred close outcome', () => {
    const h = harness(), id = h.accept(), thread = { source: 'github', id: 'pull-3' }
    h.enable(id); h.engine.bindThread(id, thread, true)
    // A close older than this assignment is deferred while work remains unfinished.
    h.engine.threadClosed(thread, 'closed', '2026-11-01T23:00:00.000Z')
    expect(h.current(id).ended).toBeUndefined()
    expect(() => h.engine.report(id, { state: 'dropped', summary: 'Use the close instead' })).toThrow(/validation/i)
    expect(h.current(id).ended).toBeUndefined()
  })

  it('preserves a shared close in SQLite while strict work is blocked and legacy work ends', () => {
    const database = join(workspace(), 'shared.sqlite'), store = openStore(database)
    const h = harness(store), strict = h.accept('strict'), legacy = h.accept('legacy')
    const thread = { source: 'github', id: 'shared-pull' }
    h.engine.configureValidation(strict)
    h.engine.bindThread(strict, thread, true); h.engine.bindThread(legacy, thread, true)
    h.engine.threadClosed(thread, 'merged', '2026-11-02T01:00:00.000Z')
    expect(h.current(strict).ended).toBeUndefined()
    expect(h.current(strict).validation?.blocked).toMatch(/validation/i)
    expect(h.current(legacy).ended?.outcome).toBe('merged')
    closeStore(store)
    const restored = harness(openStore(database), h.directory)
    for (const id of [strict, legacy]) expect(restored.current(id).follows?.[0]?.closed).toEqual({ outcome: 'merged', at: '2026-11-02T01:00:00.000Z' })
    expect(restored.current(strict).validation?.blocked).toMatch(/validation/i)
    expect(restored.current(strict).ended).toBeUndefined()
    expect(restored.current(legacy).ended?.outcome).toBe('merged')
    expect(() => restored.ready(strict)).toThrow(/validation/i)
  })

  it('uses the current assignment with the same executor run-tests tool after retry', async () => {
    const h = harness(), id = h.accept()
    h.enable(id)
    const initial = h.current(id), runTicketTests = vi.spyOn(h.engine, 'runTicketTests')
    // Only the fields read by executorTools construction and the run-tests handler are needed.
    const host = { engine: h.engine, store: h.repo, github: { deployment: { github: { login: 'fixture-bot' } } } } as unknown as ExecutorToolsHost
    const tools = executorTools(host, initial)
    const tool = tools.find(item => item.name === 'orchestrator_run_tests')!
    expect(tool.schema.safeParse({ executable: 'arbitrary', evidence: { passed: true } }).success).toBe(false)
    expect(tools.find(item => item.name === 'orchestrator_report')!.schema.safeParse({ state: 'ready', summary: 'OK', testsRun: 99 }).success).toBe(false)
    const signal = new AbortController().signal
    await tool.execute(tool.schema.parse({}), signal)
    const first = h.current(id).assignments.at(-1)!.id
    expect(runTicketTests).toHaveBeenLastCalledWith(id, first, signal)
    h.engine.report(id, { state: 'failed', summary: 'Retry' }); h.engine.retryTicket(id)
    const next = h.current(id).assignments.at(-1)!.id
    h.engine.assignmentStarted(id, next)
    await tool.execute(tool.schema.parse({}), signal)
    expect(runTicketTests).toHaveBeenLastCalledWith(id, next, signal)
    expect(h.current(id).validation?.evidence?.binding.assignmentId).toBe(next)
    expect(h.ready(id).ended?.outcome).toBe('completed')
  })

  it('does not retain successful evidence when a host run is cancelled', async () => {
    const h = harness(), id = h.accept()
    h.enable(id); await h.run(id)
    const controller = new AbortController()
    const pending = h.engine.runTicketTests(id, h.current(id).assignments.at(-1)!.id, controller.signal)
    expect(h.current(id).validation?.running).toEqual(expect.any(String))
    expect(h.current(id).validation?.evidence).toBeUndefined()
    controller.abort(new Error('fixture cancellation'))
    await expect(pending).rejects.toThrow(/cancel|abort/i)
    expect(h.current(id).validation?.evidence).toBeUndefined()
    expect(h.current(id).validation?.running).toBeUndefined()
    expect(() => h.ready(id)).toThrow(/validation/i)
  })

  it('refuses replacing the contract while a run is in flight, and a stopped run leaves no process or evidence', async () => {
    const h = harness(), id = h.accept()
    h.enable(id)
    // CQTest validation only reads the report, so it settles within the same task queue turn. Start it and
    // read every guarantee the old slow-process version asserted: a run in progress is marked, the
    // contract cannot be replaced under it, and a stop leaves neither a marker nor evidence.
    const pending = h.run(id)
    expect(h.current(id).validation?.running).toEqual(expect.any(String))
    expect(() => h.engine.configureValidation(id, h.contract)).toThrow(/in progress/i)
    expect(h.current(id).validation?.contract?.revision).toBeDefined()
    h.engine.stopTicket(id, 'Cancelled')
    await expect(pending).rejects.toThrow(/cancel|abort/i)
    expect(h.current(id).validation?.running).toBeUndefined()
    expect(h.current(id).validation?.evidence).toBeUndefined()
    expect(h.current(id).ended?.outcome).toBe('stopped')
    // The stopped ticket cannot start another run.
    await expect(h.run(id)).rejects.toThrow(/open ticket/i)
  }, 20_000)

  it('allows ordinary strict dropped cleanup but refuses an unvalidated result publication', () => {
    const h = harness(), id = h.accept()
    h.engine.configureValidation(id)
    expect(h.engine.report(id, { state: 'dropped', summary: 'Nothing to do' }).ended?.outcome).toBe('dropped')
    expect(() => h.result(id)).toThrow(/validation/i)
    expect(h.outbox).toEqual([])
  })

  it('allows a person to stop strict work without tests but does not publish a result', () => {
    const h = harness(), id = h.accept()
    h.engine.configureValidation(id)
    expect(h.engine.stopTicket(id, 'Cancelled').ended?.outcome).toBe('stopped')
    expect(() => h.result(id)).toThrow()
    expect(h.outbox).toEqual([])
  })

  it('rechecks evidence at result publication after a valid ready report on an open follow', async () => {
    const h = harness(), id = h.accept()
    h.enable(id); h.engine.bindThread(id, { source: 'github', id: 'pull-4' }, true)
    await h.run(id); h.ready(id)
    writeFileSync(join(h.directory, 'source.ts'), 'export const answer = () => -1\n')
    expect(() => h.result(id)).toThrow(/validation|fingerprint|changed/i)
    expect(h.outbox).toEqual([])
  })
})
