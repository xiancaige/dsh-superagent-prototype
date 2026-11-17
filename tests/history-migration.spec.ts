import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import type { Ticket } from '../src/core/index.ts'
import { feishu, startRuntime } from './fixtures/host.ts'
import { historyMigrationStore, historyMigrationAudit } from '../src/app/history-migration.ts'

let store: Store, directory: string
it('host entry uses configured project root and does not open a model tool', async () => {
  const h = await startRuntime()
  try {
    const migrateHistory = vi.fn(async (options: { resolver: (input: { ticketId: string; sessionId: string }) => unknown }) => options.resolver({ ticketId: 'legacy', sessionId: 'worker-legacy' }))
    h.ctx.provide('evolveReflect', { migrateHistory, historyStateHash: hash, analyzeTicket: async () => ({ ok: true }) } as never)
    await h.acceptedTicket(feishu('entry', '@bot fixture'))
    const result = await h.runtime.migrateHistoricalTicketSources({ ticketIds: ['legacy'], dryRun: true, authorization: 'operator' })
    expect(result).toMatchObject({ ticketId: 'legacy', sessionId: 'worker-legacy', projectRoot: h.directory })
    expect(migrateHistory).toHaveBeenCalledWith(expect.objectContaining({ apply: false }))
    await expect(h.runtime.migrateHistoricalTicketSources({ ticketIds: ['legacy'], authorization: 'operator' } as never)).rejects.toThrow('explicit dryRun')
  } finally { await h.stop() }
})
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
afterEach(() => { store?.close(); if (directory) { expect(dirname(directory)).toBe(tmpdir()); expect(basename(directory)).toMatch(/^history-store-test-/); rmSync(directory, { recursive: true, force: true }) } })
function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'history-store-test-'))
  store = new Store(join(directory, 'test.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  const ticket = { id: 'legacy', execution: { directory }, assignments: [{ id: 'a', startedAt: '2026-11-16T00:00:00Z' }], ended: { by: 'executor', outcome: 'completed', at: '2026-11-17T00:00:00Z' }, validation: { enabled: true } } as unknown as Ticket
  store.tickets.save(ticket)
  const input = { ticketId: ticket.id, sessionId: `worker-${ticket.id}`, by: 'executor' as const, outcome: 'completed' as const, at: ticket.ended!.at }
  store.set(KV.runtime.ticketAnalysis(ticket.id), { input, result: { ok: false, reason: 'session-not-a-source' }, finishedAt: input.at })
  const adapter = historyMigrationStore(store, effects, hash)
  const mutation = { ticketId: ticket.id, expectedStateHash: hash(adapter.read(ticket.id)), binding: { sessionId: input.sessionId, projectRoot: directory, workspaceRoot: directory }, audit: { authorization: 'operator-69a86ce0' } }
  return { adapter, mutation, effects }
}
it('commits only binding, preserved original audit and requeue; rejects repeat after reopen', () => {
  const { adapter, mutation, effects } = fixture(), before = adapter.read('legacy')
  expect(adapter.atomicMigrate(mutation)).toBe(true)
  const after = adapter.read('legacy')
  expect(after.ticket).toEqual({ ...before.ticket, execution: { ...before.ticket!.execution, workerBinding: mutation.binding } })
  expect(after.analysis).toEqual(before.analysis)
  expect(store.get(historyMigrationAudit('legacy'))).toEqual({ audit: mutation.audit, originalAnalysis: before.analysis, requeue: 'requested' })
  expect(effects.pending('ticketAnalysis', 'legacy')).toBe(true)
  store.close(); store = new Store(join(directory, 'test.sqlite'))
  expect(historyMigrationStore(store, new Effects(store, new HealthBoard()), hash).atomicMigrate(mutation)).toBe(false)
})
it('CAS rejects changed state without audit or queue', () => {
  const { adapter, mutation, effects } = fixture()
  const ticket = store.tickets.get('legacy')!; ticket.ended!.at += 'changed'; store.tickets.save(ticket)
  expect(adapter.atomicMigrate(mutation)).toBe(false)
  expect(store.get(historyMigrationAudit('legacy'))).toBeUndefined()
  expect(effects.pending('ticketAnalysis', 'legacy')).toBe(false)
})
it('refuses pending analysis and never replaces its payload', () => {
  const { adapter, mutation, effects } = fixture()
  effects.enqueue('ticketAnalysis', 'legacy', adapter.read('legacy').analysis!.input)
  expect(adapter.atomicMigrate(mutation)).toBe(false)
  expect(store.tickets.get('legacy')!.execution!.workerBinding).toBeUndefined()
})
it('enqueue failure rolls back binding and append-only audit together', () => {
  const { adapter, mutation } = fixture(), before = adapter.read('legacy')
  // Rebuild the adapter around the same real SQLite store and a failed queue writer.
  const effects = new Effects(store, new HealthBoard())
  vi.spyOn(effects, 'enqueue').mockImplementation(() => { throw Error('queue write failed') })
  expect(() => historyMigrationStore(store, effects, hash).atomicMigrate(mutation)).toThrow('queue write failed')
  expect(adapter.read('legacy')).toEqual(before)
  expect(store.get(historyMigrationAudit('legacy'))).toBeUndefined()
})
