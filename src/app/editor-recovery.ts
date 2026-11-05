/**
 * Phase B2: TP editor recovery for real visual capture.
 *
 * Phase B reported `unavailable` whenever the editor MCP endpoint was down. The project rule
 * (knowledge/tpmcp/00-prerequisites-p1.md) says an unreachable TPMcp is *first* recovered, and only
 * then downgraded and reported as an environment block. This module is that recovery, with the
 * contract's own limits:
 *
 * * it runs only when the operator enabled it — for a ticket through `validation.visual.recovery`
 *   plus strict acceptance, for a deployment through `DSH_SUPERAGENT_EDITOR_RECOVERY`;
 * * one recovery chance per ticket, then an environment block; no retry loop;
 * * TP environment exclusivity (a persistent, cross-ticket and cross-session lock) is taken first,
 *   and without it nothing is detected, launched or killed;
 * * only the TP project editor is touched: the absolute `.uproject`, the process identity and the
 *   port owner are all checked, and another UE project is never killed;
 * * existing entries are reused, never re-implemented: `launch-tp-editor.ps1` starts the editor,
 *   `kill-tp-editor.ps1` cleans up only the TP editor, `wait-tp-mcp.ps1` performs the real
 *   initialize + tools/list handshake, and the TP-held mutex of `acquire-compile-restart-lock.ps1`
 *   is the interactive owner's token while a recovery runs;
 * * readiness is that handshake plus the expected capture tool being listed; a listening TCP port
 *   alone is never readiness;
 * * when the ticket ends, a TP editor this recovery started is stopped, so no unattended editor is
 *   left behind, and the exclusivity is released.
 *
 * Every trust-bearing input is the operator's: the project file, editor executable, MCP port and
 * expected capture tool. A worker tool can only ask for recovery; it cannot name a path or process.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** MCP readiness, as the contract defines it: a real handshake and the expected capture tool visible. */
export interface ReadinessCheck {
  ready: boolean
  /** HTTP endpoint that was asked; empty when no probe was attempted. */
  endpoint: string
  /** The `Mcp-Session-Id` the initialize answered with; empty when the handshake failed. */
  sessionId: string
  /** Names the `tools/list` returned, as the server spelled them. */
  tools: readonly string[]
  /** Why the check did not pass; empty when it did. */
  reason: string
  /** The failure kind, so a downgrade report can name the environment problem precisely. */
  failure?: 'port' | 'handshake' | 'capture-tool'
  listened: boolean
}

/** One TP editor process the host could see, with the facts that decide whether it is one. */
export interface EditorProcess {
  pid: number
  name: string
  commandLine: string
  executablePath: string
  /** The process creation time (ISO), which tells an editor from a later process that reused its PID. */
  startedAt?: string
}

/** The operator's TP environment: absolute paths and the fixed port, never inferred from ticket text. */
export interface TpEditorEnvironment {
  /** Absolute TP `.uproject`. Recovery never acts on another project. */
  projectFile: string
  /** Absolute UnrealEditor executable the TP project opens with. */
  editorExe: string
  /** TPMcp HTTP port (`ServerPortNumber` in the project's editor settings). */
  port: number
  /** Tool the acceptance needs; readiness without it is an environment block, not a pass. */
  captureTool: string
  /**
   * Toolset TPMcp reaches the capture tool through (`TPEditor.TPEditorToolset`). TPMcp's `tools/list`
   * shows only its dispatcher, so this names where the capture tool really lives.
   */
  captureToolset?: string
  /** Existing project scripts; defaults resolve to the TP project root (`BuildScripts/…`). */
  scripts?: { launch?: string; kill?: string; wait?: string; lock?: string }
  /** The time box of one wait/handshake; the contract's budget, not a retry loop. */
  waitSeconds?: number
}

/** What one recovery attempt did, as the operator's records keep it. */
export interface RecoveryOutcome {
  /** `reused` a ready TP editor, `recovered` one this run started, `unavailable` it could not. */
  kind: 'reused' | 'recovered' | 'unavailable'
  /** False when the attempt was refused before touching anything (no exclusivity, ended ticket…). */
  attempted: boolean
  /** Why it was refused or unavailable; empty on success. */
  reason: string
  pid?: number
  /** PID the recovery itself launched, when it did; a reused editor is never adopted for cleanup. */
  startedPid?: number
  sessionId?: string
  tools: readonly string[]
  /** A listening port that never completed the handshake is the contract's failure case. */
  portListened: boolean
  at: string
}

