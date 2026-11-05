/**
 * Phase 2 C/D lifecycle regression: who may hold the shared TP environment, and when it truly comes back.
 *
 *  1. a completion the host's acceptance confirmed releases the lease (after stopping the editor once);
 *  2. a failed editor stop keeps the lease on every path (completion, stop, handover, and the recovery adapter);
 *  3. a ticket whose environment was handed over takes it again through `Engine.ensureEnvironment`, or is refused
 *     naming the new holder and loses the host tools (`notHolding`);
 *  4. `Engine.acquireEnvironment` is the operator's explicit re-take: a completed ticket may, a stopped or dropped
 *     one may not, and a lease someone else holds is never taken;
 *  5. `acquireHolder` resumes only this process's own record or one whose Session process on this machine is gone.
 *
 * Everything runs through the real broker, `TicketedEnvironment` and `Engine` over a temporary state directory. Every
 * PID is injected (a table of living PIDs), no editor is launched and no real process is signalled. The new Engine API is
 * called through helpers that fail with a plain message when a build lacks it, so a baseline fails on behaviour.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentHeld, EXCLUSIVITY_FILE, readLease } from '../src/app/environment-exclusive.ts'
import { readinessOf, TpEditorRecovery, type EditorProcess, type ReadinessCheck, type TpEditorEnvironment } from '../src/app/editor-recovery.ts'
import { acquireEnvironment, ensureEnvironment, HOST, lifecycleHarness, SELF_PID } from './fixtures/lifecycle-harness.ts'
import { broker } from './fixtures/environment.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const dirWith = (): string => { const root = mkdtempSync(path.join(tmpdir(), 'dsh-p2cd-')); roots.push(root); return root }
const lockOf = (state: string) => readLease(path.join(state, EXCLUSIVITY_FILE))
const editorStop = new Error('kill-tp-editor.ps1 exited with 1: the editor would not close')

/** The assignment a ticket's worker now runs, which its host tools name. */
const assignmentOf = (h: ReturnType<typeof lifecycleHarness>, ticketId: string) => h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id

describe('phase 2 C/D (a): a holder is never displaced', () => {
  it('refuses a second ticket and an ordinary Session while a ticket holds, through waiting and failed reports', () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    const before = lockOf(state)!
    // A ticket asks again: the holder is named and nothing is stolen.
    expect(() => h.tickets.acquire('ticket-b', 'Fix B')).toThrow(EnvironmentHeld)
    // An ordinary Session is a holder like any other and cannot act either.
    expect(() => h.foreign(300).acquire({ kind: 'session', id: 'main-session', label: 'the main Session' })).toThrow(/held by ticket Fix 1/)
    // Reports that are not a release: waiting for a person, and a failed check awaiting rework.
    h.engine.report(first, { state: 'waiting', summary: 'waiting for the person' })
    expect(h.tickets.holds(first)).toBe(true)
    expect(() => h.tickets.acquire('ticket-b', 'Fix B')).toThrow(EnvironmentHeld)
    h.engine.report(first, { state: 'failed', summary: 'the check failed; reworking' })
    expect(h.tickets.holds(first)).toBe(true)
    // A second ticket accepted now is blocked with the holder's name and never launched.
    const second = h.accept('2')
    expect(h.repo.tickets.get(second)!.validation?.blocked).toMatch(/held by ticket Fix 1/)
    expect(h.tickets.holds(second)).toBe(false)
    // `settle` already took the first ticket's launch, so the blocked second ticket left none behind.
    expect(h.launches).toHaveLength(0)
    // The record is exactly the first ticket's, untouched by all of it.
    const after = lockOf(state)!
    expect(after.token).toBe(before.token)
    expect(after.holder).toEqual(before.holder)
    expect(after.acquiredAt).toBe(before.acquiredAt)
    expect(h.broker.view().lastRelease).toBeUndefined()
  })

  it('blocks a ticket accepted while a person’s ordinary Session holds the environment', () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const session = h.foreign(300)
    session.acquire({ kind: 'session', id: 'main-session', label: 'the main Session' })
    const id = h.accept('1')
    const ticket = h.repo.tickets.get(id)!
    expect(ticket.validation?.blocked).toMatch(/held by session the main Session \(Session pid 300\)/)
    expect(h.launches).toHaveLength(0)
    expect(h.tickets.holds(id)).toBe(false)
    expect(lockOf(state)!.holder).toMatchObject({ kind: 'session', id: 'main-session' })
    // The person’s holding survives the refusal: no ticket-side release can reach it.
    expect(h.raised('ticket.exclusive').at(-1)?.data).toMatchObject({ ticketId: id, action: 'refused' })
  })
})

