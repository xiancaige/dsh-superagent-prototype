import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasActiveModelFailure, canAdvanceTicket, type Assignment } from '../src/core/index.ts'
import { followupNotice } from '../src/app/notices.ts'
import { ticketSummary } from '../src/app/views/records.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const at = '2026-11-25T00:00:00.000Z'
const later = '2026-11-25T00:00:01.000Z'
const failure = () => ({ at, error: 'provider exhausted retries', hostResumeBudget: 0 as const })
const assignment = (): Assignment => ({ id: 'a', state: 'running', createdAt: at, modelFailure: failure() })

describe('current versus historical model failure', () => {
  it('does not infer recovery from delivery, idle, old reports or a later failed report', () => {
    const current = assignment()
    current.deliveredAt = later
    current.idleAt = later
    expect(hasActiveModelFailure(current)).toBe(true)
    current.report = { at, state: 'progress', summary: 'before failure' }
    expect(hasActiveModelFailure(current)).toBe(true)
    current.report = { at: later, state: 'failed', summary: 'still failed' }
    expect(hasActiveModelFailure(current)).toBe(true)
  })
  it.each(['progress', 'waiting', 'ready', 'blocked', 'dropped'] as const)('recognizes a legacy later %s report without a database migration', state => {
    const current = assignment()
    current.report = { at: later, state, summary: 'worker recovered' }
    expect(hasActiveModelFailure(current)).toBe(false)
    current.modelFailure = { ...failure(), at: later }
    expect(hasActiveModelFailure(current)).toBe(true)
  })
  it('honors explicit recovery even when report and failure share a millisecond', () => {
    const current = assignment()
    current.modelFailure!.recoveredAt = at
    current.report = { at, state: 'progress', summary: 'recovered' }
    expect(hasActiveModelFailure(current)).toBe(false)
  })
})

let h: Host | undefined
afterEach(async () => { vi.useRealTimers(); await h?.stop(); h = undefined })

it('persists same-millisecond recovery, allows advance, and does not restore the old failure on interruption', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const active = stored.assignments.at(-1)!
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date())
  active.modelFailure = { ...failure(), at: new Date().toISOString() }
  active.deliveredAt = at
  h.runtime.store.tickets.save(stored)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', completion: 'implementation', summary: 'Recovered implementation' })
  const recovered = h.runtime.store.tickets.get(ticket.id)!
  expect(recovered.assignments.at(-1)!.modelFailure?.recoveredAt).toBe(active.modelFailure.at)
  expect(recovered.assignments.at(-1)!.report!.at).toBe(active.modelFailure.at)
  vi.useRealTimers()
  expect(ticketSummary(recovered)).not.toHaveProperty('modelFailure')
  expect(canAdvanceTicket(recovered)).toBe(true)
  h.runtime.engine.assignmentInterrupted(ticket.id, active.id)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments[0]!.report?.state).toBe('ready')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', completion: 'accepted', summary: 'Acceptance done' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
})

it('legacy recovery neither stalls follow-up notices nor regresses to failed on a host restart', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const active = stored.assignments.at(-1)!
  active.modelFailure = failure()
  active.deliveredAt = at
  active.report = { at: later, state: 'ready', completion: 'implementation', summary: 'Recovered before upgrade' }
  h.runtime.store.tickets.save(stored)
  h.runtime.engine.assignmentInterrupted(ticket.id, active.id)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments[0]!.report?.state).toBe('ready')
  expect(ticketSummary(h.runtime.store.tickets.get(ticket.id)!)).not.toHaveProperty('modelFailure')
  const followup = feishu('2', '进度', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(followup)
  await h.runtime.idle()
  const notice = followupNotice(h.runtime.store, h.runtime.sources, followup.id)
  expect(notice).toBeDefined()
  expect(JSON.parse(notice!.text).delivered_to[0]).not.toHaveProperty('stalled')
})
