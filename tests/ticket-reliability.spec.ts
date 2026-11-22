import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { diagnoseTicketAnalysisSource, resolveTicketAnalysisSource } from '../src/app/ticket-analysis.ts'
let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('does not multiply terminal model transport failures into another turn', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix'))
  const agent = h.agents.get(sessionId)!
  const before = h.deliveries.mock.calls.length
  h.ctx.emit('agent/error', { agent, error: Object.assign(new Error('TIMEOUT 300s ECONNRESET after six attempts'), { code: 'ECONNRESET' }) } as never)
  await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.assignments.at(-1)).toMatchObject({ modelFailure: { hostResumeBudget: 0 }, report: { state: 'failed', summary: expect.stringContaining('Explicit human retry') } })
  expect(h.deliveries.mock.calls.slice(before).filter(([call]) => call.sessionId === sessionId)).toHaveLength(0)
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('keeps implementation ready open until an accepted report, without guessing summary prose', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', completion: 'implementation', summary: 'Code ready; PIE and CQTest not run.' })
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'ready', completion: 'implementation' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', completion: 'accepted', summary: 'Acceptance passed; evidence recorded.' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
})

it('does not resume any completed ticket on a shared-thread probe, but accepts one explicit unique id', async () => {
  h = await startRuntime()
  const first = await h.acceptedTicket(feishu('1', '@bot fix'))
  const second = await h.acceptedTicket(feishu('2', '@bot other'))
  const shared = { source: 'feishu', id: 'shared' }
  h.runtime.engine.bindThread(first.ticket.id, shared, false)
  h.runtime.engine.bindThread(second.ticket.id, shared, false)
  // End without followed PR dependencies using dropped.
  await h.runTool(first.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing remains' })
  await h.runTool(second.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing remains' })
  const probe = { ...feishu('3', '测试'), threads: [shared] }
  h.runtime.receive(probe); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(first.ticket.id)!.ended).toBeDefined()
  expect(h.runtime.store.tickets.get(second.ticket.id)!.ended).toBeDefined()
  await expect(h.route({ kind: 'attach', ticket_id: first.ticket.id, trigger_id: probe.id })).rejects.toThrow('explicit unique')
  h.runtime.receive({ ...feishu('4', `继续 ${first.ticket.id}`), threads: [shared] }); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(first.ticket.id)!.ended).toBeUndefined()
  expect(h.runtime.store.tickets.get(second.ticket.id)!.ended).toBeDefined()
})

it('resolves only persisted terminal worker bindings and rejects stop, spoofing and directory changes', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix'))
  const store = h.runtime.store
  const source = () => resolveTicketAnalysisSource(store, { ticketId: ticket.id, sessionId })
  expect(source()).toBeUndefined()
  expect(diagnoseTicketAnalysisSource(store, { ticketId: 'unknown', sessionId })).toBe('ticket-not-found')
  expect(diagnoseTicketAnalysisSource(store, { ticketId: ticket.id, sessionId })).toBe('ticket-not-ended')
  const stored = store.tickets.get(ticket.id)!
  expect(stored.execution!.workerBinding).toEqual({ sessionId, projectRoot: h.directory, workspaceRoot: stored.execution!.directory })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'No work' })
  expect(source()).toMatchObject({ ticketId: ticket.id, sessionId, outcome: 'dropped', projectRoot: h.directory })
  expect(diagnoseTicketAnalysisSource(store, { ticketId: ticket.id, sessionId })).toBeUndefined()
  expect(resolveTicketAnalysisSource(store, { ticketId: ticket.id, sessionId: 'worker-other' })).toBeUndefined()
  expect(diagnoseTicketAnalysisSource(store, { ticketId: ticket.id, sessionId: 'worker-other' })).toBe('session-id-mismatch')
  const ended = store.tickets.get(ticket.id)!
  ended.execution!.directory += '-forged'; store.tickets.save(ended)
  expect(source()).toBeUndefined()
  expect(diagnoseTicketAnalysisSource(store, { ticketId: ticket.id, sessionId })).toBe('binding-workspace-mismatch')
  ended.execution!.directory = ended.execution!.workerBinding!.workspaceRoot
  ended.ended = { at: new Date().toISOString(), by: 'human', outcome: 'stopped' }; store.tickets.save(ended)
  expect(source()).toBeUndefined()
  expect(diagnoseTicketAnalysisSource(store, { ticketId: ticket.id, sessionId })).toBe('stopped-by-person')
  ended.ended = { at: new Date().toISOString(), by: 'human', outcome: 'completed' }; store.tickets.save(ended)
  expect(diagnoseTicketAnalysisSource(store, { ticketId: ticket.id, sessionId })).toBe('ticket-ended-by-non-executor')
  ended.ended = { at: new Date().toISOString(), by: 'executor', outcome: 'completed' }
  delete ended.execution!.workerBinding; store.tickets.save(ended)
  expect(diagnoseTicketAnalysisSource(store, { ticketId: ticket.id, sessionId })).toBe('missing-worker-binding')
})
