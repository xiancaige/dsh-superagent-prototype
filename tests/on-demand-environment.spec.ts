/**
 * TODO 32: every ticket works in its own git worktree, and the TP environment (editor + TPMcp port) is taken only when a
 * ticket asks for the editor. No ticket is told apart by its role; the only shared resource is the one editor.
 *
 * Runs the real Engine over the real broker and `TicketedEnvironment` in a temporary state directory; no editor is launched.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvironmentHeld, EXCLUSIVITY_FILE, readLease } from '../src/app/environment-exclusive.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { lifecycleHarness } from './fixtures/lifecycle-harness.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const dirWith = (): string => { const root = mkdtempSync(path.join(tmpdir(), 'dsh-ondemand-')); roots.push(root); return root }
const lockOf = (state: string) => readLease(path.join(state, EXCLUSIVITY_FILE))
const onDemand = (state: string, extra = {}) => lifecycleHarness(state, { environmentMode: 'editor', ...extra })

describe('on-demand environment: accepting a ticket takes no lock', () => {
  it('launches every accepted ticket at once, with no environment block and no lease on file', () => {
    const state = dirWith()
    const h = onDemand(state)
    const ids = ['1', '2', '3'].map(id => h.accept(id))
    expect(h.launches.map(([ticket]) => ticket.id).sort()).toEqual([...ids].sort())
    for (const id of ids) {
      expect(h.repo.tickets.get(id)!.environmentBlock).toBeUndefined()
      expect(h.tickets.holds(id)).toBe(false)
    }
    expect(lockOf(state)).toBeUndefined()
    expect(h.raised('ticket.exclusive')).toHaveLength(0)
  })

  it('does not take the lock to continue a worker, nor a delivery, so a ticket that only edits files never holds it', () => {
    const state = dirWith()
    const h = onDemand(state)
    const id = h.accept('1')
    h.settle()
    h.engine.ensureEnvironment(id)
    expect(h.tickets.holds(id)).toBe(false)
    expect(lockOf(state)).toBeUndefined()
  })

  it('leaves the default behaviour alone: without the mode a second ticket is still refused at acceptance', () => {
    const state = dirWith()
    const h = lifecycleHarness(state)
    h.accept('1')
    const second = h.accept('2')
    expect(h.repo.tickets.get(second)!.environmentBlock).toMatch(/held by ticket Fix 1/)
  })
})

describe('on-demand environment: only the editor step is exclusive', () => {
  it('takes the lock when a ticket asks for the editor, and refuses a second asker naming the holder while it keeps running', () => {
    const state = dirWith()
    const h = onDemand(state)
    const first = h.accept('1'), second = h.accept('2')
    h.settle()
    expect(h.engine.acquireEditor(first)).toEqual({ held: true })
    expect(lockOf(state)!.holder).toMatchObject({ kind: 'ticket', id: first })
    expect(h.engine.acquireEditor(first)).toEqual({ held: true })
    expect(() => h.engine.acquireEditor(second)).toThrow(EnvironmentHeld)
    expect(() => h.engine.acquireEditor(second)).toThrow(/held by ticket Fix 1/)
    // The refused ticket is not blocked: it is still a running ticket and its work goes on.
    const refused = h.repo.tickets.get(second)!
    expect(refused.environmentBlock).toBeUndefined()
    expect(refused.assignments.at(-1)!.state).toBe('running')
    expect(h.raised('ticket.exclusive').filter(event => event.data.action === 'refused').at(-1)?.data).toMatchObject({ ticketId: second })
    // The holder's record was never touched by the refusal.
    expect(lockOf(state)!.holder.id).toBe(first)
  })

  it('stops the editor then releases when the ticket gives the editor back, and the next asker takes it; the ticket keeps running', async () => {
    const state = dirWith()
    const h = onDemand(state)
    const first = h.accept('1'), second = h.accept('2')
    h.settle()
    h.engine.acquireEditor(first)
    h.hosts.editors.add(first)
    expect(await h.engine.releaseEditor(first)).toEqual({ released: true })
    expect(h.hosts.stops).toEqual([{ ticketId: first, failed: false, holdsAtStop: true }])
    expect(lockOf(state)).toBeUndefined()
    expect(h.repo.tickets.get(first)!.assignments.at(-1)!.state).toBe('running')
    expect(h.engine.acquireEditor(second)).toEqual({ held: true })
    expect(lockOf(state)!.holder.id).toBe(second)
  })

  it('keeps the lock when the editor cannot be stopped, and the retry releases', async () => {
    const state = dirWith()
    const h = onDemand(state)
    const first = h.accept('1')
    h.settle()
    h.engine.acquireEditor(first)
    h.hosts.editors.add(first)
    h.hosts.stopFailure = new Error('kill-tp-editor.ps1 exited with 1')
    const failed = await h.engine.releaseEditor(first)
    expect(failed.released).toBe(false)
    expect(failed.error).toMatch(/kill-tp-editor/)
    expect(h.tickets.holds(first)).toBe(true)
    expect(lockOf(state)!.holder.id).toBe(first)
    h.hosts.stopFailure = undefined
    expect(await h.engine.releaseEditor(first)).toEqual({ released: true })
    expect(lockOf(state)).toBeUndefined()
  })

  it('has nothing to give back for a ticket that never asked for the editor', async () => {
    const h = onDemand(dirWith())
    const id = h.accept('1')
    expect(await h.engine.releaseEditor(id)).toEqual({ released: false })
    expect(h.hosts.stops).toHaveLength(0)
  })

  it('releases the editor lock when the ticket completes, so the next ticket can take it; a ticket that never asked completes without one', async () => {
    const state = dirWith()
    const h = onDemand(state)
    const first = h.accept('1'), second = h.accept('2')
    h.settle()
    h.engine.acquireEditor(first)
    h.hosts.editors.add(first)
    h.ready(first)
    await vi_waitFor(() => lockOf(state) === undefined)
    expect(h.repo.tickets.get(first)!.ended?.outcome).toBe('completed')
    expect(h.hosts.stops).toHaveLength(1)
    h.ready(second)
    expect(h.repo.tickets.get(second)!.ended?.outcome).toBe('completed')
    expect(h.hosts.stops).toHaveLength(1)
  })

  it('does not wake any waiter on a release, since nothing waits at acceptance', async () => {
    const h = onDemand(dirWith())
    const first = h.accept('1')
    h.settle()
    h.engine.acquireEditor(first)
    await h.engine.releaseEditor(first)
    expect(h.launches).toHaveLength(0)
  })

  it('still refuses a foreign Session that holds the editor, naming it', () => {
    const state = dirWith()
    const h = onDemand(state)
    h.foreign(300).acquire({ kind: 'session', id: 'main-session', label: 'the main Session' })
    const id = h.accept('1')
    expect(h.launches.map(([ticket]) => ticket.id)).toEqual([id])
    expect(() => h.engine.acquireEditor(id)).toThrow(/held by session the main Session/)
  })

  it('makes a strict test run take the editor first, and refuses it while another ticket has the editor', async () => {
    const state = dirWith()
    const h = onDemand(state)
    const first = h.accept('1'), second = h.accept('2')
    h.settle()
    h.engine.acquireEditor(first)
    await expect(h.engine.runTicketTests(second, h.repo.tickets.get(second)!.assignments.at(-1)!.id)).rejects.toThrow(/held by ticket Fix 1/)
    await expect(h.engine.runTicketTests(first, h.repo.tickets.get(first)!.assignments.at(-1)!.id)).rejects.toThrow(/Strict validation not enabled/)
  })
})

describe('on-demand environment: the worker surface', () => {
  it('registers an acquire and a release tool that take no arguments and act only on the ticket itself', async () => {
    const calls: string[] = []
    const host = { engine: { report: () => {}, acquireEditor: (id: string) => { calls.push(`acquire:${id}`); return { held: true } },
      releaseEditor: async (id: string) => { calls.push(`release:${id}`); return { released: true } } },
    store: { tickets: { get: () => undefined } }, github: { deployment: { github: { login: 'bot' } } } } as unknown as ExecutorToolsHost
    const tools = executorTools(host, { id: 'ticket-x' } as never)
    const acquire = tools.find(tool => tool.name === 'orchestrator_acquire_editor')!
    const release = tools.find(tool => tool.name === 'orchestrator_release_editor')!
    expect(acquire && release).toBeTruthy()
    expect(() => acquire.schema.parse({ ticket_id: 'another' })).toThrow()
    expect(() => release.schema.parse({ ticket_id: 'another' })).toThrow()
    await acquire.execute(acquire.schema.parse({}), new AbortController().signal)
    await release.execute(release.schema.parse({}), new AbortController().signal)
    expect(calls).toEqual(['acquire:ticket-x', 'release:ticket-x'])
  })
})

/** Polls briefly: the release after an end runs on a promise. */
async function vi_waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('condition not met')
}
