/**
 * Phase B visual evidence: shared, platform-neutral rules for what a screenshot frame is and what
 * reading one may decide. The host capture adapter (MCP transport), the host inspection subprocess
 * (image header + judgement) and the strict-acceptance gate all import these, so there is one
 * definition of a decodable frame, one derivation of its content digest, and one verdict vocabulary.
 * Nothing here trusts worker text: a frame is a host-captured file, a verdict is either produced by
 * the host reading that file or recorded as `undetermined`.
 */
import { createHash } from 'node:crypto'
import fs, { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/** Directory inside a ticket workspace where the host adapter stores frames; excluded from source fingerprints. */
export const VISUAL_EVIDENCE_DIR = '.dsh-visual-evidence'

/**
 * Bump when the parsing/assessment vocabulary changes, so old evidence cannot pass silently.
 * 2 (phase B3): a capture must be fresh, one frame file belongs to exactly one capture, and every
 * report names the frame digest, size, capture time and tool response it was computed from.
 */
export const VISUAL_CONTRACT_VERSION = 2

/**
 * Type-only view of the host-side contract and evidence. The core holds these in the ticket but never
 * imports the host adapter (which links an MCP client), so completion checks stay pure and portable.
 * Fields beyond `digest` and the binding are read by the host validator only.
 */
export interface VisualContractView {
  readonly digest: string
  readonly scenario: string
  readonly checks: readonly string[]
  readonly minimumFrames: number
  readonly version: number
  readonly capture: { readonly server: string; readonly tool: string; readonly arguments: Readonly<Record<string, unknown>>; readonly timeoutMs: number; readonly argumentsDigest: string }
  readonly inspector: { readonly executable: string; readonly args: readonly string[] }
  readonly timeoutMs: number
  readonly executableFingerprint: string
}
export interface VisualEvidenceView {
  readonly contractDigest: string
  readonly ticketId: string
  readonly assignmentId: string
  readonly workspace: string
  readonly workspaceFingerprint: string
  readonly passed: boolean
  readonly reasons: readonly string[]
  readonly groups: readonly { readonly verdict: Verdict; readonly group: string; readonly status: string; readonly frames?: readonly FrameRecord[] }[]
  /** Phase B3: the frame digests this report decided differently from an earlier captured report. Never a pass. */
  readonly contradictions?: readonly FrameContradiction[]
  readonly startedAt: string
  readonly finishedAt: string
}export interface VisualBinding {
  readonly ticketId: string
  readonly assignmentId: string
  readonly workspace: string
  readonly contractDigest: string
}
export type VisualContract = VisualContractView
export type VisualEvidence = VisualEvidenceView

/** Magic bytes of a real PNG stream, followed by the IHDR chunk length and type. */
const PNG_IHDR = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
/** Upper bound of a single trusted frame; the host adapter enforces the same value. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024
/** Upper bound of decoded pixels; rejects decompression bombs before IHDR width/height are believed. */
export const MAX_FRAME_PIXELS = 64 * 1024 * 1024

export interface ImageHeader {
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly colorType: number
}

/**
 * Decode the fixed PNG prefix. Returns undefined for anything that is not a well-formed PNG whose
 * IHDR has plausible dimensions; the caller treats that as "not a readable image", never as success.
 * Only the header is parsed here: pixel decoding is the host inspection subprocess's job.
 */
export function readImageHeader(bytes: Buffer): ImageHeader | undefined {
  // The 16-byte prefix is signature + the IHDR chunk's length and type.
  if (bytes.length < 33 || !bytes.subarray(0, 16).equals(PNG_IHDR)) return undefined
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const bitDepth = bytes.readUInt8(24)
  const colorType = bytes.readUInt8(25)
  const compression = bytes.readUInt8(26)
  const filter = bytes.readUInt8(27)
  const interlaced = bytes.readUInt8(28)
  if (!width || !height || width * height > MAX_FRAME_PIXELS) return undefined
  if (![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)) return undefined
  if (compression !== 0 || filter !== 0 || interlaced > 1) return undefined
  // A truncated stream (no IEND) is not a complete image and cannot be read as one. The floor is the
  // header plus IEND and one minimal IDAT; a sound uniform frame can legitimately be very small.
  if (bytes.length < 80 || !bytes.subarray(bytes.length - 12).equals(PNG_IEND)) return undefined
  return { width, height, bitDepth, colorType }
}

/** True when the file is decodable enough to be a captured frame at the trusted boundary. */
export function inspectFrameFile(filename: string): ImageHeader {
  const info = lstatSync(filename)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Visual frame must be a regular file')
  if (info.size > MAX_FRAME_BYTES) throw new Error('Visual frame exceeds the size limit')
  const absolute = path.resolve(filename)
  if (realpathSync(absolute) !== absolute) throw new Error('Visual frame escaped its directory')
  const header = readImageHeader(readFileSync(absolute))
  if (!header) throw new Error('Visual frame is not a readable PNG')
  return header
}

/** The same content digest the source fingerprint uses for a file, applied to one frame's bytes. */
export function frameDigest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
export function frameFileDigest(filename: string): string { return frameDigest(readFileSync(filename)) }

/** Host scratch inside the evidence directory: a tool's own output set aside, never a frame of any group. */
export const SCRATCH_DIRECTORY = '.capture-scratch'

/** Relative, forward-slash path of one frame inside the evidence directory. */
export function frameRelativePath(group: string, instruction: string, index: number): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(group)) throw new Error('Visual group must be a short path-safe name')
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(instruction)) throw new Error('Visual instruction name must be a short path-safe slug')
  return `${group}/${instruction}-${String(index).padStart(2, '0')}.png`
}

