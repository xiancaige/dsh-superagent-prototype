import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type Candidate, type OutboundMessage } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { LocalConflict, localKind, localMessages, receiveLocal } from '../src/sources/local.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Key } from '../src/kv.ts'
import type { Commands } from '../src/infra/commands.ts'

function harness(listed = true, state = new Map<string, unknown>()) {
  const repo = new MemoryRepositories(), candidates: Candidate[] = []
  const settings = SettingsSchema.parse({ policy: { sources: { local: { allowed: listed ? [{ id: 'operator' }] : [] } } } })
  const sources = new SourceRegistry(() => settings)
  const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
    assessor: { request: candidate => { candidates.push(candidate) }, release: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const host = { receive: (trigger: import('../src/core/index.ts').Trigger) => engine.receive(trigger), triggers: repo.triggers,
    state: { get: <V>(key: Key<V>) => state.get(key) as V | undefined, set: <V>(key: Key<V>, value: V | undefined) => { state.set(key, value) } },
    atomic: <T>(run: () => T) => run() } as unknown as SourceContext
  sources.register(localKind(host))
  return { host, repo, engine, candidates, sources, state }
}
describe('local operator source', () => {
  it('uses real intake and Eval, stable retry IDs, then fans followups into an accepted ticket', async () => {
    const h = harness()
    const receipt = await receiveLocal(h.host, { id: 'first', text: 'Do the work' })
    expect(receipt).toEqual({ id: 'first', thread: 'first', triggerId: 'local:message:first', result: 'stored' })
    expect(h.repo.tickets.list()).toHaveLength(0)
    h.engine.evaluateDue()
    expect(h.candidates).toHaveLength(1)
    expect(h.candidates[0]!.triggers[0]!.actor).toEqual({ source: 'local', id: 'operator' })
    const decision = h.engine.decide(receipt.triggerId, { evalId: h.candidates[0]!.evalId, kind: 'accept', title: 'Work', scope: 'requested work', reason: 'requested', acknowledgement: 'Working' })
    expect(decision.ticketId).toBeTruthy()
    expect((await receiveLocal(h.host, { id: 'first', text: 'Do the work' })).result).toBe('duplicate')
    await expect(receiveLocal(h.host, { id: 'first', text: 'Different' })).rejects.toBeInstanceOf(LocalConflict)
    await receiveLocal(h.host, { id: 'next', thread: 'first', text: 'Additional detail' })
    expect(h.repo.triggers.disposition('local:message:next')?.fanout).toContain(decision.ticketId)
    expect(localMessages(h.host, 'first')).toHaveLength(2)
  })
  it('does not authorize an unlisted operator and rejects sender spoofing or invalid input', async () => {
    const h = harness(false)
    await receiveLocal(h.host, { id: 'unlisted', text: 'Do work' })
    h.engine.evaluateDue()
    expect(h.candidates).toHaveLength(0)
    expect(h.repo.tickets.list()).toHaveLength(0)
    await expect(receiveLocal(h.host, { id: 'bad', text: ' ', actor: 'admin' })).rejects.toThrow()
    await expect(receiveLocal(h.host, { id: '../bad', text: 'work' })).rejects.toThrow()
  })
  it('persists replies idempotently in source KV and reads them after recreation', async () => {
    const h = harness(), kind = localKind(h.host)
    const reply: OutboundMessage = { id: 'reply-1', channel: { source: 'local', thread: 'topic', address: { thread: 'topic' } }, text: 'Done', kind: 'reply', ticketId: 'ticket-1' }
    await kind.channel!.send({ commands: {} as Commands }, reply)
    await kind.channel!.send({ commands: {} as Commands }, reply)
    const reopened = harness(true, h.state)
    expect(localMessages(reopened.host, 'topic')).toEqual([expect.objectContaining({ id: 'reply-1', from: 'agent', text: 'Done', ticketId: 'ticket-1' })])
  })
})