/** How a deployment configures recovery; absent means recovery is off and an unreachable editor stays unavailable. */
export interface RecoverySettings {
  enabled: boolean
  environment?: TpEditorEnvironment
}

/** Dependencies the adapter needs; every one is injectable so tests never launch, kill or lock a real editor. */
export interface RecoveryDeps {
  now?: () => string
  /** Starts the editor and returns its PID; the default runs `launch-tp-editor.ps1`. */
  launch?(environment: TpEditorEnvironment, signal: AbortSignal): Promise<number>
  /** Stops only TP editors; the default runs `kill-tp-editor.ps1`. */
  killEditor?(environment: TpEditorEnvironment, pid: number | undefined, signal: AbortSignal): Promise<void>
  /** The real handshake; the default runs `wait-tp-mcp.ps1` and then lists tools over MCP. */
  handshake?(environment: TpEditorEnvironment, signal: AbortSignal): Promise<ReadinessCheck>
  /** Lists TP editor processes; the default reads the Windows process table. */
  processList?(): Promise<EditorProcess[]>
  /** Probes whether the TPMcp port is listening; a listening port alone is never readiness. */
  listening?(): Promise<boolean>
  /** The TCP table lines `netstat -ano` prints, so the port's owner can be decided; injectable for tests. */
  portTable?(): Promise<readonly string[]>
  /** Takes the TP environment exclusivity; the default borrows phase 2 C's one lock through `port`. */
  exclusive?: (environment: TpEditorEnvironment, ticketId: string, signal: AbortSignal) => Promise<ExclusiveLease>
  /** Phase 2 C's environment broker; the recovery borrows the one lock through it instead of writing its own. */
  port?: ExclusivityPort
  /** Told the PID a recovery started for a ticket, so the holder's persisted lease records it. */
  recordStarted?(ticketId: string, pid: number, startedAt?: string): void
  /** The PID the holder's persisted lease records for a ticket, which a restarted host uses for cleanup. */
  recordedPid?(ticketId: string): number | string | undefined
  /** The creation time the holder's lease recorded with that PID, when the editor was seen starting. */
  recordedStart?(ticketId: string): string | undefined
  /** Stops exactly one process by PID (the default runs `Stop-Process -Id` and waits for it to exit). */
  stopProcess?(pid: number, signal: AbortSignal): Promise<void>
  platform?: NodeJS.Platform
}

/** A held exclusivity; `release` always runs once the recovery is over. */
export interface ExclusiveLease {
  readonly holder: string
  release(): Promise<void>
}

/** What the recovery adapter holds to take the environment: phase 2 C's one broker, never a second lock. */
export interface ExclusivityPort {
  /** Borrow the environment for `ticketId`, for one attempt; rejects with the holder's name when another holds it. */
  borrow(ticketId: string, signal: AbortSignal): Promise<ExclusiveLease>
}

/** The recorded recovery of one ticket, so one ticket gets one recovery chance and its launch is cleaned up. */
export interface TicketRecoveryRecord {
  /** One attempt per ticket/assignment: a later assignment is a new chance only if the operator re-enables it. */
  attempts: number
  outcome?: RecoveryOutcome
  /** A PID this recovery started; stopped when the ticket ends. */
  startedPid?: number
}

/**
 * The lock file, kept from B2 for compatibility: phase 2 C owns the record now
 * (`environment-exclusive.ts`), and B2's readers import the name from here.
 */
export const EXCLUSIVITY_FILE = 'tp-environment.lock'

/** TPMcp's dispatcher tool: editor functions are called through it by toolset and bare name. */
export const DISPATCH_TOOL = 'call_tool'

