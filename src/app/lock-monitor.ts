/** Periodic script-backed liveness monitor for tickets holding TP environment or source-checkout locks. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { advanceBlockedCode, canAdvanceTicket, key, latestAssignment, latestReport, liveTicket, runningAssignment, ticketStage,
  type AdvanceBlockCode, type Ticket } from '../core/index.ts'
import { runningJobs } from '../executor/background.ts'
import { workerSessionId } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { packagePath } from '../infra/paths.ts'
import { ticketCard } from './cards.ts'
import type { Effects } from './effects.ts'
import { EXCLUSIVITY_FILE, type EnvironmentExclusivity, type EnvironmentLeaseRecord } from './environment-exclusive.ts'
import type { BudgetRetryStatus } from './retry-health.ts'
import type { Sessions } from './sessions.ts'
import type { SourceLockStatus } from './source-lock.ts'
import type { Store } from './store.ts'

const execFileAsync = promisify(execFile)

/** Default sweep interval when checking whether any lock is held. */
export const LOCK_MONITOR_EVERY_MS = 60_000
/** Minimum cooldown before re-alerting the main Session for an unchanged stalled/dead lock state. */
export const LOCK_ALERT_COOLDOWN_MS = 10 * 60_000
/** Timeout for running the external lock-check script subprocess. */
const SCRIPT_TIMEOUT_MS = 15_000

export const DEFAULT_LOCK_THRESHOLDS = {
  turnSilentMs: 15 * 60_000,
  toolSilentMs: 30 * 60_000,
  launchStalledMs: 5 * 60_000,
  idleGraceMs: 60_000,
  endedGraceMs: 60_000,
} as const

export type LockKind = 'tp-environment.lock' | 'tp-source-operation.lock'
export type LockOwnerStatus = 'unlocked' | 'alive' | 'stalled' | 'dead'

export interface LockTicketDiagnostics {
  ticket_id: string
  title: string
  state: string
  can_advance: boolean
  advance_blocked?: AdvanceBlockCode
  assignment_id?: string
  assignment_state?: string
  report_state?: string
  report_at?: string
  worker_status: 'missing' | 'idle' | 'running'
  running_jobs: number
  subagents_count: number
  open_tool_calls: number
  model_retry?: BudgetRetryStatus
  last_activity_at?: string
  quiet_ms?: number
}

export interface LockCheckItem {
  lock: LockKind
  file: string
  status: Exclude<LockOwnerStatus, 'unlocked'>
  reasonCode: string
  detail: string
  holder: {
    kind: 'ticket' | 'session' | 'operation'
    id?: string
    label?: string
    pid?: number
    pidAlive?: boolean
    host?: string
    acquiredAt?: string
    heartbeat?: string
    editorPid?: number
    editorPidAlive?: boolean
    op?: string
  }
  ticket?: LockTicketDiagnostics
}

export interface LockMonitorIssue {
  lock: LockKind
  status: 'stalled' | 'dead'
  reasonCode: string
  detail: string
  ticketId?: string
  holderLabel?: string
  canAdvance?: boolean
  stateSignature: string
}

export interface LockMonitorReport {
  checkedAt: string
  status: LockOwnerStatus
  locked: boolean
  locks: LockCheckItem[]
  issues: LockMonitorIssue[]
}

export interface LockEvaluateInput {
  envRecord?: EnvironmentLeaseRecord
  envLive: boolean
  envFile?: string
  sourceLock?: SourceLockStatus
  store: Pick<Store, 'tickets'>
  context: Context
  effects?: Pick<Effects, 'pending'>
  modelRetry?: (sessionId: string) => { model_retry?: BudgetRetryStatus }
  alive?: (pid: number) => boolean
  nowMs?: number
  thresholds?: Partial<typeof DEFAULT_LOCK_THRESHOLDS>
}

