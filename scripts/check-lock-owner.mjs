#!/usr/bin/env node
/**
 * Check whether any TP environment lock (`tp-environment.lock`) or source checkout lock
 * (`tp-source-operation.lock`) is currently held and whether the lock-holding ticket is dead or stalled.
 *
 * Exit codes:
 *   0 - unlocked, or lock is held by a live ticket/operation
 *   2 - lock is held by a dead, ended, missing, or stalled ticket/operation
 *   1 - script usage or inspection error
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DEFAULT_STALE_MINUTES = 15
const DEFAULT_TIMEOUT_MS = 4000
const IDLE_GRACE_MS = 60_000
const ENDED_GRACE_MS = 60_000
const SOURCE_STALE_MS = 5 * 60_000

function parseArgs(argv) {
  const opts = {
    url: undefined,
    stateDir: undefined,
    sourceRoot: undefined,
    staleMinutes: DEFAULT_STALE_MINUTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--url') {
      opts.url = argv[++i]
    } else if (arg.startsWith('--url=')) {
      opts.url = arg.slice('--url='.length)
    } else if (arg === '--state-dir') {
      opts.stateDir = argv[++i]
    } else if (arg.startsWith('--state-dir=')) {
      opts.stateDir = arg.slice('--state-dir='.length)
    } else if (arg === '--source-root') {
      opts.sourceRoot = argv[++i]
    } else if (arg.startsWith('--source-root=')) {
      opts.sourceRoot = arg.slice('--source-root='.length)
    } else if (arg === '--stale-minutes') {
      opts.staleMinutes = Number(argv[++i])
    } else if (arg.startsWith('--stale-minutes=')) {
      opts.staleMinutes = Number(arg.slice('--stale-minutes='.length))
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = Number(argv[++i])
    } else if (arg.startsWith('--timeout-ms=')) {
      opts.timeoutMs = Number(arg.slice('--timeout-ms='.length))
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!Number.isFinite(opts.staleMinutes) || opts.staleMinutes <= 0) {
    throw new Error('--stale-minutes must be a positive number')
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number')
  }
  if (!opts.url && !opts.stateDir) {
    opts.url = process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3080'
  }
  return opts
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sameHost(recordHost) {
  if (!recordHost) return true
  try {
    return recordHost === hostname()
  } catch {
    return false
  }
}

async function fetchHttpReport(baseUrl, timeoutMs) {
  const parsed = new URL(baseUrl)
  const target = new URL('/orchestrator/api/lock-monitor', parsed)
  const response = await fetch(target, {
    headers: {
      Host: parsed.host,
      Origin: parsed.origin,
      'x-orchestrator-request': '1',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status} from ${target}: ${body}`)
  }
  const report = await response.json()
  return verifyReportPids(report)
}

function verifyReportPids(report) {
  if (!report || !Array.isArray(report.locks)) return report
  const locks = report.locks.map(item => ({ ...item, holder: { ...item.holder } }))
  const issues = Array.isArray(report.issues) ? [...report.issues] : []
  for (const item of locks) {
    if (typeof item.holder?.pid === 'number' && sameHost(item.holder.host)) {
      const alive = isPidAlive(item.holder.pid)
      item.holder.pidAlive = alive
      if (!alive && item.status === 'alive') {
        item.status = 'dead'
        item.reasonCode = item.lock === 'tp-source-operation.lock' ? 'source_lock_dead_pid' : 'lock_pid_dead'
        item.detail = `${item.lock} owner PID ${item.holder.pid} is not running`
        issues.push({
          lock: item.lock,
          status: 'dead',
          reasonCode: item.reasonCode,
          detail: item.detail,
          ...(item.ticket?.ticket_id ? { ticketId: item.ticket.ticket_id, canAdvance: item.ticket.can_advance } : {}),
          ...(item.holder.label ? { holderLabel: item.holder.label } : {}),
          stateSignature: `${item.holder.id ?? ''}:${item.holder.pid}:dead`,
        })
      }
    }
    if (typeof item.holder?.editorPid === 'number' && sameHost(item.holder.host)) {
      item.holder.editorPidAlive = isPidAlive(item.holder.editorPid)
    }
  }
  const status = !locks.length ? 'unlocked'
    : locks.some(item => item.status === 'dead') ? 'dead'
    : locks.some(item => item.status === 'stalled') ? 'stalled'
    : 'alive'
  return { ...report, status, locked: locks.length > 0, locks, issues }
}

function readEnvLease(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
  if (!raw.trim()) return undefined
  if (!raw.trimStart().startsWith('{')) {
    const field = name => new RegExp(`^${name}=(.*)$`, 'm').exec(raw.replace(/\r/g, ''))?.[1]?.trim() ?? ''
    const token = field('token')
    if (!token) return undefined
    const time = field('time') || new Date(0).toISOString()
    const holder = field('holder') || 'unknown holder'
    return {
      token,
      pid: Number(field('pid') || 0),
      host: field('host'),
      holder: { kind: 'ticket', id: holder, label: holder },
      acquiredAt: time,
      heartbeat: time,
    }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.token) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function readTicketFromSqlite(stateDir, ticketId) {
  const dbPath = join(stateDir, 'orchestrator.sqlite')
  if (!existsSync(dbPath)) return undefined
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare('SELECT value FROM ticket WHERE id = ?').get(ticketId)
    return row?.value ? JSON.parse(row.value) : undefined
  } catch {
    return undefined
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

function ticketStageOffline(ticket) {
  if (ticket.ended) return { stage: 'ended', action: ticket.ended.outcome }
  if ((ticket.environmentBlock ?? ticket.validation?.blocked)?.startsWith('TP environment block: ')) {
    return { stage: 'working', action: 'queued' }
  }
  const latest = ticket.assignments?.at(-1)
  const report = latest?.report
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  if (report?.state === 'ready') return { stage: 'person', action: 'review' }
  if (report?.state === 'blocked' || report?.state === 'failed') {
    const hasReplyAfter = ticket.inputs?.some(input =>
      ((input.kind === 'trigger' && input.human && !input.context) || input.kind === 'orchestrator-decision')
      && input.at > report.at)
    if (!hasReplyAfter) return { stage: 'person', action: report.state }
  }
  if (latest?.state === 'running') {
    if (report?.state === 'waiting' && !(latest.deliveredAt && latest.deliveredAt >= report.at)) {
      return { stage: 'idle' }
    }
    return { stage: 'working' }
  }
  if (latest?.state === 'pending') return { stage: 'working', action: 'queued' }
  return { stage: 'idle' }
}

function inspectOffline({ stateDir, sourceRoot, staleMinutes }) {
  const nowMs = Date.now()
  const staleMs = staleMinutes * 60_000
  const locks = []
  const issues = []

  if (stateDir) {
    const envFile = join(stateDir, 'tp-environment.lock')
    const record = existsSync(envFile) ? readEnvLease(envFile) : undefined
    if (record) {
      const hostMatches = sameHost(record.host)
      const pidAlive = Number.isSafeInteger(record.pid) && record.pid > 0 ? (hostMatches ? isPidAlive(record.pid) : true) : false
      const editorPid = record.facts?.editorPid && /^\d+$/.test(String(record.facts.editorPid)) ? Number(record.facts.editorPid) : undefined
      const editorPidAlive = editorPid !== undefined ? (hostMatches ? isPidAlive(editorPid) : true) : undefined
      const holder = {
        kind: record.holder?.kind === 'session' ? 'session' : 'ticket',
        id: String(record.holder?.id ?? ''),
        label: String(record.holder?.label ?? record.holder?.id ?? 'unknown'),
        pid: Number(record.pid ?? 0),
        pidAlive,
        ...(record.host ? { host: record.host } : {}),
        acquiredAt: String(record.acquiredAt ?? ''),
        heartbeat: String(record.heartbeat ?? ''),
        ...(editorPid !== undefined ? { editorPid, editorPidAlive } : {}),
      }

      let status = 'alive'
      let reasonCode = holder.kind === 'session' ? 'session_lock_alive' : 'alive'
      let detail = `Lock held by ${holder.kind} ${holder.label}`
      let ticketDiag

      if (!pidAlive) {
        status = 'dead'
        reasonCode = 'lock_pid_dead'
        detail = `tp-environment.lock owner PID ${holder.pid} is dead`
      } else if (holder.kind === 'ticket' && holder.id) {
        const ticket = readTicketFromSqlite(stateDir, holder.id)
        if (!ticket) {
          status = 'dead'
          reasonCode = 'ticket_missing'
          detail = `Ticket ${holder.id} holding tp-environment.lock was not found`
        } else if (ticket.ended) {
          const endedMs = Date.parse(ticket.ended.at)
          const forDelivery = record.facts?.purpose === 'delivery' && ticket.ended.outcome === 'completed'
          if (!forDelivery && (!Number.isFinite(endedMs) || nowMs - endedMs >= ENDED_GRACE_MS)) {
            status = 'dead'
            reasonCode = 'ticket_ended'
            detail = `Ended ticket ${ticket.id.slice(0, 8)} (${ticket.ended.outcome}) still holds tp-environment.lock`
          }
        } else {
          const stage = ticketStageOffline(ticket)
          const latest = ticket.assignments?.at(-1)
          const report = latest?.report
          const activityMs = Math.max(
            ...[Date.parse(report?.at ?? ''), Date.parse(latest?.startedAt ?? ''), Date.parse(latest?.deliveredAt ?? ''), Date.parse(ticket.updatedAt ?? '')]
              .filter(Number.isFinite),
          )
          const quietMs = Number.isFinite(activityMs) ? Math.max(0, nowMs - activityMs) : undefined
          const cardState = stage.stage === 'person' ? `person/${stage.action}` : stage.action === 'queued' ? 'working/queued' : stage.stage
          if (stage.stage === 'person') {
            if (stage.action === 'failed') {
              status = 'dead'; reasonCode = 'worker_failed_holding_lock'
              detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} is in person/failed`
            } else if (stage.action === 'blocked') {
              status = 'stalled'; reasonCode = 'worker_blocked_holding_lock'
              detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} is in person/blocked`
            } else if (stage.action === 'delivery') {
              status = 'stalled'; reasonCode = 'worker_delivery_failed'
              detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} hit delivery failure`
            } else if (stage.action === 'review') {
              status = 'stalled'; reasonCode = 'worker_ready_holding_lock'
              detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} reported ${report?.completion ?? 'ready'} while holding lock`
            } else if (quietMs !== undefined && quietMs >= IDLE_GRACE_MS) {
              status = 'stalled'; reasonCode = 'worker_waiting_answer_holding_lock'
              detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} is waiting for answer while holding lock`
            }
          } else if (stage.stage === 'idle' && (quietMs === undefined || quietMs >= IDLE_GRACE_MS)) {
            status = 'dead'; reasonCode = 'worker_idle_holding_lock'
            detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} is idle while holding tp-environment.lock`
          } else if (quietMs !== undefined && quietMs >= staleMs) {
            status = 'stalled'; reasonCode = 'worker_turn_silent'
            detail = `Lock-holding ticket ${ticket.id.slice(0, 8)} has no recorded updates for ${Math.round(quietMs / 60_000)}m`
          }
          ticketDiag = {
            ticket_id: ticket.id,
            title: ticket.title,
            state: cardState,
            can_advance: latest?.modelFailure?.hostResumeBudget !== 0,
            ...(latest ? { assignment_id: latest.id, assignment_state: latest.state } : {}),
            ...(report ? { report_state: report.state, report_at: report.at } : {}),
            worker_status: 'idle',
            running_jobs: 0,
            subagents_count: 0,
            open_tool_calls: 0,
            ...(quietMs !== undefined ? { quiet_ms: quietMs } : {}),
          }
        }
      }

      const item = { lock: 'tp-environment.lock', file: envFile, status, reasonCode, detail, holder, ...(ticketDiag ? { ticket: ticketDiag } : {}) }
      locks.push(item)
      if (status !== 'alive') {
        issues.push({
          lock: item.lock,
          status,
          reasonCode,
          detail,
          ...(holder.kind === 'ticket' ? { ticketId: holder.id } : {}),
          holderLabel: holder.label,
          ...(ticketDiag ? { canAdvance: ticketDiag.can_advance } : {}),
          stateSignature: `${holder.id}:${holder.pid}:${reasonCode}`,
        })
      }
    }
  }

  if (sourceRoot) {
    try {
      const common = resolve(sourceRoot, String(execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })).trim())
      const srcFile = resolve(common, 'tp-source-operation.lock')
      if (existsSync(srcFile)) {
        const raw = readFileSync(srcFile, 'utf8')
        let parsed
        try { parsed = JSON.parse(raw) } catch { parsed = undefined }
        const pid = typeof parsed?.pid === 'number' ? parsed.pid : undefined
        const pidAlive = pid ? (sameHost(parsed?.host) ? isPidAlive(pid) : true) : undefined
        const atMs = parsed?.at ? Date.parse(parsed.at) : NaN
        const stale = pidAlive === false || (Number.isFinite(atMs) && nowMs - atMs >= SOURCE_STALE_MS)
        const status = pidAlive === false ? 'dead' : stale ? 'stalled' : 'alive'
        const reasonCode = pidAlive === false ? 'source_lock_dead_pid' : stale ? 'source_lock_stale' : 'source_lock_active'
        const detail = pidAlive === false
          ? `Source checkout lock (${parsed?.op ?? 'unknown'}) is held by dead PID ${pid}`
          : stale ? `Source checkout lock (${parsed?.op ?? 'unknown'}) is stale` : `Source checkout lock (${parsed?.op ?? 'unknown'}) is active`
        const item = {
          lock: 'tp-source-operation.lock',
          file: srcFile,
          status,
          reasonCode,
          detail,
          holder: {
            kind: parsed?.ticket ? 'ticket' : 'operation',
            ...(parsed?.ticket ? { id: String(parsed.ticket), label: String(parsed.ticket) } : {}),
            ...(pid !== undefined ? { pid, pidAlive } : {}),
            ...(parsed?.host ? { host: String(parsed.host) } : {}),
            ...(parsed?.at ? { acquiredAt: String(parsed.at) } : {}),
            ...(parsed?.op ? { op: String(parsed.op) } : {}),
          },
        }
        locks.push(item)
        if (status !== 'alive') {
          issues.push({
            lock: item.lock,
            status,
            reasonCode,
            detail,
            ...(parsed?.ticket ? { ticketId: String(parsed.ticket) } : {}),
            stateSignature: `${parsed?.ticket ?? ''}:${pid ?? ''}:${reasonCode}`,
          })
        }
      }
    } catch {
      // Source root is not a git repo or unavailable in offline fallback.
    }
  }

  const status = !locks.length ? 'unlocked'
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

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('Usage: check-lock-owner.mjs [--url <http://127.0.0.1:3080>] [--state-dir <path>] [--source-root <path>] [--stale-minutes <15>]')
    return 0
  }
  let report
  if (opts.url) {
    try {
      report = await fetchHttpReport(opts.url, opts.timeoutMs)
    } catch (error) {
      if (!opts.stateDir) throw error
      report = inspectOffline(opts)
    }
  } else {
    report = inspectOffline(opts)
  }
  console.log(JSON.stringify(report, null, 2))
  return report.status === 'dead' || report.status === 'stalled' ? 2 : 0
}

main()
  .then(code => { process.exitCode = code })
  .catch(error => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  })
