/** Local temporary workspaces/SQLite only; no services, worker processes or external delivery. */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type Repositories, type Ticket } from '../src/core/index.ts'
import { assertTicketDesignApproved, DesignApprovalRequest, DesignConfigurationRequest } from '../src/core/design.ts'
import { assertTicketValidated } from '../src/core/validation.ts'
import { Store } from '../src/app/store.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { Effects, Later } from '../src/app/effects.ts'

const roots: string[] = []
const stores = new Set<Store>()
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})
function directory() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-design-gate-'))); roots.push(root); return root }
function fixture(repo: Repositories = new MemoryRepositories(), root = directory()) {
  mkdirSync(join(root, 'plans'), { recursive: true })
  writeFileSync(join(root, 'plans/design.md'), '# Design\nA bounded change\n')
  const ticket: Ticket = { id: 'design-ticket', title: 'Design fixture', decisionId: 'decision',
    mandate: { strength: 'explicit', policyVersion: 'v1', actor: { source: 'local', id: 'operator' }, scope: 'fixture', basis: { via: 'listed' } },
    channels: [], assignments: [{ id: 'a1', state: 'pending', createdAt: new Date().toISOString() }], inputs: [], undelivered: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), origin: { triggerId: 'trigger', triggerIds: ['trigger'] },
    execution: { name: 'fixture', directory: root, assignment: 'Do scoped work' } }
  repo.tickets.save(ticket)
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const engine = new Engine({ repo, policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 1000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request: vi.fn(), release: vi.fn() },
    executor, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }, acceptance: () => true })
  const current = () => repo.tickets.get(ticket.id)!
  const configure = (scope = 'Implement the documented bounded change') => engine.configureDesign(ticket.id, { required: true, scope, documentPath: 'plans/design.md' })
  const approve = () => engine.approveDesign(ticket.id, { assignmentId: current().assignments.at(-1)!.id, operatorId: 'operator-alice' })
  return { repo, root, ticket, engine, executor, current, configure, approve }
}