/** A TPMcp capture call in the shape the server really accepts. */
export interface TpmcpCaptureCall {
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

/**
 * Build the MCP call TPMcp really accepts for a visual contract's fixed capture tool.
 *
 * The editor exposes its functions through one dispatcher: `tools/list` shows `call_tool`, and a call
 * names `toolset_name`, the bare `tool_name`, and `arguments` as an object. A contract's template is
 * therefore nested under `arguments` rather than sent as the call's own arguments. A deployment whose
 * server lists the tool directly is called directly, and a contract that already spells the dispatcher
 * is passed through unchanged.
 *
 * Measured on the running TP editor (2026-11-02): `tools/list` = list_toolsets, describe_toolset,
 * call_tool; `TPEditor.TPEditorToolset.CaptureWidgetBlueprintScreenshot` requires `blueprintPath`
 * (`/Game/.../Name.Name`) and `outputPath`, and renders through a preview widget.
 */
export function tpmcpCaptureCall(input: {
  tool: string
  /** Toolset the contract names, such as `TPEditor.TPEditorToolset`. */
  toolset?: string
  /** The contract's argument template with `{{path}}` already substituted. */
  template: Readonly<Record<string, unknown>>
  /** Names the server answered `tools/list` with; undefined when not yet known. */
  listed?: readonly string[]
}): TpmcpCaptureCall {
  const listed = input.listed ?? []
  const toolset = input.toolset?.trim()
  const bare = input.tool.replace(`${toolset}.`, '')
  // A server that lists the tool itself takes the template as the call's arguments.
  const direct = listed.some(name => name === input.tool || name === bare)
  if (!toolset || direct) return { tool: bare, arguments: { ...input.template } }
  if (input.tool === DISPATCH_TOOL) return { tool: DISPATCH_TOOL, arguments: { ...input.template } }
  // Otherwise the dispatcher is the only route: the template becomes its `arguments` object.
  return { tool: DISPATCH_TOOL, arguments: { toolset_name: toolset, tool_name: bare, arguments: { ...input.template } } }
}

const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
const backslashes = (value: string) => value.replace(/\//g, '\\')

/**
 * Whether a process is the TP editor of exactly this project: the absolute `.uproject` on its command
 * line, and an executable name that is an UnrealEditor. Another UE project (any other `.uproject`) is
 * false, so cleanup can never reach it. A process that names several projects is the TP editor of any
 * one of them that matches this exact path; cleanup acts on the TP editor, not on a guessed project.
 */
export function isTpEditorProcess(process: Pick<EditorProcess, 'name' | 'commandLine' | 'executablePath'>, projectFile: string): boolean {
  if (!/^unrealeditor/i.test(process.name)) return false
  if (!process.commandLine) return false
  const commandLine = comparable(backslashes(process.commandLine))
  const project = comparable(backslashes(path.resolve(projectFile)))
  if (!project) return false
  // Only the exact absolute path counts: a relative or differently-located file with the same
  // basename is another project, and a bare name on the command line never qualifies.
  return commandLine.includes(project)
}

/** The PID owning a listening TCP port, or undefined when the owner cannot be determined. */
export function portOwner(lines: readonly string[], port: number): number | undefined {
  const pattern = new RegExp(`^(?!\\s*\\*).*:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i')
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match) return Number(match[1])
  }
  return undefined
}

/** The port ownership rule: a listening port is TP's only when the living TP editor owns it. */
export function portOwnedBy(owner: number | undefined, editors: readonly EditorProcess[], projectFile: string): boolean {
  if (!owner || !Number.isSafeInteger(owner)) return false
  const editor = editors.find(candidate => candidate.pid === owner)
  return !!editor && isTpEditorProcess(editor, projectFile)
}

/**
 * The readiness rule: a real handshake with a session id, and the configured capture tool visible.
 *
 * TPMcp exposes only a small dispatcher surface (`list_toolsets`, `describe_toolset`, `call_tool`) in
 * `tools/list`; editor functions are reached through `call_tool` and named like
 * `TPEditor.TPEditorToolset.CaptureWidgetBlueprintScreenshot`. The tool therefore counts as visible when
 * `tools/list` names it directly, or when the dispatcher is present and the contract names a toolset it
 * can reach. A listening port without a handshake is never readiness.
 */
export function readinessOf(check: Omit<ReadinessCheck, 'ready' | 'tools' | 'reason' | 'failure'> & { tools?: readonly string[]; reason?: string; toolset?: string }, expectedTool: string): ReadinessCheck {
  const tools = check.tools ?? []
  const fail = (kind: 'port' | 'handshake' | 'capture-tool', reason: string): ReadinessCheck => ({ ...check, tools, ready: false, reason, failure: kind })
  if (!check.listened) return fail('port', check.reason || 'The TPMcp port is not listening')
  if (!check.sessionId) return fail('handshake', check.reason || 'initialize did not answer with an Mcp-Session-Id')
  if (check.reason) return fail('handshake', check.reason)
  const lower = expectedTool.toLowerCase()
  const listed = tools.some(name => name === expectedTool || name.endsWith(`.${expectedTool}`) || name.toLowerCase() === lower)
  // A named toolset is reachable through the dispatcher: `call_tool` then names the tool by its bare name.
  const dispatched = !!check.toolset && tools.includes(DISPATCH_TOOL)
  if (!listed && !dispatched) return fail('capture-tool', `tools/list listed no ${expectedTool} capture tool${check.toolset ? ` and no ${DISPATCH_TOOL} dispatcher for ${check.toolset}` : ''}`)
  return { ...check, tools, ready: true, reason: '' }
}

const defaultDelegate = (environment: TpEditorEnvironment) => {
  const root = path.dirname(environment.projectFile)
  const scripts = environment.scripts ?? {}
  return {
    launch: scripts.launch ?? path.join(root, 'BuildScripts', 'launch-tp-editor.ps1'),
    kill: scripts.kill ?? path.join(root, 'BuildScripts', 'kill-tp-editor.ps1'),
    wait: scripts.wait ?? path.join(root, 'BuildScripts', 'wait-tp-mcp.ps1'),
  }
}

const powershell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Run an existing PowerShell entry with a time box and process-tree termination, as the phase A runner does. */
function runPowerShell(script: string, args: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      resolve({ code, stdout, stderr })
    }
    const stop = () => {
      if (settled) return
      if (child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
        killer.once('error', () => child.kill())
        killer.unref()
      }
      finish(null)
    }
    const timer = setTimeout(stop, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', data => { if (stdout.length < 64_000) stdout += String(data) })
    child.stderr.on('data', data => { if (stderr.length < 64_000) stderr += String(data) })
    child.once('error', () => finish(null))
    child.once('close', code => finish(code))
  })
}

/** Read the live-owner exclusivity file, reaping a dead owner; a live owner is never stolen. */
function readExclusivity(file: string): { pid: number; holder: string; host: string; time: string; token: string } | undefined {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    // `\S+` would capture the CRLF's carriage return; the lines are read one at a time without it.
    const field = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(text.replace(/\r/g, ''))?.[1]?.trim() ?? ''
    const pid = Number(field('pid'))
    return { pid: Number.isSafeInteger(pid) ? pid : 0, holder: field('holder'), host: field('host'), time: field('time'), token: field('token') }
  } catch { return undefined }
}

function ownerAlive(pid: number, stamp: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch { return false }
  return true
}

/**
 * Whether an existing lock is live. The exclusive resource is one whole TP editor, so a lock is held
 * while its holder Session still lives: this very process (another ticket or a concurrent recovery),
 * or a holder that is itself a running recovery rather than a process that reused its PID.
 */
function lockHeld(existing: { pid: number; token: string }, stamp: string): boolean {
  // A token from this process is a held lock even before the OS reports the pid, and always after.
  if (existing.token && existing.token.startsWith(`${existing.pid}-`) && existing.pid === process.pid) return true
  return ownerAlive(existing.pid, stamp)
}

/**
 * The TP environment exclusivity: one lock file in the deployment state directory, outside every
 * ticket workspace, so it holds across tickets and ordinary Sessions, and it survives a restart
 * because a live owner keeps it and a dead one is reaped.
 */
export function fileExclusivity(stateDir: string): (environment: TpEditorEnvironment, ticketId: string, signal: AbortSignal) => Promise<ExclusiveLease> {
  return async (_environment, ticketId, signal) => {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const file = path.join(stateDir, EXCLUSIVITY_FILE)
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const existing = existsSync(file) ? readExclusivity(file) : undefined
    // A lock another holder wrote is respected while its owner lives, even inside this same process.
    if (existing && existing.token && lockHeld(existing, existing.time)) {
      throw new Error(`TP environment is held by live pid ${existing.pid} (${existing.host || existing.holder || 'unknown holder'})`)
    }
    if (existing) rmSync(file, { force: true })
    const body = `pid=${process.pid}\r\nholder=${ticketId}\r\nhost=${hostName()}\r\ntime=${new Date().toISOString()}\r\ntoken=${token}\r\n`
    // `wx` makes the create atomic: a racing Session either wins the file or sees the live owner.
    try { writeFileSync(file, body, { flag: 'wx', encoding: 'utf8' }) } catch {
      const raced = readExclusivity(file)
      if (raced && lockHeld(raced, raced.time)) throw new Error(`TP environment is held by live pid ${raced.pid} (${raced.host || raced.holder || 'unknown holder'})`)
      writeFileSync(file, body, { encoding: 'utf8' })
    }
    signal.throwIfAborted()
    return {
      holder: ticketId,
      release: async () => {
        const held = readExclusivity(file)
        // Only the token this takeover wrote is removed: a later holder's lock is never deleted.
        if (held?.token !== token) return
        try { unlinkSync(file) } catch { /* already gone */ }
      },
    }
  }
}

/** The host this Session runs on, recorded with the lock so a cross-machine holder is named. */
function hostName(): string {
  try { return os.hostname() } catch { return 'unknown-host' }
}

/** Windows process facts: the command line and executable are what identity is decided on. */
async function windowsProcesses(): Promise<EditorProcess[]> {
  if (process.platform !== 'win32') return []
  return await new Promise((resolve, reject) => {
    const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name LIKE 'UnrealEditor%'\" | Select-Object ProcessId,Name,CommandLine,ExecutablePath,@{n='StartedAt';e={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }}} | ConvertTo-Json -Compress"], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', data => { stdout += String(data) })
    // A listing that failed is not an empty listing: an editor may still be running, so the caller must not read it as "gone".
    child.once('error', error => reject(error))
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`the process listing exited with ${code ?? 'no code'}`)); return }
      try {
        const parsed = JSON.parse(stdout.trim() || '[]') as unknown
        const rows = Array.isArray(parsed) ? parsed : [parsed]
        resolve(rows.flatMap(row => {
          const item = row as { ProcessId?: number; Name?: string; CommandLine?: string; ExecutablePath?: string; StartedAt?: string }
          return Number.isSafeInteger(item.ProcessId) ? [{ pid: item.ProcessId!, name: item.Name ?? '', commandLine: item.CommandLine ?? '', executablePath: item.ExecutablePath ?? '',
            ...item.StartedAt ? { startedAt: item.StartedAt } : {} }] : []
        }))
      } catch (error) { reject(new Error(`the process listing could not be read: ${error instanceof Error ? error.message : String(error)}`)) }
    })
  })
}

/** Stop one process by PID and wait for it to be gone; the editor is a Windows process, so this is `Stop-Process -Id`. */
async function stopProcess(pid: number, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`not a process id: ${pid}`)
  await new Promise<void>((resolve, reject) => {
    // The PID is an integer checked above, so it is the only thing the command carries; the process is waited for, and a
    // process that is still there afterwards is an error, never a success.
    const command = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id ${pid} -Force -ErrorAction Stop; `
      + `if (-not $p.WaitForExit(30000)) { exit 3 } }; exit 0`
    const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'], signal })
    let stderr = ''
    child.stderr.on('data', data => { stderr += String(data) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`stopping the TP editor pid ${pid} failed (exit ${code ?? 'none'}): ${stderr.trim().slice(0, 300)}`)))
  })
}