/** Absolute path of a frame, refusing anything that leaves the evidence directory. */
export function framePath(workspace: string, relative: string): string { return framePathIn(workspace, VISUAL_EVIDENCE_DIR, relative) }

/** Absolute path of a file inside one of the workspace's host-owned directories, refusing escapes. */
export function framePathIn(workspace: string, directory: string, relative: string): string {
  // The trusted tool reads this path, so it is normalised here (Windows 8.3 short names like
  // `C:\Users\GONGLI~1` are what the default temp dir yields) before any contract binds it.
  const root = path.join(fs.realpathSync.native(workspace), directory)
  const absolute = path.resolve(root, relative)
  const inside = path.relative(root, absolute)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`Visual frame must live inside ${directory}`)
  return absolute
}

/** Length-prefixed file fingerprint, the same encoding the phase A workspace fingerprint uses. */
export function fingerprintFile(digest: ReturnType<typeof createHash>, relative: string, bytes: Buffer): void {
  digest.update(`file\0${relative}\0${bytes.length}\0`).update(bytes).update('\0')
}

/**
 * What the trusted capture tool answered for one frame, as the manifest keeps it: the call the tool
 * was really given, its own text and content kinds, and digests of the whole response.
 */
export interface CaptureResponseRecord {
  /** The tool name and the exact arguments it was called with (the frame path included). */
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
  /** The tool's own answer: its text blocks, and the kind and byte length of each content block. */
  readonly text: string
  readonly content: readonly { readonly type: string; readonly mimeType?: string; readonly bytes?: number }[]
  /** sha256 of the classified summary and of the raw response JSON. */
  readonly responseDigest: string
  readonly rawDigest: string
  readonly respondedAt: string
}

/** One captured file as the manifest records it. */
export interface FrameRecord {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly capturedAt: string
  /** sha256 of the whole capture record that wrote this file: one frame file, one capture. */
  readonly captureDigest?: string
  readonly response?: CaptureResponseRecord
}

/** A group of frames the host adapter captured in one capture call for one instruction. */
export interface CaptureRecord {
  readonly instruction: string
  readonly sequence: number
  readonly group: string
  readonly tool: string
  readonly server: string
  readonly capturedAt: string
  readonly manifestDigest: string
  readonly frames: readonly FrameRecord[]
}

export type Verdict = 'passed' | 'failed' | 'undetermined'

/** One check of the acceptance contract, judged against read frames. */
export interface VisualCheckVerdict {
  readonly check: string
  readonly verdict: Verdict
  readonly reason: string
  /** Frames the assessment looked at for this check; at least one whenever the verdict is passed. */
  readonly frames: readonly string[]
}

/** The Judgement as one captured group judged it. */
export interface CapturedJudgement {
  readonly group: string
  readonly verdict: Verdict
  readonly reason: string
  readonly checks: readonly VisualCheckVerdict[]
}

export function isVerdict(value: unknown): value is Verdict { return value === 'passed' || value === 'failed' || value === 'undetermined' }

/**
 * Refuse a judgement that does not account for every contract check exactly once with a valid
 * verdict. The shape is checked here; whether a `passed` was earned is checked against the frames.
 */
export function normalizeJudgement(value: unknown, checks: readonly string[]): { verdict: Verdict; reason: string; checks: VisualCheckVerdict[] } {
  if (!value || typeof value !== 'object') throw new Error('Judgement must be an object')
  const record = value as { verdict?: unknown; reason?: unknown; checks?: unknown }
  if (!isVerdict(record.verdict)) throw new Error('Judgement verdict must be passed, failed or undetermined')
  if (typeof record.reason !== 'string' || !record.reason.trim()) throw new Error('Judgement reason is required')
  if (!Array.isArray(record.checks)) throw new Error('Judgement checks are required')
  const wanted = new Set(checks)
  const seen = new Set<string>()
  const verdicts: VisualCheckVerdict[] = []
  for (const raw of record.checks) {
    if (!raw || typeof raw !== 'object') throw new Error('Each judgement check must be an object')
    const item = raw as { check?: unknown; verdict?: unknown; reason?: unknown; frames?: unknown }
    if (typeof item.check !== 'string' || !wanted.has(item.check)) throw new Error('Judgement named a check the contract does not have')
    if (seen.has(item.check)) throw new Error('Judgement judged a check twice')
    seen.add(item.check)
    if (!isVerdict(item.verdict)) throw new Error('Each judgement check needs a valid verdict')
    if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('Each judgement check needs a reason')
    const frames = Array.isArray(item.frames) ? item.frames.filter((frame): frame is string => typeof frame === 'string') : []
    verdicts.push({ check: item.check, verdict: item.verdict, reason: item.reason.trim(), frames })
  }
  if (seen.size !== wanted.size) throw new Error('Judgement must judge every contract check')
  return { verdict: record.verdict, reason: record.reason.trim(), checks: verdicts }
}