describe('phase 2 C/D (b): a confirmed completion gives the environment back', () => {
  it('stops the editor once, then releases, and only then lets the next ticket in', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    h.hosts.editors.add(first)
    h.tickets.recordStarted(first, 4242)
    const second = h.accept('2')
    expect(h.tickets.holds(second)).toBe(false)
    // The worker reports ready and the host’s own acceptance passes: the ticket completes.
    h.ready(first)
    expect(h.repo.tickets.get(first)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    await vi.waitFor(() => expect(h.tickets.holds(first)).toBe(false))
    // Exactly one stop, and it ran while the ticket still held the lock (the stop precedes the release).
    expect(h.hosts.stops).toEqual([{ ticketId: first, failed: false, holdsAtStop: true }])
    expect(h.hosts.editors.has(first)).toBe(false)
    // The released environment goes to the ticket that was waiting for it, so the release no longer leaves it free.
    await vi.waitFor(() => expect(h.broker.view()).toMatchObject({ held: true, lastRelease: { reason: 'acceptance', ticketId: first } }))
    expect(h.broker.view().holder?.id).toBe(second)
    // The next ticket entered on that release and started, without a person's message.
    expect(h.launches.map(([ticket]) => ticket.id)).toEqual([second])
    // A ticket accepted now is refused behind the waiter that now holds it.
    const third = h.accept('3')
    expect(h.repo.tickets.get(third)!.validation?.blocked).toMatch(/held by ticket Fix 2/)
    expect(lockOf(state)!.holder.id).toBe(second)
  })

  it('keeps the lock when the host’s acceptance is false, and releases once it passes', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const id = h.accept('1')
    h.settle()
    h.hosts.editors.add(id)
    h.hosts.acceptance = () => false
    const token = lockOf(state)!.token
    expect(() => h.ready(id)).toThrow(/not passed the acceptance/)
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()
    expect(h.tickets.holds(id)).toBe(true)
    expect(h.hosts.stops).toHaveLength(0)
    expect(h.hosts.editors.has(id)).toBe(true)
    expect(() => h.tickets.acquire('ticket-b', 'Fix B')).toThrow(EnvironmentHeld)
    expect(lockOf(state)!.token).toBe(token)
    // The check later passes: the same report completes the ticket and gives the environment back.
    h.hosts.acceptance = () => true
    h.ready(id)
    await vi.waitFor(() => expect(h.tickets.holds(id)).toBe(false))
    expect(h.hosts.stops).toHaveLength(1)
    expect(h.broker.view().lastRelease).toMatchObject({ reason: 'acceptance', ticketId: id })
  })
})

