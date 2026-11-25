import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
it('keeps terminal model failure settled after persisted restore even before its failed report, and sends idempotent notice + relay', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix'))
  const followup = feishu('2', '进度', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(followup)
  await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const assignment = stored.assignments.at(-1)!
  const at = new Date().toISOString()
  assignment.deliveredAt = at
  assignment.modelFailure = { at, error: 'TIMEOUT after model retries', hostResumeBudget: 0 }
  delete assignment.report
  h.runtime.store.tickets.save(stored)
  h.runtime.engine.assignmentInterrupted(ticket.id, assignment.id)
  await h.runtime.idle()
  const restored = h.runtime.store.tickets.get(ticket.id)!
  expect(restored.assignments).toHaveLength(1)
  expect(restored.assignments[0]!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('budget 0') })
  const notices = h.runtime.store.receipts.list().filter(item => item.ticketId === ticket.id && item.kind === 'notice')
  expect(notices).toHaveLength(1)
  expect(notices[0]!.text).toContain('TIMEOUT after model retries')
  const relays = h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')
  expect(relays).toHaveLength(1)
  expect(relays[0]).toMatchObject({
    kind: 'worker_report',
    ticket: { ticket_id: ticket.id },
    state: 'failed',
    unanswered_triggers: [expect.objectContaining({ trigger_id: followup.id })],
  })
  // Re-running interruption recovery does not duplicate the assignment, Feishu notice, or relay.
  h.runtime.engine.assignmentInterrupted(ticket.id, assignment.id)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
  expect(h.runtime.store.receipts.list().filter(item => item.ticketId === ticket.id && item.kind === 'notice')).toHaveLength(1)
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report')).toHaveLength(1)
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_reply', {
    ticket_id: ticket.id,
    trigger_id: followup.id,
    purpose: 'answer',
    text: '工单因模型超时失败暂停，等待确认后重试。',
  })).resolves.toEqual({ status: 'sent' })
})
it('rejects globally ambiguous short ids even when only one match subscribes to the thread', async () => {
  h = await startRuntime()
  const one = await h.acceptedTicket(feishu('1', '@bot fix'))
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'done' })
  const ended = h.runtime.store.tickets.get(one.ticket.id)!
  const prefix = one.ticket.id.slice(0, 6)
  h.runtime.store.tickets.save({ ...ended, id: prefix + 'f'.repeat(26), inputs: [], assignments: [] })
  h.runtime.receive(feishu('2', `继续 ${prefix}`, { root_id: 'om_1' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.ended).toBeDefined()
})
it('fails launch closed when an existing worker session has another cwd', async () => {
  h = await startRuntime()
  const original = h.resolveDefault
  h.controller.resolveAgent.mockImplementation(async id => {
    const result = await original(id)
    if (String(id).startsWith('worker-') && result.agent) {
      ;(result.agent as unknown as { session: { header: { cwd: string } } }).session.header.cwd = h!.directory + '-other'
    }
    return result
  })
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.execution!.workerBinding).toBeUndefined()
  expect(stored.assignments.at(-1)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('another workspace') })
})
