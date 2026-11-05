import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, readdirSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readCqtestReport, validCqtestId } from './cqtest-validation.ts'

/** Host/admin-only input. Never accept executable, IDs or exclusions from a worker tool. */
export interface ValidationContractInput {
  /** `cqtest-report` never launches Unreal: it validates the report a trusted script wrote (see cqtest-validation.ts). Its `executable` is that trusted validator, bound by digest like the other adapters' interpreters. */
  adapter: 'python-unittest' | 'node-test' | 'cqtest-report'
  executable: string
  workspace: string
  requiredTestIds: readonly string[]
  revision: string
  timeoutMs?: number
}
export interface ValidationContract extends Readonly<ValidationContractInput> {
  readonly requiredTestIds: readonly string[]
  readonly timeoutMs: number
  readonly digest: string
  readonly executableFingerprint: string
}
export interface ValidationBinding {
  readonly ticketId: string
  readonly assignmentId: string
  readonly workspace: string
  readonly contractRevision: string
  /** The current assignment's start; the freshness floor for a `cqtest-report` (a report older than it is reused, not evidence). */
  readonly assignmentStartedAt?: string
}
export interface ValidationEvidence {
  readonly binding: Readonly<ValidationBinding>
  readonly contractDigest: string
  readonly beforeFingerprint: string
  readonly afterFingerprint: string
  readonly exitCode: number | null
  readonly completed: boolean
  readonly testsRun: number
  readonly failures: number
  readonly errors: number
  readonly skipped: number
  readonly successfulTestIds: readonly string[]
  readonly passed: boolean
  readonly reasons: readonly string[]
  readonly startedAt: string
  readonly finishedAt: string
  /** `cqtest-report` only: SHA-256 of the exact report accepted, re-checked whenever the evidence is re-validated. */
  readonly reportSha256?: string
}

const ADAPTERS: readonly string[] = ['python-unittest', 'node-test', 'cqtest-report']
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
const samePath = (a: string, b: string) => comparable(a) === comparable(b)

