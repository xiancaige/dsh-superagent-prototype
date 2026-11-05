/**
 * Phase 2 C, the TP environment exclusivity itself: the persisted lease in B2's one lock file, the
 * holder that is never stolen, the heartbeat that keeps it across waiting and idling, the restart that
 * keeps the owner, the releases the contract allows and nothing else, and the handover export that
 * preserves a ticket's uncommitted scene instead of discarding it.
 *
 * Every PID is injected: the tests never signal a real process, launch an editor or lock a real
 * environment. The git half runs real `git` in a throw-away repository.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EnvironmentExclusivity, EnvironmentHeld, EnvironmentHeldBySelf, EXCLUSIVITY_FILE, environmentResources, leaseLive, readLease,
} from '../src/app/environment-exclusive.ts'
import { environmentPort } from '../src/app/ticketed-environment.ts'
import { broker, ticketed, TP } from './fixtures/environment.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const dir = (prefix: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), `dsh-env-${prefix}-`))
  roots.push(root)
  return root
}
const ownBroker = (host: string, pid: number, alive: (candidate: number) => boolean = candidate => candidate === 100, state?: string) =>
  broker(host, pid, alive, state ?? dir('state'))

describe('phase 2 C the persisted lease', () => {
  it('records the holder, its kind, the resources, the acquisition time and a heartbeat in B2 one lock file', () => {
    const state = dir('state')
    const instance = ownBroker('host-1', 100, pid => pid === 100, state)
    const lease = instance.acquire({ kind: 'ticket', id: 'ticket-a', label: 'Ticket A', resources: environmentResources(TP, 'F:\\TP\\.dsh\\work\\a') })
    const file = path.join(state, EXCLUSIVITY_FILE)
    expect(file.endsWith('tp-environment.lock')).toBe(true)
    expect(existsSync(file)).toBe(true)
    const record = readLease(file)!
    expect(record).toMatchObject({ pid: 100, host: 'host-1', holder: { kind: 'ticket', id: 'ticket-a', label: 'Ticket A' } })
    expect(record.acquiredAt).toBeTruthy()
    expect(record.heartbeat).toBe(record.acquiredAt)
    expect(record.resources.map(resource => resource.name)).toEqual(['tp-editor', 'tpmcp-port', 'tp-project', 'ticket-directory'])
    expect(record.resources.map(resource => resource.value)).toEqual([TP.projectFile, '55255', 'F:\\TP', 'F:\\TP\\.dsh\\work\\a'])
    // A heartbeat moves the heartbeat time on, and keeps the holder and the acquisition time.
    lease.beat()
    const beaten = readLease(file)!
    expect(beaten.heartbeat > record.heartbeat).toBe(true)
    expect(beaten.acquiredAt).toBe(record.acquiredAt)
    expect(beaten.token).toBe(record.token)
  })

  it('refuses a second holder and names the one that has it, without retrying or stealing', () => {
    const state = dir('state')
    const first = ownBroker('host-1', 100, pid => pid === 100 || pid === 200, state).acquire({ id: 'ticket-a', label: 'Ticket A' })
    const second = ownBroker('host-1', 200, pid => pid === 100 || pid === 200, state)
    let refusal: unknown
    try { second.acquire({ id: 'ticket-b', label: 'Ticket B' }) } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(EnvironmentHeld)
    expect((refusal as Error).message).toMatch(/held by ticket Ticket A \(Session pid 100\)/)
    // The holder's record is untouched by the refusal, and a second try is the same refusal: nothing is taken by force.
    expect(readLease(path.join(state, EXCLUSIVITY_FILE))!.token).toBe(first.token)
    expect(() => second.acquire({ id: 'ticket-b', label: 'Ticket B' })).toThrow(/held by ticket Ticket A/)
  })

  it('refuses an ordinary Session while a ticket holds it, and a ticket while a person does', () => {
    const state = dir('state')
    const alive = (pid: number) => [100, 300, 400].includes(pid)
    const tickets = ownBroker('host-1', 100, alive, state)
    tickets.acquire({ id: 'ticket-a', label: 'Ticket A' })
    // A person's ordinary Session is a holder like any other: it cannot act while the ticket has the environment.
    const person = ownBroker('host-1', 300, alive, state)
    expect(() => person.acquire({ kind: 'session', id: 'main-session', label: 'the main Session' })).toThrow(/held by ticket Ticket A/)
    // The ticket is stopped, and the person's handover takes the environment for their own work.
    tickets.release(tickets.read()!.token, 'stopped', 'ticket-a')
    const held = person.acquire({ kind: 'session', id: 'main-session', label: 'the main Session' })
    expect(held.record.holder).toMatchObject({ kind: 'session', id: 'main-session' })
    expect(() => ownBroker('host-1', 400, alive, state).acquire({ id: 'ticket-b', label: 'Ticket B' })).toThrow(/held by session the main Session/)
  })

  it('keeps the owner across a restart of the same Session process, and resumes rather than taking a second', () => {
    const state = dir('state')
    const before = ownBroker('host-1', 100, pid => pid === 100, state)
    const held = before.acquire({ id: 'ticket-a', label: 'Ticket A' })
    // A host restarts in place: the same Session process re-reads the record, which is still live.
    const after = new EnvironmentExclusivity(state, { self: () => ({ pid: 100, host: 'host-1' }), alive: pid => pid === 100 })
    const record = readLease(path.join(state, EXCLUSIVITY_FILE))!
    expect(leaseLive(record, { self: () => ({ pid: 100, host: 'host-1' }), alive: pid => pid === 100 })).toBe(true)
    // The restarted host re-takes the lease it persisted: same holder, same acquisition time, a new token.
    const resumed = after.acquireHolder({ id: 'ticket-a', label: 'Ticket A' })
    expect(resumed.record.holder).toMatchObject({ id: 'ticket-a' })
    expect(resumed.record.acquiredAt).toBe(held.record.acquiredAt)
    expect(resumed.token).not.toBe(held.token)
    expect(readLease(path.join(state, EXCLUSIVITY_FILE))!.holder.id).toBe('ticket-a')
  })

  it('reaps only a record whose Session process is gone, and never another machine holder', () => {
    const state = dir('state')
    ownBroker('host-1', 100, () => false, state).acquire({ id: 'ticket-dead', label: 'Dead ticket' })
    // Its process is gone: the environment is free for the next holder.
    const next = ownBroker('host-1', 200, pid => pid === 200, state).acquire({ id: 'ticket-next', label: 'Next' })
    expect(next.record.holder.id).toBe('ticket-next')
    // Another machine's live record is respected, even though this host cannot see its PID.
    const remote = ownBroker('host-other', 500, pid => pid === 500, state)
    remote.release(remote.read()!.token, 'stopped')
    remote.acquire({ id: 'ticket-remote', label: 'Remote' })
    expect(() => ownBroker('host-1', 300, () => false, state).acquire({ id: 'ticket-c', label: 'C' })).toThrow(/held by ticket Remote/)
  })

  it('reads a B2 key=value lock as a ticket lease, so an upgrade finds the same lock instead of a second one', () => {
    const state = dir('state')
    mkdirSync(state, { recursive: true })
    writeFileSync(path.join(state, EXCLUSIVITY_FILE), 'pid=999999\r\nholder=ticket-old\r\nhost=host-1\r\ntime=2026-11-02T00:00:00.000Z\r\ntoken=dead\r\n')
    const record = readLease(path.join(state, EXCLUSIVITY_FILE))!
    expect(record).toMatchObject({ token: 'dead', holder: { kind: 'ticket', id: 'ticket-old' } })
    // Its PID is gone, so the next holder may take the same file.
    expect(ownBroker('host-1', 200, () => false, state).acquire({ id: 'ticket-new', label: 'New' }).record.holder.id).toBe('ticket-new')
  })

  it('takes its own live record as held by self, which a resumed host takes back instead of failing', () => {
    const state = dir('state')
    const first = ownBroker('host-1', 100, pid => pid === 100, state).acquire({ id: 'ticket-a', label: 'Ticket A' })
    const same = ownBroker('host-1', 100, pid => pid === 100, state)
    expect(() => same.acquire({ id: 'ticket-a', label: 'Ticket A' })).toThrow(EnvironmentHeldBySelf)
    expect(same.acquireHolder({ id: 'ticket-a', label: 'Ticket A' }).record.acquiredAt).toBe(first.record.acquiredAt)
  })
})

describe('phase 2 C releases', () => {
  const held = (state: string) => {
    const instance = ownBroker('host-1', 100, pid => pid === 100, state)
    const lease = instance.acquire({ id: 'ticket-a', label: 'Ticket A' })
    return { instance, lease }
  }

  it('refuses a release that is not one of the contract facts, and only the holder own token releases', () => {
    const state = dir('state')
    const { instance, lease } = held(state)
    // Waiting for a person, idling, a released slot, a failure to rework: none of them is a release reason.
    for (const reason of ['waiting', 'idle', 'slot', 'failed', 'rework', 'restart']) {
      expect(() => instance.release(lease.token, reason as never)).toThrow(/not a release reason/)
    }
    expect(existsSync(path.join(state, EXCLUSIVITY_FILE))).toBe(true)
    // A token that is not the current holder's never deletes a later holder's lock.
    expect(() => instance.release('someone-else', 'handover')).toThrow(/not held by this token/)
    expect(lease.release.bind(lease, 'acceptance')).not.toThrow()
    expect(existsSync(path.join(state, EXCLUSIVITY_FILE))).toBe(false)
    // The next holder is refused a release with the earlier holder's token.
    const next = instance.acquire({ id: 'ticket-b', label: 'Ticket B' })
    expect(() => instance.release(lease.token, 'stopped')).toThrow(/not held by this token/)
    expect(readLease(path.join(state, EXCLUSIVITY_FILE))!.holder.id).toBe('ticket-b')
    expect(next.record.holder.id).toBe('ticket-b')
  })

  it('records why it released, which a person reads', () => {
    const state = dir('state')
    const { instance, lease } = held(state)
    lease.release('handover', 'ticket-a', 'handovers/ticket-a-2026')
    const view = instance.view()
    expect(view.held).toBe(false)
    expect(view.lastRelease).toMatchObject({ reason: 'handover', ticketId: 'ticket-a', export: 'handovers/ticket-a-2026', holder: 'Ticket A' })
  })

  it('does not write a heartbeat once the host stopped, so its record survives for the next start', () => {
    const state = dir('state')
    const { instance, lease } = held(state)
    instance.halt()
    const before = readLease(path.join(state, EXCLUSIVITY_FILE))!.heartbeat
    expect(instance.beat(lease.token)!.heartbeat).toBe(before)
    // A live holder's record is never reaped as stale by a later start.
    expect(ownBroker('host-1', 100, pid => pid === 100, state).reapIfDead()).toBe(false)
  })
})

describe('phase 2 C ticket lifecycle', () => {
  it('blocks a second ticket with the holder name while the first waits for a person or idles', () => {
    const state = dir('state')
    const { instance, tickets } = ticketed(state)
    tickets.acquire('ticket-a', 'Ticket A')
    // The worker waits for a person, reports waiting, its slot is freed, its turn goes idle: none of it releases.
    for (let beat = 0; beat < 3; beat++) tickets.beat()
    expect(tickets.holds('ticket-a')).toBe(true)
    expect(() => tickets.acquire('ticket-b', 'Ticket B')).toThrow(/held by ticket Ticket A/)
    expect(instance.view()).toMatchObject({ held: true, holder: { kind: 'ticket', id: 'ticket-a' } })
  })

  it('releases only for acceptance that passed, a stop, or the work ending by itself', async () => {
    const state = dir('state')
    const { instance, tickets, events, editors } = ticketed(state)
    tickets.acquire('ticket-a', 'Ticket A')
    // A completion the host cannot see as passed keeps the lock, as a retry that reworks does.
    expect(await tickets.end('ticket-a', { by: 'executor', outcome: 'completed' }, false)).toBe(false)
    expect(tickets.holds('ticket-a')).toBe(true)
    // Its acceptance passed: the host completes it, stops exactly its editor and releases.
    editors.set('ticket-a', '4242')
    expect(await tickets.end('ticket-a', { by: 'executor', outcome: 'completed' }, true)).toBe(true)
    expect(events).toEqual(['stop:ticket-a'])
    expect(instance.view().lastRelease).toMatchObject({ reason: 'acceptance', ticketId: 'ticket-a' })
    // Now the next ticket enters.
    tickets.acquire('ticket-b', 'Ticket B')
    expect(tickets.holds('ticket-b')).toBe(true)
    // A person stops it: the ticket is released as stopped.
    expect(await tickets.end('ticket-b', { by: 'human', outcome: 'stopped' }, false)).toBe(true)
    expect(instance.view().lastRelease).toMatchObject({ reason: 'stopped', ticketId: 'ticket-b' })
  })

  it('exposes the hold as the engine own second line of defence', () => {
    const state = dir('state')
    const { tickets } = ticketed(state)
    const port = environmentPort(tickets)!
    expect(port.holds('ticket-a')).toBe(false)
    expect(port.describe('ticket-a')).toBeUndefined()
    tickets.acquire('ticket-a', 'Ticket A')
    expect(port.holds('ticket-a')).toBe(true)
    expect(port.describe('ticket-a')).toMatchObject({ ticketId: 'ticket-a', held: { at: expect.any(String) } })
  })
})

describe('phase 2 C handover export', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  function repository(): string {
    const root = dir('repo')
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    writeFileSync(path.join(root, 'kept.txt'), 'one\n')
    writeFileSync(path.join(root, 'changed.txt'), 'before\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    return root
  }
  const status = (root: string) => git(root, 'status', '--porcelain=v1', '-uall')

  it('exports the uncommitted scene without touching it, and proves the export holds it', async () => {
    const root = repository()
    // The ticket's uncommitted work: a tracked change, an untracked file, and a staged one.
    writeFileSync(path.join(root, 'changed.txt'), 'after\n')
    writeFileSync(path.join(root, 'brand-new.txt'), 'new file\n')
    writeFileSync(path.join(root, 'staged.txt'), 'staged\n')
    git(root, 'add', 'staged.txt')
    const before = status(root)
    const head = git(root, 'rev-parse', 'HEAD').trim()
    const exported = (await ownBroker('host-1', process.pid).export(root, 'ticket-a'))!
    expect(exported).toMatchObject({ directory: root, mode: 'bundle', head })
    expect(exported.files.map(file => file.path)).toEqual(['worktree.patch', 'worktree.bundle'])
    for (const file of exported.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    // The scene is exactly as it was: nothing committed, stashed away, reset or cleaned.
    expect(status(root)).toBe(before)
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(root, 'stash', 'list').trim()).toBe('')
    expect(readFileSync(path.join(root, 'changed.txt'), 'utf8')).toBe('after\n')
    expect(readFileSync(path.join(root, 'brand-new.txt'), 'utf8')).toBe('new file\n')
    // The export holds the scene: the snapshot's parent is HEAD, its tree is the work tree as it stood.
    expect(git(root, 'rev-parse', `${exported.snapshot}^1`).trim()).toBe(head)
    expect(git(root, 'show', `${exported.snapshot}^2:staged.txt`)).toBe('staged\n')
    // The patch holds the tracked changes (unstaged and staged); the bundle holds the whole scene.
    expect(readFileSync(exported.patch!, 'utf8')).toMatch(/^\+\+\+ b\/changed\.txt$/m)
    expect(readFileSync(exported.patch!, 'utf8')).toMatch(/^\+\+\+ b\/staged\.txt$/m)
    // The bundle restored elsewhere reproduces the commit, its snapshot and the staged tree.
    const clone = dir('restore')
    git(clone, 'init', '-q')
    git(clone, 'bundle', 'unbundle', exported.bundle!)
    expect(git(clone, 'cat-file', '-p', `${exported.snapshot}^2:staged.txt`)).toBe('staged\n')
    expect(git(clone, 'rev-parse', `${exported.snapshot}^1`).trim()).toBe(head)
  })

  it('hands the environment over only after the export, so the next ticket enters with the scene preserved', async () => {
    const root = repository()
    writeFileSync(path.join(root, 'changed.txt'), 'mine\n')
    const state = dir('state')
    const { instance, tickets, directories } = ticketed(state)
    directories.set('ticket-a', root)
    tickets.acquire('ticket-a', 'Ticket A')
    const result = await tickets.handover('ticket-a')
    expect(result.handedOver).toBe(true)
    expect(result.files).toBe(2)
    expect(result.export).toMatch(/worktree\.bundle$/)
    expect(readFileSync(path.join(root, 'changed.txt'), 'utf8')).toBe('mine\n')
    expect(status(root)).toContain('M changed.txt')
    expect(instance.view().held).toBe(false)
    // The next ticket now enters.
    tickets.acquire('ticket-b', 'Ticket B')
    expect(tickets.holds('ticket-b')).toBe(true)
  })

  it('refuses the handover, and keeps the lock, when the scene cannot be exported', async () => {
    const plain = dir('plain')
    writeFileSync(path.join(plain, 'work.txt'), 'uncommitted\n')
    const state = dir('state')
    const { instance, tickets, directories } = ticketed(state)
    directories.set('ticket-a', plain)
    tickets.acquire('ticket-a', 'Ticket A')
    const result = await tickets.handover('ticket-a')
    expect(result.handedOver).toBe(false)
    expect(result.error).toMatch(/not a git work tree/)
    expect(instance.view()).toMatchObject({ held: true, holder: { id: 'ticket-a' } })
    expect(readFileSync(path.join(plain, 'work.txt'), 'utf8')).toBe('uncommitted\n')
  })

  it('refuses to claim an export for a repository with no commit, which holds no scene to sketch', async () => {
    const root = dir('repo-empty')
    git(root, 'init', '-q')
    writeFileSync(path.join(root, 'first.txt'), 'fresh\n')
    await expect(ownBroker('host-1', process.pid).export(root, 'ticket-a')).rejects.toThrow(/no commit yet/)
    // Its scene is untouched, and a directory that is not a work tree reports nothing to export at all.
    expect(readFileSync(path.join(root, 'first.txt'), 'utf8')).toBe('fresh\n')
    expect(await ownBroker('host-1', process.pid).export(dir('plain'), 'ticket-b')).toBeUndefined()
  })
})