/** Whether the TPMcp port is listening, read from the TCP table rather than an assumed listener. */
async function listeningPorts(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  return await new Promise(resolve => {
    const child = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe'), ['-ano', '-p', 'TCP'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', data => { stdout += String(data) })
    child.once('error', () => resolve([]))
    child.once('close', () => resolve(stdout.split(/\r?\n/)))
  })
}

/**
 * The recovery adapter. One instance lives with the deployment; it remembers which ticket started
 * an editor, so finishing that ticket stops exactly what it started.
 */
export class TpEditorRecovery {
  private readonly started = new Map<string, number>()
  private readonly startedAt = new Map<string, string>()
  private readonly now: () => string
  constructor(private readonly settings: () => RecoverySettings, private readonly deps: RecoveryDeps = {}, private readonly stateDir: string) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** Whether recovery is configured at all; false keeps an unreachable editor `unavailable`, as phase B did. */
  enabled(): boolean { return this.settings().enabled && !!this.settings().environment }

  /** Whether this deployment can act on a ticket: it needs a Windows host and the configured environment. */
  private usable(): { ok: true; environment: TpEditorEnvironment } | { ok: false; reason: string } {
    const settings = this.settings()
    if (!settings.enabled || !settings.environment) return { ok: false, reason: 'TP editor recovery is not configured for this deployment; strict acceptance requires an operator with DSH_SUPERAGENT_EDITOR_RECOVERY' }
    if ((this.deps.platform ?? process.platform) !== 'win32') return { ok: false, reason: 'TP editor recovery needs a Windows host' }
    const environment = settings.environment
    if (!path.isAbsolute(environment.projectFile) || !existsSync(environment.projectFile)) return { ok: false, reason: `The TP project file is missing or not absolute: ${environment.projectFile}` }
    if (!path.isAbsolute(environment.editorExe)) return { ok: false, reason: `The TP editor executable must be an absolute path: ${environment.editorExe}` }
    if (!Number.isSafeInteger(environment.port) || environment.port < 1 || environment.port > 65535) return { ok: false, reason: `Invalid TPMcp port: ${environment.port}` }
    if (!environment.captureTool.trim()) return { ok: false, reason: 'A capture tool name is required for readiness' }
    return { ok: true, environment }
  }

