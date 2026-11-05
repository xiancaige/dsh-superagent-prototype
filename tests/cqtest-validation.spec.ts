import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CQTEST_REPORT_RELATIVE, parseReportStamp, readCqtestReport, validCqtestId } from '../src/cqtest-validation.ts'
import { createValidationContract, fingerprintWorkspace, runValidation, validateValidationEvidence } from '../src/validation.ts'

/**
 * Real files, real fingerprinting, real adapter code. The only synthetic input is the Unreal report itself, shaped from a
 * real BuildScripts/run-cqtest output (see the sample fields below); Unreal is never launched by the host.
 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, '').replace(/-/g, '.').replace('T', '-').replace(/:/g, '.')
const entry = (name: string, state = 'Success', extra: Record<string, unknown> = {}) =>
  ({ testDisplayName: name.split('.').at(-1), fullTestPath: name, tags: [], state, deviceInstance: ['x'], duration: 0.01, dateTime: '2026.11.04-00.00.00', entries: [], warnings: 0, errors: 0, artifacts: [], ...extra })
function report(tests: ReturnType<typeof entry>[], over: Record<string, unknown> = {}, createdMs = Date.now()) {
  const count = (state: string) => tests.filter(t => t.state === state && !(state === 'Success' && t.warnings > 0)).length
  return { comparisonExportDirectory: '', comparisonExported: false, devices: [], succeeded: count('Success'),
    succeededWithWarnings: tests.filter(t => t.state === 'Success' && t.warnings > 0).length + count('SuccessWithWarnings'),
    failed: count('Fail'), notRun: count('NotRun'), inProcess: count('InProcess'), totalDuration: 1, reportCreatedOn: stamp(createdMs), tests, ...over }
}
const IDS = ['TP.Editor.UiDsl.A', 'TP.Editor.UiDsl.B']
const good = () => report(IDS.map(id => entry(id)))

function project(content: unknown = good(), mtimeMs?: number) {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-cqtest-')))
  roots.push(workspace)
  writeFileSync(path.join(workspace, 'TP.uproject'), '{}')
  mkdirSync(path.join(workspace, 'Source'), { recursive: true })
  writeFileSync(path.join(workspace, 'Source', 'A.cpp'), 'int a;')
  const file = path.join(workspace, ...CQTEST_REPORT_RELATIVE.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return { workspace, file }
}
const validator = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-cqtest-validator-')))
  roots.push(dir)
  const script = path.join(dir, 'validate-cqtest-report.py')
  writeFileSync(script, '# trusted validator stand-in, outside the worktree\n')
  return script
}
function setup(workspace: string, ids = IDS, startedMinutesAgo = 5) {
  const input = { adapter: 'cqtest-report' as const, executable: validator(), workspace, requiredTestIds: ids, revision: 'r1', timeoutMs: 10_000 }
  const contract = createValidationContract(input)
  const binding = { ticketId: 't1', assignmentId: 'a1', workspace, contractRevision: 'r1',
    assignmentStartedAt: new Date(Date.now() - startedMinutesAgo * 60_000).toISOString() }
  return { contract, binding }
}
const run = (workspace: string, ids = IDS, minutes = 5) => { const { contract, binding } = setup(workspace, ids, minutes); return { contract, binding, evidence: runValidation(contract, binding) } }

describe('cqtest-report adapter accepts only a clean, fresh, complete Unreal report', () => {
  it('accepts a good fresh report with every required test Success, and survives JSON persistence', async () => {
    const { workspace } = project()
    const { contract, binding, evidence } = run(workspace)
    const e = await evidence
    expect(e).toMatchObject({ passed: true, completed: true, testsRun: 2, failures: 0, errors: 0, successfulTestIds: [...IDS].sort() })
    expect(e.reportSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(e)).toBe(true)
    expect(validateValidationEvidence(createValidationContract(JSON.parse(JSON.stringify(contract))), binding, JSON.parse(JSON.stringify(e))).valid).toBe(true)
  })

  it.each([
    ['a failed test', report([entry(IDS[0]!), entry(IDS[1]!, 'Fail', { errors: 1 })])],
    ['a NotRun test', report([entry(IDS[0]!), entry(IDS[1]!, 'NotRun')])],
    ['an InProcess test', report([entry(IDS[0]!), entry(IDS[1]!, 'InProcess')])],
    ['an unknown state', report([entry(IDS[0]!), entry(IDS[1]!, 'Weird')])],
    ['an error entry on a passing state', report([entry(IDS[0]!), entry(IDS[1]!, 'Success', { errors: 2 })])],
  ])('rejects %s', async (_name, content) => {
    const { workspace } = project(content)
    const e = await run(workspace).evidence
    expect(e.passed).toBe(false)
    expect(e.reasons.length).toBeGreaterThan(0)
  })

  it('rejects a NON-required test that fails: the whole run must be clean, not just the required ids', async () => {
    // Both required tests pass; an unrelated third test Fails with no error entries. Only the "not clean" rule can catch it.
    for (const state of ['Fail', 'NotRun', 'InProcess']) {
      const { workspace } = project(report([...IDS.map(id => entry(id)), entry('TP.Editor.Other.Z', state)]))
      const e = await run(workspace, IDS).evidence
      expect(e.passed, state).toBe(false)
      expect(e.reasons.join(';'), state).toMatch(/CQTest not clean/)
    }
  })

  it('rejects a required test that is absent even when every listed test passes', async () => {
    const { workspace } = project(report([entry(IDS[0]!)]))
    const e = await run(workspace).evidence
    expect(e.passed).toBe(false)
    expect(e.reasons).toContain('Required CQTest IDs did not pass')
  })

  it('rejects root counts that disagree with the listed tests (a doctored summary)', async () => {
    const { workspace } = project(report(IDS.map(id => entry(id)), { failed: 0, succeeded: 99 }))
    const e = await run(workspace).evidence
    expect(e.passed).toBe(false)
    expect(e.reasons.join(';')).toMatch(/succeeded=99 does not match/)
  })

  it('rejects an empty tests array, malformed JSON, a non-object root and a missing report', async () => {
    for (const content of [report([]), '{not json', '[]', '"x"']) {
      const { workspace } = project(content)
      expect((await run(workspace).evidence).passed).toBe(false)
    }
    const { workspace, file } = project()
    rmSync(file)
    const e = await run(workspace).evidence
    expect(e.passed).toBe(false)
    expect(e.reasons).toContain('CQTest report is missing')
  })

  it('rejects entries without fullTestPath/state and duplicate passing ids', async () => {
    const noPath = { ...entry(IDS[0]!), fullTestPath: '' }
    expect((await run(project(report([noPath, entry(IDS[1]!)])).workspace).evidence).passed).toBe(false)
    const dup = report([entry(IDS[0]!), entry(IDS[0]!), entry(IDS[1]!)])
    expect((await run(project(dup).workspace).evidence).reasons.join(';')).toMatch(/duplicate passing/)
  })
})

describe('freshness: a report left by an earlier run or assignment is never evidence', () => {
  it('rejects a report created before the assignment started (stale reportCreatedOn)', async () => {
    const created = Date.now() - 3_600_000
    const { workspace } = project(report(IDS.map(id => entry(id)), {}, created))
    const e = await run(workspace, IDS, 5).evidence
    expect(e.passed).toBe(false)
    expect(e.reasons.join(';')).toMatch(/predates the current assignment/)
  })

  it('rejects a report whose FILE is old even if its own stamp claims to be recent (a copied/old file)', async () => {
    const { workspace } = project(good(), Date.now() - 3_600_000)
    const e = await run(workspace, IDS, 5).evidence
    expect(e.passed).toBe(false)
    expect(e.reasons.join(';')).toMatch(/file predates/)
  })

  it('rejects an unparseable or missing reportCreatedOn', async () => {
    for (const bad of ['yesterday', '2026-11-04T00:00:00Z', undefined]) {
      const { workspace } = project(report(IDS.map(id => entry(id)), { reportCreatedOn: bad }))
      expect((await run(workspace).evidence).reasons.join(';')).toMatch(/reportCreatedOn/)
    }
  })

  it('rejects when the binding carries no assignment start (cannot prove freshness)', async () => {
    const { workspace } = project()
    const { contract, binding } = setup(workspace)
    const { assignmentStartedAt: _drop, ...without } = binding
    const e = await runValidation(contract, without)
    expect(e.passed).toBe(false)
    expect(e.reasons).toContain('CQTest validation needs the current assignment start time')
  })

  it('a report from the PREVIOUS assignment cannot satisfy a newer assignment', async () => {
    const { workspace } = project(good())
    const first = await run(workspace, IDS, 5).evidence
    expect(first.passed).toBe(true)
    const { contract, binding } = setup(workspace, IDS, 0)
    const later = { ...binding, assignmentStartedAt: new Date(Date.now() + 60_000).toISOString() }
    const e = await runValidation(contract, later)
    expect(e.passed).toBe(false)
    expect(e.reasons.join(';')).toMatch(/predates|stale/)
  })

  it('parses the Unreal UTC stamp exactly and rejects impossible dates', () => {
    expect(parseReportStamp('2026.11.02-07.10.32')).toBe(Date.UTC(2026, 10, 2, 7, 10, 32))
    for (const bad of ['2026.13.02-07.10.32', '2026.02.31-07.10.32', '2026.11.02-7.10.32', '', null, 5]) expect(parseReportStamp(bad as never)).toBeUndefined()
  })
})

describe('evidence is re-checked against the disk it was taken from', () => {
  it('a report replaced after validation invalidates the evidence', async () => {
    const { workspace, file } = project()
    const { contract, binding, evidence } = run(workspace)
    const e = await evidence
    expect(validateValidationEvidence(contract, binding, e).valid).toBe(true)
    writeFileSync(file, JSON.stringify(report(IDS.map(id => entry(id)), { totalDuration: 99 })))
    const after = validateValidationEvidence(contract, binding, e)
    expect(after.valid).toBe(false)
    expect(after.reasons.join(';')).toMatch(/report changed/)
  })

  it('a source change after validation invalidates the evidence (fingerprint)', async () => {
    const { workspace } = project()
    const { contract, binding, evidence } = run(workspace)
    const e = await evidence
    writeFileSync(path.join(workspace, 'Source', 'A.cpp'), 'int a; // edited after the pass')
    expect(validateValidationEvidence(contract, binding, e).reasons.join(';')).toMatch(/stale/)
  })

  it('evidence missing its report hash is not valid for this adapter', async () => {
    const { workspace } = project()
    const { contract, binding, evidence } = run(workspace)
    const { reportSha256: _drop, ...bare } = await evidence
    expect(validateValidationEvidence(contract, binding, bare as never).valid).toBe(false)
  })

  it('the Unreal run output directories do not enter the fingerprint, so a test run does not stale its own evidence', async () => {
    const { workspace } = project()
    const before = fingerprintWorkspace(workspace)
    for (const dir of ['Saved/Logs', 'Intermediate/Build', 'Binaries/Win64']) {
      mkdirSync(path.join(workspace, dir), { recursive: true })
      writeFileSync(path.join(workspace, dir, 'noise.log'), String(Math.random()))
    }
    expect(fingerprintWorkspace(workspace)).toBe(before)
    writeFileSync(path.join(workspace, 'Source', 'B.cpp'), 'int b;')
    expect(fingerprintWorkspace(workspace)).not.toBe(before)
  })

  it('does NOT skip Saved/Intermediate/Binaries for a non-Unreal workspace (no .uproject)', () => {
    const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-plain-')))
    roots.push(plain)
    mkdirSync(path.join(plain, 'Saved'))
    writeFileSync(path.join(plain, 'Saved', 'x.py'), 'a = 1')
    const before = fingerprintWorkspace(plain)
    writeFileSync(path.join(plain, 'Saved', 'x.py'), 'a = 2')
    expect(fingerprintWorkspace(plain)).not.toBe(before)
  })

  it('only the TOP-LEVEL Saved is generated; a nested Saved folder is still source', () => {
    const { workspace } = project()
    mkdirSync(path.join(workspace, 'Source', 'Saved'), { recursive: true })
    writeFileSync(path.join(workspace, 'Source', 'Saved', 'real.cpp'), 'int x;')
    const before = fingerprintWorkspace(workspace)
    writeFileSync(path.join(workspace, 'Source', 'Saved', 'real.cpp'), 'int y;')
    expect(fingerprintWorkspace(workspace)).not.toBe(before)
  })
})

describe('contract and path hardening', () => {
  it('requires CQTest-shaped ids and rejects python/node-shaped or malformed ones', () => {
    for (const id of ['TP.Editor.UiDsl.A', 'TP.Bag']) expect(validCqtestId(id)).toBe(true)
    for (const id of ['', 'test_x.Case.test_y', 'a.test.mjs::["x"]', 'TP', 'TP..X', 'TP.x y', 'Other.Editor.A', 42]) expect(validCqtestId(id as never)).toBe(false)
    const { workspace } = project()
    expect(() => createValidationContract({ adapter: 'cqtest-report', executable: validator(), workspace, requiredTestIds: ['test_x.Case.test_y'], revision: 'r' })).toThrow(/required/i)
  })

  it('rejects a trusted validator that lives inside the worktree', () => {
    const { workspace } = project()
    const inside = path.join(workspace, 'validate.py')
    writeFileSync(inside, 'x')
    expect(() => createValidationContract({ adapter: 'cqtest-report', executable: inside, workspace, requiredTestIds: IDS, revision: 'r' })).toThrow(/outside/)
  })

  it('rejects a report path that crosses a link', () => {
    const { workspace } = project()
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-cqtest-outside-')))
    roots.push(outside)
    writeFileSync(path.join(outside, 'index.json'), JSON.stringify(good()))
    rmSync(path.join(workspace, 'Saved'), { recursive: true, force: true })
    try { symlinkSync(outside, path.join(workspace, 'Saved'), 'junction') } catch { return }
    expect(readCqtestReport(workspace, Date.now() - 60_000).reasons.join(';')).toMatch(/link|missing/i)
  })

  it('never spawns anything: validation of a report needs no executable to run', async () => {
    const { workspace } = project()
    const e = await run(workspace).evidence
    expect(e.passed).toBe(true)
    expect(e.exitCode).toBe(0)
  })
})
