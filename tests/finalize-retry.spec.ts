/** Recovery refreshes only durable cleanup payloads; ticket evidence and finalizer safety remain untouched. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { retryFinalize } from '../src/app/finalize-retry.ts'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { Store } from '../src/app/store.ts'
import { UserError, type Ticket, type TicketOutcome } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'

let directory: string
let store: Store
let effects: Effects
let executor: { workspaceBusy: ReturnType<typeof vi.fn<(id: string) => boolean>> }
const id = 'completed-ticket'
const endedAt = '2026-11-20T01:02:03.000Z'
const ticket = (): Ticket => ({
  id, title: 'Completed work', decisionId: 'decision',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'local', id: 'operator' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], origin: { triggerId: 'request', triggerIds: ['request'] },
  createdAt: 'created', updatedAt: 'updated', ended: { at: endedAt, by: 'executor', outcome: 'completed', reason: 'verified' },
  result: { assignmentId: 'worker', outcome: 'completed', at: endedAt },
  execution: { name: 'worktree', directory: 'Z:/already-gone/ticket', assignment: 'original assignment' },
})
const row = () => store.db.prepare("SELECT * FROM effect WHERE kind = 'finalize' AND key = ?").get(id)!
const retry = () => retryFinalize({ store, effects, executor, mounted: { workspaceMode: 'isolated' } }, id)
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'finalize-retry-'))
  store = new Store(join(directory, 'db.sqlite'))
  effects = new Effects(store, new HealthBoard(), () => 12345)
  executor = { workspaceBusy: vi.fn(() => false) }
  store.tickets.save(ticket())
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, finalize: '  safe-finalizer current-command  ' } })
  effects.enqueue('finalize', id, { ticketId: id, endedAt, command: 'broken-snapshotted-command ""' })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('refreshes the same pending key with original endedAt and current command without requiring a directory on disk', () => {
  store.db.prepare("UPDATE effect SET attempts = 11, error = 'old failure', due = 999999 WHERE kind = 'finalize'").run()
  const before = row(), evidence = store.tickets.get(id)
  expect(retry()).toEqual({ retried: true })
  expect(row()).toMatchObject({ key: id, seq: before.seq, since: before.since,
    generation: Number(before.generation) + 1, attempts: 0, error: '', due: 12345 })
  expect(JSON.parse(String(row().value))).toEqual({ ticketId: id, endedAt, command: 'safe-finalizer current-command' })
  expect(store.tickets.get(id)).toEqual(evidence)
  expect(executor.workspaceBusy).toHaveBeenCalledWith(id)
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'finalize'").get()?.n).toBe(1)
})

function refused(message: string, operation = retry) {
  const before = row(), evidence = store.tickets.get(id)
  try { operation(); throw new Error('Expected refusal') } catch (error) {
    expect(error).toBeInstanceOf(UserError)
    expect((error as Error).message).toBe(message)
  }
  expect(row()).toEqual(before)
  expect(store.tickets.get(id)).toEqual(evidence)
}
it('refuses unknown tickets with the standard missing UserError', () => {
  expect(() => retryFinalize({ store, effects, executor, mounted: { workspaceMode: 'isolated' } }, 'missing')).toThrow(new UserError('unknownTicket'))
})
it('refuses recovery in source workspace mode even when cleanup is pending', () => {
  refused('Workspace finalization is disabled in source workspace mode',
    () => retryFinalize({ store, effects, executor, mounted: { workspaceMode: 'source' } }, id))
})
it('refuses an open ticket', () => {
  const current = ticket(); delete current.ended; store.tickets.save(current)
  refused('Only a completed ticket can retry workspace finalization')
})
it.each<TicketOutcome>(['merged', 'closed', 'dropped', 'stopped'])('refuses outcome %s', outcome => {
  const current = ticket(); current.ended!.outcome = outcome; store.tickets.save(current)
  refused('Only a completed ticket can retry workspace finalization')
})
it('refuses a completed ticket without a pending finalize effect', () => {
  effects.cancel('finalize', id)
  refused('No pending workspace finalization to retry')
})
it.each([undefined, '', '   '])('refuses an absent or blank directory (%s)', directory => {
  const current = ticket()
  if (directory === undefined) delete current.execution
  else current.execution!.directory = directory
  store.tickets.save(current)
  refused('The completed ticket has no workspace directory')
})
it.each(['', '   '])('refuses an empty current finalize command (%s)', finalize => {
  const settings = store.settings(); store.saveSettings({ ...settings, executor: { ...settings.executor, finalize } })
  refused('The current executor.finalize command is empty')
})
it('refuses an active workspace finalizer', () => {
  executor.workspaceBusy.mockReturnValue(true)
  refused('Workspace finalization is currently running')
})
it('reads and validates all mutable state inside the atomic transaction before enqueueing', () => {
  const atomic = store.atomic.bind(store)
  let inside = false
  vi.spyOn(store, 'atomic').mockImplementation(work => atomic(() => {
    inside = true
    try { return work() } finally { inside = false }
  }))
  const checked = <A extends unknown[], R>(run: (...args: A) => R) => (...args: A): R => {
    expect(inside).toBe(true)
    return run(...args)
  }
  const get = store.tickets.get.bind(store.tickets), settings = store.settings.bind(store)
  const pending = effects.pending.bind(effects), enqueue = effects.enqueue.bind(effects)
  vi.spyOn(store.tickets, 'get').mockImplementation(checked(get))
  vi.spyOn(store, 'settings').mockImplementation(checked(settings))
  vi.spyOn(effects, 'pending').mockImplementation(checked(pending))
  vi.spyOn(effects, 'enqueue').mockImplementation(checked(enqueue))
  executor.workspaceBusy.mockImplementation(checked(() => false))
  expect(retry()).toEqual({ retried: true })
})
it('rechecks completion after entering atomic rather than trusting a stale ticket', () => {
  const atomic = store.atomic.bind(store)
  vi.spyOn(store, 'atomic').mockImplementation(work => atomic(() => {
    const current = ticket(); delete current.ended; store.tickets.save(current)
    return work()
  }))
  expect(retry).toThrow('Only a completed ticket can retry workspace finalization')
  expect(JSON.parse(String(row().value)).command).toBe('broken-snapshotted-command ""')
})

it('exposes POST finalize/retry through the existing same-origin route and serializes UserError', async () => {
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => {
    handler = route.handler; return () => {}
  } } }
  registerHttp(ctx as never, { store, effects, executor, mounted: { workspaceMode: 'isolated' }, ready: Promise.resolve() } as unknown as HttpHost)
  const call = async (path: string, headers: Record<string, string | undefined> = {}) => {
    let status = 0, text = ''
    await handler({ method: 'POST', url: `/orchestrator/api/tickets/${path}/finalize/retry`,
      headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers } },
    { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) }
  }
  const before = row()
  for (const headers of [{ origin: 'http://evil' }, { 'x-orchestrator-request': undefined }, { host: 'evil:3082' }]) {
    expect(await call(id, headers)).toMatchObject({ status: 403 })
  }
  expect(row()).toEqual(before)
  expect(await call('missing')).toMatchObject({ status: 404, body: { code: 'unknownTicket' } })
  executor.workspaceBusy.mockReturnValue(true)
  expect(await call(id)).toMatchObject({ status: 400, body: { code: 'notRetryable', error: 'Workspace finalization is currently running' } })
  executor.workspaceBusy.mockReturnValue(false)
  expect(await call(id)).toEqual({ status: 200, body: { retried: true } })
})
