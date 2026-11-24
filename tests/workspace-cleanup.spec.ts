/** Registry-only cleanup: all filesystem fixtures are unique temporary paths. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Ticket } from '../src/core/index.ts'
import { unregisterMissingWorkspace } from '../src/executor/workspace-cleanup.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'workspace-cleanup-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const ended = (directory: string, outcome = 'completed') => ({ id: 'old', ended: { at: '2026-11-24', outcome }, execution: { directory } }) as Ticket
function fixture(ticket = ended(join(root, 'gone'))) {
  let current: Ticket | undefined = ticket
  let open: Ticket[] = []
  const records = [{ id: 'registration' as WorkspaceId, path: ticket.execution!.directory }]
  const registry = { list: vi.fn(() => records), delete: vi.fn(async () => true) }
  const tickets = { get: () => current, open: () => open }
  const clean = (stat?: typeof import('node:fs/promises').lstat) =>
    unregisterMissingWorkspace(registry, tickets, ticket, join(root, 'source'), stat)
  return { ticket, registry, clean, resume: () => { current = { ...ticket, ended: undefined } }, own: () => { open = [{ execution: ticket.execution } as Ticket] } }
}

it.each(['completed', 'stopped', 'dropped'])('removes only an ended %s ticket exact registration', async outcome => {
  const f = fixture(ended(join(root, 'gone'), outcome))
  expect(await f.clean()).toBe(1)
  expect(f.registry.delete).toHaveBeenCalledWith('registration')
})
it('preserves existing directories and files', async () => {
  for (const kind of ['directory', 'file']) {
    const path = join(root, kind)
    if (kind === 'directory') mkdirSync(path); else writeFileSync(path, '')
    const f = fixture(ended(path))
    expect(await f.clean()).toBe(0)
    expect(f.registry.delete).not.toHaveBeenCalled()
  }
})
it('preserves source, unrelated registry records and live owners', async () => {
  const source = fixture(ended(join(root, 'source')))
  expect(await source.clean()).toBe(0)
  const unrelated = fixture(); unrelated.registry.list.mockReturnValue([{ id: 'other' as WorkspaceId, path: join(root, 'other') }])
  expect(await unrelated.clean()).toBe(0)
  const live = fixture(); live.own()
  expect(await live.clean()).toBe(0)
  const resumed = fixture(); resumed.resume()
  expect(await resumed.clean()).toBe(0)
})
it('does not interpret filesystem errors as absence, and propagates registry failures', async () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  await expect(fixture().clean(async () => { throw denied })).rejects.toThrow('permission denied')
  const f = fixture(); f.registry.delete.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(f.clean()).rejects.toThrow('storage unavailable')
})
it('rechecks completion after filesystem I/O', async () => {
  const f = fixture()
  const cleaning = f.clean(); f.resume()
  expect(await cleaning).toBe(0)
})

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
it('reconciles historical ended missing workspaces, leaves live/existing/unrelated entries and is idempotent', async () => {
  h = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, finalize: 'test-finalize' } })
  const old = ended(join(root, 'old'))
  h.runtime.store.tickets.save(old)
  await h.workspaceRegistry.create(old.execution!.directory)
  const existing = { ...ended(root), id: 'existing' }; h.runtime.store.tickets.save(existing)
  await h.workspaceRegistry.create(root)
  const live = { ...ended(join(root, 'live')), id: 'live', ended: undefined }; h.runtime.store.tickets.save(live)
  await h.workspaceRegistry.create(live.execution!.directory)
  await h.workspaceRegistry.create(join(root, 'unrelated'))
  const before = h.workspaceRegistry.list().length
  await h.runtime.executor.reconcileWorkspaces()
  expect(h.workspaceRegistry.list()).toHaveLength(before - 1)
  expect(h.workspaceRegistry.delete).toHaveBeenCalledWith(old.execution!.directory)
  await h.runtime.executor.reconcileWorkspaces()
  expect(h.workspaceRegistry.delete).toHaveBeenCalledTimes(1)
})
it('recreates a retained worker Session membership after its registration was removed', async () => {
  h = await startRuntime()
  const one = await h.acceptedTicket(feishu('resume-registration', '@bot fix tooling'))
  const cwd = one.ticket.execution!.directory
  await h.workspaceRegistry.delete(cwd)
  await h.runtime.sessions.ensure(one.sessionId, cwd, 'resumed', 'worker')
  expect(h.controller.create.mock.calls.filter(([args]) => args.sessionId === one.sessionId)).toHaveLength(1)
  expect((await h.workspaceRegistry.create(cwd)).attachSession).toHaveBeenCalledWith(one.sessionId)
})
it('unregisters a reclaimed ticket workspace during finalize and keeps retry if registry deletion fails', async () => {
  h = await startRuntime()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, finalize: 'echo finalize-ticket' } })
  const one = await h.acceptedTicket(feishu('finalize-unregister', '@bot fix'))
  const directory = join(root, 'reclaimed')
  const ticket = h.runtime.store.tickets.get(one.ticket.id)!
  ticket.execution!.directory = directory
  h.runtime.store.tickets.save(ticket)
  await h.workspaceRegistry.create(directory)
  h.workspaceRegistry.delete.mockRejectedValueOnce(new Error('storage offline'))
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
  const agent = h.agents.get(one.sessionId)!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  expect(h.runtime.effects.pending('finalize', one.ticket.id)).toBe(true)
  h.runtime.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'finalize'").run()
  await h.runtime.idle()
  expect(h.runtime.effects.pending('finalize', one.ticket.id)).toBe(false)
  expect(h.workspaceRegistry.list().some(workspace => workspace.path === directory)).toBe(false)
  expect(h.agents.has(one.sessionId)).toBe(true)
})