describe('phase 2 C/D (c): a failed editor stop never frees the environment', () => {
  it('keeps the lease and the editor ownership after a completion, until a retry stops the editor', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    h.hosts.editors.add(first)
    h.tickets.recordStarted(first, 4242)
    const token = lockOf(state)!.token
    h.hosts.stopFailure = editorStop
    h.ready(first)
    // The release failure is reported, and not swallowed into a release.
    await vi.waitFor(() => expect(h.raised('ticket.handover').at(-1)?.data).toMatchObject({ ticketId: first, handedOver: false, error: expect.stringMatching(/release failed.*would not close/s) }))
    expect(h.hosts.stops).toEqual([{ ticketId: first, failed: true, holdsAtStop: true }])
    expect(h.tickets.holds(first)).toBe(true)
    expect(lockOf(state)!.token).toBe(token)
    expect(lockOf(state)!.facts?.editorPid).toBe('4242')
    expect(h.hosts.editors.has(first)).toBe(true)
    expect((h.tickets as unknown as { editorPids: Map<string, number | undefined> }).editorPids.get(first)).toBe(4242)
    expect(h.broker.view().lastRelease).toBeUndefined()
    // The next ticket is still refused, with the first one’s name.
    const second = h.accept('2')
    expect(h.repo.tickets.get(second)!.validation?.blocked).toMatch(/held by ticket Fix 1/)
    expect(h.tickets.holds(second)).toBe(false)
    // The editor can be stopped on a retry: only then is the environment released.
    h.hosts.stopFailure = undefined
    expect(await h.tickets.end(first, { by: 'executor', outcome: 'completed' }, true)).toBe(true)
    expect(h.hosts.stops.map(stop => stop.failed)).toEqual([true, false])
    expect(h.hosts.editors.has(first)).toBe(false)
    expect((h.tickets as unknown as { editorPids: Map<string, number | undefined> }).editorPids.has(first)).toBe(false)
    expect(h.broker.view()).toMatchObject({ held: false, lastRelease: { reason: 'acceptance', ticketId: first } })
    const third = h.accept('3')
    expect(h.tickets.holds(third)).toBe(true)
  })

  it('keeps the lease when a person’s stop cannot stop the editor, and releases on the retry', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const id = h.accept('1')
    h.settle()
    h.hosts.editors.add(id)
    h.tickets.recordStarted(id, 4242)
    h.hosts.stopFailure = editorStop
    h.engine.stopTicket(id)
    await vi.waitFor(() => expect(h.raised('ticket.handover').at(-1)?.data).toMatchObject({ ticketId: id, handedOver: false }))
    expect(h.repo.tickets.get(id)!.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
    expect(h.tickets.holds(id)).toBe(true)
    expect(h.hosts.editors.has(id)).toBe(true)
    expect(() => h.tickets.acquire('ticket-b', 'Fix B')).toThrow(EnvironmentHeld)
    expect(h.broker.view().lastRelease).toBeUndefined()
    h.hosts.stopFailure = undefined
    expect(await h.tickets.end(id, { by: 'human', outcome: 'stopped' }, false)).toBe(true)
    expect(h.broker.view().lastRelease).toMatchObject({ reason: 'stopped', ticketId: id })
    expect(h.tickets.holds(id)).toBe(false)
  })

  it('refuses a handover whose editor cannot be stopped, keeps the ticket holding, and hands over on the retry', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const id = h.accept('1')
    h.settle()
    h.hosts.editors.add(id)
    h.tickets.recordStarted(id, 4242)
    const token = lockOf(state)!.token
    h.hosts.stopFailure = editorStop
    const refused = await h.engine.handOverEnvironment(id)
    expect(refused.handedOver).toBe(false)
    expect(refused.error).toMatch(/editor.*could not be stopped.*would not close/s)
    expect(h.tickets.holds(id)).toBe(true)
    expect(lockOf(state)!.token).toBe(token)
    expect(h.hosts.editors.has(id)).toBe(true)
    expect(() => h.tickets.acquire('ticket-b', 'Fix B')).toThrow(EnvironmentHeld)
    expect(h.raised('ticket.handover').at(-1)?.data).toMatchObject({ ticketId: id, handedOver: false })
    h.hosts.stopFailure = undefined
    const done = await h.engine.handOverEnvironment(id)
    expect(done.handedOver).toBe(true)
    expect(h.hosts.editors.has(id)).toBe(false)
    expect(h.tickets.holds(id)).toBe(false)
    expect(h.broker.view().lastRelease).toMatchObject({ reason: 'handover', ticketId: id })
  })

  it('makes the recovery adapter’s cleanup throw and keep its record of the editor it started', async () => {
    const root = dirWith()
    const projectFile = path.join(root, 'TP.uproject')
    writeFileSync(projectFile, '{}')
    const environment: TpEditorEnvironment = { projectFile, editorExe: path.join(root, 'UnrealEditor.exe'), port: 55255, captureTool: 'Capture' }
    const editor: EditorProcess = { pid: 4242, name: 'UnrealEditor.exe', commandLine: `"${environment.editorExe}" "${projectFile}"`, executablePath: environment.editorExe }
    const kills: (number | undefined)[] = []
    let failKill = false
    let handshakes = 0
    const notReady = readinessOf({ listened: false, endpoint: '', sessionId: '', tools: [] }, 'Capture')
    const ready: ReadinessCheck = { ready: true, endpoint: 'http://127.0.0.1:55255/mcp', sessionId: 'mcp', tools: ['Capture'], reason: '', listened: true }
    const recovery = new TpEditorRecovery(() => ({ enabled: true, environment }), {
      platform: 'win32',
      exclusive: async () => ({ holder: 'ticket-a', release: async () => {} }),
      handshake: async () => (++handshakes === 1 ? notReady : ready),
      launch: async () => 4242,
      killEditor: async (_environment, pid) => { kills.push(pid); if (pid !== undefined && failKill) throw editorStop },
      processList: async () => [editor],
      portTable: async () => ['  TCP    0.0.0.0:55255    0.0.0.0:0    LISTENING    4242'],
    }, root)
    const outcome = await recovery.recover('ticket-a', undefined, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'recovered', startedPid: 4242 })
    expect(recovery.owns('ticket-a')).toBe(true)
    failKill = true
    await expect(recovery.cleanup('ticket-a', environment)).rejects.toThrow(/would not close/)
    // The failed stop leaves the record: the editor is still the ticket’s to stop.
    expect(recovery.owns('ticket-a')).toBe(true)
    failKill = false
    await recovery.cleanup('ticket-a', environment)
    expect(recovery.owns('ticket-a')).toBe(false)
    expect(kills.filter(pid => pid === 4242)).toHaveLength(2)
  })
})