/** Reject links/junctions in every component, including workspace ancestors. */
function strictPath(value: string, directory: boolean): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Validation path must be absolute')
  const absolute = path.resolve(value)
  let cursor = absolute
  for (;;) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Validation symlink rejected: ${cursor}`)
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const canonical = realpathSync(absolute)
  if (!samePath(canonical, absolute)) throw new Error('Validation realpath mismatch')
  if (directory ? !statSync(canonical).isDirectory() : !statSync(canonical).isFile()) throw new Error('Invalid validation path type')
  return canonical
}

// Fixed generated artifacts only: no contract/worker-supplied exclusions, no extension filtering.
const generatedDirectories = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'])
// Unreal's own build/run output. Top-level only, and only when the root holds a .uproject: a CQTest run writes Saved/Intermediate/Binaries
// (GBs of PCH/PDB and rolling logs), which would make any fingerprint of a UE worktree unreadable (>2 GiB files) or never stable.
const unrealGeneratedDirectories = new Set(['Saved', 'Intermediate', 'Binaries', 'DerivedDataCache', '.vs'])
function isUnrealProject(root: string): boolean {
  try { return readdirSync(root).some(name => name.toLowerCase().endsWith('.uproject')) } catch { return false }
}
function generated(relative: string, name: string, directory: boolean, unreal = false): boolean {
  return directory && (generatedDirectories.has(name) || relative === '.dsh/home' || unreal && unrealGeneratedDirectories.has(relative))
    || !directory && (name === '.coverage' || name.startsWith('.coverage.'))
}

/** Conservative source + tests fingerprint (all non-generated regular files, names and bytes). */
export function fingerprintWorkspace(workspace: string): string {
  const root = strictPath(workspace, true)
  const unreal = isUnrealProject(root)
  const digest = createHash('sha256')
  function walk(directory: string, prefix: string): void {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) throw new Error(`Validation symlink rejected: ${relative}`)
      if (generated(relative, name, info.isDirectory(), unreal)) continue
      if (info.isDirectory()) { digest.update(`directory\0${relative}\0`); walk(absolute, relative) }
      else if (info.isFile()) {
        if (!samePath(realpathSync(absolute), absolute)) throw new Error('Validation path escaped workspace')
        const data = readFileSync(absolute)
        digest.update(`file\0${relative}\0${data.length}\0`).update(data).update('\0')
      } else throw new Error(`Unsupported validation file type: ${relative}`)
    }
  }
  walk(root, '')
  return digest.digest('hex')
}

/** Node IDs: portable relative *.test.{mjs,cjs,js} path + :: + canonical JSON
 * array of exact ancestor/test names, e.g. a.test.mjs::["suite","adds numbers"].
 * Arrays avoid ambiguous fullName concatenation; duplicate observed IDs fail closed. */
function validNodeId(id: string): boolean {
  const separator = id.indexOf('::')
  if (separator < 0) return false
  const file = id.slice(0, separator)
  if (!/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.test\.(?:mjs|cjs|js)$/.test(file)) return false
  try {
    const names: unknown = JSON.parse(id.slice(separator + 2))
    return Array.isArray(names) && names.length > 0 && names.every(name => typeof name === 'string' && name.length > 0 && !/[\x00-\x1f\x7f]/.test(name))
      && JSON.stringify(names) === id.slice(separator + 2)
  } catch { return false }
}

/** Call only at a trusted management boundary, including when restoring persisted contracts. */
export function createValidationContract(input: ValidationContractInput): ValidationContract {
  if (!input || !ADAPTERS.includes(input.adapter)) throw new Error('Unsupported validation adapter')
  const allowed = new Set(['adapter', 'executable', 'workspace', 'requiredTestIds', 'revision', 'timeoutMs', 'digest', 'executableFingerprint'])
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('Unsupported validation contract field')
  if (typeof input.revision !== 'string' || !input.revision.trim()) throw new Error('Validation revision is required')
  if (!Array.isArray(input.requiredTestIds) || !input.requiredTestIds.length
    || input.requiredTestIds.some(id => typeof id !== 'string' || !(input.adapter === 'node-test' ? validNodeId(id) : input.adapter === 'cqtest-report' ? validCqtestId(id) : /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){2,}$/.test(id)))
    || new Set(input.requiredTestIds).size !== input.requiredTestIds.length) throw new Error('Unique required unittest IDs are required')
  const timeoutMs = input.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid validation timeout')
  const executable = strictPath(input.executable, false)
  const workspace = strictPath(input.workspace, true)
  const executableRelative = path.relative(workspace, executable)
  if (!executableRelative || !executableRelative.startsWith(`..${path.sep}`) && executableRelative !== '..' && !path.isAbsolute(executableRelative)) throw new Error('Trusted validation executable must be outside the worker workspace')
  const body = {
    adapter: input.adapter,
    executable,
    executableFingerprint: hash(readFileSync(executable)),
    workspace,
    requiredTestIds: Object.freeze([...input.requiredTestIds].sort()),
    revision: input.revision,
    timeoutMs,
  }
  return Object.freeze({ ...body, digest: hash(JSON.stringify(body)) })
}

function assertBinding(contract: ValidationContract, binding: ValidationBinding): void {
  if (!binding || typeof binding.ticketId !== 'string' || !binding.ticketId.trim()
    || typeof binding.assignmentId !== 'string' || !binding.assignmentId.trim()) throw new Error('Validation ticket/assignment binding is required')
  if (binding.contractRevision !== contract.revision) throw new Error('Validation contract revision mismatch')
  if (!samePath(strictPath(binding.workspace, true), contract.workspace)) throw new Error('Validation workspace binding mismatch')
}

// Structured report from host-owned code, never inferred from stdout/stderr. -I -S isolates
// Python startup; worker tests still execute code, NOT an OS sandbox against hostile tests.
const pythonRunner = String.raw`
import sys, os, json, unittest, io, traceback
root, report = sys.argv[1:3]
sys.dont_write_bytecode = True
sys.path.insert(0, root)
class Result(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.successful_ids = []
    def addSuccess(self, test):
        super().addSuccess(test)
        self.successful_ids.append(test.id())
try:
    suite = unittest.TestLoader().discover(root, pattern='test*.py', top_level_dir=root)
    result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=Result, verbosity=0).run(suite)
    payload = dict(completed=True, testsRun=result.testsRun, failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped), successfulTestIds=result.successful_ids, unexpectedSuccesses=len(result.unexpectedSuccesses), expectedFailures=len(result.expectedFailures))
    with open(report, 'x', encoding='utf-8') as output:
        json.dump(payload, output)
    sys.exit(0 if result.wasSuccessful() else 1)
