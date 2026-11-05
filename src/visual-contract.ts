/**
 * The visual contract: host-only validation of what a ticket's visual acceptance requires. Kept free
 * of the MCP transport and the inspector process so the Engine can restore and verify a persisted
 * contract without loading the capture adapter. The frames described here live in `visual.ts`; the
 * adapter and inspector live in `visual-host.ts`.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { VISUAL_CONTRACT_VERSION } from './visual.ts'


/** Host/admin-only visual input. A worker tool never supplies any of it. */
export interface VisualContractInput {
  /** The fixed scenario/state the acceptance speaks of; names the capture instruction (short slug). */
  scenario: string
  /** The fixed capture tool: one MCP server, one tool name and its JSON argument template (`{{path}}` is the frame path). */
  capture: { server: string; tool: string; arguments: Readonly<Record<string, unknown>>; timeoutMs?: number }
  /** The independent, host-trusted image inspector executable (for example installed Python with Pillow). */
  inspector: { executable: string; args?: readonly string[] }
  /** Checks the inspector must judge piece by piece, from the frames only. */
  checks: readonly string[]
  /** Frames required per capture group. Multi-frame evidence asks for more than one. */
  minimumFrames: number
  /** Present only in a restored contract: re-derivation pins them instead of recomputing them. */
  version?: number
  timeoutMs?: number
  executableFingerprint?: string
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
const samePath = (a: string, b: string) => comparable(a) === comparable(b)
const INSTRUCTION = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Sorted JSON so a template's digest never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function absoluteRealFile(value: string, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  const absolute = path.resolve(value)
  const info = lstatSync(absolute)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a real file`)
  if (!samePath(realpathSync(absolute), absolute)) throw new Error(`${label} realpath mismatch`)
  return absolute
}

/** A validated contract. It carries exactly the fields validation reads, so a restore re-derives the digest. */
/** The validated, digest-covered contract body. Key order is irrelevant: the digest is over JSON. */
type VisualContractDerived = {
  version: number
  scenario: string
  capture: { server: string; tool: string; arguments: Readonly<Record<string, unknown>>; timeoutMs: number; argumentsDigest: string }
  inspector: { executable: string; args: readonly string[] }
  checks: readonly string[]
  minimumFrames: number
  timeoutMs: number
  executableFingerprint: string
  digest: string
}

/** A validated contract. It carries exactly the fields validation reads, so a restore re-derives the digest. */
export type ValidVisualContract = Readonly<{
  version: number
  scenario: string
  capture: VisualContractDerived['capture']
  inspector: VisualContractDerived['inspector']
  checks: readonly string[]
  minimumFrames: number
  timeoutMs: number
  executableFingerprint: string
  digest: string
}>


/** Validate a visual contract. Called wherever a contract is restored, so a changed tool cannot be reused. */
export function createVisualContract(input: VisualContractInput): ValidVisualContract {
  const allowed = new Set(['scenario', 'capture', 'inspector', 'checks', 'minimumFrames', 'version', 'timeoutMs', 'executableFingerprint'])
  if (!input || Object.keys(input).some(key => !allowed.has(key))) throw new Error('Unsupported visual contract field')
  if (typeof input.scenario !== 'string' || !INSTRUCTION.test(input.scenario)) throw new Error('Visual scenario must be a short lowercase slug naming the fixed state')
  if (!input.capture || typeof input.capture !== 'object') throw new Error('Visual contract requires a fixed capture tool')
  if (Object.keys(input.capture).some(key => !['server', 'tool', 'arguments', 'timeoutMs', 'argumentsDigest'].includes(key))) throw new Error('Unsupported capture field')
  if (typeof input.capture.server !== 'string' || !input.capture.server.trim()) throw new Error('Capture server is required')
  if (typeof input.capture.tool !== 'string' || !input.capture.tool.trim()) throw new Error('Capture tool is required')
  if (!input.capture.arguments || typeof input.capture.arguments !== 'object' || Array.isArray(input.capture.arguments)) throw new Error('Capture argument template must be an object')
  const captureTimeout = input.capture.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(captureTimeout) || captureTimeout < 1 || captureTimeout > 300_000) throw new Error('Invalid capture timeout')
  if (!input.inspector || typeof input.inspector !== 'object' || typeof input.inspector.executable !== 'string') throw new Error('Visual contract requires an independent image inspector')
  if (Object.keys(input.inspector).some(key => !['executable', 'args'].includes(key))) throw new Error('Unsupported inspector field')
  const args = input.inspector.args ?? []
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Inspector arguments must be strings')
  if (!Array.isArray(input.checks) || !input.checks.length || input.checks.some(check => typeof check !== 'string' || !check.trim())) throw new Error('Visual contract requires named checks')
  if (new Set(input.checks).size !== input.checks.length) throw new Error('Visual checks must be unique')
  if (!Number.isSafeInteger(input.minimumFrames) || input.minimumFrames < 1 || input.minimumFrames > 20) throw new Error('minimumFrames must be 1..20')
  const executable = absoluteRealFile(input.inspector.executable, 'Inspector executable')
  const body = {
    version: VISUAL_CONTRACT_VERSION,
    scenario: input.scenario,
    capture: {
      server: input.capture.server, tool: input.capture.tool, arguments: Object.freeze({ ...input.capture.arguments }), timeoutMs: captureTimeout,
      argumentsDigest: hash(canonicalJson(input.capture.arguments)),
    },
    inspector: { executable, args: Object.freeze([...args]) },
    checks: Object.freeze([...input.checks]),
    minimumFrames: input.minimumFrames,
    timeoutMs: 120_000,
    executableFingerprint: hash(readFileSync(executable)),
  }
  return Object.freeze({ ...body, digest: hash(JSON.stringify(body)) })
}

/** Digest of the parts a restore must still match on disk. */
export function visualContractStillValid(contract: ValidVisualContract): boolean {
  try {
    // A stored contract may carry non-contract bookkeeping; only the contract fields are re-derived.
    const { scenario, capture, inspector, checks, minimumFrames, version, timeoutMs, executableFingerprint } = contract
    return createVisualContract({ scenario, capture, inspector, checks, minimumFrames, version, timeoutMs, executableFingerprint }).digest === contract.digest
  } catch { return false }
}

/** The capture template with one frame's absolute path substituted. Refuses a template that drops the path. */
export function captureArgumentsFor(template: Readonly<Record<string, unknown>>, filename: string): Record<string, unknown> {
  const substitute = (value: unknown): unknown => {
    if (typeof value === 'string') return value === '{{path}}' ? filename : value
    if (Array.isArray(value)) return value.map(item => substitute(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, substitute(item)]))
    return value
  }
  const substituted = substitute(template) as Record<string, unknown>
  if (!canonicalJson(substituted).includes(JSON.stringify(filename))) throw new Error('Capture argument template must place {{path}} for the frame path')
  return substituted
}
