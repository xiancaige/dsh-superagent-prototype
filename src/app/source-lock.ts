/** Inspection, stale-lock reaping, and operator force-unlock for the shared source checkout mutex (`tp-source-operation.lock`). */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { canRetry, latestReport, UserError, type EngineForPeople } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { Store } from './store.ts'

const REAPABLE_OPS = new Set(['prepare', 'finalize'])
const STALE_LOCK_MS = 5 * 60_000

export interface SourceLockHolder {
  token?: string
  pid?: number
  host?: string
  op?: string
  ticket?: string
  at?: string
  reapable?: boolean
}

export interface SourceLockStatus {
  available: boolean
  sourceRoot?: string
  file?: string
  locked: boolean
  pidAlive?: boolean
  reapable?: boolean
  stale?: boolean
  holder?: SourceLockHolder
  raw?: string
  error?: string
}

export interface ForceUnlockResult {
  unlocked: boolean
  existed: boolean
  forced: boolean
  stale: boolean
  file: string
  sourceRoot: string
  holder?: SourceLockHolder
  raw?: string
}

export interface ForceUnlockResponse extends ForceUnlockResult {
  retriedTickets: string[]
}

export interface SourceLockDeps {
  runGit?: (sourceRoot: string, args: string[]) => string
  alive?: (pid: number) => boolean
  host?: string
  nowMs?: () => number
}

const defaultAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as { code?: string })?.code === 'EPERM' }
}

const defaultRunGit = (sourceRoot: string, args: string[]): string =>
  String(execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))

function refuse(message: string): never {
  const error = new UserError('notRetryable')
  error.message = message
  throw error
}

/** Resolve the TP source repository root from mounted machine settings or deployment overrides. */
export function resolveSourceRoot(
  mounted: Pick<Machine, 'sourceRoot' | 'environment'>,
  deployment?: Pick<Deployment, 'sourceRoot' | 'environment'>,
): string | undefined {
  const projectFile = mounted.environment?.projectFile ?? deployment?.environment?.projectFile
  return mounted.sourceRoot || deployment?.sourceRoot || (projectFile ? dirname(projectFile) : undefined)
}

/** Resolve `<git-common-dir>/tp-source-operation.lock` for `sourceRoot`. */
export function sourceLockFile(sourceRoot: string, deps: Pick<SourceLockDeps, 'runGit'> = {}): string {
  const runGit = deps.runGit ?? defaultRunGit
  const common = resolve(sourceRoot, runGit(sourceRoot, ['rev-parse', '--git-common-dir']).trim())
  return resolve(common, 'tp-source-operation.lock')
}

function parseHolder(raw: string): SourceLockHolder | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const value = parsed as Record<string, unknown>
    return {
      ...(typeof value.token === 'string' && value.token ? { token: value.token } : {}),
      ...(typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : {}),
      ...(typeof value.host === 'string' && value.host ? { host: value.host } : {}),
      ...(typeof value.op === 'string' && value.op ? { op: value.op } : {}),
      ...(typeof value.ticket === 'string' ? { ticket: value.ticket } : {}),
      ...(typeof value.at === 'string' && value.at ? { at: value.at } : {}),
      ...(value.reapable === true ? { reapable: true } : {}),
    }
  } catch {
    return undefined
  }
}

function isPidAlive(holder: SourceLockHolder | undefined, alive: (pid: number) => boolean, host: string): boolean | undefined {
  if (!holder?.pid) return undefined
  if (holder.host && host && holder.host !== host) return true
  return alive(holder.pid)
}

function isReapable(holder: SourceLockHolder | undefined, pidAlive: boolean | undefined): boolean {
  return Boolean(holder?.token && (holder.reapable === true || (holder.op && REAPABLE_OPS.has(holder.op))) && pidAlive === false)
}