/**
 * Combine per-check verdicts into the group verdict. Any failure fails; otherwise the first check
 * without a trusted pass (or none at all) leaves the group undetermined. Never a pass by absence.
 */
export function groupVerdict(details: readonly { verdict: Verdict; reason: string }[], count: number): { verdict: Verdict; reason: string } {
  if (count === 0) return { verdict: 'undetermined', reason: 'No screenshot was captured for this instruction' }
  const failed = details.find(item => item.verdict === 'failed')
  if (failed) return { verdict: 'failed', reason: failed.reason }
  const unknown = details.find(item => item.verdict === 'undetermined')
  if (unknown) return { verdict: 'undetermined', reason: unknown.reason }
  return { verdict: 'passed', reason: 'Every check passed against the captured frames' }
}

/** The checks that a minimum frame count demands, as their canonical labels. */
export function minimumFramesCheck(instruction: string): string { return `${instruction}:minimum frames` }

/** One frame digest that two captures decided differently, or that a second capture wrote again. */
export interface FrameContradiction {
  readonly sha256: string
  readonly group: string
  readonly earlier: string
  readonly later: string
  readonly reason: string
}

/** Frame digests two settled reports decided differently, and frame digests a later capture wrote again. */
export interface FrameConflicts {
  readonly contradictions: readonly FrameContradiction[]
  readonly aliases: readonly FrameContradiction[]
  readonly reused: readonly string[]
}

type SettledGroup = { readonly group: string; readonly checks: readonly VisualCheckVerdict[]; readonly frames: readonly { readonly sha256: string }[] }

/**
 * Compare the frames of the settled `prior` groups with a `current` report. One frame digest decided
 * `passed` in one and `failed` in the other, for the same check, is a contradiction; a later capture
 * whose bytes an earlier capture already wrote is a reused frame, renamed or not. Both are refusals,
 * never a pass. Comparing settled against new keeps a report from contradicting itself, while a real
 * change between two captures is caught by their different digests.
 */
export function findFrameConflicts(prior: readonly SettledGroup[], current: readonly SettledGroup[]): FrameConflicts {
  const contradictions: FrameContradiction[] = []
  const aliases: FrameContradiction[] = []
  const reused: string[] = []
  const decided = new Map<string, Map<string, { verdict: Verdict; group: string }>>()
  const owner = new Map<string, string>()
  const settle = (frames: readonly { readonly sha256: string }[], group: string) => { for (const frame of frames) if (!owner.has(frame.sha256)) owner.set(frame.sha256, group) }
  const judge = (frame: { readonly sha256: string }, group: string, checks: readonly VisualCheckVerdict[]) => {
    const perFrame = decided.get(frame.sha256) ?? new Map<string, { verdict: Verdict; group: string }>()
    for (const check of checks) {
      if (check.verdict === 'undetermined') continue
      const before = perFrame.get(check.check)
      if (before && before.verdict !== check.verdict) {
        contradictions.push({ sha256: frame.sha256, group, earlier: `${before.verdict} in ${before.group}`, later: `${check.verdict} in ${group}`,
          reason: `frame ${frame.sha256} was decided ${before.verdict} in ${before.group} and ${check.verdict} in ${group} for check ${check.check}` })
      }
      perFrame.set(check.check, { verdict: check.verdict, group })
    }
    decided.set(frame.sha256, perFrame)
  }
  for (const group of prior) { settle(group.frames, group.group); for (const frame of group.frames) judge(frame, group.group, group.checks) }
  for (const group of current) {
    for (const frame of group.frames) {
      const earlier = owner.get(frame.sha256)
      // A frame another capture already wrote is reused; its new verdict still has to agree with the
      // old one, so a rename can be reported as both a reuse and a contradiction.
      if (earlier !== undefined && earlier !== group.group) {
        reused.push(frame.sha256)
        aliases.push({ sha256: frame.sha256, group: group.group, earlier, later: group.group,
          reason: `capture ${group.group} wrote frame ${frame.sha256} that capture ${earlier} already wrote` })
      }
      if (earlier === undefined) owner.set(frame.sha256, group.group)
      judge(frame, group.group, group.checks)
    }
  }
  return { contradictions, aliases, reused }
}

/** The refusal reasons a set of frame conflicts yields; empty when there is none. */
export function conflictReasons(conflicts: FrameConflicts): string[] {
  return [...conflicts.contradictions.map(item => `Contradictory verdict for one frame: ${item.reason}`),
    ...conflicts.aliases.map(item => `Capture reused a frame that already existed: ${item.reason}`)]
}
