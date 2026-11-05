/**
 * Phase 2 C: the persistent TP environment exclusivity.
 *
 * B2's recovery took a lock only for the length of one attempt. Phase 2 C asks for more: from the
 * moment a ticket starts changing the TP environment until its acceptance is done and handed over,
 * exactly one ticket (or one ordinary Session, through a person's handover) may own the TP editor
 * process, the TPMcp port, the TP project workspace and the ticket's own execution directory.
 *
 * The record is the *same* lock B2 wrote, {@link EXCLUSIVITY_FILE} in the deployment state directory, so there alone. What changes is what it means and how long it is held:
 *
 * * a lease is **persisted** for the whole span: the record names the holder, its kind, the resources it
 *   covers, when it was taken, a heartbeat, and the TP editor PID this deployment started if any;
 *   a restarted host re-reads it and keeps the owner (`wake`, `restore`);
 * * a foreign holder (a living Session process that is not this one) is **never stolen**: acquisition
 *   fails and names the holder, and nothing is detected, launched or killed;
 * * nothing but `RELEASE_REASONS` releases it: the ticket's acceptance passed, a person's explicit
 *   handover, or the ticket being stopped. Waiting for a person, a `waiting` report, a released worker
 *   slot, a failed acceptance to rework, a host restart and the end of an idle turn all keep it;
 * * a handover preserves the scene instead of discarding it: a ticket's uncommitted changes in its
 *   execution directory are written to an export (a `git stash create` sketch that is never applied, a
 *   bundle holding it, and a binary patch) under the state directory's `handovers/`, and are never
 *   `stash`ed, committed, `reset` or `clean`ed. An export that cannot be made refuses the handover, so
 *   the lock stays with the ticket;
 * * the B2 recovery takes this same store (`acquireHolder`), so a ticket holding the environment is
 *   respected by its recovery and the recovery never creates a second lock.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The one TP environment lock; B2 wrote it and phase 2 C keeps writing it. */
export const EXCLUSIVITY_FILE = 'tp-environment.lock'

/** Who holds the environment: a ticket from its start to its acceptance, or a person's ordinary Session in a handover. */
export type HolderKind = 'ticket' | 'session'

/** A resource the environment covers, as the record names it. */
export type ManagedResource = 'tp-editor' | 'tpmcp-port' | 'tp-project' | 'ticket-directory'

/**
 * The only facts that release the environment. `acceptance` is a passing acceptance the host itself
 * recorded, with the ticket's work complete, so its editor is cleaned up; `handover` is a person's
 * explicit hand-back; `stopped` is the ticket being stopped.
 */
export const RELEASE_REASONS = ['acceptance', 'handover', 'stopped'] as const
export type ReleaseReason = typeof RELEASE_REASONS[number]

export const isReleaseReason = (value: unknown): value is ReleaseReason =>
  typeof value === 'string' && (RELEASE_REASONS as readonly string[]).includes(value)

/** One persisted lease: who holds the environment, for what, since when, and how it is still alive. */
export interface EnvironmentLeaseRecord {
  token: string
  /** The hosting Session process; a different live PID means another Session's lease. */
  pid: number
  host: string
  holder: { kind: HolderKind; id: string; label: string }
  /** The TP resources this lease covers, and the ticket's own execution directory. */
  resources: { name: ManagedResource; value: string }[]
  acquiredAt: string
  heartbeat: string
  /** Recorded facts, such as the TP editor this deployment started for the holder. */
  facts?: Record<string, string>
}

/** The record as a person sees it: the holder, when it was taken, and when it last beat. */
export interface EnvironmentExclusivityView {
  held: boolean
  holder?: { kind: HolderKind; id: string; label: string }
  acquiredAt?: string
  heartbeat?: string
  resources?: { name: ManagedResource; value: string }[]
  /** The owning Session process, and whether it is this host's. */
  pid?: number
  thisHost?: boolean
  /** The latest release this deployment made: why, when, by whom, and what it exported. */
  lastRelease?: { reason: ReleaseReason; at: string; holder: string; ticketId?: string; export?: string }
}

