import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, MemoryRepositories, type Policy, type Repositories, type Ticket, type WorkerReport } from '../src/core/index.ts'
import { assertTicketValidated } from '../src/core/validation.ts'
import { ReviewConfigurationRequest, ReviewDecisionRequest } from '../src/core/review.ts'
import { fingerprintWorkspace } from '../src/validation.ts'

const roots: string[] = []
const stores = new Set<Store>()
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-review-')))
  roots.push(root)
  return root
}
function harness(repo: Repositories = new MemoryRepositories(), workspace = directory()) {
  writeFileSync(join(workspace, 'source.ts'), 'export const answer = 42\n')
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const execute = vi.fn(async () => ({ receipt: 'trusted-target-receipt' }))
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: vi.fn(), release: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    deliveryTarget: { id: 'review-fixture-target', version: () => 'version-1', execute },
    environments: { holds: () => true } as never,
    acceptance: ticket => { try { assertTicketValidated(ticket); return true } catch { return false } },
    now: () => '2026-11-02T00:00:00.000Z',
  })
  const ticket: Ticket = { id: 'ticket-1', title: 'Review fixture', decisionId: 'decision-1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'chat', id: 'alice' }, scope: 'fixture' },
    channels: [{ source: 'chat', thread: 't1', address: {} }], assignments: [{ id: 'assignment-1', state: 'running', createdAt: '2026-11-02T00:00:00.000Z' }],
    inputs: [], undelivered: [], createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', origin: { triggerId: 'origin', triggerIds: ['origin'] },
    execution: { name: 'fixture', directory: workspace, assignment: 'Implement' } }
  repo.tickets.save(ticket)
  const current = () => repo.tickets.get(ticket.id)!
  const enable = () => engine.configureReview(ticket.id, { required: true, implementerId: 'developer-session', reviewerId: 'review-session' })
  const sign = (verdict: 'approved' | 'rejected' = 'approved') => engine.recordReview(ticket.id, { assignmentId: current().assignments.at(-1)!.id,
    reviewerId: 'review-session', verdict, summary: 'Independent inspection of current changes' })
  const ready = () => engine.report(ticket.id, { state: 'ready', summary: 'Implemented' })
  const mutate = (change: (item: Ticket) => void) => { const item = structuredClone(current()); change(item); repo.tickets.save(item) }
  return { repo, engine, workspace, ticket, current, enable, sign, ready, mutate, execute }
}