export interface LockMonitorHost {
  readonly context: Context
  readonly store: Pick<Store, 'tickets'>
  readonly sessions: Pick<Sessions, 'relay'>
  readonly health: HealthEntry
  readonly stateDir: string
  sourceRoot?: () => string | undefined
  webPort?: () => number | undefined
  envBroker?: () => Pick<EnvironmentExclusivity, 'read' | 'liveRecord' | 'file'> | undefined
  sourceLock?: () => SourceLockStatus
  inspectLocks?: () => Promise<LockMonitorReport>
  runScript?: (args: readonly string[], signal?: AbortSignal) => Promise<LockMonitorReport>
  configured(): boolean
  paused(): boolean
  closing(): boolean
  now?(): number
  sweepEveryMs?: number
  alertCooldownMs?: number
}

interface SubagentsService {
  listDescendants?(rootSessionId: SessionId): Promise<readonly { id: string; activity?: string }[]>
  listChildren?(parentSessionId: string): Promise<readonly { id: string; activity?: string }[]>
}

const defaultAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as { code?: string })?.code === 'EPERM' }
}

function parseMs(value: string | undefined): number {
  if (!value) return NaN
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : NaN
}

async function activeSubagentCount(ctx: Context, sessionId: string): Promise<number> {
  const subagents = ctx.get('subagents') as SubagentsService | undefined
  if (!subagents) return 0
  try {
    const children = subagents.listDescendants
      ? await subagents.listDescendants(sessionId as SessionId)
      : await subagents.listChildren?.(sessionId) ?? []
    return children.filter(child => {
      const childAgent = ctx.agents?.get(child.id as SessionId)
      return childAgent ? childAgent.status !== 'idle' : child.activity === 'running'
    }).length
  } catch {
    return 0
  }
}

function sessionActivity(agent: Agent | undefined): { lastEventMs: number; openToolCalls: number } {
  const events = agent?.session?.snapshotEvents?.() ?? []
  let lastEventMs = NaN
  const openCalls = new Set<string>()
  for (const event of events) {
    if (typeof event.time === 'number' && Number.isFinite(event.time)) {
      lastEventMs = Number.isFinite(lastEventMs) ? Math.max(lastEventMs, event.time) : event.time
    }
    if (event.type === 'tool/call') openCalls.add(event.data.callId)
    else if (event.type === 'tool/result') openCalls.delete(event.data.message.toolCallId)
    else if (event.type === 'turn/end') openCalls.clear()
  }
  return { lastEventMs, openToolCalls: openCalls.size }
}

function signatureOf(ticket: Ticket | undefined, item: LockCheckItem): string {
  if (!ticket) return `${item.holder.id ?? ''}:${item.holder.pid ?? ''}:${item.holder.acquiredAt ?? ''}`
  const latest = latestAssignment(ticket)
  return [ticket.updatedAt, latest?.id ?? '', latest?.state ?? '', latest?.report?.at ?? '', item.ticket?.worker_status ?? ''].join('|')
}

function toIssue(item: LockCheckItem, ticket?: Ticket): LockMonitorIssue | undefined {
  if (item.status === 'alive') return undefined
  return {
    lock: item.lock,
    status: item.status,
    reasonCode: item.reasonCode,
    detail: item.detail,
    ...(item.ticket ? { ticketId: item.ticket.ticket_id, canAdvance: item.ticket.can_advance } : item.holder.kind === 'ticket' && item.holder.id ? { ticketId: item.holder.id } : {}),
    ...(item.holder.label ? { holderLabel: item.holder.label } : {}),
    stateSignature: signatureOf(ticket, item),
  }
}

