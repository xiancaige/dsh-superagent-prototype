/**
 * Phase B host visual adapter: the real capture transport and the independent image inspector.
 *
 * The host owns every trust-bearing input: the fixed scenario/state, the fixed capture tool (an MCP
 * server, one tool name and its argument template), the inspector executable, the frames themselves
 * (captured here, never uploaded by a worker) and the judgements (produced here by reading those
 * frames, never typed by a worker). A worker tool can only ask for a capture or a read; nothing it
 * passes can turn a failed or absent capture into a pass.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client'
import {
  MAX_FRAME_BYTES, SCRATCH_DIRECTORY, VISUAL_EVIDENCE_DIR, conflictReasons, fingerprintFile, findFrameConflicts, frameDigest, frameFileDigest, framePath, framePathIn, frameRelativePath,
  groupVerdict, inspectFrameFile,
  normalizeJudgement, type CaptureRecord, type CaptureResponseRecord, type FrameContradiction, type FrameRecord, type ImageHeader, type Verdict, type VisualCheckVerdict,
} from './visual.ts'
import { captureArgumentsFor, canonicalJson, createVisualContract, visualContractStillValid } from './visual-contract.ts'
import type { VisualContract } from './visual.ts'
import { fingerprintWorkspace } from './validation.ts'
export type { VisualContract }

/**
 * The workspace fingerprint a capture binds, with the host-written evidence directory counted by the
 * digest of what it held: source edits still expire the evidence, while writing the frames the host
 * itself records does not make the evidence stale.
 */
function workspaceFingerprintWith(workspace: string): string {
  const root = framePathIn(workspace, VISUAL_EVIDENCE_DIR, 'placeholder')
  const rootDirectory = path.dirname(root)
  const digest = createHash('sha256')
  digest.update(fingerprintWorkspace(workspace))
  for (const name of existsSync(rootDirectory) ? readdirSync(rootDirectory, { recursive: true, encoding: 'utf8' }).sort() : []) {
    const relative = String(name).split(path.sep).join('/')
    try {
      const filename = framePathIn(workspace, VISUAL_EVIDENCE_DIR, relative)
      if (!statSync(filename).isFile()) continue
      fingerprintFile(digest, `${VISUAL_EVIDENCE_DIR}/${relative}`, readFileSync(filename))
    } catch { /* a link or a vanished entry contributes nothing; the frame check reports it */ }
  }
  return digest.digest('hex')
}

/** Outcome of one capture group: `captured` frames decode, `failed` the tool errored, `unavailable` no tool could be reached. */
export type CaptureStatus = 'captured' | 'failed' | 'unavailable'

/** One capture group as the gate sees it: verified frames and the verdicts read from them. */
export type VisualGroupEvidence = {
  readonly group: string
  readonly instruction: string
  readonly sequence: number
  readonly status: CaptureStatus
  readonly capturedAt: string
  /** The frames this group's verdict was computed from, with the capture each came from. */
  readonly frames: readonly FrameRecord[]
  readonly verdict: Verdict
  readonly reason: string
  readonly checks: readonly VisualCheckVerdict[]
  readonly readAt: string
}

export type VisualEvidence = {
  readonly contractDigest: string
  readonly ticketId: string
  readonly assignmentId: string
  readonly workspace: string
  readonly workspaceFingerprint: string
  /** Every capture group the latest assessment evaluated, in capture order. */
  readonly groups: readonly VisualGroupEvidence[]
  readonly passed: boolean
  readonly reasons: readonly string[]
  /** Frames this report decided differently from a settled report, and frames a capture wrote again. Never a pass. */
  readonly contradictions?: readonly FrameContradiction[]
  readonly startedAt: string
  readonly finishedAt: string
}

/** A report this ticket already settled: the frame digests it judged and per-check verdicts it gave. */
export type SettledReport = { readonly group: string; readonly checks: readonly VisualCheckVerdict[]; readonly frames: readonly FrameRecord[] }

/** One capture request, bound to a ticket, assignment, workspace, contract and group name. */
export type CaptureBinding = {
  readonly ticketId: string
  readonly assignmentId: string
  readonly workspace: string
  readonly contract: VisualContract
  readonly group: string
}