describe('phase 2 C/D (d): a ticket continues after a handover only through the lock', () => {
  const handedOver = async (h: ReturnType<typeof lifecycleHarness>, id: string) => {
    const result = await h.engine.handOverEnvironment(id)
    expect(result.handedOver).toBe(true)
    expect(h.tickets.holds(id)).toBe(false)
  }

  it('takes the environment again when nobody holds it, and leaves a holder’s own lease alone', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const id = h.accept('1')
    h.settle()
    // A ticket that holds nothing wrong is left alone: no new token, no event.
    const token = lockOf(state)!.token
    const raised = h.raised('ticket.exclusive').length
    ensureEnvironment(h.engine, id)
    expect(lockOf(state)!.token).toBe(token)
    expect(h.raised('ticket.exclusive')).toHaveLength(raised)
    await handedOver(h, id)
    ensureEnvironment(h.engine, id)
    expect(h.tickets.holds(id)).toBe(true)
    expect(lockOf(state)!.holder.id).toBe(id)
    expect(h.raised('ticket.exclusive').at(-1)?.data).toMatchObject({ ticketId: id, action: 'acquired' })
    // The host tools work again for it (they then fail for their own reasons, not for the lock).
    await expect(h.engine.runTicketTests(id, assignmentOf(h, id))).rejects.toThrow(/Strict validation not enabled/)
  })

  it('refuses to take a lock another ticket now holds, names it, and takes the host tools away', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    const assignmentId = assignmentOf(h, first)
    await handedOver(h, first)
    const second = h.accept('2')
    expect(h.tickets.holds(second)).toBe(true)
    const before = lockOf(state)!
    expect(() => ensureEnvironment(h.engine, first)).toThrow(/held by ticket Fix 2/)
    expect(h.raised('ticket.exclusive').at(-1)?.data).toMatchObject({ ticketId: first, action: 'refused', reason: expect.stringMatching(/held by ticket Fix 2/) })
    // Nothing was taken: B still owns the very same record.
    const after = lockOf(state)!
    expect(after.token).toBe(before.token)
    expect(after.holder.id).toBe(second)
    expect(after.acquiredAt).toBe(before.acquiredAt)
    expect(h.tickets.holds(first)).toBe(false)
    expect(h.tickets.holds(second)).toBe(true)
    // The first ticket’s worker may not run a host tool for an environment it does not hold.
    await expect(h.engine.runTicketTests(first, assignmentId)).rejects.toMatchObject({ code: 'notHolding' })
    // Once B hands over, A may take it back.
    await handedOver(h, second)
    ensureEnvironment(h.engine, first)
    expect(h.tickets.holds(first)).toBe(true)
  })

  it('is refused naming a person’s ordinary Session that took the environment, and does nothing for an ended ticket', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    await handedOver(h, first)
    h.foreign(300).acquire({ kind: 'session', id: 'main-session', label: 'the main Session' })
    expect(() => ensureEnvironment(h.engine, first)).toThrow(/held by session the main Session/)
    expect(lockOf(state)!.holder).toMatchObject({ kind: 'session', id: 'main-session' })
    // An ended ticket never takes the environment again here, whoever holds it.
    h.engine.stopTicket(first)
    expect(() => ensureEnvironment(h.engine, first)).not.toThrow()
    expect(lockOf(state)!.holder.id).toBe('main-session')
  })

  it('is called by the executor before a launch and before delivering an Input', () => {
    const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'executor', 'dsh.ts'), 'utf8')
    const body = (name: string) => source.slice(source.indexOf(`${name}(`))
    for (const method of ['private async deliverQueued', 'private async launch']) {
      const text = body(method)
      const next = text.indexOf('\n  private ', 10)
      const section = next > 0 ? text.slice(0, next) : text
      expect(section, method).toMatch(/engine\.ensureEnvironment\(/)
    }
  })
})