/** What a handover preserved from a ticket's execution directory. */
export interface HandoverExport {
  directory: string
  /** The export files, with a SHA-256 of each so a later check proves they still hold the same scene. */
  files: { path: string; sha256: string; bytes: number }[]
  /** The snapshot commit the work tree's state was sketched into, which is never applied to the work tree. */
  snapshot?: string
  /** The bundle holding the snapshot, when the repository's HEAD anchors it. */
  bundle?: string
  /** The binary diff from HEAD (or from the empty tree) to the snapshot. */
  patch?: string
  /** How the handover carried the changes: `bundle` when a HEAD anchors the snapshot, else `patch` alone. */
  mode: 'bundle' | 'patch'
  at: string
  /** The repository root, and HEAD as it was. */
  root?: string
  head?: string
}

/** A blocked acquisition: the holder is named, as the contract requires. */
export class EnvironmentHeld extends Error {
  constructor(readonly record: EnvironmentLeaseRecord) {
    super(`TP environment is held by ${record.holder.kind} ${record.holder.label} (Session pid ${record.pid}) since ${record.acquiredAt}; waiting, idle time and a restart do not release it`)
    this.name = 'EnvironmentHeld'
  }
}

/** The same holder's lease again: a restart resumes it instead of taking a new one, and no second lease is taken. */
export class EnvironmentHeldBySelf extends Error {
  constructor(readonly record: EnvironmentLeaseRecord) {
    super(`TP environment is held by this holder already (${record.holder.label}, Session pid ${record.pid}); the persisted lease is resumed, not taken anew`)
    this.name = 'EnvironmentHeldBySelf'
  }
}

export interface ExclusivityDeps {
  now?: () => string
  /** Whether a PID is alive; the default asks the OS. */
  alive?: (pid: number) => boolean
  /** This host's PID and name; the default is the current process and the machine name. */
  self?: () => { pid: number; host: string }
  /** Git runner for the handover export; the default runs git in the directory. */
  git?: (directory: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}

const defaultAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const defaultGit = (directory: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => new Promise(resolve => {
  execFile('git', [...args], { cwd: directory, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : error ? 1 : 0
    resolve({ code, stdout: String(stdout), stderr: String(stderr) })
  })
})

/** This machine's name, recorded so a cross-machine holder is named rather than guessed at. */
function hostName(): string {
  try { return os.hostname() } catch { return 'unknown-host' }
}

/**
 * Read a lease record. A file B2 wrote (`key=value` with `pid`, `holder`, `host`, `time`, `token`)
 * reads as a ticket lease, so an upgrade finds the same lock instead of building a second one.
 */
export function readLease(file: string): EnvironmentLeaseRecord | undefined {
  let raw: string
  try { raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '') } catch { return undefined }
  if (!raw.trim()) return undefined
  if (!raw.trimStart().startsWith('{')) {
    const field = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(raw.replace(/\r/g, ''))?.[1]?.trim() ?? ''
    const token = field('token')
    if (!token) return undefined
    const time = field('time') || new Date(0).toISOString()
    const holder = field('holder') || 'unknown holder'
    return { token, pid: Number(field('pid') || 0), host: field('host'), holder: { kind: 'ticket', id: holder, label: holder },
      resources: [], acquiredAt: time, heartbeat: time }
  }
  let parsed: Partial<EnvironmentLeaseRecord>
  try { parsed = JSON.parse(raw) as Partial<EnvironmentLeaseRecord> } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || !parsed.token) return undefined
  const at = new Date(0).toISOString()
  return {
    token: String(parsed.token),
    pid: Number(parsed.pid ?? 0),
    host: String(parsed.host ?? ''),
    holder: { kind: parsed.holder?.kind === 'session' ? 'session' : 'ticket', id: String(parsed.holder?.id ?? ''),
      label: String(parsed.holder?.label ?? parsed.holder?.id ?? 'unknown holder') },
    resources: Array.isArray(parsed.resources) ? parsed.resources.filter(item => item && typeof item.name === 'string')
      .map(item => ({ name: item.name as ManagedResource, value: String(item.value ?? '') })) : [],
    acquiredAt: String(parsed.acquiredAt ?? at),
    heartbeat: String(parsed.heartbeat ?? parsed.acquiredAt ?? at),
    ...parsed.facts && typeof parsed.facts === 'object' ? { facts: parsed.facts as Record<string, string> } : {},
  }
}