/** What one capture attempt found: the group it recorded and what happened. */
export type CaptureOutcome = {
  readonly group: string
  readonly status: CaptureStatus
  readonly frames: number
  readonly reason: string
}

/** A persisted capture group. The host adapter is the only writer of this manifest. */
export type VisualManifestEntry = CaptureRecord & {
  readonly ticketId: string
  readonly assignmentId: string
  readonly status: CaptureStatus
  readonly toolPreparedAt: string
  readonly groupDigest: string
}

/**
 * Where the trusted capture tool lives. `mcpDatabase` is the tool's own state location; the ticket
 * workspace must never contain it, or worker files could pose as trusted tool state.
 */
export type CaptureTool = { readonly mcpDatabase: string; readonly endpoint?: string }

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
/** Refuse a tool state path inside the worker workspace, where worker files could pose as tool state. */
export function assertOutsideWorkspace(workspace: string, statePath: string): void {
  // Across drives, and from a drive root, `path.relative` yields an absolute path instead of a parent link.
  const inside = path.relative(path.resolve(workspace), path.resolve(statePath))
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) throw new Error('Capture tool state must lie outside the ticket workspace')
}
const GROUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function atomicWrite(filename: string, text: string): void {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, text, { flag: 'wx' })
  renameSync(temporary, filename)
}

/** Raised when the trusted tool cannot be reached; recorded as `unavailable`, never as a pass. */
export class UnavailableCapture extends Error {}

/** Read back a captured frame; an unreadable one fails the group with the tool's own words for why. */
function inspectCapturedFrame(filename: string, result: unknown): ImageHeader {
  try { return inspectFrameFile(filename) } catch (error) {
    const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content
    const text = content?.filter(block => block.type === 'text').map(block => block.text).join(' ')
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(text ? `${why} (${String(text).slice(0, 200)})` : why)
  }
}
export interface CaptureSession {
  prepare(): Promise<void>
  call(server: string, tool: string, args: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

/** The real capture transport: one MCP Streamable HTTP connection per ticket adapter session. */
export class McpCaptureSession implements CaptureSession {
  private client: Client | undefined
  constructor(private readonly endpoint: string | undefined) {}
  async prepare(): Promise<void> {
    if (this.client) return
    if (!this.endpoint) throw new UnavailableCapture('No MCP endpoint is configured for the trusted capture tool')
    const url = new URL(this.endpoint)
    if (!/^https?:$/.test(url.protocol)) throw new UnavailableCapture('Capture endpoint must be an http(s) URL')
    const client = new Client({ name: 'dsh-superagent-visual', version: '0.1.0' })
    try { await client.connect(new StreamableHTTPClientTransport(url)) }
    catch (error) { throw new UnavailableCapture(`Trusted capture tool is not reachable at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`) }
    this.client = client
  }
  async call(server: string, tool: string, args: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    await this.prepare()
    const client = this.client!
    // The server name is the contract's own namespace: one endpoint per adapter session.
    void server
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    const abort = () => { void client.close() }
    combined.addEventListener('abort', abort, { once: true })
    try {
      const result = await client.callTool({ name: tool, arguments: args }, { signal: combined })
      if ((result as CallToolResult & { isError?: unknown }).isError === true) throw new Error('Capture tool reported an error')
      return result
    } finally { combined.removeEventListener('abort', abort) }
  }
  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    if (client) await client.close().catch(() => undefined)
  }
}

/** A capture tool answer, already read for one frame: what it returned and where its image went. */
type CapturedAnswer = { readonly record: CaptureResponseRecord; readonly bytes?: Buffer }

/**
 * Read what the trusted tool answered: its text, the kind and size of every content block, and digests
 * of both a summary and the raw response. Nothing here is trusted to be a frame yet; the frame is the
 * file read back from disk, and its digest is what a check may cite.
 */
function readCaptureAnswer(result: unknown, server: string, tool: string, args: Readonly<Record<string, unknown>>): CapturedAnswer {
  if (!result || typeof result !== 'object') throw new Error('Capture tool returned no response')
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) throw new Error('Capture tool returned no content')
  for (const block of content) {
    if ((block as { type?: unknown } | undefined)?.type !== 'image') continue
    const data = (block as { data?: unknown }).data
    if (typeof data !== 'string') throw new Error('Capture tool returned image content without bytes')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length) {
      // The summary keeps every block, with an image's bytes replaced by their digest.
      const summary = content.map(item => {
        const entry = item as { type?: unknown; data?: unknown }
        return typeof entry?.data === 'string' ? { ...entry, data: frameDigest(Buffer.from(entry.data, 'base64')) } : entry
      })
      const text = content.filter(item => (item as { type?: unknown }).type === 'text').map(item => String((item as { text?: unknown }).text ?? '')).join(' ')
      return { bytes, record: { tool, arguments: { ...args }, text: text.slice(0, 2000),
        content: content.map(item => { const entry = item as { type: string; mimeType?: string; data?: string }
          return { type: entry.type, ...(entry.mimeType ? { mimeType: entry.mimeType } : {}), ...(typeof entry.data === 'string' ? { bytes: Buffer.from(entry.data, 'base64').length } : {}) } }),
        responseDigest: hash(canonicalJson({ server, tool, content: summary, text })), rawDigest: hash(canonicalJson(result)), respondedAt: new Date().toISOString() } }
    }
  }
  throw new Error('Capture tool returned no image content')
}