describe('opt-in host-managed design confirmation', () => {
  it('keeps legacy tickets compatible', () => {
    const f = fixture()
    f.engine.assignmentStarted(f.ticket.id, 'a1')
    expect(f.engine.report(f.ticket.id, { state: 'ready', summary: 'legacy ready' }).ended?.outcome).toBe('completed')
  })
  it('blocks a previously planned assignment before start and permits an operator-approved design', () => {
    const f = fixture(); f.configure()
    expect(() => f.engine.assignmentStarted(f.ticket.id, 'a1')).toThrow(/Design confirmation/)
    expect(f.current().assignments[0]!.state).toBe('pending')
    f.approve(); f.engine.assignmentStarted(f.ticket.id, 'a1')
    expect(f.current().assignments[0]!.state).toBe('running')
    expect(f.engine.report(f.ticket.id, { state: 'ready', summary: 'approved result' }).ended?.outcome).toBe('completed')
  })
  it('refuses executor launch before workspace preparation or session creation', async () => {
    const f = fixture(); f.configure()
    const ensure = vi.fn()
    const host = { closing: () => false, paused: () => false, store: { tickets: f.repo.tickets, triggers: { get: () => undefined } }, sessions: { ensure } }
    // Exercise the real launch method without registering any runtime handlers/services.
    const launch = (DshExecutor.prototype as unknown as { launch: (this: unknown, ticket: Ticket, assignment: Ticket['assignments'][number]) => Promise<void> }).launch
    await expect(launch.call({ host }, f.current(), f.current().assignments[0]!)).rejects.toThrow(/Design confirmation/)
    expect(ensure).not.toHaveBeenCalled()
    expect(f.current().assignments[0]!.state).toBe('pending')
  })
  it('keeps the real launch effect pending with zero failures, then approval wakes the same assignment', async () => {
    const store = new Store(join(directory(), 'queue.sqlite')); stores.add(store)
    const f = fixture(store); f.configure()
    const effects = new Effects(store, { claim: () => ({ set: vi.fn() }) } as never)
    const inbox = { remove: vi.fn() }
    const prompt = vi.fn(async (_session: string, _id: string, _text: string, _mode: string, authorize?: () => void, claimed?: () => void) => { authorize?.(); claimed?.() })
    const ensure = vi.fn(async () => ({ inbox }))
    const host = { store, effects, engine: f.engine, closing: () => false, paused: () => false,
      sessions: { ensure, prompt, holds: async () => false, promptedId: (id: string) => id }, context: { agents: { get: () => undefined } } }
    const runtime = new DshExecutor(host as never)
    f.executor.start.mockImplementation((ticket, assignment) => runtime.start(ticket, assignment))
    runtime.start(f.current(), f.current().assignments[0]!)
    effects.start(); await effects.idle('launch')
    expect(f.current().assignments[0]!.state).toBe('pending')
    expect(effects.pending('launch', 'a1')).toBe(true)
    expect(store.db.prepare("SELECT attempts FROM effect WHERE kind = 'launch'").get()?.attempts).toBe(0)
    expect(ensure).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled()
    f.approve(); await effects.idle('launch')
    expect(f.current().assignments).toHaveLength(1)
    expect(f.current().assignments[0]!.state).toBe('running')
    expect(effects.pending('launch', 'a1')).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(1)
    await effects.drain()
  })
  it('blocks running input delivery before ensure/claim and resumes the retained input after approval', async () => {
    const f = fixture(); f.engine.assignmentStarted(f.ticket.id, 'a1'); f.configure()
    const ticket = f.current(); ticket.inputs.push({ id: 'input1', kind: 'text', text: 'continue', at: new Date().toISOString() }); ticket.undelivered.push('input1'); f.repo.tickets.save(ticket)
    const ensure = vi.fn(async () => ({})); const prompt = vi.fn(async (_s: string, _i: string, _t: string, _m: string, authorize?: () => void) => { authorize?.() })
    const subject = { host: { store: { tickets: f.repo.tickets }, engine: f.engine, closing: () => false, context: { agents: { get: () => undefined } }, sessions: { ensure, prompt } },
      stopped: async () => {}, running: () => true, stopping: new Map(), deliverInput: (DshExecutor.prototype as unknown as { deliverInput: unknown }).deliverInput }
    const deliver = (DshExecutor.prototype as unknown as { deliverQueued: (this: unknown, id: string) => Promise<void> }).deliverQueued
    await expect(deliver.call(subject, ticket.id)).rejects.toBeInstanceOf(Later)
    expect(ensure).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled(); expect(f.current().undelivered).toEqual(['input1'])
    f.approve(); await deliver.call(subject, ticket.id)
    expect(prompt).toHaveBeenCalledTimes(1); expect(f.current().undelivered).toEqual([])
  })
  it('defers transient-timer continuation durably instead of prompting or spinning while design is unapproved', () => {
    const f = fixture(); f.engine.assignmentStarted(f.ticket.id, 'a1'); f.configure()
    const prompt = vi.fn(); const timers: (() => void)[] = []
    const subject = { host: { store: { tickets: f.repo.tickets }, engine: f.engine, closing: () => false, paused: () => false, sessions: { prompt } },
      transient: new Map([['a1', 1]]), resuming: new Set(), running: () => true, after: (_ms: number, go: () => void) => timers.push(go) }
    const resume = (DshExecutor.prototype as unknown as { resumeAfter: (this: unknown, id: string, assignment: string, error: unknown) => void }).resumeAfter
    resume.call(subject, f.ticket.id, 'a1', new Error('temporary provider error'))
    expect(timers).toHaveLength(1); timers[0]!()
    expect(prompt).not.toHaveBeenCalled(); expect(timers).toHaveLength(1)
    expect(f.current().undelivered).toContain('retry:a1:1')
    expect(subject.resuming.size).toBe(0)
    f.executor.deliver.mockClear(); f.approve()
    expect(f.executor.deliver).toHaveBeenCalledTimes(1)
    expect(f.current().assignments).toHaveLength(1)
  })
  it('binds only design bytes; source edits remain valid but document edits block start and completion', () => {
    const f = fixture(); f.configure(); f.approve()
    writeFileSync(join(f.root, 'implementation.ts'), 'export const changed = true\n')
    expect(() => assertTicketValidated(f.current())).not.toThrow()
    f.engine.assignmentStarted(f.ticket.id, 'a1')
    writeFileSync(join(f.root, 'plans/design.md'), '# Revised design\n')
    expect(() => f.engine.report(f.ticket.id, { state: 'ready', summary: 'not accepted' })).toThrow(/stale document/)
    expect(f.current().ended).toBeUndefined()
    expect(() => f.engine.assignmentStarted(f.ticket.id, 'a1')).toThrow(/stale document/)
    f.approve()
    expect(() => assertTicketValidated(f.current())).not.toThrow()
  })
  it('rechecks design approval on every delivery level even without strict validation', async () => {
    const f = fixture(); f.configure(); f.approve(); f.engine.assignmentStarted(f.ticket.id, 'a1')
    writeFileSync(join(f.root, 'plans/design.md'), 'Changed before delivery')
    for (const level of ['commit', 'push', 'release'] as const) {
      const result = await f.engine.deliverTicket(f.ticket.id, 'a1', level, `design-${level}`)
      expect(result).toHaveProperty('refused', true)
      if ('refused' in result) expect(result.reasons.join('\n')).toMatch(/Design confirmation: stale document/)
    }
  })
  it('retains a source-close fact but records why stale design confirmation defers completion', () => {
    const f = fixture(); f.configure(); f.approve(); f.engine.assignmentStarted(f.ticket.id, 'a1')
    const thread = { source: 'local', id: 'followed' }
    f.engine.bindThread(f.ticket.id, thread, true)
    f.engine.report(f.ticket.id, { state: 'ready', summary: 'waiting for source close' })
    writeFileSync(join(f.root, 'plans/design.md'), 'Changed before source close')
    expect(() => f.engine.threadClosed(thread, 'merged', new Date().toISOString())).not.toThrow()
    expect(f.current().follows?.[0]?.closed?.outcome).toBe('merged')
    expect(f.current().ended).toBeUndefined()
    expect(f.current().designApproval?.blocked).toMatch(/Design confirmation/)
  })
  it('requires re-signature for scope changes and replacement assignments', () => {
    const f = fixture(); f.configure(); f.approve(); f.configure('Changed scope')
    expect(() => assertTicketValidated(f.current())).toThrow(/missing operator approval/)
    f.approve()
    const ticket = f.current(); ticket.assignments[0]!.state = 'ended'; ticket.assignments.push({ id: 'a2', state: 'pending', createdAt: new Date().toISOString() }); f.repo.tickets.save(ticket)
    expect(() => f.engine.assignmentStarted(ticket.id, 'a2')).toThrow(/stale document/)
    expect(() => f.engine.approveDesign(ticket.id, { assignmentId: 'a1', operatorId: 'alice' })).toThrow(/stale assignment/)
    f.approve(); expect(() => f.engine.assignmentStarted(ticket.id, 'a2')).not.toThrow()
  })
  it('rejects forged approval/digest fields and malformed scope/path contracts', () => {
    expect(() => DesignApprovalRequest.parse({ assignmentId: 'a1', operatorId: 'alice', documentDigest: 'forged' })).toThrow()
    expect(() => DesignConfigurationRequest.parse({ required: true, scope: 'x', documentPath: 'plans/design.md', approval: {} })).toThrow()
    for (const documentPath of ['../escape.md', '/absolute.md', 'C:/escape.md', 'plans/../design.md', 'plans\\design.md', 'plans//design.md']) {
      expect(() => DesignConfigurationRequest.parse({ required: true, scope: 'x', documentPath })).toThrow()
    }
    expect(() => DesignConfigurationRequest.parse({ required: true, scope: '  ', documentPath: 'design.md' })).toThrow()
  })
  it('rejects document hardlinks, links and junction traversal', () => {
    const f = fixture()
    linkSync(join(f.root, 'plans/design.md'), join(f.root, 'hard.md'))
    expect(() => f.engine.configureDesign(f.ticket.id, { required: true, scope: 'scope', documentPath: 'hard.md' })).toThrow(/link-free/)
    const outside = directory(); writeFileSync(join(outside, 'outside.md'), 'outside')
    symlinkSync(outside, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => f.engine.configureDesign(f.ticket.id, { required: true, scope: 'scope', documentPath: 'linked/outside.md' })).toThrow(/links/)
  })
  it('persists contract and signature in the generic Ticket SQLite path and rechecks bytes after reopen', () => {
    const root = directory(); const file = join(directory(), 'state.sqlite')
    let store = new Store(file); stores.add(store)
    const f = fixture(store, root); f.configure(); f.approve()
    const expected = f.current().designApproval
    store.close(); stores.delete(store)
    store = new Store(file); stores.add(store)
    const restored = store.tickets.get(f.ticket.id)!
    expect(restored.designApproval).toEqual(expected)
    expect(() => assertTicketDesignApproved(restored)).not.toThrow()
    writeFileSync(join(root, 'plans/design.md'), 'Changed after restart')
    expect(() => assertTicketValidated(store.tickets.get(f.ticket.id)!)).toThrow(/stale document/)
  })
})