  private processes(): Promise<EditorProcess[]> {
    if (!this.deps.processList) return windowsProcesses()
    return this.deps.processList()
  }

  private busy(port: number): Promise<boolean> {
    if (!this.deps.listening) return listeningPorts().then(lines => portOwner(lines, port) !== undefined)
    return this.deps.listening()
  }

  private async exclusive(environment: TpEditorEnvironment, ticketId: string, signal: AbortSignal): Promise<ExclusiveLease> {
    if (this.deps.exclusive) return await this.deps.exclusive(environment, ticketId, signal)
    // Phase 2 C: the recovery borrows the deployment's one environment lock; it never writes a second.
    if (this.deps.port) return await this.deps.port.borrow(ticketId, signal)
    return await fileExclusivity(this.stateDir)(environment, ticketId, signal)
  }

  /**
   * Recover the TP environment for one ticket, at most once. The exclusivity is taken before anything
   * looks at a process, so a recovery never races another ticket or an ordinary Session. On any
   * failure the result is `unavailable` with the concrete reason; the caller records an environment
   * block and does not try again.
   */
  async recover(ticketId: string, prior: TicketRecoveryRecord | undefined, signal: AbortSignal): Promise<RecoveryOutcome> {
    const at = this.now()
    const refused = (reason: string): RecoveryOutcome => ({ kind: 'unavailable', attempted: false, reason, tools: [], portListened: false, at })
    if (prior && prior.attempts >= 1) return refused(`This ticket already used its one TP editor recovery: ${prior.outcome?.reason || prior.outcome?.kind || 'no detail'}`)
    const usable = this.usable()
    if (!usable.ok) return refused(usable.reason)
    const environment = usable.environment
    let lease: ExclusiveLease
    try { lease = await this.exclusive(environment, ticketId, signal) } catch (error) {
      return refused(`TP environment exclusivity was not obtained: ${error instanceof Error ? error.message : String(error)}`)
    }
    let startedPid: number | undefined
    try {
      const check = await this.handshake(environment, signal)
      if (check.ready) {
        const editors = await this.processes()
        const owner = await this.portOwner(environment)
        // A ready endpoint must belong to this TP editor: another project's listener is not TP's MCP.
        const ownerPid = owner.find(pid => portOwnedBy(pid, editors, environment.projectFile))
        if (ownerPid === undefined) {
          return { kind: 'unavailable', attempted: true, reason: `TPMcp answered on port ${environment.port} but no TP editor of ${environment.projectFile} owns it`, tools: check.tools, portListened: true, sessionId: check.sessionId, at }
        }
        // A reused editor is the holder's: this deployment did not start it, so its lease records none.
        this.deps.recordStarted?.(ticketId, -1)
        return { kind: 'reused', attempted: true, reason: '', pid: ownerPid, sessionId: check.sessionId, tools: check.tools, portListened: true, at }
      }
      // A listening port owned by a non-TP process is not TP's to restart; leave it and report the block.
      // This is checked before any cleanup so another UE project's editor is never stopped.
      if (check.listened) {
        const owner = await this.portOwner(environment)
        const editors = await this.processes()
        if (owner.length && !owner.some(pid => portOwnedBy(pid, editors, environment.projectFile))) {
          return { kind: 'unavailable', attempted: true, reason: `Port ${environment.port} is held by a process that is not this TP editor`, tools: check.tools, portListened: true, sessionId: check.sessionId, at }
        }
      }
      // Only the TP editor is stopped: the delegated script matches the absolute `.uproject` alone.
      await this.kill(environment, undefined, signal)
      startedPid = await this.launch(environment, signal)
      const recovered = await this.handshake(environment, signal)
      if (!recovered.ready) {
        return { kind: 'unavailable', attempted: true, reason: `The TP editor started as pid ${startedPid} but ${recovered.reason}`, pid: startedPid, startedPid, tools: recovered.tools, portListened: recovered.listened, sessionId: recovered.sessionId, at }
      }
      const editors = await this.processes()
      const owner = await this.portOwner(environment)
      const mine = editors.some(editor => editor.pid === startedPid && isTpEditorProcess(editor, environment.projectFile))
      // The port owner can be a helper process of the same editor; the launched PID must be the TP editor.
      if (!mine || (owner.length && !owner.includes(startedPid) && !portOwnedBy(owner[0], editors, environment.projectFile))) {
        // Whatever answered, it is not the editor this recovery started.
        return { kind: 'unavailable', attempted: true, reason: `The MCP endpoint answered but PID ${startedPid} is not the TP editor serving it`, pid: startedPid, startedPid, tools: recovered.tools, portListened: true, sessionId: recovered.sessionId, at }
      }
      this.started.set(ticketId, startedPid)
      const seen = editors.find(editor => editor.pid === startedPid)?.startedAt
      if (seen) this.startedAt.set(ticketId, seen)
      // Phase 2 C: the holder's lease records the editor this deployment started, so a restart still
      // knows what to stop, and no other ticket's recovery adopts it.
      const launched = editors.find(editor => editor.pid === startedPid)
      this.deps.recordStarted?.(ticketId, startedPid, launched?.startedAt)
      return { kind: 'recovered', attempted: true, reason: '', pid: startedPid, startedPid, sessionId: recovered.sessionId, tools: recovered.tools, portListened: recovered.listened, at }
    } catch (error) {
      return { kind: 'unavailable', attempted: true, reason: error instanceof Error ? error.message : String(error), pid: startedPid, startedPid, tools: [], portListened: false, at }
    } finally {
      await lease.release().catch(() => undefined)
    }
  }

