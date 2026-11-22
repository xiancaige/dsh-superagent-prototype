/** Tests for orchestrator decision delegation, ticket advancement, decision-process recording, safety gates, and resource reads. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine, MemoryRepositories, UserError, key, ticketStage, waitsForPerson, type Assessor, type Candidate, type Executor, type Outcome,
  type Policy, type Trigger } from '../src/core/index.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'
import { phase2cHarness } from './fixtures/engine-harness.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const alice = { source: 'feishu', id: 'ou_alice' }
const msg = (id: string, text: string): Trigger => ({
  id, source: 'feishu', threads: [{ source: 'feishu', id: `th_${id}` }], actor: alice, human: true,
  at: `2026-11-22T00:00:${id.padStart(2, '0')}.000Z`, text,
  channel: { source: 'feishu', thread: `th_${id}`, address: { message_id: id } }, meta: {},
})

function domainHarness(fixedClock?: () => string) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const starts: string[] = []
  const deliveries: string[] = []
  const withdrawn: string[] = []
  const emitted: string[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) }, release: () => {} }
  const executor: Executor = {
    start: (ticket, assignment) => { starts.push(`${ticket.id}:${assignment.id}`) },
    deliver: ticket => { deliveries.push(`${ticket.id}:${ticket.undelivered.join(',')}`) },
    stop: () => {},
  }
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true, admitsInferred: () => true,
  }
  const outbox = { send: () => {}, status: () => undefined, withdraw: (id: string) => { withdrawn.push(id) } }
  const engine = new Engine({
    repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor, outbox,
    ...(fixedClock ? { now: fixedClock } : {}),
    emit: event => { emitted.push(event.type) },
  })
  const accept = (id: string) => {
    engine.receive(msg(id, `Request ${id}`)); engine.evaluateDue()
    const candidate = requests.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, {
      kind: 'accept', title: `Ticket ${id}`, scope: 'small', reason: 'requested', acknowledgement: 'ok', evalId: candidate.evalId,
    } as Outcome)
    const ticketId = decision.ticketId!
    const assignment = repo.tickets.get(ticketId)!.assignments[0]!
    engine.assignmentStarted(ticketId, assignment.id)
    return { ticketId, assignmentId: assignment.id }
  }
  return { repo, engine, starts, deliveries, withdrawn, emitted, accept }
}

describe('Engine.advanceTicket', () => {
  const dirs: string[] = []
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

  it('resolves open attention, withdraws unsent attention reply, lifts waitsForPerson, and records rationale', () => {
    const h = domainHarness(() => '2026-11-22T01:00:00.000Z')
    const { ticketId } = h.accept('1')
    h.engine.report(ticketId, { state: 'blocked', summary: 'Need sort order choice', question: 'Sort newest-first or alphabetical?' })
    const before = h.repo.tickets.get(ticketId)!
    const attentionId = before.attention!.id
    expect(ticketStage(before)).toEqual({ stage: 'person', action: 'answer' })
    expect(waitsForPerson(before)).toBe(true)

    const result = h.engine.advanceTicket(ticketId, {
      decision: 'Use newest-first sort order to match the other lists.',
      rationale: 'Worker paused on a routine UI convention. Checked existing lists and chose newest-first within the ticket mandate without interrupting the requester.',
    })

    expect(result.resolvedAttention).toBe('Sort newest-first or alphabetical?')
    expect(h.withdrawn).toContain(key('attention-reply', attentionId))
    const after = h.repo.tickets.get(ticketId)!
    expect(after.attention).toBeUndefined()
    expect(waitsForPerson(after)).toBe(false)
    expect(ticketStage(after)).toEqual({ stage: 'working' })
    expect(after.orchestratorDecisions).toHaveLength(1)
    expect(after.orchestratorDecisions![0]).toMatchObject({
      stage: 'person/answer',
      attentionId,
      question: 'Sort newest-first or alphabetical?',
      decision: 'Use newest-first sort order to match the other lists.',
      rationale: 'Worker paused on a routine UI convention. Checked existing lists and chose newest-first within the ticket mandate without interrupting the requester.',
    })
    expect(after.undelivered).toContain(after.orchestratorDecisions![0]!.inputId)
    expect(h.deliveries.at(-1)).toContain(after.orchestratorDecisions![0]!.inputId)
    expect(h.emitted).toContain('ticket.advanced')

    // Under a frozen clock, a subsequent blocked report still sets waitsForPerson back to true.
    h.engine.report(ticketId, { state: 'blocked', summary: 'Missing external token' })
    expect(waitsForPerson(h.repo.tickets.get(ticketId)!)).toBe(true)
  })

  it('advances an idle (waiting) ticket and launches a failed pending assignment', () => {
    const h = domainHarness()
    const { ticketId } = h.accept('2')
    h.engine.report(ticketId, { state: 'waiting', summary: 'Paused before running tests.' })
    expect(ticketStage(h.repo.tickets.get(ticketId)!)).toEqual({ stage: 'idle' })

    h.engine.advanceTicket(ticketId, {
      decision: 'Proceed to run the plugin tests and finish delivery.',
      rationale: 'Worker ended its turn idle before running verification; simple push-forward within mandate.',
    })
    const advanced = h.repo.tickets.get(ticketId)!
    expect(ticketStage(advanced)).toEqual({ stage: 'working' })
    expect(advanced.orchestratorDecisions![0]).toMatchObject({
      stage: 'idle',
      context: 'Paused before running tests.',
    })

    // Also test a pending assignment that reported failed during launch.
    h.repo.atomic(() => {
      h.engine.receive(msg('3', 'Request 3'))
    })
    h.engine.evaluateDue()
    const ticket3 = h.accept('4').ticketId
    const stored3 = h.repo.tickets.get(ticket3)!
    stored3.assignments[0]!.state = 'pending'
    stored3.assignments[0]!.report = { state: 'failed', summary: 'Transient launch failure', at: '2026-11-22T00:00:05.000Z' }
    h.repo.tickets.save(stored3)
    expect(waitsForPerson(h.repo.tickets.get(ticket3)!)).toBe(true)
    const startsBefore = h.starts.length
    h.engine.advanceTicket(ticket3, {
      decision: 'Retry workspace setup and continue.',
      rationale: 'Recoverable setup glitch; pushing forward.',
    })
    expect(h.starts.length).toBe(startsBefore + 1)
    expect(waitsForPerson(h.repo.tickets.get(ticket3)!)).toBe(false)
  })

  it('refuses ended tickets, shared environment blocks, terminal model failures, design blocks, and ready tickets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'advance-env-'))
    dirs.push(dir)
    const env = phase2cHarness(dir)
    const first = env.accept('1')
    env.settle()
    const second = env.accept('2')
    expect(() => env.engine.advanceTicket(second, { decision: 'Go', rationale: 'Push' }))
      .toThrow(new UserError('advanceEnvironmentBlocked'))

    env.engine.stopTicket(first, 'done')
    expect(() => env.engine.advanceTicket(first, { decision: 'Go', rationale: 'Push' }))
      .toThrow(new UserError('ticketEnded'))

    const h = domainHarness()
    const { ticketId: modelFailId } = h.accept('5')
    const failedTicket = h.repo.tickets.get(modelFailId)!
    failedTicket.assignments[0]!.modelFailure = { at: '2026-11-22T00:00:10.000Z', error: 'quota', hostResumeBudget: 0 }
    h.repo.tickets.save(failedTicket)
    expect(() => h.engine.advanceTicket(modelFailId, { decision: 'Go', rationale: 'Push' }))
      .toThrow(new UserError('advanceModelFailure'))

    const { ticketId: readyId } = h.accept('6')
    const readyTicket = h.repo.tickets.get(readyId)!
    readyTicket.follows = [{ thread: 'github:42', own: true }]
    h.repo.tickets.save(readyTicket)
    h.engine.report(readyId, { state: 'ready', summary: 'All done.' })
    expect(() => h.engine.advanceTicket(readyId, { decision: 'Go', rationale: 'Push' }))
      .toThrow(new UserError('advanceAlreadyReady'))

    const { ticketId: designId } = h.accept('7')
    const ws = mkdtempSync(join(tmpdir(), 'advance-design-'))
    dirs.push(ws)
    mkdirSync(join(ws, 'plans'), { recursive: true })
    writeFileSync(join(ws, 'plans', 'd.md'), '# design\n')
    const designTicket = h.repo.tickets.get(designId)!
    designTicket.assignments[0]!.state = 'pending'
    designTicket.execution = { name: 't7', directory: ws, assignment: 'a' }
    h.repo.tickets.save(designTicket)
    h.engine.configureDesign(designId, { required: true, documentPath: 'plans/d.md', scope: 's' })
    expect(() => h.engine.advanceTicket(designId, { decision: 'Go', rationale: 'Push' }))
      .toThrow(new UserError('advanceDesignBlocked'))
  })
})

describe('orchestrator_ticket_advance runtime tool & resources', () => {
  let host: Host | undefined
  afterEach(async () => { await host?.stop(); host = undefined })

  it('delivers the decision to the worker without sending IM, and exposes decision records via resources and views', async () => {
    host = await startRuntime()
    const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 把列表加个默认排序'))
    await host.runTool(sessionId, 'orchestrator_report', {
      state: 'blocked',
      summary: 'Need default sort order.',
      human_action: 'Default to newest-first or alphabetical?',
    })

    const outboxBefore = host.runtime.store.receipts.list().length
    const res = await host.runTool(host.runtime.masterId, 'orchestrator_ticket_advance', {
      ticket_id: ticket.id,
      decision: 'Use newest-first as the default sort order and finish the tests.',
      rationale: 'Newest-first matches all existing list views in this module and stays within the requested scope.',
    }) as { advanced: boolean; resolved_attention?: string; ticket: { state: string } }

    expect(res.advanced).toBe(true)
    expect(res.resolved_attention).toBe('Default to newest-first or alphabetical?')
    expect(res.ticket.state).toBe('working')
    expect(host.runtime.store.receipts.list().length).toBe(outboxBefore)

    await host.runtime.idle()
    const delivered = host.deliveries.mock.calls.map(([item]) => item).filter(item => item.sessionId === sessionId).at(-1)
    expect(delivered).toBeDefined()
    expect(JSON.parse(delivered!.text)).toMatchObject({
      kind: 'orchestrator-decision',
      question: 'Default to newest-first or alphabetical?',
      decision: 'Use newest-first as the default sort order and finish the tests.',
      rationale: 'Newest-first matches all existing list views in this module and stays within the requested scope.',
    })

    const ticketResource = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: `ticket/${ticket.id}` }) as {
      orchestrator_decisions: { items: { decision: string; rationale: string; read: string }[] }
    }
    expect(ticketResource.orchestrator_decisions.items).toHaveLength(1)
    expect(ticketResource.orchestrator_decisions.items[0]).toMatchObject({
      decision: 'Use newest-first as the default sort order and finish the tests.',
    })

    const advancesPage = await host.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/advances` }) as {
      items: { decision: string; rationale: string; read: string }[]
    }
    expect(advancesPage.items).toHaveLength(1)
    const fullInput = await host.runTool(sessionId, 'orchestrator_read', { resource: advancesPage.items[0]!.read }) as { text: string }
    expect(JSON.parse(fullInput.text)).toMatchObject({
      kind: 'orchestrator-decision',
      rationale: 'Newest-first matches all existing list views in this module and stays within the requested scope.',
    })

    const view = ticketDetail({ store: host.runtime.store, sources: host.runtime.sources, links: host.runtime.links() }, ticket.id)!
    expect(view.orchestratorDecisions).toHaveLength(1)
    expect(view.inputs[0]).toMatchObject({ kind: 'orchestrator-decision', delivered: true })
  })
})
