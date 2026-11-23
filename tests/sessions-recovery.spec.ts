import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sessions } from '../src/app/sessions.ts'
import { defaultPrompts } from '../src/app/prompts.ts'
import { SettingsSchema } from '../src/policy.ts'
import { HealthBoard } from '../src/infra/health.ts'

describe('Sessions master error-turn inbox recovery', () => {
  const contexts: Context[] = []
  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    vi.restoreAllMocks()
  })

  function setup(opts: { paused?: boolean; initialEvents?: SessionEvent[]; hasPendingMasterWork?: () => boolean; onMasterTurnCompleted?: () => void } = {}) {
    const ctx = new Context()
    contexts.push(ctx)
    const masterId = 'orchestrator-test'
    const events: SessionEvent[] = [...(opts.initialEvents ?? [])]
    const inbox = {
      nextTurn: [] as UserMessage[],
      nextStep: [] as UserMessage[],
      remove: vi.fn((id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
        const idx = list.findIndex(item => item.id === id)
        if (idx >= 0) list.splice(idx, 1)
        return idx >= 0
      })),
    }
    const agentCtx = new Context()
    const preset = {}
    agentCtx.reflect.provide('tools', {
      register: () => () => {},
      get: () => undefined,
      restrict: () => () => {},
      guard: () => () => {},
    })
    agentCtx.reflect.provide('skills', { register: () => () => {} })
    agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })

    const session = {
      id: masterId,
      header: { agentPreset: 'dsh-superagent-router' },
      snapshotEvents: () => events,
      requestHeader: () => undefined,
      append: vi.fn(),
    }
    const agent = {
      id: SessionId(masterId),
      ctx: agentCtx,
      session,
      inbox,
      status: 'idle' as 'idle' | 'running',
      steer: vi.fn((message: UserMessage) => {
        inbox.nextStep.push(message)
        agent.status = 'running'
        ctx.emit('agent/status', { agent: agent as unknown as Agent, status: 'running' })
      }),
      followup: vi.fn((message: UserMessage) => {
        inbox.nextTurn.push(message)
        agent.status = 'running'
        ctx.emit('agent/status', { agent: agent as unknown as Agent, status: 'running' })
      }),
      inject: vi.fn(),
      cancel: vi.fn(),
      whenIdle: async () => {},
    }
    bindScopeParent(agent as never, preset)

    const agentsMap = new Map([[agent.id, agent]])
    ctx.reflect.provide('agents', {
      get: (id: SessionId) => agentsMap.get(id),
      list: () => [...agentsMap.values()],
    })
    ctx.reflect.provide('sessionPersistence', {
      flush: vi.fn(async () => {}),
      open: vi.fn(async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} })),
    })
    ctx.reflect.provide('sessionController', {
      resolveAgent: vi.fn(async () => ({ agent })),
      rename: vi.fn(async () => {}),
    })
    ctx.reflect.provide('permissionPresets', { set: vi.fn() })
    ctx.reflect.provide('llm', { resolveCallConfig: vi.fn(async (m: unknown) => m) })

    let paused = opts.paused ?? false
    const board = new HealthBoard()
    const sessions = new Sessions({
      context: ctx,
      store: {
        tickets: { get: () => undefined, list: () => [], open: () => [] } as never,
        settings: () => SettingsSchema.parse({}),
        get: () => undefined,
        set: () => {},
        keys: () => [],
      },
      prompts: {
        current: () => ({ revision: 1, previousRevision: null, savedAt: '', source: 'defaults' as const, config: defaultPrompts() }),
        version: () => ({ revision: 1, previousRevision: null, savedAt: '', source: 'defaults' as const, config: defaultPrompts() }),
        compose: () => 'prompt',
        skills: () => [],
      },
      effects: {
        enqueue: vi.fn(),
        handle: vi.fn(),
        idle: vi.fn(async () => {}),
        pending: vi.fn(() => false),
      },
      health: board.claim('models'),
      masterId,
      lifetime: new AbortController().signal,
      closing: () => false,
      paused: () => paused,
      ...(opts.hasPendingMasterWork ? { hasPendingMasterWork: opts.hasPendingMasterWork } : {}),
      ...(opts.onMasterTurnCompleted ? { onMasterTurnCompleted: opts.onMasterTurnCompleted } : {}),
      environment: () => [],
      tools: () => [],
    })
    sessions.install()
    return {
      ctx,
      agent,
      session,
      inbox,
      sessions,
      setPaused: (v: boolean) => { paused = v },
      emitTurnStart: (turn = 1) => {
        const ev = { type: 'turn/start', seq: SessionSeq(events.length + 1), time: Date.now(), data: { turn } } as unknown as SessionEvent
        events.push(ev)
        ctx.emit('session/event', session as never, ev)
        for (const msg of [...inbox.nextStep.splice(0), ...inbox.nextTurn.splice(0)]) {
          const userEv = { type: 'user/message', seq: SessionSeq(events.length + 1), time: Date.now(), data: msg } as unknown as SessionEvent
          events.push(userEv)
          ctx.emit('session/event', session as never, userEv)
        }
      },
      emitUserMessage: (message: UserMessage) => {
        const ev = { type: 'user/message', seq: SessionSeq(events.length + 1), time: Date.now(), data: message } as unknown as SessionEvent
        events.push(ev)
        ctx.emit('session/event', session as never, ev)
      },
      emitTurnEnd: (kind: 'completed' | 'error') => {
        const ev = {
          type: 'turn/end',
          seq: SessionSeq(events.length + 1),
          time: Date.now(),
          data: kind === 'error'
            ? { turn: 1, reason: { kind: 'error', error: { message: 'stream closed', code: 'PI_AI_ERROR' } } }
            : { turn: 1, reason: { kind: 'completed' } },
        } as unknown as SessionEvent
        events.push(ev)
        ctx.emit('session/event', session as never, ev)
      },
    }
  }

  it('wakes masterId with backoff when a turn ends with error leaving a stranded relay in inbox', async () => {
    vi.useFakeTimers()
    const s = setup()
    await s.sessions.ensure(s.session.id, 'D:/TP', 'master', 'orchestrator')

    const msg = freezeMessage({
      id: MessageId('dsh-superagent:relay-1'),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: '{"kind":"worker_report"}' }],
      source: { kind: 'dsh-superagent' as const, form: 'relay' as const },
    })
    s.inbox.nextStep.push(msg)
    s.agent.status = 'running'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'running' })

    // Turn fails with PI_AI_ERROR and drops to idle while msg remains in nextStep.
    s.emitTurnEnd('error')
    s.agent.status = 'idle'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'idle' })

    expect(s.agent.steer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4999)
    expect(s.agent.steer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(s.agent.steer).toHaveBeenCalledOnce()
    expect(s.agent.status).toBe('running')
    expect(s.inbox.nextStep).toHaveLength(1)

    // A second consecutive error backs off to 10s.
    s.emitTurnEnd('error')
    s.agent.status = 'idle'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'idle' })
    await vi.advanceTimersByTimeAsync(9999)
    expect(s.agent.steer).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(s.agent.steer).toHaveBeenCalledTimes(2)

    // Completing a turn resets the backoff; completed turns do not trigger wakes.
    s.emitTurnEnd('completed')
    s.agent.status = 'idle'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'idle' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.agent.steer).toHaveBeenCalledTimes(2)

    s.sessions.dispose()
  })

  it('cancels pending wake if woken earlier and recovers persisted error-turn inbox on boot', async () => {
    vi.useFakeTimers()
    const stranded = freezeMessage({
      id: MessageId('dsh-superagent:relay-boot'),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: '{"kind":"followup"}' }],
      source: { kind: 'dsh-superagent' as const, form: 'relay' as const },
    })
    const initialError = {
      type: 'turn/end',
      seq: SessionSeq(1),
      time: Date.now(),
      data: { turn: 889, reason: { kind: 'error', error: { message: 'stream closed', code: 'PI_AI_ERROR' } } },
    } as unknown as SessionEvent

    const s = setup({ initialEvents: [initialError], paused: true })
    s.inbox.nextStep.push(stranded)
    await s.sessions.ensure(s.session.id, 'D:/TP', 'master', 'orchestrator')

    // While paused, it defers without calling steer.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(s.agent.steer).not.toHaveBeenCalled()

    // Unpause -> next check wakes the stranded message.
    s.setPaused(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(s.agent.steer).toHaveBeenCalledOnce()
    expect(s.agent.status).toBe('running')

    s.sessions.dispose()
  })

  it('wakes masterId with recovery_wake when inbox is empty after an error turn if pending master work exists', async () => {
    vi.useFakeTimers()
    let pendingWork = true
    const onMasterTurnCompleted = vi.fn()
    const s = setup({ hasPendingMasterWork: () => pendingWork, onMasterTurnCompleted })
    await s.sessions.ensure(s.session.id, 'D:/TP', 'master', 'orchestrator')

    // Candidate was spliced out of inbox at turn/start, then the turn crashed with PI_AI_ERROR leaving inbox empty.
    s.agent.status = 'running'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'running' })
    s.emitTurnStart(1)
    s.emitTurnEnd('error')
    s.agent.status = 'idle'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'idle' })

    expect(s.inbox.nextStep).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(4999)
    expect(s.agent.steer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(s.agent.steer).toHaveBeenCalledOnce()
    const wakeMsg = s.agent.steer.mock.calls[0]![0] as UserMessage
    expect(wakeMsg.id).toMatch(/^dsh-superagent:recovery-wake:/)
    expect(wakeMsg.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"kind":"recovery_wake"') })

    // Second error turn backs off to 10s when inbox is empty.
    s.emitTurnStart(2)
    s.emitTurnEnd('error')
    s.agent.status = 'idle'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'idle' })
    await vi.advanceTimersByTimeAsync(9999)
    expect(s.agent.steer).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(s.agent.steer).toHaveBeenCalledTimes(2)

    // Completing a turn notifies onMasterTurnCompleted and stops waking even if pendingWork flips false.
    pendingWork = false
    s.emitTurnStart(3)
    s.emitTurnEnd('completed')
    s.agent.status = 'idle'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'idle' })
    await Promise.resolve()
    expect(onMasterTurnCompleted).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.agent.steer).toHaveBeenCalledTimes(2)

    s.sessions.dispose()
  })

  it('wakes masterId when a relay was consumed into a crashed turn even without other pending evals, and stays idle when nothing was pending', async () => {
    vi.useFakeTimers()
    const relayMsg = freezeMessage({
      id: MessageId('dsh-superagent:report-1'),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: '{"kind":"worker_report"}' }],
      source: { kind: 'dsh-superagent' as const, form: 'relay' as const },
    })
    const initialEvents = [
      { type: 'turn/start', seq: SessionSeq(1), time: Date.now(), data: { turn: 10 } },
      { type: 'user/message', seq: SessionSeq(2), time: Date.now(), data: relayMsg },
      { type: 'turn/end', seq: SessionSeq(3), time: Date.now(), data: { turn: 10, reason: { kind: 'error', error: { message: 'socket closed', code: 'TRANSPORT' } } } },
    ] as unknown as SessionEvent[]
    const s = setup({ initialEvents, hasPendingMasterWork: () => false })
    await s.sessions.ensure(s.session.id, 'D:/TP', 'master', 'orchestrator')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(s.agent.steer).toHaveBeenCalledOnce()

    // Once completed, a subsequent empty error turn with no relay and no pending work does not trigger a wake.
    s.emitTurnStart(11)
    s.emitTurnEnd('completed')
    s.agent.status = 'idle'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'idle' })

    s.emitTurnStart(12)
    s.emitTurnEnd('error')
    s.agent.status = 'idle'
    s.ctx.emit('agent/status', { agent: s.agent as never, status: 'idle' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.agent.steer).toHaveBeenCalledOnce()

    s.sessions.dispose()
  })
})