  /** Whether this adapter's recovery started an editor for the ticket (or a restarted host still owns one it recorded). */
  owns(ticketId: string): boolean {
    if (this.started.has(ticketId)) return true
    const recorded = Number(this.deps.recordedPid?.(ticketId) ?? 0)
    return Number.isSafeInteger(recorded) && recorded > 0
  }

  /** Stop the TP editor a ticket's recovery started; only that PID, only when it is still this project's editor. */
  async cleanup(ticketId: string, environment: TpEditorEnvironment): Promise<void> {
    const remembered = this.started.get(ticketId)
    // A restarted host has only the holder's lease: the PID it recorded is the editor it started.
    const recorded = Number(this.deps.recordedPid?.(ticketId) ?? 0)
    const pid = remembered ?? (Number.isSafeInteger(recorded) && recorded > 0 ? recorded : undefined)
    if (!pid) return
    // A failed stop throws and keeps the ownership: the caller must not give the environment to another holder.
    await this.stopStarted(environment, pid, this.startedAt.get(ticketId) ?? this.deps.recordedStart?.(ticketId), new AbortController().signal)
    this.started.delete(ticketId)
    this.startedAt.delete(ticketId)
  }

  /**
   * Stop exactly the editor this deployment started: the PID is listed again, must still be this project's editor and, when its
   * start time was recorded, must be the same process; then that one PID is stopped. A listing that fails, a PID whose start time
   * differs (reused) or one without a recorded start time that is still alive all refuse: the lock stays with the ticket.
   * A PID that is gone is done.
   */
  private async stopStarted(environment: TpEditorEnvironment, pid: number, startedAt: string | undefined, signal: AbortSignal): Promise<void> {
    if (this.deps.killEditor) return await this.deps.killEditor(environment, pid, signal)
    const editor = (await this.processes()).find(candidate => candidate.pid === pid)
    if (!editor) return
    if (!isTpEditorProcess(editor, environment.projectFile)) return
    if (!startedAt || !editor.startedAt) throw new Error(`the TP editor pid ${pid} is still running but its start was not recorded, so it cannot be proven to be the one this ticket started; stop it by hand`)
    if (new Date(editor.startedAt).getTime() !== new Date(startedAt).getTime()) return
    await (this.deps.stopProcess ?? stopProcess)(pid, signal)
  }