/** Write the trusted tool's image to a frame path that did not exist, then read the header back from disk. */
function writeFrame(bytes: Buffer, filename: string): ImageHeader {
  if (bytes.length > MAX_FRAME_BYTES) throw new Error('Capture produced an oversized frame')
  writeFileSync(filename, bytes, { flag: 'wx' })
  if (frameDigest(bytes) !== frameFileDigest(filename)) throw new Error('Captured frame changed while being written')
  return inspectFrameFile(filename)
}

/** True for anything at the path, including a link whose target does not exist. */
function lstatExists(filename: string): boolean {
  try { lstatSync(filename); return true } catch { return false }
}

/** Move a capture tool's own output aside into the host-owned scratch directory, before the call. */
function hideStaleOutput(filename: string, scratch: string): string | undefined {
  if (!lstatExists(filename)) return undefined
  mkdirSync(scratch, { recursive: true })
  const aside = path.join(scratch, `${path.basename(filename, '.png')}-${process.pid}-${Date.now()}.bin`)
  renameSync(filename, aside)
  return aside
}

export const EVIDENCE_DIRECTORY = VISUAL_EVIDENCE_DIR

/**
 * The host capture adapter. The transport it holds is the only path to a frame: a capture is real
 * because this transport reached the trusted MCP tool, never because a worker said so.
 */
export class VisualEvidenceStore {
  constructor(private readonly session: CaptureSession, private readonly tool: CaptureTool) {}
  /** Release the transport once a capture is over. */
  close(): Promise<void> { return this.session.close() }
  private root(workspace: string): string { return path.join(workspace, VISUAL_EVIDENCE_DIR) }
  private manifestFile(workspace: string): string { return path.join(this.root(workspace), 'manifest.json') }

  /** Create the host-owned evidence directory once per workspace (idempotent). */
  ensureDirectory(workspace: string): void {
    const root = this.root(workspace)
    mkdirSync(root, { recursive: true })
    const marker = path.join(root, '.owned')
    if (!existsSync(marker)) writeFileSync(marker, 'dsh-superagent visual evidence: host-captured frames only\n', { flag: 'wx' })
  }

  readManifest(workspace: string): VisualManifestEntry[] {
    const file = this.manifestFile(workspace)
    if (!existsSync(file)) return []
    const info = lstatSync(file)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Visual manifest must be a regular file')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error('Visual manifest is not a list')
    return parsed as VisualManifestEntry[]
  }

  private writeManifest(workspace: string, entries: VisualManifestEntry[]): void {
    atomicWrite(this.manifestFile(workspace), `${JSON.stringify(entries, null, 2)}\n`)
  }

  /** Capture groups recorded for one instruction, in capture order. */
  groupsOf(workspace: string, instruction: string): VisualManifestEntry[] {
    return this.readManifest(workspace).filter(entry => entry.instruction === instruction).sort((a, b) => a.sequence - b.sequence)
  }

