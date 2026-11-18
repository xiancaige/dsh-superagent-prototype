import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
it('keeps terminal model failure settled after persisted restore even before its failed report', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const assignment = stored.assignments.at(-1)!
  const at = new Date().toISOString()
  assignment.deliveredAt = at
  assignment.modelFailure = { at, error: 'TIMEOUT after model retries', hostResumeBudget: 0 }
  delete assignment.report
  h.runtime.store.tickets.save(stored)
  h.runtime.engine.assignmentInterrupted(ticket.id, assignment.id)
  const restored = h.runtime.store.tickets.get(ticket.id)!
  expect(restored.assignments).toHaveLength(1)
  expect(restored.assignments[0]!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('budget 0') })
  h.runtime.engine.assignmentInterrupted(ticket.id, assignment.id)
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
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