  private async kill(environment: TpEditorEnvironment, pid: number | undefined, signal: AbortSignal): Promise<void> {
    if (this.deps.killEditor) return await this.deps.killEditor(environment, pid, signal)
    // `kill-tp-editor.ps1` acts on every TP editor of this absolute `.uproject` and on nothing else,
    // so it is the delegated cleanup for both "replace the TP editor" and "stop what we started".
    // A PID is only a precondition here: when it is no longer the TP editor's, nothing is stopped.
    if (pid) {
      const editors = await this.processes()
      const editor = editors.find(candidate => candidate.pid === pid)
      if (!editor || !isTpEditorProcess(editor, environment.projectFile)) return
    }
    const { kill } = defaultDelegate(environment)
    const result = await runPowerShell(kill, ['-ProjectFile', environment.projectFile, '-WaitSeconds', '30'], 120_000, signal)
    if (result.code !== 0) throw new Error(`kill-tp-editor.ps1 exited with ${result.code ?? 'no code'}: ${result.stderr.trim().slice(0, 500)}`)
  }

  private async launch(environment: TpEditorEnvironment, signal: AbortSignal): Promise<number> {
    if (this.deps.launch) return await this.deps.launch(environment, signal)
    const { launch } = defaultDelegate(environment)
    const result = await runPowerShell(launch, ['-EditorExe', environment.editorExe, '-ProjectFile', environment.projectFile], 120_000, signal)
    const pid = /PID=(\d+)/.exec(result.stdout)?.[1]
    if (result.code !== 0 || !pid) throw new Error(`launch-tp-editor.ps1 did not start the editor: ${(result.stderr || result.stdout).trim().slice(0, 500) || 'no output'}`)
    return Number(pid)
  }