describe('phase 2 C/D (e): the lease of another living Session process is never resumed', () => {
  const holder = { id: 'ticket-a', label: 'Ticket A' }
  const processes = (...living: number[]) => (pid: number) => living.includes(pid)

  it('refuses the same holder id from a different living PID, on this machine or another', () => {
    const state = dirWith()
    const first = broker(HOST, 100, processes(100, 200, 500), state).acquireHolder(holder)
    const before = lockOf(state)!
    // Same machine, different living PID: not this process’s record, and its owner is alive.
    expect(() => broker(HOST, 200, processes(100, 200, 500), state).acquireHolder(holder)).toThrow(EnvironmentHeld)
    // Another machine: liveness cannot be judged here, so it is respected.
    expect(() => broker('host-other', 500, processes(100, 200, 500), state).acquireHolder(holder)).toThrow(EnvironmentHeld)
    const after = lockOf(state)!
    expect(after).toEqual(before)
    expect(after.token).toBe(first.token)
    expect(after.pid).toBe(100)
    // The record of the very first call is also what a person reads.
    expect(broker(HOST, 100, processes(100), state).view()).toMatchObject({ held: true, holder: { id: 'ticket-a' }, pid: 100 })
  })

  it('resumes the record of a dead Session process on this machine: same owner and time, a new token', () => {
    const state = dirWith()
    const first = broker(HOST, 100, processes(100), state).acquireHolder(holder)
    const before = lockOf(state)!
    // PID 100 is gone and the host starts again as Session process 200 (`wake`, as a restarted deployment does, which keeps
    // this machine’s own record instead of reaping it): it takes its predecessor’s own record back.
    const restarted = broker(HOST, 200, processes(200), state)
    restarted.wake()
    const resumed = restarted.acquireHolder(holder)
    const after = lockOf(state)!
    expect(resumed.token).not.toBe(first.token)
    expect(after.token).toBe(resumed.token)
    expect(after.token).not.toBe(before.token)
    expect(after.holder).toEqual(before.holder)
    expect(after.acquiredAt).toBe(before.acquiredAt)
    expect(after.pid).toBe(200)
    expect(after.heartbeat > before.heartbeat).toBe(true)
  })

  it('resumes this process’s own record after a restart in place, and still refuses a different holder', () => {
    const state = dirWith()
    const first = broker(HOST, 100, processes(100), state).acquireHolder(holder)
    const before = lockOf(state)!
    const resumed = broker(HOST, 100, processes(100), state).acquireHolder(holder)
    const after = lockOf(state)!
    expect(after.token).toBe(resumed.token)
    expect(after.token).not.toBe(first.token)
    expect(after.acquiredAt).toBe(before.acquiredAt)
    expect(after.holder).toEqual(before.holder)
    expect(() => broker(HOST, 100, processes(100), state).acquireHolder({ id: 'ticket-b', label: 'Ticket B' })).toThrow(EnvironmentHeld)
    expect(lockOf(state)!.token).toBe(after.token)
  })

  it('does not let a second process’s ticket side take the ticket’s lease through the Engine’s port', () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const id = h.accept('1')
    const before = lockOf(state)!
    // A second deployment on the same state directory, a living foreign process, asks for the same ticket.
    expect(() => h.foreign(200).acquireHolder({ kind: 'ticket', id, label: 'Fix 1' })).toThrow(EnvironmentHeld)
    expect(lockOf(state)).toEqual(before)
    expect(h.tickets.holds(id)).toBe(true)
    expect(SELF_PID).toBe(before.pid)
  })
})

