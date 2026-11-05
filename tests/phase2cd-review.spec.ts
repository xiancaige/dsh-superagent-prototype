/** Phase 2 C+D review regressions (R1..R7). Every assertion is a behaviour that fails on the pre-fix code:
 *  R1/R2 handover export, R3 editor-recovery cleanup identity, R4 commit-level gates, R5 running->uncertain,
 *  R6 operator reconcile, R7 EnvironmentHeld is not a transient error. Local only: real git, real SQLite, real unittest,
 *  injected processes and a local delivery target. Nothing is pushed or published and no editor is touched.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { environmentPort } from '../src/app/ticketed-environment.ts'
import { EnvironmentExclusivity, EnvironmentHeld, type EnvironmentLeaseRecord } from '../src/app/environment-exclusive.ts'
import { TpEditorRecovery, type EditorProcess, type RecoveryDeps, type TpEditorEnvironment } from '../src/app/editor-recovery.ts'
import { transient } from '../src/executor/dsh.ts'
import { Engine, MemoryRepositories, type Candidate, type EngineOptions, type Policy, type Repositories, type Ticket } from '../src/core/index.ts'
import type { DeliveryAttempt, DeliveryLevel, DeliveryResult } from '../src/core/delivery.ts'
import { ticketed } from './fixtures/environment.ts'
import { gitEnv } from './fixtures/git.ts'

const executable = execFileSync('python', ['-I', '-S', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
const roots: string[] = []
const stores = new Set<Store>()
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
function directory(prefix = 'state') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `dsh-p2cd-review-${prefix}-`)))
  roots.push(root)
  return root
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
  { cwd, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 })

/* ------------------------------------------------------------------ R1 / R2: handover export */

describe('R1/R2 handover export', () => {
  function repo(files: Record<string, string>) {
    const root = directory('repo')
    git(root, 'init', '-q')
    for (const [name, text] of Object.entries(files)) { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), text) }
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base')
    return root
  }

  it('R1 exports a work tree whose only change is untracked files (text and binary), with a verified bundle', async () => {
    const root = repo({ 'kept.txt': 'kept\n' })
    writeFileSync(join(root, 'fresh-one.txt'), 'UNTRACKED-ONE-LINE\n')
    mkdirSync(join(root, 'sub')); writeFileSync(join(root, 'sub', 'fresh-two.md'), '# UNTRACKED-TWO-LINE\n')
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]))
    // Precondition: tracked clean, nothing staged.
    expect(git(root, 'diff', 'HEAD', '--stat')).toBe('')
    expect(git(root, 'diff', '--cached', '--stat')).toBe('')
    const before = git(root, 'status', '--porcelain', '-uall')
    const result = await new EnvironmentExclusivity(directory('state')).export(root, 'ticket-r1')
    expect(result, 'an untracked-only scene must still be exported').toBeDefined()
    expect(result!.files.length).toBeGreaterThanOrEqual(1)
    expect(result!.files.map(file => file.path)).toContain('worktree.patch')
    expect(result!.patch && existsSync(result!.patch)).toBe(true)
    const patch = readFileSync(result!.patch!, 'utf8')
    expect(patch).toContain('+UNTRACKED-ONE-LINE')
    expect(patch).toContain('+# UNTRACKED-TWO-LINE')
    expect(patch).toMatch(/diff --git a\/fresh-one\.txt b\/fresh-one\.txt\r?\nnew file mode/)
    expect(patch).toMatch(/diff --git a\/sub\/fresh-two\.md b\/sub\/fresh-two\.md\r?\nnew file mode/)
    expect(patch).toMatch(/diff --git a\/blob\.bin b\/blob\.bin\r?\nnew file mode/)
    expect(patch).toMatch(/GIT binary patch/)
    // The bundle is written, verifies, and is among the listed files with a digest.
    expect(result!.bundle && existsSync(result!.bundle)).toBe(true)
    expect(result!.files.map(file => file.path)).toContain('worktree.bundle')
    for (const file of result!.files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
    git(root, 'bundle', 'verify', result!.bundle!)
    // The scene is untouched: nothing staged, stashed, cleaned or reset.
    expect(git(root, 'status', '--porcelain', '-uall')).toBe(before)
    expect(git(root, 'stash', 'list')).toBe('')
    expect(readFileSync(join(root, 'fresh-one.txt'), 'utf8')).toBe('UNTRACKED-ONE-LINE\n')
  }, 60_000)

  it('R2 writes every one of 3000 modified tracked files into the patch and leaves the work tree unchanged', async () => {
    const count = 3000
    const name = (index: number) => `many/f${String(index).padStart(4, '0')}.txt`
    const files: Record<string, string> = {}
    for (let index = 0; index < count; index++) files[name(index)] = `original ${index}\n`
    const root = repo(files)
    for (let index = 0; index < count; index++) writeFileSync(join(root, name(index)), `original ${index}\nMODIFIED-${index}\n`)
    const before = git(root, 'status', '--porcelain', '-uall')
    const result = await new EnvironmentExclusivity(directory('state')).export(root, 'ticket-r2')
    expect(result?.patch).toBeTruthy()
    const patch = readFileSync(result!.patch!, 'utf8')
    for (const index of [0, 1, 1499, 1500, 2998, 2999]) {
      expect(patch, `file ${index} must be in the patch`).toContain(`+MODIFIED-${index}\n`)
      expect(patch).toContain(`diff --git a/${name(index)} b/${name(index)}`)
    }
    // Stronger than sampling: every file has exactly one header and its added line.
    expect(patch.match(/^diff --git /gm)?.length).toBe(count)
    expect(patch.match(/^\+MODIFIED-\d+$/gm)?.length).toBe(count)
    expect(git(root, 'status', '--porcelain', '-uall')).toBe(before)
    expect(git(root, 'stash', 'list')).toBe('')
    git(root, 'bundle', 'verify', result!.bundle!)
  }, 120_000)
})