  private async handshake(environment: TpEditorEnvironment, signal: AbortSignal): Promise<ReadinessCheck> {
    if (this.deps.handshake) return await this.deps.handshake(environment, signal)
    const { wait } = defaultDelegate(environment)
    const waitSeconds = environment.waitSeconds ?? 300
    const result = await runPowerShell(wait, ['-Port', String(environment.port), '-TimeoutSec', String(waitSeconds)], (waitSeconds + 60) * 1000, signal)
    const endpoint = `http://127.0.0.1:${environment.port}/mcp`
    if (result.code !== 0) {
      const listened = await this.busy(environment.port)
      return readinessOf({ listened, endpoint, sessionId: '', tools: [], reason: `wait-tp-mcp.ps1 did not reach readiness in ${waitSeconds}s${listened ? ' (the port listened but the handshake never completed)' : ''}` }, environment.captureTool)
    }
    return await this.listTools(endpoint, environment, signal)
  }

  /** A real `initialize` + `tools/list` over MCP, then the capture tool's own toolset when TPMcp dispatches. */
  private async listTools(endpoint: string, environment: TpEditorEnvironment, signal: AbortSignal): Promise<ReadinessCheck> {
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
    const client = new Client({ name: 'dsh-superagent-recovery', version: '0.1.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
      const listed = await client.listTools(undefined, { timeout: 20_000, signal })
      const tools = (listed.tools ?? []).map(tool => tool.name)
      const toolset = environment.captureToolset
      let visible = tools
      if (toolset && tools.includes(DISPATCH_TOOL) && !tools.some(name => name.endsWith(`.${environment.captureTool}`))) {
        // TPMcp names its toolsets; a toolset that describes itself is reachable through the dispatcher.
        const described = await client.callTool({ name: DISPATCH_TOOL, arguments: { toolset_name: toolset, tool_name: 'describe_toolset', arguments: { toolset_name: toolset } } }, { timeout: 20_000, signal })
        const text = ((described as { content?: { type?: string; text?: string }[] }).content ?? []).filter(block => block.type === 'text').map(block => block.text).join(' ')
        if (!text.includes(toolset)) return readinessOf({ listened: true, endpoint, sessionId: 'mcp', tools, reason: `${toolset} did not describe itself through ${DISPATCH_TOOL}: ${text.slice(0, 300)}` }, environment.captureTool)
        visible = [...tools, `${toolset}.${environment.captureTool}`]
      }
      const sessionId = String((client as unknown as { transport?: { sessionId?: string } }).transport?.sessionId ?? 'mcp')
      return readinessOf({ listened: true, endpoint, sessionId, tools: visible }, environment.captureTool)
    } catch (error) {
      const listened = await this.busy(Number(new URL(endpoint).port))
      return readinessOf({ listened, endpoint, sessionId: '', tools: [], reason: `MCP handshake failed at ${endpoint}: ${error instanceof Error ? error.message : String(error)}` }, environment.captureTool)
    } finally { await client.close().catch(() => undefined) }
  }

  /** The PIDs the TPMcp port listens on, empty when the owner cannot be attributed. */
  private async portOwner(environment: TpEditorEnvironment): Promise<number[]> {
    const lines = this.deps.portTable ? await this.deps.portTable() : await listeningPorts()
    const owner = portOwner(lines, environment.port)
    return owner ? [owner] : []
  }

  /** Whether an exclusive lock file still exists (test/observability aid; never a freshness claim). */
  exclusivityPath(): string { return path.join(this.stateDir, EXCLUSIVITY_FILE) }
}