describe('phase 2 C/D (f): Engine.acquireEnvironment is the operator’s explicit re-take', () => {
  it('lets a completed ticket take the environment again, and is idempotent', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const id = h.accept('1')
    h.settle()
    h.ready(id)
    await vi.waitFor(() => expect(h.tickets.holds(id)).toBe(false))
    expect(h.repo.tickets.get(id)!.ended?.outcome).toBe('completed')
    expect(acquireEnvironment(h.engine, id)).toEqual({ held: true })
    expect(h.tickets.holds(id)).toBe(true)
    expect(lockOf(state)!.holder.id).toBe(id)
    expect(h.raised('ticket.exclusive').at(-1)?.data).toMatchObject({ ticketId: id, action: 'acquired' })
    const token = lockOf(state)!.token
    expect(acquireEnvironment(h.engine, id)).toEqual({ held: true })
    expect(lockOf(state)!.token).toBe(token)
  })

  it('refuses a stopped or dropped ticket and takes nothing', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const stopped = h.accept('1')
    h.settle()
    h.engine.stopTicket(stopped)
    await vi.waitFor(() => expect(h.tickets.holds(stopped)).toBe(false))
    expect(() => acquireEnvironment(h.engine, stopped)).toThrow(/Ticket has ended/)
    expect(h.broker.held()).toBeUndefined()
    const dropped = h.accept('2')
    h.settle()
    h.engine.report(dropped, { state: 'dropped', summary: 'nothing to do' })
    await vi.waitFor(() => expect(h.tickets.holds(dropped)).toBe(false))
    expect(() => acquireEnvironment(h.engine, dropped)).toThrow(/Ticket has ended/)
    expect(h.broker.held()).toBeUndefined()
    expect(() => acquireEnvironment(h.engine, 'unknown-ticket')).toThrow(/Unknown ticket/)
  })

  it('refuses a completed ticket while another ticket holds the environment, and never steals it', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    h.ready(first)
    await vi.waitFor(() => expect(h.tickets.holds(first)).toBe(false))
    const second = h.accept('2')
    expect(h.tickets.holds(second)).toBe(true)
    const before = lockOf(state)!
    expect(() => acquireEnvironment(h.engine, first)).toThrow(/held by ticket Fix 2/)
    expect(h.raised('ticket.exclusive').at(-1)?.data).toMatchObject({ ticketId: first, action: 'refused' })
    expect(lockOf(state)).toEqual(before)
    expect(h.tickets.holds(first)).toBe(false)
    // A person’s ordinary Session holding it is refused the same way.
    await h.engine.handOverEnvironment(second)
    h.foreign(300).acquire({ kind: 'session', id: 'main-session', label: 'the main Session' })
    expect(() => acquireEnvironment(h.engine, first)).toThrow(/held by session the main Session/)
    expect(lockOf(state)!.holder.id).toBe('main-session')
  })
})

