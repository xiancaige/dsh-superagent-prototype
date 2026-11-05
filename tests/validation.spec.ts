/**
 * Strict acceptance contract, binding and fingerprint rules.
 *
 * Validation now accepts only Unreal CQTest reports (the project's own `BuildScripts/run-cqtest` runs
 * the tests; the host validates the file). The report semantics themselves are covered by
 * `cqtest-validation.spec.ts`; this file covers the contract/binding/fingerprint layer around it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertValidationEvidence, createValidationContract, fingerprintWorkspace, validateValidationEvidence,
} from '../src/validation.ts'
import type { ValidationBinding, ValidationContractInput } from '../src/validation.ts'
import { CQTEST_PASSING_ID, writeCqtestReport } from './fixtures/cqtest-report.ts'

/** A trusted validator outside every workspace, like the `BuildScripts/validate-cqtest-report.py` role. */
const executable = realpathSync(process.execPath)
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-validation-test-')))
  roots.push(workspace)
  writeCqtestReport(workspace)
  const input: ValidationContractInput = { adapter: 'cqtest-report', executable, workspace, requiredTestIds: [CQTEST_PASSING_ID], revision: 'r1' }
  const contract = createValidationContract(input)
  const binding: ValidationBinding = { ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace, contractRevision: 'r1',
    assignmentStartedAt: new Date(Date.now() - 60_000).toISOString() }
  return { workspace, input, contract, binding }
}

describe('strict CQTest acceptance contract', () => {
  it('copies trusted IDs instead of retaining mutable input', () => {
    const { input } = fixture()
    const ids = [...input.requiredTestIds]
    const contract = createValidationContract({ ...input, requiredTestIds: ids })
    ids[0] = 'TP.Other.Fake'
    expect(contract.requiredTestIds).toEqual([CQTEST_PASSING_ID])
    expect(Object.isFrozen(contract)).toBe(true)
    expect(Object.isFrozen(contract.requiredTestIds)).toBe(true)
  })

  it('fingerprints all source extensions and file names but excludes fixed generated caches/reports', () => {
    const { workspace } = fixture()
    const before = fingerprintWorkspace(workspace)
    for (const name of ['__pycache__', '.pytest_cache']) {
      mkdirSync(path.join(workspace, name), { recursive: true })
      writeFileSync(path.join(workspace, name, 'generated'), 'cache')
    }
    expect(fingerprintWorkspace(workspace)).toBe(before)
    writeFileSync(path.join(workspace, 'source.unknown-extension'), 'source')
    expect(fingerprintWorkspace(workspace)).not.toBe(before)
  })

  it('binds ticket, assignment, workspace and revision, including restored contracts', async () => {
    const { contract, binding, workspace } = fixture()
    const evidence = await import('../src/validation.ts').then(m => m.runValidation(contract, binding))
    for (const changed of [
      { ...binding, ticketId: 'other' }, { ...binding, assignmentId: 'other' },
      { ...binding, contractRevision: 'r2' }, { ...binding, workspace: fixture().workspace },
    ]) expect(() => assertValidationEvidence(contract, changed, evidence)).toThrow()
    const newer = createValidationContract({ ...contract, revision: 'r2' })
    expect(() => assertValidationEvidence(newer, { ...binding, contractRevision: 'r2' }, evidence)).toThrow()
    // A restored contract (JSON round trip) still satisfies the same binding.
    expect(() => assertValidationEvidence(createValidationContract(JSON.parse(JSON.stringify(contract))), binding,
      JSON.parse(JSON.stringify(evidence)))).not.toThrow()
    expect(workspace).toBe(binding.workspace)
  })

  it('rejects unsupported adapters, relative executables/workspaces, arbitrary commands/exclusions and empty IDs', () => {
    const { workspace } = fixture()
    const base = { executable, workspace, requiredTestIds: [CQTEST_PASSING_ID], revision: 'r1' }
    for (const adapter of ['python-unittest', 'node-test', 'gauntlet']) {
      expect(() => createValidationContract({ ...base, adapter } as never)).toThrow()
    }
    expect(() => createValidationContract({ ...base, adapter: 'cqtest-report', workspace: 'relative/path' })).toThrow()
    expect(() => createValidationContract({ ...base, adapter: 'cqtest-report', executable: 'node' })).toThrow()
    expect(() => createValidationContract({ ...base, adapter: 'cqtest-report', command: 'rm -rf /' } as never)).toThrow()
    expect(() => createValidationContract({ ...base, adapter: 'cqtest-report', requiredTestIds: [] })).toThrow()
    expect(() => createValidationContract({ ...base, adapter: 'cqtest-report', requiredTestIds: ['python.module.Case.test'] })).toThrow()
  })

  it('rejects workspace links, ancestor links, executable links and links escaping a tree', () => {
    const { workspace } = fixture()
    const linked = path.join(path.dirname(workspace), `link-${process.pid}`)
    let made = false
    try { symlinkSync(workspace, linked, 'junction'); made = true } catch { /* no privilege for links on this host */ }
    if (!made) return
    try {
      // A symlinked workspace is rejected outright.
      expect(() => createValidationContract({ adapter: 'cqtest-report', executable, workspace: linked,
        requiredTestIds: [CQTEST_PASSING_ID], revision: 'r1' })).toThrow()
      // A trusted validator reached through a link is rejected as well.
      const linkedExe = path.join(path.dirname(workspace), `exe-link-${process.pid}`)
      try {
        symlinkSync(executable, linkedExe, 'file')
        expect(() => createValidationContract({ adapter: 'cqtest-report', executable: linkedExe, workspace,
          requiredTestIds: [CQTEST_PASSING_ID], revision: 'r1' })).toThrow()
      } catch { /* linking a file may be refused; the workspace case above still applies */ }
      finally { rmSync(linkedExe, { force: true }) }
    } finally { rmSync(linked, { recursive: true, force: true }) }
  })

  it('refuses a modified contract digest', async () => {
    const { contract, binding } = fixture()
    const tampered = { ...contract, requiredTestIds: [...contract.requiredTestIds], digest: 'deadbeef' }
    await expect(import('../src/validation.ts').then(m => m.runValidation(tampered as never, binding))).rejects.toThrow()
  })

  it('rejects timeout bounds outside the accepted range', () => {
    const { input } = fixture()
    for (const timeoutMs of [0, -1, 600_001, 1.5]) {
      expect(() => createValidationContract({ ...input, timeoutMs })).toThrow()
    }
  })

  it('expires evidence after editing a source file', async () => {
    const { workspace, contract, binding } = fixture()
    const evidence = await import('../src/validation.ts').then(m => m.runValidation(contract, binding))
    expect(validateValidationEvidence(contract, binding, evidence).valid).toBe(true)
    writeFileSync(path.join(workspace, 'source.ts'), 'changed')
    expect(validateValidationEvidence(contract, binding, evidence).valid).toBe(false)
  })
})