  /**
   * Capture frames for one instruction into a fresh group. `prepared` is the host's last recorded
   * preparation of the trusted tool; without it the tool is not known ready, so nothing is captured
   * and the group is recorded as `failed` (still blocking, never a pass).
   */
  async capture(binding: CaptureBinding, count: number, prepared: { at: string } | undefined, signal: AbortSignal): Promise<CaptureOutcome> {
    if (signal.aborted) throw new Error('Visual capture cancelled')
    const { contract, workspace, group } = binding
    if (!GROUP.test(group)) throw new Error('Capture group must be a short path-safe name')
    if (!visualContractStillValid(contract)) throw new Error('Visual contract changed; capture refused')
    // On a drive root `path.relative` yields an absolute path, so both shapes count as inside.
    assertOutsideWorkspace(workspace, this.tool.mcpDatabase)
    if (!Number.isSafeInteger(count) || count < 1 || count > contract.minimumFrames) throw new Error(`A capture produces 1..${contract.minimumFrames} frame(s)`)
    this.ensureDirectory(workspace)
    const existing = this.groupsOf(workspace, contract.scenario)
    if (existing.some(entry => entry.group === group)) throw new Error(`Capture group ${group} already exists; a group is captured once`)
    const sequence = existing.length ? existing[existing.length - 1]!.sequence + 1 : 1
    const capturedAt = new Date().toISOString()
    const frames: CaptureRecord['frames'][number][] = []
    let status: CaptureStatus = 'captured'
    let reason = ''
    const scratch = path.join(this.root(workspace), SCRATCH_DIRECTORY)
    try {
      if (!prepared) throw new Error('Trusted capture tool was not prepared for this ticket; prepare it first')
      await this.session.prepare()
      for (let index = 1; index <= count; index++) {
        const relative = frameRelativePath(group, contract.scenario, index)
        const filename = framePath(workspace, relative)
        const args = captureArgumentsFor(contract.capture.arguments, filename)
        // Phase B3: a frame path belongs to one capture. Anything already at it — a file an earlier
        // capture wrote, or one a worker left there — is set aside, never read as this capture's frame.
        // A mere symlink cannot be renamed over another file's content, so it is removed by its own name.
        if (lstatExists(filename)) hideStaleOutput(filename, scratch)
        const at = new Date().toISOString()
        const result = await this.session.call(contract.capture.server, contract.capture.tool, args, contract.capture.timeoutMs, signal)
        const answer = readCaptureAnswer(result, contract.capture.server, contract.capture.tool, args)
        // The tool may write the frame itself. Either way the frame is the file read back from disk now,
        // and the image it returned must be exactly those bytes; a file left by something else fails.
        if (answer.bytes) {
          if (existsSync(filename)) {
            if (!readFileSync(filename).equals(answer.bytes)) throw new Error('The capture tool left a frame that is not the image it returned')
          } else writeFrame(answer.bytes, filename)
        } else if (!existsSync(filename)) throw new Error('Capture tool returned no image and wrote no frame')
        const header = inspectCapturedFrame(filename, result)
        const sha256 = frameFileDigest(filename)
        frames.push({ path: relative, sha256, bytes: statSync(filename).size, width: header.width, height: header.height, capturedAt: at,
          captureDigest: hash(canonicalJson({ group, relative, sha256, capturedAt: at, response: answer.record })), response: answer.record })
      }
    } catch (error) {
      status = error instanceof UnavailableCapture ? 'unavailable' : 'failed'
      reason = error instanceof Error ? error.message : String(error)
    }
    // A failed or partial group is recorded too: it must stay visible to the gate instead of vanishing.
    const body = { instruction: contract.scenario, sequence, group, tool: contract.capture.tool, server: contract.capture.server, capturedAt, frames }
    const record: VisualManifestEntry = { ...body, ticketId: binding.ticketId, assignmentId: binding.assignmentId, status,
      toolPreparedAt: prepared?.at ?? '', manifestDigest: hash(canonicalJson(body)), groupDigest: hash(canonicalJson(body)) }
    this.writeManifest(workspace, [...this.readManifest(workspace), record])
    return { group, status, frames: frames.length, reason }
  }
}

/** What the inspector subprocess prints: one judgement per capture group, from the frames it read. */
interface InspectorReport {
  groups: { group: string; verdict: unknown; reason: unknown; checks: unknown }[]
}
function readInspectorReport(filename: string): InspectorReport | undefined {
  try {
    if (statSync(filename).size > 1024 * 1024) return undefined
    const parsed = JSON.parse(readFileSync(filename, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as InspectorReport).groups)) return undefined
    return parsed as InspectorReport
  } catch { return undefined }
}