/** Evaluates current environment and source-checkout locks and determines whether any lock-holding ticket is dead or stalled. */
export async function evaluateLockMonitor(input: LockEvaluateInput): Promise<LockMonitorReport> {
  const nowMs = input.nowMs ?? Date.now()
  const thresholds = { ...DEFAULT_LOCK_THRESHOLDS, ...input.thresholds }
  const alive = input.alive ?? defaultAlive
  const locks: LockCheckItem[] = []
  const issues: LockMonitorIssue[] = []

  if (input.envRecord) {
    const record = input.envRecord
    const file = input.envFile ?? EXCLUSIVITY_FILE
    const rawEditorPid = record.facts?.editorPid && /^\d+$/.test(record.facts.editorPid) ? Number(record.facts.editorPid) : undefined
    const editorPidAlive = rawEditorPid !== undefined ? alive(rawEditorPid) : undefined
    const holderBase: LockCheckItem['holder'] = {
      kind: record.holder.kind,
      id: record.holder.id,
      label: record.holder.label,
      pid: record.pid,
      pidAlive: input.envLive,
      ...(record.host ? { host: record.host } : {}),
      acquiredAt: record.acquiredAt,
      heartbeat: record.heartbeat,
      ...(rawEditorPid !== undefined ? { editorPid: rawEditorPid, editorPidAlive } : {}),
    }

    if (record.holder.kind === 'session') {
      const recoveryBorrow = record.holder.id.startsWith('editor-recovery:')
      const acquiredMs = parseMs(record.acquiredAt)
      const staleBorrow = recoveryBorrow && Number.isFinite(acquiredMs) && nowMs - acquiredMs >= thresholds.turnSilentMs
      const status: LockCheckItem['status'] = !input.envLive ? 'dead' : staleBorrow ? 'stalled' : 'alive'
      const reasonCode = !input.envLive ? 'lock_pid_dead' : staleBorrow ? 'recovery_borrow_stale' : 'session_lock_alive'
      const detail = !input.envLive
        ? `TP environment lock writer PID ${record.pid} is dead (session ${record.holder.label})`
        : staleBorrow
          ? `Editor recovery borrow ${record.holder.id} has held tp-environment.lock since ${record.acquiredAt}`
          : `TP environment is held by live session ${record.holder.label} (PID ${record.pid})`
      const item: LockCheckItem = { lock: 'tp-environment.lock', file, status, reasonCode, detail, holder: holderBase }
      locks.push(item)
      const issue = toIssue(item)
      if (issue) issues.push(issue)
    } else {
      const ticket = input.store.tickets.get(record.holder.id)
      if (!ticket) {
        const item: LockCheckItem = {
          lock: 'tp-environment.lock', file, status: 'dead', reasonCode: 'ticket_missing',
          detail: `Ticket ${record.holder.id} holding tp-environment.lock was not found in store`,
          holder: holderBase,
        }
        locks.push(item)
        issues.push(toIssue(item)!)
      } else if (ticket.ended) {
        const endedMs = parseMs(ticket.ended.at)
        const forDelivery = record.facts?.purpose === 'delivery' && ticket.ended.outcome === 'completed'
        const pastGrace = !Number.isFinite(endedMs) || nowMs - endedMs >= thresholds.endedGraceMs
        const status: LockCheckItem['status'] = !input.envLive ? 'dead' : forDelivery ? 'alive' : pastGrace ? 'dead' : 'alive'
        const reasonCode = !input.envLive ? 'lock_pid_dead' : forDelivery ? 'delivery_lock_held' : pastGrace ? 'ticket_ended' : 'ticket_ending_cleanup'
        const detail = !input.envLive
          ? `Ended ticket ${ticket.id.slice(0, 8)} holds tp-environment.lock with dead PID ${record.pid}`
          : forDelivery
            ? `Completed ticket ${ticket.id.slice(0, 8)} holds tp-environment.lock for delivery`
            : pastGrace
              ? `Ticket ${ticket.id.slice(0, 8)} already ended (${ticket.ended.outcome}) at ${ticket.ended.at} but still holds tp-environment.lock`
              : `Ended ticket ${ticket.id.slice(0, 8)} is finishing environment release`
        const item: LockCheckItem = { lock: 'tp-environment.lock', file, status, reasonCode, detail, holder: holderBase }
        locks.push(item)
        const issue = toIssue(item, ticket)
        if (issue) issues.push(issue)
      } else if (liveTicket(ticket)) {
        const card = ticketCard(ticket)
        const stage = ticketStage(ticket)
        const latest = latestAssignment(ticket)
        const running = runningAssignment(ticket)
        const report = latestReport(ticket)
        const sessionId = workerSessionId(ticket.id)
        const agent = input.context.agents?.get(sessionId as SessionId) as Agent | undefined
        const jobs = runningJobs(input.context, sessionId)
        const subagentsCount = await activeSubagentCount(input.context, sessionId)
        const retry = input.modelRetry?.(sessionId)?.model_retry
        const { lastEventMs, openToolCalls } = sessionActivity(agent)
        const timestamps = [
          lastEventMs,
          parseMs(latest?.report?.at),
          parseMs(latest?.startedAt),
          parseMs(latest?.deliveredAt),
          parseMs(ticket.updatedAt),
        ].filter(Number.isFinite)
        const lastActivityMs = timestamps.length ? Math.max(...timestamps) : NaN
        const quietMs = Number.isFinite(lastActivityMs) ? Math.max(0, nowMs - lastActivityMs) : undefined
        const canAdvance = canAdvanceTicket(ticket)
        const advanceBlocked = advanceBlockedCode(ticket)
        const workerStatus: LockTicketDiagnostics['worker_status'] = !agent ? 'missing' : agent.status === 'running' ? 'running' : 'idle'

        let status: LockCheckItem['status'] = 'alive'
        let reasonCode = 'alive'
        let detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} (${card.state}) is active`

        if (!input.envLive) {
          status = 'dead'; reasonCode = 'lock_pid_dead'
          detail = `Ticket ${ticket.id.slice(0, 8)} holds tp-environment.lock with dead host PID ${record.pid}`
        } else if (retry) {
          status = 'stalled'; reasonCode = 'worker_model_budget_retry'
          detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} is stuck on ${retry.provider} model budget retry (${retry.attempts} attempts since ${retry.since})`
        } else if (stage.stage === 'person') {
          if (stage.action === 'failed') {
            status = 'dead'; reasonCode = 'worker_failed_holding_lock'
            detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} is in person/failed while holding tp-environment.lock`
          } else if (stage.action === 'blocked') {
            status = 'stalled'; reasonCode = 'worker_blocked_holding_lock'
            detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} is in person/blocked while holding tp-environment.lock`
          } else if (stage.action === 'delivery') {
            status = 'stalled'; reasonCode = 'worker_delivery_failed'
            detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} hit input delivery failure while holding tp-environment.lock`
          } else if (stage.action === 'review') {
            status = 'stalled'; reasonCode = 'worker_ready_holding_lock'
            detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} reported ${report?.completion ?? 'ready'} while still holding tp-environment.lock`
          } else if (quietMs !== undefined && quietMs >= thresholds.idleGraceMs) {
            status = 'stalled'; reasonCode = 'worker_waiting_answer_holding_lock'
            detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} is waiting for an answer while holding tp-environment.lock`
          }
        } else if (stage.stage === 'idle') {
          if (agent?.status !== 'running' && jobs.length === 0 && subagentsCount === 0
            && (quietMs === undefined || quietMs >= thresholds.idleGraceMs)) {
            status = 'dead'; reasonCode = 'worker_idle_holding_lock'
            detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} ended its turn idle without releasing tp-environment.lock`
          }
        } else if (stage.stage === 'working') {
          if (!running || stage.action === 'queued') {
            const pendingSince = parseMs(latest?.createdAt ?? ticket.updatedAt)
            const pendingAge = Number.isFinite(pendingSince) ? nowMs - pendingSince : 0
            if (pendingAge >= thresholds.launchStalledMs) {
              status = 'stalled'; reasonCode = 'worker_launch_stalled'
              detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} has remained queued (${Math.round(pendingAge / 60_000)}m) without a running worker`
            }
          } else if (!agent) {
            const launchPending = !!input.effects?.pending?.('launch', running.id)
            const createdMs = parseMs(running.createdAt)
            const age = Number.isFinite(createdMs) ? nowMs - createdMs : Infinity
            if (!launchPending || age >= thresholds.launchStalledMs) {
              status = 'dead'; reasonCode = 'worker_session_dead'
              detail = `Worker session ${sessionId} is missing while assignment ${running.id} is running and holds tp-environment.lock`
            }
          } else if (agent.status === 'idle') {
            const delivering = !!input.effects?.pending?.('delivery', ticket.id)
            if (jobs.length === 0 && subagentsCount === 0 && !delivering
              && (quietMs === undefined || quietMs >= thresholds.idleGraceMs)) {
              status = 'dead'; reasonCode = 'worker_session_dead'
              detail = `Worker session ${sessionId} is idle with no active background jobs or subagents while assignment ${running.id} is marked running`
            }
          } else if (jobs.length === 0 && subagentsCount === 0 && quietMs !== undefined) {
            const limit = openToolCalls > 0 ? thresholds.toolSilentMs : thresholds.turnSilentMs
            if (quietMs >= limit) {
              status = 'stalled'; reasonCode = openToolCalls > 0 ? 'worker_tool_hung' : 'worker_turn_silent'
              detail = `Worker session ${sessionId} has produced no activity for ${Math.round(quietMs / 60_000)}m while holding tp-environment.lock`
            }
          }
        }

        const item: LockCheckItem = {
          lock: 'tp-environment.lock',
          file,
          status,
          reasonCode,
          detail,
          holder: holderBase,
          ticket: {
            ticket_id: ticket.id,
            title: ticket.title,
            state: card.state,
            can_advance: canAdvance,
            ...(advanceBlocked ? { advance_blocked: advanceBlocked } : {}),
            ...(latest ? { assignment_id: latest.id, assignment_state: latest.state } : {}),
            ...(report ? { report_state: report.state, report_at: report.at } : {}),
            worker_status: workerStatus,
            running_jobs: jobs.length,
            subagents_count: subagentsCount,
            open_tool_calls: openToolCalls,
            ...(retry ? { model_retry: retry } : {}),
            ...(Number.isFinite(lastActivityMs) ? { last_activity_at: new Date(lastActivityMs).toISOString() } : {}),
            ...(quietMs !== undefined ? { quiet_ms: quietMs } : {}),
          },
        }
        locks.push(item)
        const issue = toIssue(item, ticket)
        if (issue) issues.push(issue)
      }
    }
  }

  if (input.sourceLock?.locked) {
    const src = input.sourceLock
    const holderTicket = src.holder?.ticket ? input.store.tickets.get(src.holder.ticket) : undefined
    const endedMs = holderTicket?.ended ? parseMs(holderTicket.ended.at) : NaN
    // Finalize legitimately runs on an ended ticket; only non-finalize ops on ended tickets past grace are orphaned.
    const ticketEndedPastGrace = src.holder?.op !== 'finalize' && !!holderTicket?.ended
      && (!Number.isFinite(endedMs) || nowMs - endedMs >= thresholds.endedGraceMs)
    const status: LockCheckItem['status'] = src.pidAlive === false ? 'dead' : (src.stale || ticketEndedPastGrace) ? 'stalled' : 'alive'
    const reasonCode = src.pidAlive === false ? 'source_lock_dead_pid'
      : ticketEndedPastGrace ? 'source_lock_ended_ticket'
      : src.stale ? 'source_lock_stale'
      : 'source_lock_active'
    const detail = src.pidAlive === false
      ? `Source checkout lock (${src.holder?.op ?? 'unknown'}) is held by dead PID ${src.holder?.pid ?? '?'}`
      : ticketEndedPastGrace
        ? `Source checkout lock (${src.holder?.op ?? 'unknown'}) references ended ticket ${holderTicket!.id.slice(0, 8)}`
        : src.stale
          ? `Source checkout lock (${src.holder?.op ?? 'unknown'}) is stale since ${src.holder?.at ?? 'unknown'}`
          : `Source checkout lock (${src.holder?.op ?? 'unknown'}) is active`
    const item: LockCheckItem = {
      lock: 'tp-source-operation.lock',
      file: src.file ?? 'tp-source-operation.lock',
      status,
      reasonCode,
      detail,
      holder: {
        kind: src.holder?.ticket ? 'ticket' : 'operation',
        ...(src.holder?.ticket ? { id: src.holder.ticket, label: holderTicket?.title ?? src.holder.ticket } : {}),
        ...(src.holder?.pid !== undefined ? { pid: src.holder.pid } : {}),
        ...(src.pidAlive !== undefined ? { pidAlive: src.pidAlive } : {}),
        ...(src.holder?.host ? { host: src.holder.host } : {}),
        ...(src.holder?.at ? { acquiredAt: src.holder.at } : {}),
        ...(src.holder?.op ? { op: src.holder.op } : {}),
      },
      ...(holderTicket ? {
        ticket: {
          ticket_id: holderTicket.id,
          title: holderTicket.title,
          state: ticketCard(holderTicket).state,
          can_advance: canAdvanceTicket(holderTicket),
          ...(advanceBlockedCode(holderTicket) ? { advance_blocked: advanceBlockedCode(holderTicket) } : {}),
          worker_status: 'missing',
          running_jobs: 0,
          subagents_count: 0,
          open_tool_calls: 0,
        },
      } : {}),
    }
    locks.push(item)
    const issue = toIssue(item, holderTicket)
    if (issue) issues.push(issue)
  }

  const status: LockOwnerStatus = !locks.length ? 'unlocked'
    : locks.some(item => item.status === 'dead') ? 'dead'
    : locks.some(item => item.status === 'stalled') ? 'stalled'
    : 'alive'

  return {
    checkedAt: new Date(nowMs).toISOString(),
    status,
    locked: locks.length > 0,
    locks,
    issues,
  }
}

/** Runs `scripts/check-lock-owner.mjs` in a real Node subprocess and parses its JSON verdict. */
export async function runLockCheckScript(args: readonly string[], signal?: AbortSignal): Promise<LockMonitorReport> {
  const script = packagePath('scripts', 'check-lock-owner.mjs')
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(SCRIPT_TIMEOUT_MS)]) : AbortSignal.timeout(SCRIPT_TIMEOUT_MS)
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      signal: combined,
    })
    return JSON.parse(stdout) as LockMonitorReport
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string }
    // Exit code 2 means the script succeeded and detected a dead or stalled lock holder.
    if (failed.code === 2 && typeof failed.stdout === 'string' && failed.stdout.trim()) {
      return JSON.parse(failed.stdout) as LockMonitorReport
    }
    const detail = typeof failed.stderr === 'string' && failed.stderr.trim() ? failed.stderr.trim() : (failed.message ?? String(error))
    throw new Error(`check-lock-owner.mjs failed: ${detail}`)
  }
}

/**
 * Periodically watches TP environment and source-checkout locks: stays idle when no lock is held,
 * invokes `scripts/check-lock-owner.mjs` whenever a lock exists, updates `lockMonitor` health, and wakes the main Session on dead/stalled holders.
 */
export class LockOwnerMonitor {
  private timer?: ReturnType<typeof setInterval>
  private ticking?: Promise<LockMonitorReport | undefined>
  private readonly alerted = new Map<string, { at: number; signature: string }>()
  private latest?: LockMonitorReport

  constructor(private readonly host: LockMonitorHost) {}

  start(): void {
    if (this.timer || this.host.closing()) return
    const every = Math.max(1000, this.host.sweepEveryMs ?? LOCK_MONITOR_EVERY_MS)
    this.timer = setInterval(() => { void this.tick() }, every)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.ticking
  }

  lastReport(): LockMonitorReport | undefined {
    return this.latest
  }

  private lockPresent(): boolean {
    const broker = this.host.envBroker?.()
    const envFile = broker?.file ?? path.join(this.host.stateDir, EXCLUSIVITY_FILE)
    if (existsSync(envFile)) return true
    if (this.host.sourceLock?.().locked) return true
    return false
  }

  private scriptArgs(): string[] {
    const args: string[] = ['--state-dir', this.host.stateDir]
    const port = this.host.webPort?.()
    if (port && Number.isSafeInteger(port) && port > 0) args.push('--url', `http://127.0.0.1:${port}`)
    const sourceRoot = this.host.sourceRoot?.()
    if (sourceRoot) args.push('--source-root', sourceRoot)
    return args
  }

  /** Evaluates lock presence once; runs the external check script only while a lock is held. */
  async tick(nowMsOverride?: number): Promise<LockMonitorReport | undefined> {
    if (this.ticking) return this.ticking
    this.ticking = this.runTick(nowMsOverride).finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private async runTick(nowMsOverride?: number): Promise<LockMonitorReport | undefined> {
    if (this.host.closing() || this.host.paused() || !this.host.configured()) return undefined
    const nowMs = nowMsOverride ?? this.host.now?.() ?? Date.now()

    if (!this.lockPresent()) {
      this.alerted.clear()
      const unlocked: LockMonitorReport = { checkedAt: new Date(nowMs).toISOString(), status: 'unlocked', locked: false, locks: [], issues: [] }
      this.latest = unlocked
      this.host.health.set({ state: 'ready', detail: 'No lock held', at: unlocked.checkedAt })
      return unlocked
    }

    let report: LockMonitorReport
    try {
      const controller = new AbortController()
      report = this.host.runScript
        ? await this.host.runScript(this.scriptArgs(), controller.signal)
        : await runLockCheckScript(this.scriptArgs())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.host.health.set({ state: 'error', detail: message, at: new Date(nowMs).toISOString() })
      return undefined
    }

    this.latest = report
    if (!report.locked || report.status === 'unlocked') {
      this.alerted.clear()
      this.host.health.set({ state: 'ready', detail: 'No lock held', at: report.checkedAt })
      return report
    }

    const activeIssueKeys = new Set(report.issues.map(issue => `${issue.lock}:${issue.ticketId ?? issue.holderLabel ?? 'unknown'}:${issue.reasonCode}`))
    for (const existing of [...this.alerted.keys()]) {
      if (!activeIssueKeys.has(existing)) this.alerted.delete(existing)
    }

    if (report.status === 'alive') {
      const summary = report.locks.map(item => `${item.lock}: ${item.holder.label ?? item.holder.id ?? item.holder.op ?? 'active'} (${item.ticket?.state ?? 'alive'})`).join('; ')
      this.host.health.set({ state: 'ready', detail: summary, at: report.checkedAt })
      return report
    }

    this.host.health.set({
      state: 'error',
      detail: report.issues.map(issue => issue.detail).join('; '),
      at: report.checkedAt,
    })

    const cooldownMs = this.host.alertCooldownMs ?? LOCK_ALERT_COOLDOWN_MS
    for (const issue of report.issues) {
      const alertKey = `${issue.lock}:${issue.ticketId ?? issue.holderLabel ?? 'unknown'}:${issue.reasonCode}`
      const prev = this.alerted.get(alertKey)
      if (prev && prev.signature === issue.stateSignature && nowMs - prev.at < cooldownMs) continue
      const ticket = issue.ticketId ? this.host.store.tickets.get(issue.ticketId) : undefined
      const lockItem = report.locks.find(item => item.lock === issue.lock && (issue.ticketId ? item.ticket?.ticket_id === issue.ticketId : true))
      const payload = {
        kind: 'lock_owner_alert',
        status: issue.status,
        lock: issue.lock,
        reason_code: issue.reasonCode,
        detail: issue.detail,
        checked_at: report.checkedAt,
        ...(ticket ? { ticket: ticketCard(ticket), can_advance: canAdvanceTicket(ticket), ...(advanceBlockedCode(ticket) ? { advance_blocked: advanceBlockedCode(ticket) } : {}) } : {}),
        ...(lockItem ? { lock_info: { holder: lockItem.holder, ...(lockItem.ticket ? { diagnostics: lockItem.ticket } : {}) } } : {}),
        read: 'environment',
        script: 'scripts/check-lock-owner.mjs',
      }
      const relayId = key('lock-owner-alert', alertKey, issue.stateSignature, String(Math.floor(nowMs / Math.max(1, cooldownMs))))
      this.host.sessions.relay(relayId, JSON.stringify(payload))
      this.alerted.set(alertKey, { at: nowMs, signature: issue.stateSignature })
    }
    return report
  }
}