/* ------------------------------------------------------------------ R3: editor recovery cleanup identity */

describe('R3 editor-recovery cleanup proves the process is the one it started', () => {
  const PROJECT = 'F:\\TP\\TP.uproject'
  const environment: TpEditorEnvironment = { projectFile: PROJECT, editorExe: 'F:\\UE\\UnrealEditor.exe', port: 55255, captureTool: 'capture_screenshot' }
  const PID = 4321
  const STARTED = '2026-11-03T06:00:00.000Z'
  const editor = (patch: Partial<EditorProcess> = {}): EditorProcess => ({ pid: PID, name: 'UnrealEditor.exe', executablePath: 'F:\\UE\\UnrealEditor.exe',
    commandLine: `"F:\\UE\\UnrealEditor.exe" "${PROJECT}" -log`, startedAt: STARTED, ...patch })
  function recovery(input: { list: () => Promise<EditorProcess[]>; recordedStart?: string | undefined; recordedPid?: number | string | undefined; withKill?: boolean }) {
    const stopProcess = vi.fn(async (_pid: number, _signal: AbortSignal) => {})
    const killEditor = vi.fn(async () => {})
    const deps: RecoveryDeps = { processList: input.list, stopProcess, recordedPid: () => 'recordedPid' in input ? input.recordedPid : PID,
      recordedStart: () => 'recordedStart' in input ? input.recordedStart : STARTED, ...input.withKill ? { killEditor } : {}, platform: 'win32' }
    const instance = new TpEditorRecovery(() => ({ enabled: true, environment }), deps, directory('recovery'))
    return { instance, stopProcess, killEditor }
  }

  it('does not stop a process that reused the PID with another start time (and does not throw)', async () => {
    const { instance, stopProcess, killEditor } = recovery({ list: async () => [editor({ startedAt: '2026-11-03T07:30:00.000Z' })] })
    await expect(instance.cleanup('t1', environment)).resolves.toBeUndefined()
    expect(stopProcess).toHaveBeenCalledTimes(0)
    expect(killEditor).not.toHaveBeenCalled()
  })

  it('stops exactly that pid when the start time is the same, without the project-wide kill script', async () => {
    const { instance, stopProcess, killEditor } = recovery({ list: async () => [editor(), editor({ pid: 9999, startedAt: '2026-01-01T00:00:00.000Z' })] })
    await instance.cleanup('t1', environment)
    expect(stopProcess).toHaveBeenCalledTimes(1)
    expect(stopProcess.mock.calls[0]![0]).toBe(PID)
    expect(killEditor).not.toHaveBeenCalled()
  })

  it('accepts the same instant spelled differently (offset form)', async () => {
    const { instance, stopProcess } = recovery({ list: async () => [editor({ startedAt: '2026-11-03T14:00:00.000+08:00' })] })
    await instance.cleanup('t1', environment)
    expect(stopProcess).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the process is alive but no start time was recorded, and keeps ownership', async () => {
    const { instance, stopProcess } = recovery({ list: async () => [editor()], recordedStart: undefined })
    expect(instance.owns('t1')).toBe(true)
    await expect(instance.cleanup('t1', environment)).rejects.toThrow(/start|record|cannot be proven|by hand/i)
    expect(stopProcess).toHaveBeenCalledTimes(0)
    expect(instance.owns('t1')).toBe(true)
  })

  it('fails closed when the process listing itself fails, and keeps ownership', async () => {
    const { instance, stopProcess } = recovery({ list: async () => { throw new Error('the process listing exited with 1') } })
    await expect(instance.cleanup('t1', environment)).rejects.toThrow(/listing/i)
    expect(stopProcess).toHaveBeenCalledTimes(0)
    expect(instance.owns('t1')).toBe(true)
  })

  it('treats a pid that is no longer listed as already stopped', async () => {
    const { instance, stopProcess } = recovery({ list: async () => [editor({ pid: 1111 })] })
    await expect(instance.cleanup('t1', environment)).resolves.toBeUndefined()
    expect(stopProcess).toHaveBeenCalledTimes(0)
  })

  it('never stops another TP project\'s editor that now has the recorded pid', async () => {
    const other = editor({ commandLine: '"F:\\UE\\UnrealEditor.exe" "F:\\Other\\Other.uproject" -log' })
    const { instance, stopProcess, killEditor } = recovery({ list: async () => [other] })
    await expect(instance.cleanup('t1', environment)).resolves.toBeUndefined()
    expect(stopProcess).toHaveBeenCalledTimes(0)
    expect(killEditor).not.toHaveBeenCalled()
  })

  it('a stop that fails is surfaced and keeps ownership', async () => {
    const { instance, stopProcess } = recovery({ list: async () => [editor()] })
    stopProcess.mockRejectedValueOnce(new Error('exit 3'))
    await expect(instance.cleanup('t1', environment)).rejects.toThrow(/exit 3/)
    expect(instance.owns('t1')).toBe(true)
  })

  it('without any recorded pid there is nothing to own or stop', async () => {
    const { instance, stopProcess } = recovery({ list: async () => [editor()], recordedPid: undefined })
    expect(instance.owns('t1')).toBe(false)
    await instance.cleanup('t1', environment)
    expect(stopProcess).toHaveBeenCalledTimes(0)
  })
})

