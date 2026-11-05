/** Phase 2 D: real Engine acceptance, a real file-backed environment broker, and local-only targets.
 * Passing evidence is produced solely by configureValidation + runTicketTests (Python stdlib unittest).
 * Repository tampering appears only in explicitly negative binding tests. No remote delivery is performed.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SimulatedDelivery } from '../src/app/simulated-delivery.ts'
import { environmentPort } from '../src/app/ticketed-environment.ts'
import { HostVisualCapture } from '../src/app/visual-capture.ts'
import { VISUAL_EVIDENCE_DIR } from '../src/visual.ts'
import { Engine, MemoryRepositories, type Candidate, type EngineOptions, type Policy, type Repositories, type Ticket } from '../src/core/index.ts'
import type { DeliveryAttempt, DeliveryLevel, DeliveryResult } from '../src/core/delivery.ts'
import { ticketed } from './fixtures/environment.ts'

const executable = execFileSync('python', ['-I', '-S', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
const here = dirname(fileURLToPath(import.meta.url))
const roots: string[] = []
const stores = new Set<Store>()
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function directory(prefix = 'state') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `dsh-p2d-${prefix}-`)))
  roots.push(root)
  return root
}
function workspace() {
  const root = directory('workspace')
  writeFileSync(join(root, 'answer.py'), 'def answer():\n    return 42\n')
  writeFileSync(join(root, 'test_delivery.py'), 'import unittest\nfrom answer import answer\nclass Delivery(unittest.TestCase):\n    def test_answer(self):\n        self.assertEqual(answer(), 42)\n')
  return root
}
function openStore(file: string) { const store = new Store(file); stores.add(store); return store }
function closeStore(store: Store) { store.close(); stores.delete(store) }
function localTarget() {
  const execute = vi.fn(async (attempt: Readonly<DeliveryAttempt>) => ({ receipt: `local:${attempt.operationKey}`, detail: 'local simulated target only' }))
  // Version is host-owned, not a request parameter. It may change independently of workspace bytes (e.g. Git HEAD).
  const version = vi.fn((_workspace: string) => 'host-version-1')
  return { id: 'local-simulated-delivery', execute, version }
}
type Target = NonNullable<EngineOptions['deliveryTarget']>
function harness(input: { repo?: Repositories; directory?: string; state?: string; target?: Target | null; environment?: boolean } = {}) {
  const repo = input.repo ?? new MemoryRepositories()
  const root = input.directory ?? workspace()
  const state = input.state ?? directory()
  const environment = ticketed(state)
  const requests: Candidate[] = []
  const target = input.target === undefined ? localTarget() : input.target
  let clock = Date.now()
  const policy: Policy = { version: 'delivery-policy', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true, admitsInferred: () => true }
  const visual = new HostVisualCapture({
    settings: () => ({ transport: 'stdio', command: process.execPath, args: [join(here, 'fixtures', 'capture-server.mjs')] }),
    statePath: () => join(state, 'capture-state'),
  })
  const engine = new Engine({ repo, policy: () => policy,
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: candidate => { requests.push(candidate) }, release: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'delivery-test', directory: root, assignment: 'Test before local delivery' } }),
    ...(target ? { deliveryTarget: target } : {}),
    ...(input.environment === false ? {} : { environments: environmentPort(environment.tickets) }),
    visualCapture: visual,
    acceptance: () => true, // ready still passes the Engine's strict evidence check; never grants delivery.
    now: () => new Date(clock).toISOString(),
  })
  const current = (id: string) => repo.tickets.get(id)!
  const assignment = (id: string) => current(id).assignments.at(-1)!.id
  function accept(triggerId = 'delivery-request') {
    engine.receive({ id: triggerId, source: 'chat', threads: [{ source: 'chat', id: triggerId }], actor: { source: 'chat', id: 'operator' },
      human: true, at: new Date(clock).toISOString(), text: 'Implement locally', meta: {} })
    engine.evaluateDue()
    const decision = engine.decide(triggerId, { kind: 'accept', evalId: requests.at(-1)!.evalId, title: 'Local delivery', scope: 'fixture', reason: 'requested' })
    const id = decision.ticketId!
    engine.assignmentStarted(id, assignment(id))
    return id
  }
  const contract = { adapter: 'python-unittest' as const, executable, workspace: root,
    requiredTestIds: ['test_delivery.Delivery.test_answer'], timeoutMs: 10_000 }
  async function strict(id: string) {
    engine.configureValidation(id, contract)
    return run(id)
  }
  async function run(id: string) {
    const evidence = await engine.runTicketTests(id, assignment(id))
    expect(evidence).toMatchObject({ passed: true, completed: true, exitCode: 0, testsRun: 1, failures: 0, errors: 0, skipped: 0,
      successfulTestIds: ['test_delivery.Delivery.test_answer'], binding: { ticketId: id, assignmentId: assignment(id), workspace: root } })
    return evidence
  }
  const grant = (id: string, level: DeliveryLevel) => engine.configureDelivery(id, level, true, 'operator-alice')
  const deliver = (id: string, level: DeliveryLevel, requestId = `${level}-request`) => engine.deliverTicket(id, assignment(id), level, requestId)
  function tamper(id: string, change: (ticket: Ticket) => void) {
    const ticket: Ticket = JSON.parse(JSON.stringify(current(id)))
    change(ticket); repo.tickets.save(ticket)
  }
  function retry(id: string) {
    engine.report(id, { state: 'failed', summary: 'Rework requested' }); engine.retryTicket(id)
    engine.assignmentStarted(id, assignment(id))
  }
  function configureVisual(id: string) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'NODE_OPTIONS' && value !== undefined))
    engine.configureVisual(id, { scenario: 'delivery', capture: { server: 'tpmcp', tool: 'capture_screenshot', arguments: { path: '{{path}}', scenario: 'default' } },
      inspector: { executable, args: [join(here, '..', 'scripts', 'visual_inspector.py'), '--', JSON.stringify(env)] }, checks: ['nonblank', 'readable'], minimumFrames: 1 })
  }
  return { repo, root, state, target, environment, engine, current, assignment, accept, contract, strict, run, grant, deliver, tamper, retry, configureVisual,
    advance: (milliseconds: number) => { clock += milliseconds } }
}
function delivered(result: DeliveryResult) {
  expect(result).not.toHaveProperty('refused')
  if ('refused' in result) throw new Error(result.reasons.join('; '))
  expect(result.attempt.state).toBe('delivered')
  return result
}
function refused(result: DeliveryResult, reason: RegExp) {
  expect(result).toMatchObject({ refused: true })
  if (!('refused' in result)) throw new Error('Expected refusal before target execution')
  expect(result.reasons.join('; ')).toMatch(reason)
}

describe('phase 2 D independent, version-bound delivery authorization', () => {
  it.each(['push', 'release'] as const)('refuses and audits unauthorized %s even with real passing tests', async level => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id)
    refused(await h.deliver(id, level), /grant|authoriz/i)
    refused(await h.deliver(id, level), /grant|authoriz/i)
    expect(h.engine.deliveryState(id).refusals).toHaveLength(1)
    expect(h.engine.deliveryState(id).refusals?.[0]).toMatchObject({ assignmentId: h.assignment(id), level, requestId: `${level}-request` })
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('has no default target and cannot grant or dispatch into an implicit channel', async () => {
    const h = harness({ target: null }), id = h.accept()
    await h.strict(id)
    expect(() => h.grant(id, 'push')).toThrow(/target/i)
    refused(await h.deliver(id, 'push'), /target/i)
    expect(h.engine.deliveryState(id).attempts ?? []).toHaveLength(0)
  })

  it('permits separately granted commit without strict tests; it grants neither push nor release', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    h.grant(id, 'commit')
    delivered(await h.deliver(id, 'commit'))
    expect(h.current(id).validation).toBeUndefined()
    for (const level of ['push', 'release'] as const) refused(await h.deliver(id, level), /grant|authoriz/i)
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it('keeps push/release grants independent and revocation effective', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push')
    refused(await h.deliver(id, 'release'), /grant|authoriz/i)
    h.engine.configureDelivery(id, 'push', false, 'operator-alice')
    refused(await h.deliver(id, 'push'), /grant|authoriz/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['push', 'release'] as const)('delivers %s before ready under the real broker exactly once across request ids', async level => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, level)
    const grant = h.engine.deliveryState(id).grants?.[level]
    expect(grant).toMatchObject({ ticketId: id, assignmentId: h.assignment(id), workspace: h.root, level, target: target.id,
      by: 'operator-alice', version: 'host-version-1', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(Date.parse(grant!.expiresAt) - Date.parse(grant!.at)).toBe(3_600_000)
    expect(h.environment.tickets.holds(id)).toBe(true)
    const first = delivered(await h.deliver(id, level))
    expect(first.repeated).toBe(false)
    expect(first.attempt).toMatchObject({ ticketId: id, assignmentId: h.assignment(id), workspace: h.root, target: target.id, level, version: 'host-version-1' })
    expect(h.current(id).ended).toBeUndefined()
    expect(h.current(id).assignments.at(-1)?.report).toBeUndefined()
    for (const request of [`${level}-request`, 'another-request']) {
      const repeat = delivered(await h.deliver(id, level, request))
      expect(repeat.repeated).toBe(true); expect(repeat.attempt.operationKey).toBe(first.attempt.operationKey)
    }
    expect(target.version).toHaveBeenCalledWith(h.root)
    expect(target.execute).toHaveBeenCalledTimes(1)
    expect(h.environment.tickets.holds(id)).toBe(true)
  })

  it('ready never produces delivery grants', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id)
    h.engine.report(id, { state: 'ready', summary: 'Development complete, not publishing' })
    expect(h.current(id).ended?.outcome).toBe('completed')
    expect(h.engine.deliveryState(id).grants ?? {}).toEqual({})
    for (const level of ['commit', 'push', 'release'] as const) refused(await h.deliver(id, level), /grant|authoriz/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['no strict', 'no evidence', 'visual requirement without evidence'] as const)('refuses %s despite a grant', async kind => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    if (kind === 'no evidence') h.engine.configureValidation(id, h.contract)
    if (kind === 'visual requirement without evidence') { await h.strict(id); h.configureVisual(id) }
    h.grant(id, 'push')
    refused(await h.deliver(id, 'push'), /strict|acceptance|evidence|validation|visual/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['push', 'release'] as const)('refuses %s without an environment port, even with valid evidence and grant', async level => {
    const target = localTarget(), h = harness({ target, environment: false }), id = h.accept()
    await h.strict(id); h.grant(id, level)
    refused(await h.deliver(id, level), /environment|exclusiv/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['contents', 'contract', 'evidence', 'host version'] as const)('invalidates a previous grant when %s changes, even after valid tests', async kind => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push')
    if (kind === 'contents') { writeFileSync(join(h.root, 'answer.py'), 'def answer():\n    return 42\n# changed after authorization\n'); await h.run(id) }
    if (kind === 'contract') await h.strict(id)
    if (kind === 'evidence') { await new Promise(resolve => setTimeout(resolve, 5)); await h.run(id) }
    if (kind === 'host version') target.version.mockReturnValue('host-version-2')
    refused(await h.deliver(id, 'push'), /grant|bind|changed|version|digest/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['push', 'release'] as const)('rejects evidence bound to the previous assignment even after a fresh %s grant', async level => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id)
    const old = h.assignment(id)
    h.tamper(id, ticket => { ticket.assignments.at(-1)!.id = 'negative-evidence-assignment-change' })
    expect(h.assignment(id)).not.toBe(old)
    h.grant(id, level)
    refused(await h.deliver(id, level), /acceptance|evidence|binding|assignment/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('rejects stale files without rerunning tests', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'release')
    writeFileSync(join(h.root, 'answer.py'), 'def answer():\n    return -1\n')
    refused(await h.deliver(id, 'release'), /stale|changed|fingerprint|acceptance|grant/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('expires a grant at the default one-hour boundary', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push')
    h.advance(60 * 60 * 1000 + 1)
    refused(await h.deliver(id, 'push'), /expir/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['push', 'release'] as const)('expires old real unittest evidence even with a freshly issued %s grant', async level => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id)
    h.advance(60 * 60 * 1000 + 60_000)
    h.grant(id, level)
    refused(await h.deliver(id, level), /evidence.*expir|expir.*evidence|acceptance.*expir/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('refuses negative-tampered evidence timestamp in the future despite a fresh grant', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id)
    h.tamper(id, ticket => { ticket.validation!.evidence = { ...ticket.validation!.evidence!, finishedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() } })
    h.grant(id, 'push')
    refused(await h.deliver(id, 'push'), /future|timestamp|time|evidence/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('binds grants to the assignment, even if negative tampering rebinds otherwise valid evidence', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push')
    const old = h.assignment(id)
    h.tamper(id, ticket => {
      ticket.assignments.at(-1)!.id = 'tampered-replacement-assignment'
      const evidence = ticket.validation!.evidence!
      ticket.validation!.evidence = { ...evidence, binding: { ...evidence.binding, assignmentId: 'tampered-replacement-assignment' } }
    })
    refused(await h.engine.deliverTicket(id, old, 'push', 'old-assignment'), /assignment|bind/i)
    refused(await h.deliver(id, 'push', 'new-assignment'), /assignment|bind|grant/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it.each(['push', 'release'] as const)('deduplicates delivered %s across a real retry/new assignment and renewed authorization', async level => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, level)
    const first = delivered(await h.deliver(id, level)), old = h.assignment(id)
    h.retry(id); expect(h.assignment(id)).not.toBe(old)
    await h.run(id); h.grant(id, level)
    const repeated = delivered(await h.deliver(id, level, 'new-assignment-request'))
    expect(repeated.repeated).toBe(true)
    expect(repeated.attempt.operationKey).toBe(first.attempt.operationKey)
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['lost lease', 'human handover'] as const)('refuses after %s until the ticket explicitly reacquires exclusivity', async kind => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    if (kind === 'human handover') {
      // Prepare a genuinely dirty scene BEFORE the tests/grant: handover itself must not change its bytes.
      execFileSync('git', ['init', '-q'], { cwd: h.root })
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: h.root })
      execFileSync('git', ['add', '.'], { cwd: h.root })
      execFileSync('git', ['-c', 'user.name=Delivery Test', '-c', 'user.email=delivery@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: h.root })
      writeFileSync(join(h.root, 'answer.py'), 'def answer():\n    return 42\n# uncommitted scene to preserve\n')
      h.environment.directories.set(id, h.root)
    }
    await h.strict(id); h.grant(id, 'push')
    if (kind === 'lost lease') h.environment.tickets.lease(id)!.release('handover', id)
    else expect(await h.engine.handOverEnvironment(id)).toMatchObject({ handedOver: true, files: 2, export: expect.stringMatching(/worktree\.bundle$/) })
    expect(h.environment.tickets.holds(id)).toBe(false)
    refused(await h.deliver(id, 'push'), /environment|exclusiv|re-acquire/i)
    expect(target.execute).not.toHaveBeenCalled()
    h.environment.tickets.acquire(id, 'Explicit reacquisition')
    delivered(await h.deliver(id, 'push', 'after-reacquire'))
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it('does not treat a target failure after a possible side effect as safe-to-retry failed', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push')
    target.execute.mockRejectedValueOnce(new Error('connection lost after target accepted operation'))
    const first = await h.deliver(id, 'push')
    expect(first).toMatchObject({ repeated: false, attempt: { state: 'uncertain' } })
    expect(await h.deliver(id, 'push', 'different-request')).toMatchObject({ repeated: true, attempt: { state: 'uncertain' } })
    target.version.mockReturnValue('next-version')
    h.grant(id, 'push')
    refused(await h.deliver(id, 'push', 'next-version-request'), /running|uncertain|unresolved|reconcil/i)
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['push', 'release'] as const)('SQLite reopen + new Engine never repeats delivered %s', async level => {
    const file = join(directory('database'), 'delivery.sqlite'), store = openStore(file)
    const target = localTarget(), h = harness({ repo: store, target }), id = h.accept()
    await h.strict(id); h.grant(id, level)
    const first = delivered(await h.deliver(id, level))
    closeStore(store)
    const restored = harness({ repo: openStore(file), directory: h.root, state: h.state, target })
    restored.environment.tickets.acquire(id, 'Recovered ticket')
    const repeat = delivered(await restored.deliver(id, level, 'after-restart'))
    expect(repeat.repeated).toBe(true)
    expect(repeat.attempt.operationKey).toBe(first.attempt.operationKey)
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it('persists repeated request aliases across SQLite reopen and refuses rebinding an alias to another version or level', async () => {
    const file = join(directory('database'), 'request-alias.sqlite'), store = openStore(file)
    const target = localTarget(), h = harness({ repo: store, target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push')
    const first = delivered(await h.deliver(id, 'push', 'r1'))
    const alias = delivered(await h.deliver(id, 'push', 'r2'))
    expect(alias.repeated).toBe(true)
    expect(alias.attempt.operationKey).toBe(first.attempt.operationKey)
    expect(target.execute).toHaveBeenCalledTimes(1)
    closeStore(store)
    const restored = harness({ repo: openStore(file), directory: h.root, state: h.state, target })
    restored.environment.tickets.acquire(id, 'Recovered alias ticket')
    expect(restored.engine.deliveryState(id).requests).toContainEqual({ requestId: 'r2', operationKey: first.attempt.operationKey, assignmentId: restored.assignment(id) })
    restored.grant(id, 'release')
    refused(await restored.deliver(id, 'release', 'r2'), /request id.*bound.*version\/assignment\/level/i)
    target.version.mockReturnValue('host-version-2')
    restored.grant(id, 'push')
    refused(await restored.deliver(id, 'push', 'r2'), /request id.*bound.*version\/assignment\/level/i)
    expect(target.execute).toHaveBeenCalledTimes(1)
    const second = delivered(await restored.deliver(id, 'push', 'r3'))
    expect(second.repeated).toBe(false)
    expect(second.attempt.version).toBe('host-version-2')
    expect(second.attempt.operationKey).not.toBe(first.attempt.operationKey)
    expect(target.execute).toHaveBeenCalledTimes(2)
  })

  it.each(['push', 'release'] as const)('the real SimulatedDelivery writes one durable %s receipt including all sub-effects', async level => {
    const receipts = directory('receipts'), target = new SimulatedDelivery(receipts)
    const execute = vi.spyOn(target, 'execute')
    const h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, level)
    const first = delivered(await h.deliver(id, level))
    expect(first.attempt.receipt).toBe(join(receipts, `${first.attempt.operationKey}.json`))
    expect(JSON.parse(readFileSync(first.attempt.receipt!, 'utf8'))).toEqual({ simulated: true, operationKey: first.attempt.operationKey,
      level, version: first.attempt.version, effects: level === 'push' ? ['simulated-push', 'simulated-pr'] : ['simulated-release'] })
    expect(delivered(await h.deliver(id, level, 'transport-retry')).repeated).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    // Target-level receipt idempotence is independent of the Engine ledger and survives constructing a new target.
    const reopened = new SimulatedDelivery(receipts)
    expect(await reopened.execute(first.attempt)).toMatchObject({ receipt: first.attempt.receipt })
    expect(await reopened.execute(first.attempt)).toMatchObject({ receipt: first.attempt.receipt })
    expect(readdirSync(receipts)).toEqual([`${first.attempt.operationKey}.json`])
  })

  it('persists running before dispatch, blocks concurrent calls and cannot repeat a completed side effect whose receipt was never recorded', async () => {
    const file = join(directory('database'), 'pending.sqlite'), store = openStore(file)
    let sideEffects = 0
    const target = { ...localTarget(), execute: vi.fn((_attempt: Readonly<DeliveryAttempt>) => {
      sideEffects++ // Simulate durable remote acceptance followed by a lost response / host crash.
      return new Promise<{ receipt: string }>(() => {})
    }) }
    const h = harness({ repo: store, target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push')
    void h.deliver(id, 'push', 'interrupted-request') // Intentionally never settles: models the crashed host, not an automatic retry.
    expect(sideEffects).toBe(1)
    expect(h.engine.deliveryState(id).attempts).toMatchObject([{ state: 'running' }])
    expect(await h.deliver(id, 'push', 'concurrent-request')).toMatchObject({ repeated: true, attempt: { state: 'running' } })
    closeStore(store)
    const restored = harness({ repo: openStore(file), directory: h.root, state: h.state, target })
    restored.environment.tickets.acquire(id, 'Recovered interrupted ticket')
    expect(await restored.deliver(id, 'push', 'post-crash-request')).toMatchObject({ repeated: true, attempt: { state: 'running' } })
    target.version.mockReturnValue('new-version-while-old-is-running')
    restored.grant(id, 'push')
    refused(await restored.deliver(id, 'push', 'new-version-after-crash'), /running|uncertain|unresolved|reconcil/i)
    expect(sideEffects).toBe(1)
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it('delivers with real unittest plus visual evidence and rechecks visual files rather than trusting the saved verdict', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    h.engine.configureValidation(id, h.contract); h.configureVisual(id)
    h.engine.prepareVisualCapture(id)
    expect(await h.engine.captureVisual(id, h.assignment(id), 'combined', 1)).toMatchObject({ status: 'captured', frames: 1 })
    expect(await h.engine.readVisual(id, h.assignment(id))).toMatchObject({ passed: true, groups: 1 })
    // Capture writes real files: run unit tests over the final workspace, not the pre-capture version.
    await h.run(id); h.grant(id, 'push')
    delivered(await h.deliver(id, 'push'))
    const visualEvidence = h.current(id).validation!.visual!.evidence!
    expect(visualEvidence.groups?.[0]?.frames).toHaveLength(1)
    const frame = visualEvidence.groups![0]!.frames![0]!
    writeFileSync(join(h.root, VISUAL_EVIDENCE_DIR, frame.path), 'not a PNG any more')
    await h.run(id); h.grant(id, 'release')
    refused(await h.deliver(id, 'release'), /visual|frame|acceptance|fingerprint/i)
    expect(target.execute).toHaveBeenCalledTimes(1)
  }, 90_000)

  it('requires unittest evidence even when real visual-only acceptance passed', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    h.engine.configureValidation(id); h.configureVisual(id)
    h.engine.prepareVisualCapture(id)
    expect(await h.engine.captureVisual(id, h.assignment(id), 'visual-only', 1)).toMatchObject({ status: 'captured', frames: 1 })
    expect(await h.engine.readVisual(id, h.assignment(id))).toMatchObject({ passed: true, groups: 1 })
    h.grant(id, 'push')
    refused(await h.deliver(id, 'push'), /unittest|strict|contract|evidence/i)
    expect(target.execute).not.toHaveBeenCalled()
  }, 90_000)
})
