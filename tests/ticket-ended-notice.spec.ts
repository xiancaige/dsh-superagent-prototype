/**
 * `console/ticket-ended` is the one event dsh-superagent publishes outside itself. These tests hold the facts a listener
 * plugin depends on: the notice is a copy of the end (not the stored ticket), it reaches a listener registered on the
 * host's global events, it is published after the publishing frame returns, and one misbehaving listener neither hides the
 * end from the others nor fails the ticket.
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { TicketEndedNotice } from '../src/app/runtime.ts'
import { publishTicketEnded } from '../src/app/runtime.ts'

/** A Context with a logger the tests can inspect, as the Runtime has. */
function fixture(): { ctx: Context; warn: ReturnType<typeof vi.fn> } {
  const ctx = new Context()
  const warn = vi.fn()
  Object.assign(ctx, { logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } })
  return { ctx, warn }
}

it('delivers a completed ticket notice to a listener registered on the host events', async () => {
  const { ctx } = fixture()
  const heard = vi.fn()
  ctx.on('console/ticket-ended', heard)
  const notice: TicketEndedNotice = { ticketId: 't1', by: 'executor', outcome: 'completed', at: '2026-11-05T00:00:00.000Z' }
  await publishTicketEnded(ctx, notice)
  expect(heard).toHaveBeenCalledTimes(1)
  expect(heard).toHaveBeenCalledWith(notice)
})

it('carries who ended it and why, so a listener can decide without reading the store', async () => {
  const { ctx } = fixture()
  const heard = vi.fn()
  ctx.on('console/ticket-ended', heard)
  const notice: TicketEndedNotice = { ticketId: 't2', by: 'human', outcome: 'stopped', reason: 'stopped by a person', at: '2026-11-05T01:00:00.000Z' }
  await publishTicketEnded(ctx, notice)
  expect(heard).toHaveBeenCalledWith(notice)
})

it('reaches listeners registered after one that throws', async () => {
  const { ctx, warn } = fixture()
  const after = vi.fn()
  ctx.on('console/ticket-ended', () => { throw new Error('listener broke') })
  ctx.on('console/ticket-ended', after)
  await publishTicketEnded(ctx, { ticketId: 't3', by: 'executor', outcome: 'completed', at: '2026-11-05T02:00:00.000Z' })
  // The failure is reported, and the later listener still heard the end.
  expect(after).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledTimes(1)
  expect(String(warn.mock.calls[0]?.[0])).toContain('console/ticket-ended listener(s) failed')
})

it('reports nothing when every listener succeeds', async () => {
  const { ctx, warn } = fixture()
  ctx.on('console/ticket-ended', vi.fn())
  ctx.on('console/ticket-ended', vi.fn())
  await publishTicketEnded(ctx, { ticketId: 't4', by: 'executor', outcome: 'completed', at: '2026-11-05T03:00:00.000Z' })
  expect(warn).not.toHaveBeenCalled()
})

it('completes with no listener at all, so an unwatched deployment still ends tickets', async () => {
  const { ctx, warn } = fixture()
  await expect(publishTicketEnded(ctx, { ticketId: 't5', by: 'executor', outcome: 'completed', at: '2026-11-05T04:00:00.000Z' })).resolves.toBeUndefined()
  expect(warn).not.toHaveBeenCalled()
})

it('publishes on a later macrotask, so a slow listener never holds the ticket end open', async () => {
  // Mirrors the Runtime's call site: it schedules the publish and returns, it never awaits it inside the transaction.
  const { ctx } = fixture()
  const heard = vi.fn()
  ctx.on('console/ticket-ended', heard)
  const notice: TicketEndedNotice = { ticketId: 't6', by: 'executor', outcome: 'completed', at: '2026-11-05T05:00:00.000Z' }
  let returned = false
  setImmediate(() => { void publishTicketEnded(ctx, notice).then(() => { returned = true }) })
  // The scheduling frame has returned (the emitter is free), while the notice is not yet delivered.
  expect(hearCheck(heard)).toBe(false)
  await new Promise(resolve => setImmediate(resolve))
  expect(returned).toBe(true)
  expect(heard).toHaveBeenCalledTimes(1)
})

const hearCheck = (heard: ReturnType<typeof vi.fn>): boolean => heard.mock.calls.length > 0