/**
 * Whether a record is live: another machine's is taken to be live and is never reaped here, and this
 * machine's is live while the Session process that owns it exists. Ownership survives a host restart
 * because the owner is the Session process rather than the attempt that took it.
 */
export function leaseLive(record: EnvironmentLeaseRecord, deps: Pick<ExclusivityDeps, 'alive' | 'self'> = {}): boolean {
  const self = (deps.self ?? (() => ({ pid: process.pid, host: hostName() })))()
  if (!record.pid) return false
  if (self.host && record.host && self.host !== record.host) return true
  return (deps.alive ?? defaultAlive)(record.pid)
}

/** The resources one TP environment lease covers; a ticket adds its own execution directory. */
export const environmentResources = (environment: { projectFile: string; port: number }, directory?: string): EnvironmentLeaseRecord['resources'] => [
  { name: 'tp-editor', value: environment.projectFile },
  { name: 'tpmcp-port', value: String(environment.port) },
  { name: 'tp-project', value: path.dirname(environment.projectFile) },
  ...directory ? [{ name: 'ticket-directory' as const, value: directory }] : [],
]

const digest = (file: string): { sha256: string; bytes: number } => {
  const bytes = readFileSync(file)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

/** A handle on the lease a caller now holds; `release` is the only way the environment is freed. */
export interface EnvironmentLease {
  readonly token: string
  readonly record: EnvironmentLeaseRecord
  beat(): void
  annotate(facts: Record<string, string>): void
  release(reason: ReleaseReason, ticketId?: string, exportPath?: string): void
}

/**
 * The environment broker: one lock file, persisted leases with a heartbeat, the handover export, and
 * the release rules. Everything a ticket needs at its start and at its acceptance is synchronous; only
 * the handover's git work is asynchronous.
 */
export class EnvironmentExclusivity {
  private readonly now: () => string
  private readonly deps: ExclusivityDeps
  private stopped = false
  /** Set by `wake`: this deployment stopped and started again, which keeps this machine's own record. */
  private broken = false

  constructor(private readonly stateDir: string, deps: ExclusivityDeps = {}) {
    this.deps = deps
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /** The lock file both B2 and phase 2 C use. */
  get file(): string { return path.join(this.stateDir, EXCLUSIVITY_FILE) }
  /** Where handovers export what a ticket left uncommitted. */
  get handovers(): string { return path.join(this.stateDir, 'handovers') }
  /** Set while the deployment stops: no heartbeat is written, so a restarted host keeps the lease. */
  halt(): void { this.stopped = true }
  /**
   * Set when the deployment starts again: the host that left a record stopped on purpose, so a record this
   * machine wrote still belongs to a ticket that runs once the process it lived in went away with the stop.
   */
  wake(): void { this.stopped = false; this.broken = true }

  private self() { return (this.deps.self ?? (() => ({ pid: process.pid, host: hostName() })))() }
  private alive(pid: number): boolean { return (this.deps.alive ?? defaultAlive)(pid) }
  private live(record: EnvironmentLeaseRecord | undefined): boolean {
    if (!record) return false
    // After this deployment stopped and started again, a record this machine wrote is the running ticket's,
    // however its writer's process ended; another machine's record is judged by the PID it names, as always.
    if (this.broken && record.host && record.host === this.self().host) return true
    return leaseLive(record, { alive: pid => this.alive(pid), self: () => this.self() })
  }

  /** The current record, if any; a dead record is reported as not live and is replaced only by an acquisition. */
  read(): EnvironmentLeaseRecord | undefined { return readLease(this.file) }
  /** Whether a record is this deployment's live one. */
  liveRecord(record: EnvironmentLeaseRecord | undefined): boolean { return this.live(record) }

  /** The living record, if the environment is held. */
  held(): EnvironmentLeaseRecord | undefined {
    const record = this.read()
    return this.live(record) ? record : undefined
  }

  /** Whether this holder is the environment's current owner: the second line of defence beside the lock file. */
  owns(kind: HolderKind, id: string): boolean {
    const record = this.held()
    return !!record && record.holder.kind === kind && record.holder.id === id
  }

  private write(record: EnvironmentLeaseRecord): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${randomUUID()}`
    writeFileSync(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
  }

  private create(kind: HolderKind, id: string, label: string, resources: EnvironmentLeaseRecord['resources']): EnvironmentLeaseRecord {
    const self = this.self()
    const at = this.now()
    return { token: `${self.pid}-${Date.now()}-${randomUUID()}`, pid: self.pid, host: self.host, holder: { kind, id, label }, resources,
      acquiredAt: at, heartbeat: at }
  }

  /**
   * Take the environment for `holder`, or fail naming the one that has it: a live foreign record is never
   * stolen and never reaped, while a dead one (its Session process gone) is replaced. The same holder's
   * live record is `EnvironmentHeldBySelf`, so a restarted deployment resumes it instead of taking a second.
   * @throws EnvironmentHeld | EnvironmentHeldBySelf
   */
  acquire(input: { kind?: HolderKind; id: string; label: string; resources?: EnvironmentLeaseRecord['resources'] }): EnvironmentLease {
    const kind = input.kind ?? 'ticket'
    const record = this.create(kind, input.id, input.label, input.resources ?? [])
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    // `wx` makes the create atomic between Sessions: a racer either wins the file or reads the winner.
    try {
      writeFileSync(this.file, JSON.stringify(record, null, 2), { flag: 'wx', encoding: 'utf8', mode: 0o600 })
      return this.handle(record)
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
    const conflict = (other: EnvironmentLeaseRecord | undefined): never => {
      if (other && other.holder.kind === kind && other.holder.id === input.id) throw new EnvironmentHeldBySelf(other)
      if (other) throw new EnvironmentHeld(other)
      throw new Error('TP environment exclusivity: the lock file could not be read and could not be replaced')
    }
    const existing = this.read()
    if (this.live(existing)) conflict(existing)
    // A dead record, or an unreadable file, is replaced; a racer that replaced it first then decides.
    rmSync(this.file, { force: true })
    try {
      writeFileSync(this.file, JSON.stringify(record, null, 2), { flag: 'wx', encoding: 'utf8', mode: 0o600 })
      return this.handle(record)
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
    const raced = this.read()
    if (this.live(raced)) conflict(raced)
    rmSync(this.file, { force: true })
    writeFileSync(this.file, JSON.stringify(record, null, 2), { flag: 'wx', encoding: 'utf8', mode: 0o600 })
    return this.handle(record)
  }

  /**
   * An acquisition that tolerates its own live record: after a host restart, a holder resuming the
   * persisted lease takes it back (a new token and PID, the same acquisition time and owner) instead of
   * failing on itself; any other holder is still refused with its name.
   * @throws EnvironmentHeld when another holder has it.
   */
  acquireHolder(input: { kind?: HolderKind; id: string; label: string; resources?: EnvironmentLeaseRecord['resources'] }): EnvironmentLease {
    try { return this.acquire(input) } catch (error) {
      if (!(error instanceof EnvironmentHeldBySelf)) throw error
      // The same holder id is not proof of the same owner: only this process's own record, or one whose Session
      // process on this machine is gone, is resumed. A live other process (or another machine) keeps it.
      const old = error.record
      const mine = old.pid === this.self().pid && (!old.host || old.host === this.self().host)
      const gone = !!old.host && old.host === this.self().host && !this.alive(old.pid)
      if (!mine && !gone) throw new EnvironmentHeld(old)
      const resumed = this.resume(error.record.token)
      if (!resumed) throw new EnvironmentHeld(error.record)
      return this.handle(resumed)
    }
  }

  /**
   * Take back a holder's own persisted record after a restart: the record is rewritten by this Session
   * (a new token, this PID, a fresh heartbeat), so its ownership and acquisition time survive the restart
   * while its liveness now belongs to the new process. Undefined when the record is not that one.
   */
  resume(token: string): EnvironmentLeaseRecord | undefined {
    const existing = this.read()
    if (!existing || existing.token !== token) return undefined
    const self = this.self()
    const resumed: EnvironmentLeaseRecord = { ...existing, token: `${self.pid}-${Date.now()}-${randomUUID()}`, pid: self.pid, host: self.host,
      heartbeat: this.now(), ...existing.facts ? { facts: { ...existing.facts } } : {} }
    this.write(resumed)
    return resumed
  }

  private handle(record: EnvironmentLeaseRecord): EnvironmentLease {
    const broker = this
    let token = record.token
    return {
      get token() { return token },
      record,
      beat: () => { const next = broker.beat(token); if (next) token = next.token },
      annotate: facts => { broker.annotate(token, facts) },
      release: (reason, ticketId, exportPath) => { broker.release(token, reason, ticketId, exportPath) },
    }
  }

  /** Rewrite the holder's record; someone else's record is never touched. */
  private update(token: string, change: (record: EnvironmentLeaseRecord) => void): EnvironmentLeaseRecord | undefined {
    const existing = this.read()
    if (!existing || existing.token !== token) return undefined
    const next: EnvironmentLeaseRecord = { ...existing, holder: { ...existing.holder }, resources: [...existing.resources], ...existing.facts ? { facts: { ...existing.facts } } : {} }
    change(next)
    this.write(next)
    return next
  }

  /**
   * One heartbeat: the holder is alive. Waiting for a person, a `waiting` report, an idle worker and a
   * released slot all keep beating; the heartbeat never releases the lock.
   */
  beat(token: string): EnvironmentLeaseRecord | undefined {
    if (this.stopped) return this.read()
    return this.update(token, record => { record.heartbeat = this.now() })
  }

  /** Record facts with the holder's lease, such as the TP editor this deployment started for it. */
  annotate(token: string, facts: Record<string, string>): EnvironmentLeaseRecord | undefined {
    return this.update(token, record => { record.facts = { ...record.facts, ...facts } })
  }

  /** The holder's current record, by token. */
  current(token: string): EnvironmentLeaseRecord | undefined {
    const record = this.read()
    return record?.token === token ? record : undefined
  }

  private logRelease(entry: NonNullable<EnvironmentExclusivityView['lastRelease']>): void {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const history = path.join(this.stateDir, 'tp-environment.releases.json')
      const previous = (() => { try { return JSON.parse(readFileSync(history, 'utf8')) as unknown[] } catch { return [] } })()
      writeFileSync(history, JSON.stringify([...previous, entry].slice(-100), null, 2), 'utf8')
    } catch { /* The lock is what matters; the release log is a convenience. */ }
  }

  /**
   * Release the lock. Only `RELEASE_REASONS` releases it and a caller that asks for anything else is
   * refused, so no code path frees the environment quietly; the token must be the current holder's, so a
   * later holder's lease is never deleted.
   * @returns whether this call released the lock.
   * @throws when the reason is not one the contract allows, or the token is not the holder's.
   */
  release(token: string, reason: ReleaseReason, ticketId?: string, exportPath?: string): boolean {
    if (!isReleaseReason(reason)) throw new Error(`TP environment exclusivity: ${String(reason)} is not a release reason (${RELEASE_REASONS.join(', ')})`)
    const existing = this.read()
    if (!existing || existing.token !== token) throw new Error('TP environment exclusivity: the lease is not held by this token; a later holder\'s lock is never released')
    rmSync(this.file, { force: true })
    this.logRelease({ reason, at: this.now(), holder: existing.holder.label || existing.holder.id, ...ticketId ? { ticketId } : {}, ...exportPath ? { export: exportPath } : {} })
    return true
  }

  /** The view a person sees, and the latest release this deployment made. */
  view(): EnvironmentExclusivityView {
    const record = this.read()
    let lastRelease: EnvironmentExclusivityView['lastRelease']
    try {
      const history = JSON.parse(readFileSync(path.join(this.stateDir, 'tp-environment.releases.json'), 'utf8')) as EnvironmentExclusivityView['lastRelease'][]
      lastRelease = Array.isArray(history) ? history.at(-1) : undefined
    } catch { lastRelease = undefined }
    return { held: this.live(record), ...record ? { holder: record.holder, acquiredAt: record.acquiredAt, heartbeat: record.heartbeat, resources: record.resources,
      pid: record.pid, thisHost: record.pid === this.self().pid } : {}, ...lastRelease ? { lastRelease } : {} }
  }

  /** Clear a dead record (an operator-only repair); never removes a live holder's. */
  reapIfDead(): boolean {
    const record = this.read()
    if (!record || this.live(record)) return false
    rmSync(this.file, { force: true })
    return true
  }

  /** Remove a record outright, for a deployment that starts with no holder; a live foreign holder's is never removed. */
  static clear(file: string): void { try { unlinkSync(file) } catch { /* already gone */ } }

  /**
   * Export a ticket's uncommitted scene from its execution directory, without changing it: no `stash`
   * is applied, and no `commit`, `reset`, `checkout` or `clean` runs. `git stash create` sketches the
   * work tree (tracked and untracked changes) into a commit object and prints its id. With a HEAD, the
   * sketch is exported as a bundle anchored on HEAD; a binary patch from HEAD to the sketch shows the
   * changes either way. Every export file is listed with a digest, so a later check proves the export
   * still holds the same scene.
   *
   * @returns the export, or undefined when the directory is not a git work tree (nothing to preserve).
   * @throws when git fails or an export that was written does not hold the scene.
   */
  async export(directory: string, directoryKey: string): Promise<HandoverExport | undefined> {
    const git = this.deps.git ?? defaultGit
    const inside = await git(directory, ['rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return undefined
    const root = (await git(directory, ['rev-parse', '--show-toplevel'])).stdout.trim() || directory
    const at = this.now()
    const stamp = at.replace(/[:.]/g, '-')
    const target = path.join(this.handovers, `${directoryKey.replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}`)
    mkdirSync(target, { recursive: true, mode: 0o700 })
    const head = await git(directory, ['rev-parse', '--verify', 'HEAD'])
    const anchored = head.code === 0 ? head.stdout.trim() : ''
    const files: HandoverExport['files'] = []
    let bundle: string | undefined
    let patch: string | undefined
    let snapshot: string | undefined
    const names = (stdout: string) => stdout.split(String.fromCharCode(0)).filter(Boolean)
    const untrackedNames = names((await git(directory, ['ls-files', '-z', '--others', '--exclude-standard'])).stdout)
    if (anchored) {
      // A working copy with commits: `stash create` sketches the staged, unstaged and untracked changes
      // together into a commit object, without touching the work tree, the index or any ref.
      const sketch = await git(directory, ['stash', 'create', '--include-untracked', '--message', `dsh-superagent handover ${stamp}`])
      if (sketch.code !== 0) throw new Error(`TP environment handover: the work tree could not be sketched for export: ${sketch.stderr.trim() || 'no output'}`)
      snapshot = sketch.stdout.trim() || undefined
    } else {
      // A repository without a commit yet: nothing records it, so the export refuses rather than claiming
      // a scene it could not save; the ticket keeps the environment.
      const loose = await git(directory, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      if (loose.stdout) throw new Error('TP environment handover: the repository has no commit yet, so its scene cannot be sketched into an export; make a commit in the ticket directory first')
    }
    if (snapshot || (anchored && untrackedNames.length)) {
      patch = path.join(target, 'worktree.patch')
      const untracked = untrackedNames
      // Every tracked change against HEAD, staged or not, in one call with no path list (a long list overflows the command line).
      const unstaged = await git(directory, ['diff', '--binary', '--relative', anchored])
      if (unstaged.code !== 0 && unstaged.code !== 1) throw new Error(`TP environment handover: the tracked changes could not be written to the patch: ${unstaged.stderr.trim() || 'no output'}`)
      // Each untracked file is compared against nothing on its own: several paths in one `--no-index` call would be
      // compared with each other, and a single one is a usage error. Exit 1 only says the file differs.
      const fresh: string[] = []
      for (const file of untracked) {
        const added = await git(directory, ['diff', '--binary', '--no-index', '--', '/dev/null', file])
        if (added.code !== 0 && added.code !== 1) throw new Error(`TP environment handover: the untracked file ${file} could not be written to the patch: ${added.stderr.trim() || 'no output'}`)
        fresh.push(added.stdout)
      }
      const diff = { code: unstaged.code, stdout: [unstaged.stdout, ...fresh].filter(Boolean).join(''), stderr: unstaged.stderr }
      writeFileSync(patch, [
        `# directory ${directory}`,
        `# snapshot ${snapshot ?? '(none: only untracked files changed)'}`,
        `# against HEAD ${anchored}`,
        '# the work tree is unchanged: this export is written, not applied',
        diff.stdout,
      ].join('\n'), 'utf8')
      files.push({ path: 'worktree.patch', ...digest(patch) })
      bundle = path.join(target, 'worktree.bundle')
      // `bundle create <ref>` exports one ref with its history merged in: the snapshot, and HEAD at or
      // below it, which makes the bundle self-contained. The export names that ref itself, so the work
      // tree's own refs are exactly as before.
      const ref = `refs/dsh-superagent/handover/${stamp}`
      // Only untracked files changed: `stash create` has no commit to name, the patch above carries them, and the bundle holds HEAD.
      const empty = !snapshot || (await git(directory, ['diff', '--stat', anchored, snapshot])).stdout === ''
      // A work tree unchanged against HEAD has nothing new to name; the bundle then carries HEAD alone.
      const named = await git(directory, ['update-ref', ref, empty || !snapshot ? anchored : snapshot])
      if (named.code !== 0) throw new Error(`TP environment handover: the snapshot could not be named for export: ${named.stderr.trim() || 'no output'}`)
      let created: { code: number; stderr: string }
      try { created = await git(directory, ['bundle', 'create', bundle, ref]) }
      finally { await git(directory, ['update-ref', '-d', ref]) }
      if (created.code !== 0) throw new Error(`TP environment handover: the bundle export failed: ${created.stderr.trim() || 'no output'}`)
      const verify = await git(directory, ['bundle', 'verify', bundle])
      if (verify.code !== 0) throw new Error(`TP environment handover: the written bundle does not verify: ${verify.stderr.trim() || 'no output'}`)
      const listed = await git(directory, ['bundle', 'list-heads', bundle])
      if (snapshot && !listed.stdout.split(/\s+/).includes(snapshot)) throw new Error('TP environment handover: the written bundle does not hold the work tree\'s snapshot')
      files.push({ path: 'worktree.bundle', ...digest(bundle) })
    }
    const result: HandoverExport = { directory, root, ...anchored ? { head: anchored } : {}, files, ...snapshot ? { snapshot } : {},
      ...bundle ? { bundle } : {}, ...patch ? { patch } : {}, mode: snapshot ? 'bundle' : 'patch', at }
    writeFileSync(path.join(target, 'export.json'), JSON.stringify(result, null, 2), 'utf8')
    return result
  }
}