describe('host-managed independent review gate', () => {
  it('keeps legacy tickets compatible and supports explicit operator opt-out', () => {
    const h = harness()
    expect(h.current().review).toBeUndefined()
    h.enable()
    h.engine.configureReview(h.ticket.id, { required: false })
    expect(() => assertTicketValidated(h.current())).not.toThrow()
    expect(() => h.ready()).not.toThrow()
  })
  it('requires host approval without strict tests and rejects forged worker report approval', () => {
    const h = harness(); h.enable()
    expect(h.current().validation).toBeUndefined()
    const forgery = { state: 'ready', summary: 'Reviewer passed', review: { required: false, decision: { verdict: 'approved' } }, approved: true } as WorkerReport
    expect(() => h.engine.report(h.ticket.id, forgery)).toThrow(/review/i)
    expect(h.current().review?.decision).toBeUndefined()
    expect(h.current().assignments[0]!.report).toBeUndefined()
    h.sign('rejected')
    expect(() => h.ready()).toThrow(/review rejected/)
    h.sign()
    expect(h.current().review?.decision?.fingerprint).toBe(fingerprintWorkspace(h.workspace))
    expect(h.ready().ended?.outcome).toBe('completed')
  })
  it('refuses self-signing, another signer, and stale assignment submissions', () => {
    const h = harness()
    expect(() => h.engine.configureReview(h.ticket.id, { required: true, implementerId: 'same', reviewerId: ' same ' })).toThrow(/self-sign/)
    h.enable()
    for (const reviewerId of ['developer-session', 'intruder']) {
      expect(() => h.engine.recordReview(h.ticket.id, { assignmentId: 'assignment-1', reviewerId, verdict: 'approved', summary: 'pass' })).toThrow(/reviewer|self-sign/)
    }
    expect(() => h.engine.recordReview(h.ticket.id, { assignmentId: 'old', reviewerId: 'review-session', verdict: 'approved', summary: 'pass' })).toThrow(/stale assignment/)
  })
  it.each(['source', 'new-file', 'assignment', 'ticket', 'workspace', 'identity', 'configuration'] as const)('rejects approval after %s changes', kind => {
    const h = harness(); h.enable(); h.sign()
    if (kind === 'source') writeFileSync(join(h.workspace, 'source.ts'), 'export const answer = 43\n')
    if (kind === 'new-file') writeFileSync(join(h.workspace, 'new.ts'), 'new content')
    if (kind === 'assignment') h.mutate(t => { t.assignments.push({ id: 'assignment-2', state: 'running', createdAt: t.updatedAt }) })
    if (kind === 'ticket') h.mutate(t => { t.review!.decision!.ticketId = 'other-ticket' })
    if (kind === 'workspace') h.mutate(t => { t.execution!.directory = directory() })
    if (kind === 'identity') h.mutate(t => { t.review!.decision!.reviewerId = 'developer-session' })
    if (kind === 'configuration') h.enable()
    expect(() => h.ready()).toThrow(/review/i)
    expect(h.current().ended).toBeUndefined()
  })
  it('persists configuration and approval across real SQLite reopen', () => {
    const path = join(directory(), 'state.sqlite') // Outside fingerprinted workspace.
    const store = new Store(path); stores.add(store)
    const h = harness(store); h.enable(); h.sign()
    const approval = h.current().review
    store.close(); stores.delete(store)
    const restored = new Store(path); stores.add(restored)
    const restoredTicket = restored.tickets.get(h.ticket.id)!
    expect(restoredTicket.review).toEqual(approval)
    expect(() => assertTicketValidated(restoredTicket)).not.toThrow()
    writeFileSync(join(h.workspace, 'source.ts'), 'changed after restart')
    expect(() => assertTicketValidated(restored.tickets.get(h.ticket.id)!)).toThrow(/stale/)
  })
  it('blocks a result publication after approved contents change', () => {
    const h = harness(); h.enable(); h.sign()
    h.mutate(t => { t.assignments[0]!.report = { state: 'ready', summary: 'ready', at: t.updatedAt } })
    writeFileSync(join(h.workspace, 'source.ts'), 'changed')
    expect(() => h.engine.reply({ purpose: 'result', ticketId: h.ticket.id, text: 'Done' })).toThrow(/review/i)
  })
  it('defers source-close success for missing review even without strict tests', () => {
    const h = harness(); h.enable()
    h.mutate(t => { t.follows = [{ thread: 'chat:pr', own: true }] })
    expect(() => h.engine.threadClosed({ source: 'chat', id: 'pr' }, 'merged', '2026-11-02T00:00:00.000Z')).not.toThrow()
    expect(h.current().review?.blocked).toMatch(/review/i)
    expect(h.current().ended).toBeUndefined()
  })
  it('checks review for non-strict commit and refuses an old grant after rejection', async () => {
    const h = harness(); h.enable()
    h.engine.configureDelivery(h.ticket.id, 'commit', true, 'operator')
    const first = await h.engine.deliverTicket(h.ticket.id, 'assignment-1', 'commit', 'missing-review')
    expect(first).toMatchObject({ refused: true, reasons: expect.arrayContaining([expect.stringMatching(/review/i)]) })
    expect(h.execute).not.toHaveBeenCalled()
    h.sign()
    h.engine.configureDelivery(h.ticket.id, 'commit', true, 'operator')
    h.sign('rejected')
    expect(await h.engine.deliverTicket(h.ticket.id, 'assignment-1', 'commit', 'revoked-review')).toMatchObject({ refused: true })
    expect(h.execute).not.toHaveBeenCalled()
  })
  it('allows non-strict commit only after host review and independent delivery grant', async () => {
    const h = harness(); h.enable(); h.sign()
    h.engine.configureDelivery(h.ticket.id, 'commit', true, 'operator')
    expect(await h.engine.deliverTicket(h.ticket.id, 'assignment-1', 'commit', 'approved-delivery')).toMatchObject({ attempt: { state: 'delivered' } })
    expect(h.execute).toHaveBeenCalledOnce()
  })
  it('blocks an old grant after review is reconfigured even when the operator opts out', async () => {
    const h = harness(); h.enable(); h.sign()
    h.engine.configureDelivery(h.ticket.id, 'commit', true, 'operator')
    h.engine.configureReview(h.ticket.id, { required: false })
    expect(await h.engine.deliverTicket(h.ticket.id, 'assignment-1', 'commit', 'changed-policy')).toMatchObject({ refused: true })
    expect(h.execute).not.toHaveBeenCalled()
  })
  it('rejects worker-supplied fingerprints, verdict extras and identity configuration extras in strict schemas', () => {
    expect(ReviewConfigurationRequest.safeParse({ required: true, implementerId: 'a', reviewerId: 'b', decision: { verdict: 'approved' } }).success).toBe(false)
    expect(ReviewDecisionRequest.safeParse({ assignmentId: 'a', reviewerId: 'b', verdict: 'approved', summary: 'pass', fingerprint: 'forged' }).success).toBe(false)
    const h = harness(); h.enable()
    expect(() => h.engine.recordReview(h.ticket.id, { assignmentId: 'assignment-1', reviewerId: 'review-session', verdict: 'approved', summary: 'pass', ticketId: 'forged' } as never)).toThrow()
  })
})
