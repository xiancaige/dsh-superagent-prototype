/** Tests for orchestrator decision delegation, ticket advancement, decision-process recording, safety gates, and resource reads. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine, MemoryRepositories, UserError, canAdvanceTicket, key, ticketStage, waitsForPerson, type Assessor, type Candidate, type Executor, type Outcome,
  type Policy, type Trigger } from '../src/core/index.ts'
import { resultRelay } from '../src/app/notices.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'
import { composePrompt, defaultPrompts } from '../src/app/prompts.ts'
import { masterPrompt } from '../src/app/context.ts'
import { promptFile, supervisorSkill } from '../src/app/skill-files.ts'
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

describe('prompt contracts for orchestrator advance and DSH restart verification', () => {
  let host: Host | undefined
  afterEach(async () => { await host?.stop(); host = undefined })

  it('requires DSH restart and live verification before completion and assigns responsibility to the orchestrator', () => {
    expect(masterPrompt.length).toBeLessThan(1400)
    const orchestrator = composePrompt(defaultPrompts(), 'orchestrator')
    const worker = composePrompt(defaultPrompts(), 'worker')
    expect(orchestrator).toContain('orchestrator_ticket_advance')
    expect(orchestrator).toContain('DSH plugin/prompt changes need DSH restart and live check before completion')
    expect(promptFile('dispatch')).toContain('code and push alone are incomplete: never deliver completion before DSH restarts')
    expect(promptFile('handoff-orchestrator')).toContain('ensuring DSH restarts and takes effect belongs to the orchestrator too')
    expect(promptFile('handoff-worker')).toContain('while restart or live verification is still pending, do not report accepted completion')
    expect(worker).toContain('必须完成构建部署、安全重启 DSH')
    expect(orchestrator).toContain('主调度亦不得按已完成结单或向人报喜，而应由主调度负责推进或直接落实重启与生效验证')
  })

  it('blocks premature result delivery on implementation completion and exposes completion + can_advance in relays', async () => {
    host = await startRuntime()
    const { ticket, trigger, sessionId } = await host.acceptedTicket(feishu('1', '@bot 启用测试工单跑完整流程'))
    await host.runTool(sessionId, 'orchestrator_report', {
      state: 'ready',
      completion: 'implementation',
      reply_to_trigger_id: trigger.id,
      summary: '定位到下游解析报错，尚未修完。',
    })
    const stored = host.runtime.store.tickets.get(ticket.id)!
    expect(canAdvanceTicket(stored)).toBe(true)
    const relay = JSON.parse(resultRelay(stored, 'ready', '定位到下游解析报错，尚未修完。', trigger.id).text) as Record<string, unknown>
    expect(relay).toMatchObject({
      kind: 'worker_report',
      state: 'ready',
      completion: 'implementation',
      can_advance: true,
      answer_to: trigger.id,
    })
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_reply', {
      ticket_id: ticket.id,
      purpose: 'result',
      text: '尚未完成。',
    })).rejects.toThrow(/not ready/i)
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_reply', {
      trigger_id: trigger.id,
      purpose: 'answer',
      text: '已定位到下游报错，正在推进继续修复。',
    })).resolves.toEqual({ status: 'sent' })

    await host.runTool(sessionId, 'orchestrator_report', {
      state: 'ready',
      completion: 'accepted',
      summary: '已修复并完成端到端验收。',
    })
    const completed = host.runtime.store.tickets.get(ticket.id)!
    expect(canAdvanceTicket(completed)).toBe(false)
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_reply', {
      ticket_id: ticket.id,
      purpose: 'result',
      text: '已完成端到端验收。',
    })).resolves.toEqual({ status: 'sent' })
  })

  it('force-injects dsh-superagent-supervisor skill on worker reports and nudges once if an advanceable ticket is left unacted', async () => {
    host = await startRuntime()
    const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 跑完整流程'))
    await host.runTool(sessionId, 'orchestrator_report', {
      state: 'ready',
      completion: 'implementation',
      summary: '发现下游解析 bug，停在半成品。',
    })
    await host.runtime.idle()

    const masterAgent = host.agents.get(host.runtime.masterId)!
    const masterCtx = (masterAgent as unknown as { ctx: import('@deepseek-ai/cordis').Context }).ctx
    const relayMessage = masterAgent.inbox.nextStep.at(-1)!
    const nonReportMessage = {
      ...relayMessage,
      content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'follow_up', trigger_id: 't1' }) }],
    }

    // Non-report messages do not inject the supervisor skill.
    const skipped = await masterCtx.waterfall(
      'agent/pre-step',
      { agent: masterAgent, messages: [nonReportMessage], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: {} } as never,
      async () => ({ kind: 'enter' as const, messages: [nonReportMessage] }),
    ) as { kind: string; messages: { source: { kind: string; name?: string }; content: { text?: string }[] }[] }
    expect(skipped.messages).toHaveLength(1)

    // Worker report messages force-inject the dsh-superagent-supervisor skill block.
    const entered = await masterCtx.waterfall(
      'agent/pre-step',
      { agent: masterAgent, messages: [relayMessage], turn: 2, step: 1, signal: new AbortController().signal, modelSelection: {} } as never,
      async () => ({ kind: 'enter' as const, messages: [relayMessage] }),
    ) as { kind: string; messages: { source: { kind: string; name?: string }; content: { text?: string }[] }[] }
    expect(entered.messages).toHaveLength(2)
    expect(entered.messages[1]!.source).toMatchObject({ kind: 'skill-invocation', name: supervisorSkill.name })
    expect(entered.messages[1]!.content[0]!.text).toContain('<skill_content name="dsh-superagent-supervisor">')
    expect(entered.messages[1]!.content[0]!.text).toContain('orchestrator_ticket_advance')

    // Trying to close the turn without acting steers exactly one supervisor_nudge.
    masterAgent.steer.mockClear()
    await masterCtx.serial('agent/turn-stopping', { agent: masterAgent, turn: 2, signal: new AbortController().signal } as never)
    expect(masterAgent.steer).toHaveBeenCalledTimes(1)
    const nudgeText = (masterAgent.steer.mock.calls[0]![0].content[0] as { text: string }).text
    const nudge = JSON.parse(nudgeText) as { kind: string; ticket_ids: string[] }
    expect(nudge).toMatchObject({ kind: 'supervisor_nudge', ticket_ids: [ticket.id] })

    // Repeated turn-stopping in the same turn does not loop.
    await masterCtx.serial('agent/turn-stopping', { agent: masterAgent, turn: 2, signal: new AbortController().signal } as never)
    expect(masterAgent.steer).toHaveBeenCalledTimes(1)

    // In a new turn, answering a status follow-up alone without advancing a completion=implementation ticket STILL triggers one nudge.
    const answeredRelay = {
      ...relayMessage,
      id: relayMessage.id,
    }
    await masterCtx.waterfall(
      'agent/pre-step',
      { agent: masterAgent, messages: [answeredRelay], turn: 3, step: 1, signal: new AbortController().signal, modelSelection: {} } as never,
      async () => ({ kind: 'enter' as const, messages: [answeredRelay] }),
    )
    await host.runTool(sessionId, 'orchestrator_report', {
      state: 'ready',
      completion: 'implementation',
      reply_to_trigger_id: host.runtime.store.tickets.get(ticket.id)!.origin.triggerId,
      summary: '再次汇报半成品。',
    })
    await host.runTool(host.runtime.masterId, 'orchestrator_reply', {
      trigger_id: host.runtime.store.tickets.get(ticket.id)!.origin.triggerId,
      purpose: 'answer',
      text: '已收到进度，正在核对。',
    })
    masterAgent.steer.mockClear()
    await masterCtx.serial('agent/turn-stopping', { agent: masterAgent, turn: 3, signal: new AbortController().signal } as never)
    expect(masterAgent.steer).toHaveBeenCalledTimes(1)

    // Once the orchestrator advances the ticket, turn-stopping in a new turn stays quiet.
    await masterCtx.waterfall(
      'agent/pre-step',
      { agent: masterAgent, messages: [relayMessage], turn: 4, step: 1, signal: new AbortController().signal, modelSelection: {} } as never,
      async () => ({ kind: 'enter' as const, messages: [relayMessage] }),
    )
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_advance', {
      ticket_id: ticket.id,
      decision: 'Fix the downstream bug in extraction-llm.js and verify end-to-end.',
      rationale: 'Implementation-only stop leaves the requested end-to-end flow broken; within mandate.',
    })
    masterAgent.steer.mockClear()
    await masterCtx.serial('agent/turn-stopping', { agent: masterAgent, turn: 4, signal: new AbortController().signal } as never)
    expect(masterAgent.steer).not.toHaveBeenCalled()
  })

  it('refuses repeated advances with no progress (advanceStalled) and stops nudging so stalled tickets do not spin', async () => {
    host = await startRuntime()
    const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 推进边界测试'))

    // 1. Worker repeats the same unchanged attention question after an advance -> refused with advanceStalled.
    await host.runTool(sessionId, 'orchestrator_report', {
      state: 'blocked',
      summary: 'Waiting for choice',
      human_action: 'Use mode A or mode B?',
    })
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_advance', {
      ticket_id: ticket.id,
      decision: 'Use mode A by default.',
      rationale: 'Routine default within mandate.',
    })
    await host.runTool(sessionId, 'orchestrator_report', {
      state: 'blocked',
      summary: 'Still stuck on mode choice',
      human_action: 'Use mode A or mode B?',
    })
    expect(canAdvanceTicket(host.runtime.store.tickets.get(ticket.id)!)).toBe(false)
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_ticket_advance', {
      ticket_id: ticket.id,
      decision: 'Use mode A again.',
      rationale: 'Retrying.',
    })).rejects.toThrow(/no new progress/i)

    // turn-stopping must NOT nudge when canAdvanceTicket is false (ticket must stop cleanly).
    const masterAgent = host.agents.get(host.runtime.masterId)!
    const masterCtx = (masterAgent as unknown as { ctx: import('@deepseek-ai/cordis').Context }).ctx
    const stalledRelay = masterAgent.inbox.nextStep.at(-1)!
    await masterCtx.waterfall(
      'agent/pre-step',
      { agent: masterAgent, messages: [stalledRelay], turn: 10, step: 1, signal: new AbortController().signal, modelSelection: {} } as never,
      async () => ({ kind: 'enter' as const, messages: [stalledRelay] }),
    )
    masterAgent.steer.mockClear()
    await masterCtx.serial('agent/turn-stopping', { agent: masterAgent, turn: 10, signal: new AbortController().signal } as never)
    expect(masterAgent.steer).not.toHaveBeenCalled()

    // 2. A fresh human follow-up resets consecutive non-ready advance budget, but >=2 consecutive advances without human input stops churn.
    const human2 = feishu('2', '@bot 换个方向试下 C', { root_id: 'om_1' })
    host.runtime.receive(human2)
    await host.runtime.idle()
    await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Blocked step 1', human_action: null })
    expect(canAdvanceTicket(host.runtime.store.tickets.get(ticket.id)!)).toBe(true)
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_advance', {
      ticket_id: ticket.id,
      decision: 'Try step C1.',
      rationale: 'First step after new human direction.',
    })
    await host.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'Failed step 2' })
    expect(canAdvanceTicket(host.runtime.store.tickets.get(ticket.id)!)).toBe(true)
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_advance', {
      ticket_id: ticket.id,
      decision: 'Try step C2.',
      rationale: 'Second distinct step.',
    })
    await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Paused step 3' })
    expect(canAdvanceTicket(host.runtime.store.tickets.get(ticket.id)!)).toBe(false)
    await expect(host.runTool(host.runtime.masterId, 'orchestrator_ticket_advance', {
      ticket_id: ticket.id,
      decision: 'Try step C3.',
      rationale: 'Should stop after consecutive advances without progress.',
    })).rejects.toThrow(/no new progress/i)
  })
})