except BaseException as error:
    if isinstance(error, SystemExit):
        raise
    traceback.print_exc()
    sys.exit(2)
`

// This file runs outside the workspace. Tests execute in node:test's isolated child
// processes; stdout/stderr events are only drained, NEVER interpreted as results.
// Like Python, this is not an OS sandbox against code with host filesystem access.
const nodeRunner = String.raw`
import { run } from 'node:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const [root, report, encodedFiles] = process.argv.slice(2);
const files = JSON.parse(encodedFiles);
const names = new Map();
const testNames = new Map();
const ids = [];
const completedFiles = new Set();
let summary;
let testsRun = 0;
let invalid = false;
for await (const event of run({ files, concurrency: 1, execArgv: [] })) {
  const data = event.data;
  if (event.type === 'test:stdout' || event.type === 'test:stderr') {
    // Preserve the shared host output bound, without trusting the bytes.
    process.stdout.write(data.message);
  } else if (event.type === 'test:start') {
    const stack = names.get(data.file) ?? [];
    stack.length = data.nesting;
    stack.push(data.name);
    names.set(data.file, stack);
    testNames.set(JSON.stringify([data.file, data.testId ?? [data.line, data.column, data.nesting, data.name]]), [...stack]);
  } else if ((event.type === 'test:pass' || event.type === 'test:fail') && data.details.type !== 'suite' && data.name !== data.file) {
    testsRun++;
    if (event.type !== 'test:pass' || data.skip || data.todo) continue;
    const stack = testNames.get(JSON.stringify([data.file, data.testId ?? [data.line, data.column, data.nesting, data.name]]));
    const relative = path.relative(root, data.file).split(path.sep).join('/');
    if (!files.includes(data.file) || !stack || stack.length !== data.nesting + 1 || stack[data.nesting] !== data.name) invalid = true;
    else ids.push(relative + '::' + JSON.stringify(stack));
  } else if (event.type === 'test:summary') {
    if (data.file) completedFiles.add(data.file);
    else summary = data;
  }
}
if (!summary || invalid) process.exit(2);
const c = summary.counts;
writeFileSync(report, JSON.stringify({ completed: true, testsRun, failures: c.failed, errors: c.cancelled,
  skipped: c.skipped, successfulTestIds: ids, unexpectedSuccesses: 0, expectedFailures: c.todo }), { flag: 'wx' });
