import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertValidationEvidence, createValidationContract, fingerprintWorkspace, runValidation, validateValidationEvidence,
} from '../src/validation.ts'
import type { ValidationBinding, ValidationContractInput } from '../src/validation.ts'

// Real Python only: a missing interpreter fails this suite rather than reporting a mocked pass.
const executable = execFileSync('python', ['-I', '-S', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const pass = 'import unittest\nclass Example(unittest.TestCase):\n    def test_pass(self):\n        self.assertEqual(2 + 2, 4)\n'
function fixture(source = pass) {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-validation-test-')))
  roots.push(workspace)
  writeFileSync(path.join(workspace, 'test_example.py'), source)
  const input: ValidationContractInput = { adapter: 'python-unittest', executable, workspace, requiredTestIds: ['test_example.Example.test_pass'], revision: 'r1' }
  const contract = createValidationContract(input)
  const binding: ValidationBinding = { ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace, contractRevision: 'r1' }
  return { workspace, input, contract, binding }
}

describe('trusted strict Python unittest validation', () => {
  it('runs real Python, records structured passing cases and survives JSON persistence', async () => {
    const { contract, binding } = fixture()
    const evidence = await runValidation(contract, binding)
    expect(evidence).toMatchObject({ passed: true, completed: true, exitCode: 0, testsRun: 1, failures: 0, errors: 0, skipped: 0, successfulTestIds: ['test_example.Example.test_pass'] })
    expect(evidence.beforeFingerprint).toBe(evidence.afterFingerprint)
    expect(Object.isFrozen(contract)).toBe(true)
    expect(Object.isFrozen(contract.requiredTestIds)).toBe(true)
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(() => assertValidationEvidence(createValidationContract(JSON.parse(JSON.stringify(contract))), binding, JSON.parse(JSON.stringify(evidence)))).not.toThrow()
  })

  it('copies trusted IDs instead of retaining mutable input', () => {
    const { input } = fixture()
    const ids = [...input.requiredTestIds]
    const contract = createValidationContract({ ...input, requiredTestIds: ids })
    ids[0] = 'other.Test.test_fake'
    expect(contract.requiredTestIds).toEqual(['test_example.Example.test_pass'])
  })

  it.each([
    ['zero cases', 'import unittest\n', { testsRun: 0 }],
    ['failure', pass.replace('2 + 2, 4', '2 + 2, 5'), { failures: 1 }],
    ['error', pass.replace('self.assertEqual(2 + 2, 4)', "raise RuntimeError('boom')"), { errors: 1 }],
    ['skip', pass.replace('    def test_pass', "    @unittest.skip('not ready')\n    def test_pass"), { skipped: 1 }],
    ['expected failure', pass.replace('    def test_pass', '    @unittest.expectedFailure\n    def test_pass').replace('2 + 2, 4', '2 + 2, 5'), { testsRun: 1 }],
    ['unexpected success', pass.replace('    def test_pass', '    @unittest.expectedFailure\n    def test_pass'), { testsRun: 1 }],
    ['false success log', "print('Ran 100 tests\\nOK')\n", { testsRun: 0 }],
    ['early process exit', 'import os\nos._exit(0)\n', { completed: false, exitCode: 0 }],
  ])('rejects %s', async (_label, source, counts) => {
    const { contract, binding } = fixture(source)
    const evidence = await runValidation(contract, binding)
    expect(evidence).toMatchObject({ ...counts, passed: false })
    expect(() => assertValidationEvidence(contract, binding, evidence)).toThrow()
  })

  it('rejects missing required IDs despite passing discovered tests', async () => {
    const { input, binding } = fixture()
    const contract = createValidationContract({ ...input, requiredTestIds: ['test_example.Example.test_missing'] })
    const evidence = await runValidation(contract, binding)
    expect(evidence.testsRun).toBe(1)
    expect(evidence.reasons).toContain('Required unittest IDs did not pass')
  })

  it('rejects modification during the child process', async () => {
    const { workspace, contract, binding } = fixture(pass.replace('self.assertEqual(2 + 2, 4)', "__import__('pathlib').Path('source.py').write_text('changed')"))
    writeFileSync(path.join(workspace, 'source.py'), 'before')
    const evidence = await runValidation(contract, binding)
    expect(evidence.testsRun).toBe(1)
    expect(evidence.passed).toBe(false)
    expect(evidence.beforeFingerprint).not.toBe(evidence.afterFingerprint)
  })

  it.each(['source.py', 'test_example.py'])('expires evidence after editing %s', async filename => {
    const { workspace, contract, binding } = fixture()
    const evidence = await runValidation(contract, binding)
    writeFileSync(path.join(workspace, filename), pass + '\n# changed\n')
    expect(validateValidationEvidence(contract, binding, evidence).valid).toBe(false)
  })

  it('fingerprints all source extensions and file names but excludes fixed generated caches/reports', () => {
    const { workspace } = fixture()
    const before = fingerprintWorkspace(workspace)
    for (const name of ['__pycache__', '.pytest_cache']) {
      mkdirSync(path.join(workspace, name))
      writeFileSync(path.join(workspace, name, 'generated'), 'cache')
    }
    expect(fingerprintWorkspace(workspace)).toBe(before)
    writeFileSync(path.join(workspace, 'source.unknown-extension'), 'source')
    expect(fingerprintWorkspace(workspace)).not.toBe(before)
  })

  it('binds ticket, assignment, workspace and revision, including restored contracts', async () => {
    const { contract, binding } = fixture()
    const evidence = await runValidation(contract, binding)
    for (const changed of [
      { ...binding, ticketId: 'other' }, { ...binding, assignmentId: 'other' },
      { ...binding, contractRevision: 'r2' }, { ...binding, workspace: fixture().workspace },
    ]) expect(() => assertValidationEvidence(contract, changed, evidence)).toThrow()
    const newer = createValidationContract({ ...contract, revision: 'r2' })
    expect(() => assertValidationEvidence(newer, { ...binding, contractRevision: 'r2' }, evidence)).toThrow()
  })

  it('rejects unsupported adapters, relative executables/workspaces, arbitrary commands/exclusions and empty IDs', () => {
    const { input } = fixture()
    for (const change of [
      { adapter: 'unsupported' }, { executable: 'python' }, { workspace: '.' }, { requiredTestIds: [] },
      { requiredTestIds: ['test_example.Example.test_pass', 'test_example.Example.test_pass'] },
      { command: 'echo OK' }, { exclusions: ['src'] }, { timeoutMs: 0 }, { revision: '' },
    ]) expect(() => createValidationContract({ ...input, ...change } as ValidationContractInput)).toThrow()
  })

  it('rejects workspace links, ancestor links, executable links and links escaping a tree', () => {
    const { workspace, input } = fixture()
    const outside = fixture().workspace
    const junction = path.join(workspace, 'linked')
    symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => fingerprintWorkspace(workspace)).toThrow(/symlink/)
    expect(() => createValidationContract({ ...input, workspace: junction })).toThrow(/symlink/)
    mkdirSync(path.join(outside, 'nested'))
    expect(() => createValidationContract({ ...input, workspace: path.join(junction, 'nested') })).toThrow(/symlink/)
    expect(() => createValidationContract({ ...input, executable: path.join(junction, 'test_example.py') })).toThrow(/symlink/)
  })

  it('refuses wrong binding before launch and a modified contract digest', async () => {
    const { contract, binding } = fixture()
    await expect(runValidation(contract, { ...binding, contractRevision: 'wrong' })).rejects.toThrow()
    await expect(runValidation({ ...contract, digest: 'forged' }, binding)).rejects.toThrow(/digest/)
  })

  it.each(['htmlcov', '.validation-reports'])('fingerprints imported source within %s', async directory => {
    const source = pass.replace('self.assertEqual(2 + 2, 4)', `import sys\n        sys.path.insert(0, ${JSON.stringify(directory)})\n        import helper\n        self.assertEqual(helper.value, 42)`)
    const { workspace, contract, binding } = fixture(source)
    mkdirSync(path.join(workspace, directory))
    writeFileSync(path.join(workspace, directory, 'helper.py'), 'value = 42\n')
    const evidence = await runValidation(contract, binding)
    expect(evidence.passed).toBe(true)
    writeFileSync(path.join(workspace, directory, 'helper.py'), 'value = 43\n')
    expect(() => assertValidationEvidence(contract, binding, evidence)).toThrow(/stale/)
  })

  it('bounds timeout when a real descendant inherits Python output pipes', async () => {
    const source = pass.replace('self.assertEqual(2 + 2, 4)', `import subprocess, sys\n        child = subprocess.Popen([sys.executable, '-I', '-S', '-c', 'import time; time.sleep(30)'])\n        __import__('pathlib').Path('descendant.pid').write_text(str(child.pid))\n        __import__('pathlib').Path('parent.pid').write_text(str(__import__('os').getpid()))\n        __import__('time').sleep(30)`)
    const { workspace, input, binding } = fixture(source)
    const contract = createValidationContract({ ...input, timeoutMs: 500 })
    const start = Date.now()
    const evidence = await runValidation(contract, binding)
    expect(Date.now() - start).toBeLessThan(12_000)
    expect(evidence.passed).toBe(false)
    expect(evidence.reasons).toContain('Validation timed out')
    for (const filename of ['parent.pid', 'descendant.pid']) {
      const pid = Number(readFileSync(path.join(workspace, filename), 'utf8'))
      const alive = execFileSync(executable, ['-I', '-S', '-c', process.platform === 'win32'
        ? 'import ctypes,sys; k=ctypes.windll.kernel32; k.OpenProcess.restype=ctypes.c_void_p; h=k.OpenProcess(0x1000,False,int(sys.argv[1])); code=ctypes.c_ulong(); ok=h and k.GetExitCodeProcess(ctypes.c_void_p(h),ctypes.byref(code)); print(bool(ok and code.value == 259)); h and k.CloseHandle(ctypes.c_void_p(h))'
        : 'import os,sys;\ntry: os.kill(int(sys.argv[1]),0); print(True)\nexcept ProcessLookupError: print(False)', String(pid)], { encoding: 'utf8' }).trim()
      expect(alive, filename).toBe('False')
    }
  }, 15_000)

  it('rejects a Python executable controlled by the workspace', () => {
    const { workspace, input } = fixture()
    const local = path.join(workspace, 'python.exe')
    writeFileSync(local, 'fake executable')
    expect(() => createValidationContract({ ...input, executable: local })).toThrow(/outside/)
  })

  it('rejects cancellation before launch and during a running real process', async () => {
    const { contract, binding } = fixture(pass.replace('self.assertEqual(2 + 2, 4)', '__import__("time").sleep(2)'))
    const prior = new AbortController()
    prior.abort()
    await expect(runValidation(contract, binding, prior.signal)).rejects.toThrow(/cancelled/)
    const running = new AbortController()
    const promise = runValidation(contract, binding, running.signal)
    running.abort()
    const evidence = await promise
    expect(evidence.passed).toBe(false)
    expect(evidence.reasons).toContain('Validation cancelled')
  }, 15_000)

  it('rejects timeout and malformed host evidence at the completion gate', async () => {
    const { input, binding } = fixture(pass.replace('self.assertEqual(2 + 2, 4)', '__import__("time").sleep(2)'))
    const contract = createValidationContract({ ...input, timeoutMs: 100 })
    const evidence = await runValidation(contract, binding)
    expect(evidence.passed).toBe(false)
    expect(evidence.reasons).toContain('Validation timed out')
    expect(validateValidationEvidence(contract, binding, undefined as never).valid).toBe(false)
  })
})
