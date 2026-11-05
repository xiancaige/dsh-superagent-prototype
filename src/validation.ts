import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, readdirSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readCqtestReport, validCqtestId } from './cqtest-validation.ts'

/** Host/admin-only input. Never accept executable, IDs or exclusions from a worker tool. */
export interface ValidationContractInput {
  /**
   * Only Unreal CQTest reports are accepted. The project's own `BuildScripts/run-cqtest` runs the tests
   * (the worker invokes it); the host never launches Unreal and only validates the report that run
   * wrote. `executable` is the trusted validator script, bound by digest.
   */
  adapter: 'cqtest-report'
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

const ADAPTERS: readonly string[] = ['cqtest-report']
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
// Top-level scratch output that is gitignored and rewritten while the host runs (the project's one-off scripts and
// the RAG service's rolling log). Counting it made the fingerprint move on its own, so a freshly taken acceptance
// evidence went stale without anyone editing source (TODO72, verified 2026-11-05).
const scratchDirectories = new Set(['.temp'])
function isUnrealProject(root: string): boolean {
  try { return readdirSync(root).some(name => name.toLowerCase().endsWith('.uproject')) } catch { return false }
}
function generated(relative: string, name: string, directory: boolean, unreal = false): boolean {
  return directory && (generatedDirectories.has(name) || relative === '.dsh/home' || scratchDirectories.has(relative)
      || unreal && unrealGeneratedDirectories.has(relative))
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
    || input.requiredTestIds.some(id => typeof id !== 'string' || !validCqtestId(id))
    || new Set(input.requiredTestIds).size !== input.requiredTestIds.length) throw new Error('Unique required CQTest IDs are required')
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

/**
 * Acceptance for the project's own CQTest run. The worker runs `BuildScripts/run-cqtest` itself (the
 * project script owns launching Unreal); this only validates the report that run wrote, so the host
 * never spawns Unreal and cannot be talked into running a command by a worker.
 */
export async function runValidation(contract: ValidationContract, binding: ValidationBinding): Promise<ValidationEvidence> {
  const checked = createValidationContract(contract)
  if (checked.digest !== contract.digest) throw new Error('Validation contract digest mismatch')
  assertBinding(checked, binding)
  return runCqtestValidation(checked, Object.freeze({ ...binding, workspace: checked.workspace }))
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
      || evidence.testsRun !== evidence.successfulTestIds.length || evidence.successfulTestIds.some(id => !validCqtestId(id)) || new Set(evidence.successfulTestIds).size !== evidence.successfulTestIds.length || checked.requiredTestIds.some(id => !evidence.successfulTestIds.includes(id))) reasons.push('Invalid CQTest case results')
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