// Node may treat process.exit(0) or an empty file as a successful synthetic
// file case. Every discovered file must finish its real test stream, and the
// aggregate must account for exactly the observed non-synthetic case events.
process.exitCode = summary.success && c.tests === testsRun && files.every(file => completedFiles.has(file)) ? 0 : 1;
`

function nodeFiles(workspace: string): string[] {
  const files: string[] = []
  function walk(directory: string, prefix: string): void {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) throw new Error(`Validation symlink rejected: ${relative}`)
      if (generated(relative, name, info.isDirectory())) continue
      if (info.isDirectory()) walk(absolute, relative)
      else if (/\.test\.(mjs|cjs|js)$/.test(name)) files.push(absolute)
    }
  }
  walk(workspace, '')
  return files
}

interface Report {
  completed: boolean
  testsRun: number
  failures: number
  errors: number
  skipped: number
  successfulTestIds: string[]
  unexpectedSuccesses: number
  expectedFailures: number
}
function readReport(filename: string): Report | undefined {
  try {
    if (statSync(filename).size > 1024 * 1024) return undefined
    const report = JSON.parse(readFileSync(filename, 'utf8')) as Report
    if (report.completed !== true || !['testsRun', 'failures', 'errors', 'skipped', 'unexpectedSuccesses', 'expectedFailures']
      .every(key => Number.isSafeInteger(report[key as keyof Report]) && Number(report[key as keyof Report]) >= 0)
      || !Array.isArray(report.successfulTestIds) || report.successfulTestIds.some(id => typeof id !== 'string')) return undefined
    return report
  } catch { return undefined }
}

export async function runValidation(contract: ValidationContract, binding: ValidationBinding, signal?: AbortSignal): Promise<ValidationEvidence> {
  if (signal?.aborted) throw new Error('Validation cancelled')
  const checked = createValidationContract(contract)
  if (checked.digest !== contract.digest) throw new Error('Validation contract digest mismatch')
  assertBinding(checked, binding)
  const capturedBinding = Object.freeze({ ...binding, workspace: checked.workspace })
  if (checked.adapter === 'cqtest-report') return runCqtestValidation(checked, capturedBinding)
  const startedAt = new Date().toISOString()
  const beforeFingerprint = fingerprintWorkspace(checked.workspace)
  const temporary = mkdtempSync(path.join(tmpdir(), 'dsh-validation-'))
  const filename = path.join(temporary, 'report.json')
  const node = checked.adapter === 'node-test'
  const label = node ? 'Node test' : 'Unittest'
  const environment = { ...process.env }
  if (node) for (const key of Object.keys(environment)) {
    if (['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT'].includes(key.toUpperCase())) delete environment[key]
  }
  const reasons: string[] = []
  let exitCode: number | null = null
  let report: Report | undefined
  try {
    const runner = path.join(temporary, 'runner.mjs')
    const files = node ? nodeFiles(checked.workspace) : []
    if (node) writeFileSync(runner, nodeRunner, { flag: 'wx' })
    // An explicit empty list must not fall back to node:test's ambient discovery.
    if (node && files.length === 0) reasons.push('No Node test files discovered')
    else exitCode = await new Promise<number | null>(resolve => {
      let settled = false
      const args = node ? [runner, checked.workspace, filename, JSON.stringify(files)] : ['-I', '-S', '-B', '-c', pythonRunner, checked.workspace, filename]
      const child = spawn(checked.executable, args, {
        env: environment, cwd: checked.workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      })
      let terminationTimer: ReturnType<typeof setTimeout> | undefined
      let stopping = false
      let treeKillerPending = false
      let processClosed = false
      let processExitCode: number | null = null
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (terminationTimer) clearTimeout(terminationTimer)
        signal?.removeEventListener('abort', cancel)
        child.stdout.destroy()
        child.stderr.destroy()
        resolve(code)
      }
      const stop = () => {
        if (stopping || settled) return
        stopping = true
        // A descendant can retain pipe handles after the interpreter exits. Bound settlement
        // independently of 'close', and terminate the process group/tree rather than only Python.
        terminationTimer = setTimeout(() => { reasons.push('Process-tree cleanup exceeded deadline; descendants may remain'); child.kill('SIGKILL'); finish(null) }, 10_000)
        if (child.pid) {
          if (process.platform === 'win32') {
            treeKillerPending = true
            const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
            killer.once('error', error => { reasons.push(`Process-tree cleanup error: ${error.message}`); child.kill() })
            killer.once('close', code => {
              treeKillerPending = false
              if (code !== 0) reasons.push('Process-tree cleanup failed; descendants may remain')
              child.kill()
              if (processClosed) finish(processExitCode)
            })
            killer.unref()
          } else {
            try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
          }
        } else child.kill('SIGKILL')
      }
      let bytes = 0
      const consume = (data: Buffer) => { bytes += data.length; if (bytes > 1024 * 1024) { reasons.push('Validation output limit exceeded'); stop() } }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      const cancel = () => { reasons.push('Validation cancelled'); stop() }
      const timer = setTimeout(() => { reasons.push('Validation timed out'); stop() }, checked.timeoutMs)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      child.once('error', error => { reasons.push(`Validation process error: ${error.message}`); finish(null) })
      child.once('close', code => { processClosed = true; processExitCode = code; if (!treeKillerPending) finish(code) })
    })
    report = readReport(filename)
  } finally {
    // This path is the unique absolute temp directory created above, never worker input.
    rmSync(temporary, { recursive: true, force: true })
  }
  let afterFingerprint = ''
  try { afterFingerprint = fingerprintWorkspace(checked.workspace) } catch (error) { reasons.push(`Workspace fingerprint failed: ${String(error)}`) }
  try {
    if (createValidationContract(checked).digest !== checked.digest) reasons.push('Trusted validation executable changed during validation')
  } catch (error) { reasons.push(`Trusted validation executable invalid: ${String(error)}`) }
  if (exitCode !== 0) reasons.push('Validation process did not exit successfully')
  if (!report) reasons.push(`Missing or invalid structured ${node ? 'node:test' : 'unittest'} report`)
  if (report && (report.testsRun <= 0 || report.testsRun !== report.successfulTestIds.length || node && report.successfulTestIds.some(id => !validNodeId(id)) || new Set(report.successfulTestIds).size !== report.successfulTestIds.length || report.failures || report.errors || report.skipped || report.unexpectedSuccesses || report.expectedFailures)) reasons.push(`${label} cases must all pass without failures, errors or skips`)
  if (report && checked.requiredTestIds.some(id => !report.successfulTestIds.includes(id))) reasons.push(`Required ${node ? 'node:test' : 'unittest'} IDs did not pass`)
  if (beforeFingerprint !== afterFingerprint) reasons.push('Workspace changed during validation')
  return Object.freeze({
    binding: capturedBinding, contractDigest: checked.digest, beforeFingerprint, afterFingerprint,
    exitCode, completed: report?.completed === true, testsRun: report?.testsRun ?? 0,
    failures: report?.failures ?? 0, errors: report?.errors ?? 0, skipped: report?.skipped ?? 0,
    successfulTestIds: Object.freeze(report?.successfulTestIds ?? []), passed: reasons.length === 0,
    reasons: Object.freeze(reasons), startedAt, finishedAt: new Date().toISOString(),
  })
}

/** Report-validating Unreal adapter: nothing is spawned. See cqtest-validation.ts for the exact acceptance rules and limits. */
function runCqtestValidation(checked: ValidationContract, binding: ValidationBinding): ValidationEvidence {
  const startedAt = new Date().toISOString()
  const reasons: string[] = []
  const beforeFingerprint = fingerprintWorkspace(checked.workspace)
  const notBefore = Date.parse(binding.assignmentStartedAt ?? '')
  let report: ReturnType<typeof readCqtestReport>['report']
  if (!Number.isFinite(notBefore)) reasons.push('CQTest validation needs the current assignment start time')
  else { const read = readCqtestReport(checked.workspace, notBefore); reasons.push(...read.reasons); report = read.report }
  let afterFingerprint = ''
  try { afterFingerprint = fingerprintWorkspace(checked.workspace) } catch (error) { reasons.push(`Workspace fingerprint failed: ${String(error)}`) }
  try {
    if (createValidationContract(checked).digest !== checked.digest) reasons.push('Trusted validation executable changed during validation')
  } catch (error) { reasons.push(`Trusted validation executable invalid: ${String(error)}`) }
  if (report && checked.requiredTestIds.some(id => !report.successfulTestIds.includes(id))) reasons.push('Required CQTest IDs did not pass')
  if (beforeFingerprint !== afterFingerprint) reasons.push('Workspace changed during validation')
  return Object.freeze({
    binding, contractDigest: checked.digest, beforeFingerprint, afterFingerprint,
    exitCode: report ? 0 : null, completed: report?.completed === true, testsRun: report?.testsRun ?? 0,
    failures: report?.failures ?? 0, errors: report?.errors ?? 0, skipped: report?.skipped ?? 0,
    successfulTestIds: Object.freeze(report?.successfulTestIds ?? []), passed: reasons.length === 0,
    reasons: Object.freeze(reasons), startedAt, finishedAt: new Date().toISOString(),
    ...(report ? { reportSha256: report.reportSha256 } : {}),
  })
}

/** Evidence must come from the host's persisted store, NEVER worker-supplied JSON.
 * Fingerprints bind observed states; not an OS lock against racing/transient writes. */
export function validateValidationEvidence(contract: ValidationContract, binding: ValidationBinding, evidence: ValidationEvidence): { valid: boolean; reasons: string[] } {
  const reasons: string[] = []
  try {
    const checked = createValidationContract(contract)
    assertBinding(checked, binding)
    if (checked.digest !== contract.digest || evidence.contractDigest !== checked.digest) reasons.push('Validation contract mismatch')
    if (!evidence.passed || !evidence.completed || evidence.exitCode !== 0 || evidence.reasons.length) reasons.push('Validation did not pass')
    if (evidence.binding.ticketId !== binding.ticketId || evidence.binding.assignmentId !== binding.assignmentId
      || evidence.binding.contractRevision !== binding.contractRevision || !samePath(evidence.binding.workspace, checked.workspace)) reasons.push('Validation evidence binding mismatch')
    if (!Number.isSafeInteger(evidence.testsRun) || evidence.testsRun <= 0 || evidence.failures !== 0 || evidence.errors !== 0 || evidence.skipped !== 0
      || evidence.testsRun !== evidence.successfulTestIds.length || checked.adapter === 'node-test' && evidence.successfulTestIds.some(id => !validNodeId(id)) || checked.adapter === 'cqtest-report' && evidence.successfulTestIds.some(id => !validCqtestId(id)) || new Set(evidence.successfulTestIds).size !== evidence.successfulTestIds.length || checked.requiredTestIds.some(id => !evidence.successfulTestIds.includes(id))) reasons.push('Invalid unittest case results')
    if (checked.adapter === 'cqtest-report') {
      // The accepted report must still be the same bytes, and still fresh for THIS assignment.
      const floor = Date.parse(binding.assignmentStartedAt ?? '')
      const again = Number.isFinite(floor) ? readCqtestReport(checked.workspace, floor) : undefined
      if (!evidence.reportSha256 || !again?.report || again.report.reportSha256 !== evidence.reportSha256) reasons.push('CQTest report changed, was replaced or is no longer fresh since validation')
    }
    if (!evidence.beforeFingerprint || evidence.beforeFingerprint !== evidence.afterFingerprint || fingerprintWorkspace(checked.workspace) !== evidence.afterFingerprint) reasons.push('Validation evidence is stale')
  } catch (error) { reasons.push(String(error)) }
  return { valid: reasons.length === 0, reasons }
}

export function assertValidationEvidence(contract: ValidationContract, binding: ValidationBinding, evidence: ValidationEvidence): void {
  const result = validateValidationEvidence(contract, binding, evidence)
  if (!result.valid) throw new Error(result.reasons.join('; '))
}
