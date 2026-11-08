/** Ticket completion is a durable direct call, not a host broadcast. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { installTicketAnalysis, type EvolutionAnalyzer, type TicketAnalysisInput } from '../src/app/ticket-analysis.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, feishu } from './fixtures/host.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const input: TicketAnalysisInput = { ticketId: 't1', sessionId: 'worker-t1', by: 'executor', outcome: 'completed', at: '2026-11-08T00:00:00Z' }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'direct-ticket-analysis-')); dirs.push(dir)
  const store = new Store(join(dir, 'state.sqlite'))
  const ctx = new Context()
  const warn = vi.fn()
  Object.assign(ctx, { logger: { warn } })
  let now = 1000
  const effects = new Effects(store, new HealthBoard(), () => now)
  installTicketAnalysis(ctx, store, effects)
  const service = (analyzeTicket: EvolutionAnalyzer['analyzeTicket']) => ctx.provide('evolveReflect', { analyzeTicket })
  return { store, ctx, effects, service, warn, advance: () => { now += 60_000 } }
}

it('the real Runtime routes a committed worker completion to evolution without a broadcast', async () => {
  const h = await startRuntime()
  const analyze = vi.fn(async () => ({ ok: true, status: 'completed', jobId: 'runtime-job' }))
  h.ctx.provide('evolveReflect', { analyzeTicket: analyze })
  const broadcast = vi.spyOn(h.ctx, 'parallel')
  try {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', 'Fix regression'))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done locally' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
    expect(analyze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ticketId: ticket.id, sessionId, outcome: 'completed' }))
    expect(h.runtime.store.get(KV.runtime.ticketAnalysis(ticket.id))?.result.jobId).toBe('runtime-job')
    expect(ticketDetail({ store: h.runtime.store, sources: h.runtime.sources, links: h.runtime.links() }, ticket.id)?.evolutionAnalysis?.result.jobId).toBe('runtime-job')
    expect(broadcast.mock.calls.some(call => String(call[0]) === 'console/ticket-ended')).toBe(false)
  } finally { await h.stop() }
})

it('calls one named service after commit and stores the actual result', async () => {
  const f = fixture(), analyze = vi.fn(async () => ({ ok: true, jobId: 'j1', status: 'completed' }))
  f.service(analyze)
  try {
    f.effects.start()
    f.store.atomic(() => { f.effects.enqueue('ticketAnalysis', input.ticketId, input); expect(analyze).not.toHaveBeenCalled() })
    await f.effects.idle()
    expect(analyze).toHaveBeenCalledExactlyOnceWith(input)
    expect(f.store.get(KV.runtime.ticketAnalysis('t1'))?.result).toEqual({ ok: true, jobId: 'j1', status: 'completed' })
    expect(f.effects.pending('ticketAnalysis')).toBe(false)
  } finally { await f.effects.drain(); f.store.close() }
})

it('a rolled-back ticket end never calls evolution', async () => {
  const f = fixture(), analyze = vi.fn(async () => ({ ok: true }))
  f.service(analyze)
  try {
    f.effects.start()
    expect(() => f.store.atomic(() => { f.effects.enqueue('ticketAnalysis', 't1', input); throw new Error('rollback') })).toThrow('rollback')
    await f.effects.idle()
    expect(analyze).not.toHaveBeenCalled()
    expect(f.effects.pending('ticketAnalysis')).toBe(false)
  } finally { await f.effects.drain(); f.store.close() }
})

it('survives restart and retries service unavailability and busy without dropping the ticket', async () => {
  const f = fixture()
  f.store.atomic(() => f.effects.enqueue('ticketAnalysis', 't1', input))
  await f.effects.drain()
  const next = new Effects(f.store, new HealthBoard())
  installTicketAnalysis(f.ctx, f.store, next)
  try {
    next.start(); await next.idle()
    expect(next.pending('ticketAnalysis')).toBe(true)
    const analyze = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'busy' }).mockResolvedValue({ ok: true, status: 'completed' })
    f.service(analyze)
    f.store.db.prepare('UPDATE effect SET due=0').run()
    await next.idle()
    expect(next.pending('ticketAnalysis')).toBe(true)
    expect(f.store.get(KV.runtime.ticketAnalysis('t1'))).toBeUndefined()
    f.store.db.prepare('UPDATE effect SET due=0').run()
    await next.idle()
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(next.pending('ticketAnalysis')).toBe(false)
  } finally { await next.drain(); f.store.close() }
})

it('waits for analysis completion and records failure without repeated LLM billing', async () => {
  const f = fixture()
  let finish!: (result: { ok: boolean; reason: string }) => void
  const analyze = vi.fn(() => new Promise<{ ok: boolean; reason: string }>(resolve => { finish = resolve }))
  f.service(analyze)
  try {
    f.effects.start(); f.effects.enqueue('ticketAnalysis', 't1', input)
    await Promise.resolve()
    expect(f.effects.pending('ticketAnalysis')).toBe(true)
    expect(f.store.get(KV.runtime.ticketAnalysis('t1'))).toBeUndefined()
    finish({ ok: false, reason: 'model-failed' })
    await f.effects.idle()
    expect(f.store.get(KV.runtime.ticketAnalysis('t1'))?.result.reason).toBe('model-failed')
    f.advance(); await f.effects.idle()
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(f.warn).toHaveBeenCalledTimes(1)
  } finally { await f.effects.drain(); f.store.close() }
})