/** Inspect whether `tp-source-operation.lock` exists on `sourceRoot` and whether its owning PID is alive. */
export function inspectSourceLock(sourceRoot?: string, deps: SourceLockDeps = {}): SourceLockStatus {
  if (!sourceRoot) return { available: false, locked: false }
  let file: string
  try { file = sourceLockFile(sourceRoot, deps) }
  catch (error) {
    return { available: false, sourceRoot, locked: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!existsSync(file)) return { available: true, sourceRoot, file, locked: false }
  let raw: string
  try { raw = readFileSync(file, 'utf8') }
  catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return { available: true, sourceRoot, file, locked: false }
    return { available: false, sourceRoot, file, locked: false, error: error instanceof Error ? error.message : String(error) }
  }
  const holder = parseHolder(raw)
  const alive = deps.alive ?? defaultAlive
  const host = deps.host ?? hostname()
  const nowMs = deps.nowMs ?? Date.now
  const pidAlive = isPidAlive(holder, alive, host)
  const reapable = isReapable(holder, pidAlive)
  const heldAt = holder?.at ? Date.parse(holder.at) : Number.NaN
  const stale = pidAlive === false || (Number.isFinite(heldAt) && nowMs() - heldAt >= STALE_LOCK_MS)
  return {
    available: true,
    sourceRoot,
    file,
    locked: true,
    ...(holder ? { holder } : {}),
    raw,
    ...(pidAlive !== undefined ? { pidAlive } : {}),
    reapable,
    stale,
  }
}

/** Remove `tp-source-operation.lock`; refuses a live or unknown owner unless `force` is true. */
export function forceUnlockSourceLock(sourceRoot?: string, options: { force?: boolean } & SourceLockDeps = {}): ForceUnlockResult {
  if (!sourceRoot) refuse('No source repository is configured')
  const status = inspectSourceLock(sourceRoot, options)
  if (!status.available || !status.file) refuse(status.error || 'Source repository lock path is unavailable')
  if (!status.locked) return { unlocked: false, existed: false, forced: false, stale: false, file: status.file, sourceRoot }
  if (status.pidAlive !== false && !options.force) {
    const owner = status.pidAlive ? `live PID ${status.holder?.pid}` : 'unknown owner'
    refuse(`Source checkout lock is held by ${owner} (${status.file}); confirm force unlock to override`)
  }
  try { unlinkSync(status.file) }
  catch (error) { if ((error as { code?: string })?.code !== 'ENOENT') throw error }
  return {
    unlocked: true,
    existed: true,
    forced: status.pidAlive !== false,
    stale: status.pidAlive === false,
    file: status.file,
    sourceRoot,
    ...(status.holder ? { holder: status.holder } : { raw: status.raw }),
  }
}

/** Startup safeguard: automatically clear a dead-PID `prepare`/`finalize` lock left by a crashed/killed process. */
export function reapStaleSourceLock(
  sourceRoot?: string,
  logger?: { warn: (format: string, ...args: unknown[]) => void },
  deps: SourceLockDeps = {},
): boolean {
  const status = inspectSourceLock(sourceRoot, deps)
  if (!status.locked || !status.reapable || !status.file || !status.holder?.token) return false
  try {
    const latest = readFileSync(status.file, 'utf8')
    if (parseHolder(latest)?.token !== status.holder.token) return false
    unlinkSync(status.file)
    logger?.warn('dsh-superagent: reaped stale source lock (%s, dead pid %s, ticket %s)',
      status.holder.op ?? 'unknown', String(status.holder.pid ?? '?'), status.holder.ticket ?? '')
    return true
  } catch {
    return false
  }
}

/** Retry open tickets whose latest failure was caused by `tp-source-operation.lock` contention. */
export function retrySourceLockBlockedTickets(
  engine: Pick<EngineForPeople, 'retryTicket'>,
  store: Pick<Store, 'tickets'>,
): string[] {
  const retried: string[] = []
  for (const ticket of store.tickets.open()) {
    if (!canRetry(ticket)) continue
    const summary = latestReport(ticket)?.summary ?? ''
    if (!/source checkout is busy|tp-source-operation\.lock/i.test(summary)) continue
    engine.retryTicket(ticket.id)
    retried.push(ticket.id)
  }
  return retried
}