/** Run the host-trusted inspector over the listed groups and read its structured report. */
export async function runInspector(contract: VisualContract, groups: readonly { group: string; frames: readonly string[] }[], signal: AbortSignal): Promise<InspectorReport> {
  if (signal.aborted) throw new Error('Visual inspection cancelled')
  // A stored contract already carries its validated, digest-covered shape; re-validating it would
  // only re-add the derived fields. Capture paths re-derive it before use; this path trusts the digest.
  const temporary = mkdtempSync(path.join(tmpdir(), 'dsh-visual-inspection-'))
  const request = path.join(temporary, 'request.json')
  const report = path.join(temporary, 'report.json')
  atomicWrite(request, JSON.stringify({ version: contract.version, checks: contract.checks, groups }))
  try {
    const exitCode = await runChild(contract.inspector.executable, [...contract.inspector.args, request, report], path.join(temporary, 'inspector.log'), signal, contract.timeoutMs)
    if (exitCode !== 0) {
      // Keep the inspector's own last words: a missing decoder or a bad request must be diagnosable.
      let detail = ''
      try { detail = readFileSync(path.join(temporary, 'inspector.log'), 'utf8').slice(-2000) } catch { /* no log kept */ }
      throw new Error(`Image inspector exited with ${exitCode ?? 'no code'}${detail ? `: ${detail}` : ''}`)
    }
    const parsed = readInspectorReport(report)
    if (!parsed) throw new Error('Image inspector produced no structured report')
    return parsed
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

/** Bounded child run with process-tree termination, mirroring the phase A validation runner. */
async function runChild(executable: string, args: string[], logFile: string, signal: AbortSignal, timeoutMs: number): Promise<number | null> {
  const logStream = openSync(logFile, 'w')
  // A runner may start this host with Node loader arguments (`process.execArgv`, such as tsx's). They
  // belong to this process, never to the interpreter, so the inspector starts clean.
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_REQUIRE
  return await new Promise<number | null>(resolve => {
    let settled = false
    const child = spawn(executable, args, { shell: false, windowsHide: true, env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', logStream] })
    let termination: ReturnType<typeof setTimeout> | undefined
    let stopping = false
    let closed = false
    let code: number | null = null
    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (termination) clearTimeout(termination)
      signal.removeEventListener('abort', stop)
      closeSync(logStream)
      resolve(value)
    }
    const stop = () => {
      if (stopping || settled) return
      stopping = true
      termination = setTimeout(() => { child.kill('SIGKILL'); finish(null) }, 10_000)
      if (child.pid && process.platform === 'win32') {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
        killer.once('close', () => { child.kill(); if (closed) finish(code) })
        killer.once('error', () => child.kill())
        killer.unref()
      } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } } else child.kill('SIGKILL')
    }
    const timer = setTimeout(stop, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    child.once('error', () => finish(null))
    child.once('close', value => { closed = true; code = value; if (!stopping) finish(value) })
  })
}

/**
 * Judge every recorded group for one instruction, ticket and assignment, and require a passing group.
 * Only frames the manifest holds that still exist with their recorded digest reach the inspector;
 * anything else is recorded as failed or undetermined and never silently dropped.
 *
 * Phase B3: the same frame can never be two pieces of evidence. A capture that wrote bytes another
 * capture already wrote is reused, and a frame the ticket's settled reports judged one way and this
 * report judges the other way is contradictory. Either one makes the report fail with that reason, so
 * a pass always rests on frames that only this capture produced and that only one verdict names.
 */
export async function assessVisual(contract: VisualContract, ticketId: string, assignmentId: string, workspace: string, signal: AbortSignal,
  settled: readonly SettledReport[] = []): Promise<VisualEvidence> {
  const startedAt = new Date().toISOString()
  if (!visualContractStillValid(contract)) throw new Error('Visual contract digest mismatch')
  const workspaceFingerprint = workspaceFingerprintWith(workspace)
  const store = { manifest: path.join(workspace, VISUAL_EVIDENCE_DIR, 'manifest.json') }
  const entries = existsSync(store.manifest) ? (JSON.parse(readFileSync(store.manifest, 'utf8')) as VisualManifestEntry[]) : []
  const mine = entries.filter(entry => entry.instruction === contract.scenario && entry.ticketId === ticketId && entry.assignmentId === assignmentId)
    .sort((a, b) => a.sequence - b.sequence)
  const reasons: string[] = []
  let contradictions: FrameContradiction[] = []
  const finish = (groups: VisualGroupEvidence[], reason?: string) => {
    if (reason) reasons.push(reason)
    const passed = groups.some(group => group.verdict === 'passed') && !groups.some(group => group.verdict === 'failed')
      && !reasons.length && !contradictions.length
    // Why a report that is not a pass was refused, in the report's own words rather than a summary.
    if (!passed && !reasons.length) reasons.push(contradictions.length ? `Frame integrity refusal: ${contradictions.map(item => item.reason).join('; ')}`
      : groups.some(group => group.verdict === 'passed') ? 'A capture group failed its checks' : 'No capture group passed its checks')
    return Object.freeze({ contractDigest: contract.digest, ticketId, assignmentId, workspace, workspaceFingerprint,
      groups: Object.freeze(groups), passed, reasons: Object.freeze(reasons), ...(contradictions.length ? { contradictions: Object.freeze(contradictions) } : {}),
      startedAt, finishedAt: new Date().toISOString() })
  }
  if (!mine.length) return finish([], 'No screenshot was captured for this ticket and assignment')
  const framesOf = (entry: VisualManifestEntry) => Object.freeze([...entry.frames])
  const groups: VisualGroupEvidence[] = []
  const usable: VisualManifestEntry[] = []
  // What this report decided per group, kept as the next report's ledger baseline unless it conflicts.
  const ledger: SettledReport[] = []
  const prior = () => [...settled, ...ledger]
  for (const entry of mine) {
    const base = { group: entry.group, instruction: entry.instruction, sequence: entry.sequence, status: entry.status, capturedAt: entry.capturedAt, frames: framesOf(entry) }
    const readAt = new Date().toISOString()
    if (entry.status !== 'captured') {
      groups.push({ ...base, verdict: 'undetermined', reason: `Capture ${entry.status}: the trusted tool produced no usable frames`, checks: [], readAt })
      continue
    }
    try {
      for (const frame of entry.frames) {
        const filename = framePath(workspace, frame.path)
        inspectFrameFile(filename)
        if (frameFileDigest(filename) !== frame.sha256) throw new Error(`${frame.path} content changed`)
      }
    } catch (error) {
      groups.push({ ...base, verdict: 'failed', reason: `A frame is not intact: ${error instanceof Error ? error.message : String(error)}`, checks: [], readAt })
      continue
    }
    if (entry.frames.length < contract.minimumFrames) {
      groups.push({ ...base, verdict: 'undetermined', reason: `Group holds ${entry.frames.length} frame(s); the contract requires ${contract.minimumFrames}`, checks: [], readAt })
      continue
    }
    // A capture that wrote bytes an earlier capture already wrote is a reused frame whatever its verdict.
    const repeated = findFrameConflicts(prior(), [{ group: entry.group, checks: [], frames: entry.frames }])
    if (repeated.reused.length) {
      contradictions = [...contradictions, ...repeated.aliases]
      groups.push({ ...base, verdict: 'failed', reason: `Capture wrote a frame that already existed: ${repeated.reused.join(', ')}`, checks: [], readAt })
      continue
    }
    ledger.push({ group: entry.group, checks: [], frames: entry.frames as FrameRecord[] })
    usable.push(entry)
  }
  let report: InspectorReport | undefined
  let reason: string | undefined
  if (usable.length) {
    try { report = await runInspector(contract, usable.map(entry => ({ group: entry.group, frames: entry.frames.map(frame => framePath(workspace, frame.path)) })), signal) }
    catch (error) { reason = `Image inspector unavailable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const judged = new Set<string>()
  for (const entry of usable) {
    const base = { group: entry.group, instruction: contract.scenario, sequence: entry.sequence, status: 'captured' as CaptureStatus, capturedAt: entry.capturedAt, frames: framesOf(entry) }
    const readAt = new Date().toISOString()
    const groupFrames = entry.frames.map(frame => frame.path)
    const verdictOf = (kind: Verdict, why: string, checks: VisualCheckVerdict[] = []) => groups.push({ ...base, verdict: kind, reason: why, checks, readAt })
    const item = report?.groups.find(group => group.group === entry.group && !judged.has(group.group))
    if (!reason && !item) { verdictOf('undetermined', 'The image inspector did not judge this capture group'); continue }
    if (!item) { verdictOf('undetermined', reason!); continue }
    judged.add(entry.group)
    let normalized: ReturnType<typeof normalizeJudgement>
    try { normalized = normalizeJudgement({ verdict: item.verdict, reason: item.reason, checks: item.checks }, contract.checks) }
    catch (error) { verdictOf('undetermined', `Inspector report rejected: ${error instanceof Error ? error.message : String(error)}`); continue }
    // A pass must name frames of this group that were actually read; an unnamed or foreign frame proves nothing.
    const checks = normalized.checks.map(check => {
      if (check.verdict !== 'passed') return check
      // The inspector names absolute files; the evidence keeps the workspace-relative ones.
      const cited = check.frames.filter(file => groupFrames.includes(path.relative(path.dirname(framePath(workspace, 'x')), path.resolve(file)).split(path.sep).join('/')))
      return cited.length ? { ...check, frames: cited } : { ...check, verdict: 'undetermined' as Verdict, reason: 'A pass must name the frames it was read from' }
    })
    const combined = groupVerdict(checks.map(check => ({ verdict: check.verdict, reason: `${check.check}: ${check.reason}` })), groupFrames.length)
    if (normalized.verdict !== combined.verdict) {
      verdictOf('undetermined', `Inspector verdict ${normalized.verdict} contradicts its per-check verdicts`, checks)
      continue
    }
    // Phase B3 ledger: a frame this capture wrote again, or one this ticket already judged the other
    // way, is refused. The group keeps its checks, but its refusal is what the report fails on.
    const disputed = findFrameConflicts(prior(), [{ group: entry.group, checks, frames: entry.frames }])
    if (disputed.contradictions.length || disputed.reused.length) {
      contradictions = [...contradictions, ...disputed.contradictions, ...disputed.aliases]
      verdictOf('failed', conflictReasons(disputed).join('; '), checks)
      continue
    }
    ledger.push({ group: entry.group, checks, frames: base.frames as FrameRecord[] })
    verdictOf(combined.verdict, combined.reason, checks)
  }
  return finish(groups)
}

/** Re-run the source fingerprint and the frame checks when the gate needs a fresh look; pure and host-local. */
export function visualEvidenceCurrent(contract: VisualContract, workspace: string, evidence: VisualEvidence): boolean {
  return validateVisualEvidence(contract, workspace, evidence, evidence.ticketId, evidence.assignmentId).valid
}

/** Re-check persisted visual evidence against the contract, the workspace and the frames on disk. */
export function validateVisualEvidence(contract: VisualContract, workspace: string, evidence: VisualEvidence, ticketId: string, assignmentId: string): { valid: boolean; reasons: string[] } {
  const reasons: string[] = []
  try {
    if (!visualContractStillValid(contract) || evidence.contractDigest !== contract.digest) reasons.push('Visual contract mismatch')
    if (evidence.ticketId !== ticketId || evidence.assignmentId !== assignmentId) reasons.push('Visual evidence binding mismatch')
    if (evidence.workspace !== workspace) reasons.push('Visual evidence workspace mismatch')
    if (!evidence.passed || evidence.reasons.length) reasons.push('Visual evidence did not pass')
    if (evidence.contradictions?.length) reasons.push('Visual evidence carries a contradictory frame verdict')
    if (!evidence.groups.some(group => group.verdict === 'passed')) reasons.push('No passing capture group')
    for (const group of evidence.groups) {
      for (const frame of group.frames) {
        try {
          const filename = framePath(workspace, frame.path)
          if (frameFileDigest(filename) !== frame.sha256) throw new Error('frame content changed')
          inspectFrameFile(filename)
        } catch (error) { reasons.push(`Visual frame is stale or invalid: ${frame.path}: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    if (evidence.workspaceFingerprint !== workspaceFingerprintWith(workspace)) reasons.push('Visual evidence is stale: workspace changed after the capture')
  } catch (error) { reasons.push(String(error)) }
  return { valid: reasons.length === 0, reasons }
}