describe('phase 2 C/D (g): a ticket refused the environment at acceptance starts once it is released', () => {
  it('takes the environment and launches the queued Assignment after the holder completes', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    // Accepted while the first ticket holds the environment: recorded, blocked, and never launched.
    const second = h.accept('2')
    expect(h.repo.tickets.get(second)!.validation?.blocked).toMatch(/held by ticket Fix 1/)
    expect(h.launches).toHaveLength(0)
    expect(h.tickets.holds(second)).toBe(false)
    // The holder completes and releases: the waiting ticket starts on its own, without a person's message.
    h.ready(first)
    await vi.waitFor(() => expect(h.tickets.holds(second)).toBe(true))
    expect(h.repo.tickets.get(second)!.validation?.blocked).toBeUndefined()
    expect(h.launches.map(([ticket]) => ticket.id)).toEqual([second])
    expect(lockOf(state)!.holder.id).toBe(second)
    expect(h.raised('ticket.exclusive').at(-1)?.data).toMatchObject({ ticketId: second, action: 'acquired' })
    // It is the latest ticket's own first Assignment that was launched, and only once.
    expect(h.launches[0]![1]).toBe(h.repo.tickets.get(second)!.assignments.at(-1)!.id)
    h.settle()
    expect(h.repo.tickets.get(second)!.assignments.at(-1)!.state).toBe('running')
    expect(h.launches).toHaveLength(0)
  })

  it('hands a released environment to the oldest waiter only, and the rest keep waiting', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    const second = h.accept('2')
    const third = h.accept('3')
    expect([second, third].map(id => !!h.repo.tickets.get(id)!.validation?.blocked)).toEqual([true, true])
    h.ready(first)
    // Only the oldest waiter takes it; the other keeps waiting rather than failing.
    await vi.waitFor(() => expect(h.launches.map(([ticket]) => ticket.id)).toEqual([second]))
    expect(h.tickets.holds(second)).toBe(true)
    expect(h.tickets.holds(third)).toBe(false)
    // The refused third ticket still names its own blocker: the holder it was refused for, not the ticket that just took it.
    expect(h.repo.tickets.get(third)!.validation?.blocked).toMatch(/held by ticket Fix 1/)
    // Nothing displaced the oldest waiter for the other one.
    expect(lockOf(state)!.holder.id).toBe(second)
    expect(h.launches).toHaveLength(1)
  })

  it('starts a waiter only for a release, exactly once, and not for a stop that released nothing', async () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    const first = h.accept('1')
    h.settle()
    const blocked = h.accept('2')
    expect(h.repo.tickets.get(blocked)!.validation?.blocked).toMatch(/held by ticket Fix 1/)
    // A stop of the holder's ticket that released nothing (the holder is not that ticket) starts no waiter.
    h.engine.stopTicket(first)
    await vi.waitFor(() => expect(h.tickets.holds(blocked)).toBe(true))
    expect(h.launches.map(([ticket]) => ticket.id)).toEqual([blocked])
    // A later release with no waiter leaves the environment free, and starts nothing.
    h.engine.stopTicket(blocked)
    await vi.waitFor(() => expect(h.broker.view().held).toBe(false))
    expect(h.launches).toHaveLength(1)
  })
})