/* ------------------------------------------------------------------ R4..R6: delivery through the real Engine */

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
  const version = vi.fn((_workspace: string) => 'host-version-1')
  return { id: 'local-simulated-delivery', execute, version }
}
type Target = NonNullable<EngineOptions['deliveryTarget']>
function harness(input: { repo?: Repositories; directory?: string; state?: string; target?: Target; environment?: boolean } = {}) {
  const repo = input.repo ?? new MemoryRepositories()
  const root = input.directory ?? workspace()
  const state = input.state ?? directory()
  const environment = ticketed(state)
  const requests: Candidate[] = []
  const target = input.target ?? localTarget()
  let clock = Date.now()
  const policy: Policy = { version: 'delivery-policy', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const engine = new Engine({ repo, policy: () => policy,
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: candidate => { requests.push(candidate) }, release: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'review-test', directory: root, assignment: 'Review regression' } }),
    deliveryTarget: target,
    ...(input.environment === false ? {} : { environments: environmentPort(environment.tickets) }),
    acceptance: () => true,
    now: () => new Date(clock).toISOString(),
  })
  const current = (id: string) => repo.tickets.get(id)!
  const assignment = (id: string) => current(id).assignments.at(-1)!.id
  function accept(triggerId = 'review-request') {
    engine.receive({ id: triggerId, source: 'chat', threads: [{ source: 'chat', id: triggerId }], actor: { source: 'chat', id: 'operator' },
      human: true, at: new Date(clock).toISOString(), text: 'Implement locally', meta: {} })
    engine.evaluateDue()
    const decision = engine.decide(triggerId, { kind: 'accept', evalId: requests.at(-1)!.evalId, title: 'Review delivery', scope: 'fixture', reason: 'requested' })
    const id = decision.ticketId!
    engine.assignmentStarted(id, assignment(id))
    return id
  }
  const contract = { adapter: 'python-unittest' as const, executable, workspace: root, requiredTestIds: ['test_delivery.Delivery.test_answer'], timeoutMs: 10_000 }
  async function run(id: string) {
    const evidence = await engine.runTicketTests(id, assignment(id))
    expect(evidence).toMatchObject({ passed: true, completed: true, testsRun: 1, failures: 0, errors: 0, skipped: 0 })
    return evidence
  }
  async function strict(id: string) { engine.configureValidation(id, contract); return run(id) }
  const grant = (id: string, level: DeliveryLevel) => engine.configureDelivery(id, level, true, 'operator-alice')
  const deliver = (id: string, level: DeliveryLevel, requestId = `${level}-request`) => engine.deliverTicket(id, assignment(id), level, requestId)
  function tamper(id: string, change: (ticket: Ticket) => void) {
    const ticket: Ticket = JSON.parse(JSON.stringify(current(id)))
    change(ticket); repo.tickets.save(ticket)
  }
  return { repo, root, state, target, environment, engine, current, assignment, accept, contract, strict, run, grant, deliver, tamper,
    advance: (milliseconds: number) => { clock += milliseconds } }
}
function delivered(result: DeliveryResult) {
  if ('refused' in result) throw new Error(`expected delivery, refused: ${result.reasons.join('; ')}`)
  expect(result.attempt.state).toBe('delivered')
  return result
}
function refused(result: DeliveryResult, reason: RegExp) {
  if (!('refused' in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
  expect(result.reasons.join('; ')).toMatch(reason)
}

describe('R4 commit-level gates', () => {
  it('refuses a granted commit when the ticket never had the environment port (reason names exclusivity)', async () => {
    const target = localTarget(), h = harness({ target, environment: false }), id = h.accept()
    h.grant(id, 'commit')
    refused(await h.deliver(id, 'commit'), /exclusiv/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('refuses a granted commit after the ticket lost or handed over its lease, until it reacquires', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    h.grant(id, 'commit')
    h.environment.tickets.lease(id)!.release('handover', id)
    expect(h.environment.tickets.holds(id)).toBe(false)
    refused(await h.deliver(id, 'commit'), /exclusiv/i)
    expect(target.execute).not.toHaveBeenCalled()
    h.environment.tickets.acquire(id, 'Explicit reacquisition')
    delivered(await h.deliver(id, 'commit', 'after-reacquire'))
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it('refuses a granted commit when strict acceptance is enabled but has no evidence yet', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    h.engine.configureValidation(id, h.contract)
    h.grant(id, 'commit')
    refused(await h.deliver(id, 'commit'), /strict|acceptance|evidence/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('refuses a granted commit when strict evidence has expired, even with a fresh grant', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id)
    h.advance(60 * 60 * 1000 + 60_000)
    h.grant(id, 'commit')
    refused(await h.deliver(id, 'commit'), /expir/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('refuses a granted commit whose strict evidence carries a future timestamp', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id)
    h.tamper(id, ticket => { ticket.validation!.evidence = { ...ticket.validation!.evidence!, finishedAt: new Date(Date.now() + 3_600_000).toISOString() } })
    h.grant(id, 'commit')
    refused(await h.deliver(id, 'commit'), /future|timestamp|invalid|expir/i)
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('keeps the original behaviour: no strict acceptance, environment held, commit grant -> deliverable', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    expect(h.environment.tickets.holds(id)).toBe(true)
    h.grant(id, 'commit')
    delivered(await h.deliver(id, 'commit'))
    expect(h.current(id).validation).toBeUndefined()
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it('keeps the original behaviour with valid strict evidence too', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'commit')
    delivered(await h.deliver(id, 'commit'))
    expect(target.execute).toHaveBeenCalledTimes(1)
  })
})

/** A pushed attempt the host stopped under: `running` in SQLite, written by one Engine and read by another. */
async function interrupted() {
  const file = join(directory('database'), 'review.sqlite'), store = openStore(file)
  let sideEffects = 0
  const target = { ...localTarget(), execute: vi.fn((_attempt: Readonly<DeliveryAttempt>) => { sideEffects++; return new Promise<{ receipt: string }>(() => {}) }) }
  const h = harness({ repo: store, target }), id = h.accept()
  await h.strict(id); h.grant(id, 'push'); h.grant(id, 'release')
  void h.deliver(id, 'push', 'interrupted-request')
  expect(sideEffects).toBe(1)
  const [running] = h.engine.deliveryState(id).attempts!
  expect(running!.state).toBe('running')
  closeStore(store)
  const restored = harness({ repo: openStore(file), directory: h.root, state: h.state, target })
  restored.environment.tickets.acquire(id, 'Recovered interrupted ticket')
  return { id, restored, target, operationKey: running!.operationKey, sideEffects: () => sideEffects }
}

describe('R5 running -> uncertain on host start', () => {
  it('turns a persisted running attempt into uncertain, once, and blocks every further delivery without executing the target', async () => {
    const { id, restored, target, operationKey, sideEffects } = await interrupted()
    const recover = (restored.engine as any).recoverDeliveries as (() => number) | undefined
    expect(typeof recover, 'Engine.recoverDeliveries must exist').toBe('function')
    expect(recover!.call(restored.engine)).toBe(1)
    expect(restored.engine.deliveryState(id).attempts).toMatchObject([{ operationKey, state: 'uncertain', detail: expect.stringMatching(/reconcile/i) }])
    // Nothing is left running: a second start marks nothing.
    expect(recover!.call(restored.engine)).toBe(0)

    // Same level, same version: the same operation, reported as it is (not delivered, not re-executed).
    const same = await restored.deliver(id, 'push', 'post-recover-same')
    if ('refused' in same) expect(same.reasons.join('; ')).toMatch(/running|uncertain|unresolved|reconcil/i)
    else expect(same).toMatchObject({ repeated: true, attempt: { state: 'uncertain', operationKey } })

    // Same level, new version: refused as unresolved.
    target.version.mockReturnValue('host-version-2')
    restored.grant(id, 'push')
    refused(await restored.deliver(id, 'push', 'post-recover-new-version'), /running|uncertain|unresolved|reconcil/i)

    // Another level: refused as unresolved.
    restored.grant(id, 'release')
    refused(await restored.deliver(id, 'release', 'post-recover-release'), /running|uncertain|unresolved|reconcil/i)

    expect(target.execute).toHaveBeenCalledTimes(1)
    expect(sideEffects()).toBe(1)
  }, 60_000)

  it('without recoverDeliveries the attempt stays running (the host start is what settles it)', async () => {
    const { id, restored } = await interrupted()
    expect(restored.engine.deliveryState(id).attempts).toMatchObject([{ state: 'running' }])
  }, 60_000)

  it('returns 0 and changes nothing when nothing was running', async () => {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push'); delivered(await h.deliver(id, 'push'))
    expect((h.engine as any).recoverDeliveries()).toBe(0)
    expect(h.engine.deliveryState(id).attempts).toMatchObject([{ state: 'delivered' }])
  }, 60_000)
})

describe('R6 operator reconciliation', () => {
  /** A ticket with one `uncertain` push attempt (the target failed after a possible side effect). */
  async function uncertain() {
    const target = localTarget(), h = harness({ target }), id = h.accept()
    await h.strict(id); h.grant(id, 'push')
    target.execute.mockRejectedValueOnce(new Error('connection lost after target accepted operation'))
    const first = await h.deliver(id, 'push', 'r-first')
    expect(first).toMatchObject({ attempt: { state: 'uncertain' } })
    if ('refused' in first) throw new Error('unreachable')
    return { h, id, target, operationKey: first.attempt.operationKey }
  }
  const reconcile = (h: ReturnType<typeof harness>, id: string, key: string, outcome: unknown, by = 'operator') => {
    const fn = (h.engine as any).reconcileDelivery as ((...args: unknown[]) => unknown) | undefined
    if (typeof fn !== 'function') throw new Error('Engine.reconcileDelivery does not exist')
    return fn.call(h.engine, id, key, outcome, by)
  }

  it('delivered: uncertain -> delivered with the named receipt, and the target is not executed again', async () => {
    const { h, id, target, operationKey } = await uncertain()
    reconcile(h, id, operationKey, { result: 'delivered', receipt: 'target-receipt-7' })
    expect(h.engine.deliveryState(id).attempts).toMatchObject([{ operationKey, state: 'delivered', receipt: 'target-receipt-7' }])
    expect(target.execute).toHaveBeenCalledTimes(1)
    const again = delivered(await h.deliver(id, 'push', 'r-after'))
    expect(again.repeated).toBe(true)
    expect(again.attempt.receipt).toBe('target-receipt-7')
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it('discarded: removes the attempt and its request bindings, records the reconciliation', async () => {
    const { h, id, target, operationKey } = await uncertain()
    // A second request id aliased onto the same operation must be dropped too.
    expect(await h.deliver(id, 'push', 'r-alias')).toMatchObject({ repeated: true })
    reconcile(h, id, operationKey, { result: 'discarded', reason: 'target confirmed no commit exists' }, 'operator-bob')
    const state = h.engine.deliveryState(id)
    expect(state.attempts ?? []).toHaveLength(0)
    expect((state.requests ?? []).filter(item => item.operationKey === operationKey)).toHaveLength(0)
    expect(state.reconciled).toEqual([{ operationKey, by: 'operator-bob', at: expect.any(String), reason: 'target confirmed no commit exists' }])
    expect(target.execute).toHaveBeenCalledTimes(1)
  })

  it('discarded: a new delivery needs a new operator grant (the discarded operation\'s grant is not reusable)', async () => {
    const { h, id, target, operationKey } = await uncertain()
    reconcile(h, id, operationKey, { result: 'discarded', reason: 'target confirmed no commit exists' })
    const result = await h.deliver(id, 'push', 'r-retry-without-grant')
    expect(result, 'delivery after a discard must not run on the grant that authorized the discarded attempt').toMatchObject({ refused: true })
    expect(target.execute).toHaveBeenCalledTimes(1)
    h.grant(id, 'push')
    delivered(await h.deliver(id, 'push', 'r-retry-with-grant'))
    expect(target.execute).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['an empty receipt', { result: 'delivered', receipt: '   ' }, /receipt/i],
    ['an empty reason', { result: 'discarded', reason: '' }, /why|reason/i],
  ] as const)('refuses %s and leaves the attempt uncertain', async (_name, outcome, message) => {
    const { h, id, operationKey } = await uncertain()
    expect(() => reconcile(h, id, operationKey, outcome)).toThrow(message)
    expect(h.engine.deliveryState(id).attempts).toMatchObject([{ operationKey, state: 'uncertain' }])
    expect(h.engine.deliveryState(id).reconciled ?? []).toHaveLength(0)
  })

  it('refuses an unknown operation key and an empty operator attribution', async () => {
    const { h, id, operationKey } = await uncertain()
    expect(() => reconcile(h, id, 'no-such-operation', { result: 'delivered', receipt: 'x' })).toThrow(/unknown attempt/i)
    expect(() => reconcile(h, id, operationKey, { result: 'delivered', receipt: 'x' }, '  ')).toThrow(/attribution/i)
    expect(h.engine.deliveryState(id).attempts).toMatchObject([{ operationKey, state: 'uncertain' }])
  })

  it('refuses reconciling an attempt that is already delivered, and does not rewrite its receipt', async () => {
    const { h, id, operationKey } = await uncertain()
    reconcile(h, id, operationKey, { result: 'delivered', receipt: 'first-receipt' })
    expect(() => reconcile(h, id, operationKey, { result: 'delivered', receipt: 'second-receipt' })).toThrow(/already delivered/i)
    expect(() => reconcile(h, id, operationKey, { result: 'discarded', reason: 'too late' })).toThrow(/already delivered/i)
    expect(h.engine.deliveryState(id).attempts).toMatchObject([{ operationKey, state: 'delivered', receipt: 'first-receipt' }])
  })
})

/* ------------------------------------------------------------------ R7: EnvironmentHeld is a decision, not a network blip */

describe('R7 EnvironmentHeld is not transient', () => {
  const record: EnvironmentLeaseRecord = { token: '502-1-x', pid: 502, host: 'host-1', holder: { kind: 'ticket', id: 'other', label: 'Other ticket (other)' },
    resources: [], acquiredAt: '2026-11-03T06:00:00.000Z', heartbeat: '2026-11-03T06:00:01.000Z' }

  it('does not retry an EnvironmentHeld whose message carries "pid 502", while an HTTP 503 still retries', () => {
    const held = new EnvironmentHeld(record)
    expect(held.message).toContain('502')
    expect(transient(held)).toBe(false)
    expect(transient(new Error('HTTP 503'))).toBe(true)
    expect(transient(Object.assign(new Error('bad gateway'), { status: 503 }))).toBe(true)
  })
})
