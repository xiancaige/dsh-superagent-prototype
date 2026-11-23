import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { hasPendingMasterWork, MAX_TIMEOUT_RECOVERIES, notifyEvalTimeout, recoverableTimeoutTriggers, recoverTimedOutEvals, TIMEOUT_NOTICE_COOLDOWN_MS } from '../src/app/eval-recovery.ts'
import { KV } from '../src/kv.ts'

describe('Eval timeout recovery and Feishu notification', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function openStore() {
    const dir = mkdtempSync(join(tmpdir(), 'eval-recovery-'))
    dirs.push(dir)
    return new Store(join(dir, 'orchestrator.sqlite'))
  }

  function makeFeishuTrigger(id: string, text = '处理飞书超时问题', at = '2026-11-23T08:00:00.000Z'): Trigger {
    return {
      id,
      source: 'feishu',
      actor: { source: 'feishu', id: 'ou_operator' },
      human: true,
      addressed: 'direct',
      at,
      text,
      threads: [{ source: 'feishu', id: `oc_chat:om_${id}` }],
      channel: { source: 'feishu', thread: 'feishu:oc_chat', address: { chatId: 'oc_chat', messageId: `om_${id}`, direct: 'true' } },
      meta: { chatId: 'oc_chat', messageId: `om_${id}`, direct: true },
    }
  }

  it('notifies Feishu once per thread cooldown for explicit timeout decisions and skips inferred or retried timeouts', () => {
    const store = openStore()
    try {
      const trigger1 = makeFeishuTrigger('t1', '帮我看下这个问题')
      const trigger2 = makeFeishuTrigger('t2', '再发一条测试')
      store.triggers.save(trigger1)
      store.triggers.save(trigger2)

      const sent: unknown[] = []
      const outbox = { send: vi.fn((msg: unknown) => { sent.push(msg) }) }

      const explicitTimeout = {
        id: 'dec-1',
        evalId: 'eval-1',
        threadKey: 'feishu:oc_chat:om_t1',
        triggerIds: ['t1'],
        policyVersion: 'v1',
        at: '2026-11-23T08:06:00.000Z',
        kind: 'unavailable' as const,
        reason: [{ code: 'timeout' }],
        strength: 'explicit' as const,
      }
      const t0 = Date.parse('2026-11-23T08:06:00.000Z')
      expect(notifyEvalTimeout({ store, outbox, decision: explicitTimeout, now: t0 })).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ kind: 'notice', channel: trigger1.channel, text: expect.stringContaining('评估超时') })

      // Within cooldown window on the same thread -> suppressed.
      expect(notifyEvalTimeout({ store, outbox, decision: { ...explicitTimeout, id: 'dec-2' }, now: t0 + 5 * 60_000 })).toBe(false)
      expect(sent).toHaveLength(1)

      // Inferred decision -> never notifies IM.
      expect(notifyEvalTimeout({
        store,
        outbox,
        decision: { ...explicitTimeout, id: 'dec-3', threadKey: 'feishu:oc_chat:om_t2', triggerIds: ['t2'], strength: 'inferred' },
        now: t0 + TIMEOUT_NOTICE_COOLDOWN_MS + 1000,
      })).toBe(false)
      expect(sent).toHaveLength(1)

      // After an auto-recovery attempt was already recorded -> suppressed even past cooldown.
      store.set(KV.runtime.evalTimeoutRecovery('t1'), { attempts: 1, lastAt: '2026-11-23T08:10:00.000Z' })
      expect(notifyEvalTimeout({
        store,
        outbox,
        decision: { ...explicitTimeout, id: 'dec-4' },
        now: t0 + TIMEOUT_NOTICE_COOLDOWN_MS + 1000,
      })).toBe(false)
      expect(sent).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('automatically requeues recent unavailable timeout triggers up to MAX_TIMEOUT_RECOVERIES and stops once resolved', () => {
    const store = openStore()
    try {
      let nowMs = Date.parse('2026-11-23T08:00:00.000Z')
      const requests: string[] = []
      const engine = new Engine({
        repo: store,
        now: () => new Date(nowMs).toISOString(),
        scope: { scope: () => ({ listened: true, observed: false }) },
        policy: () => ({
          version: 'v1',
          paused: false,
          evalTimeoutMs: 60_000,
          gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }),
          admitsInferred: () => false,
          revalidate: () => true,
        }),
        assessor: { request: candidate => { requests.push(candidate.evalId) } },
        executor: { start: () => {}, deliver: () => {}, stop: () => {} },
        outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
      })

      const t1 = makeFeishuTrigger('r1', '测试恢复', new Date(nowMs).toISOString())
      engine.receive(t1)
      engine.evaluateDue()
      expect(hasPendingMasterWork(store, nowMs)).toBe(true)

      // Expire initial + 2 requeues -> unavailable (timeout)
      for (let i = 0; i < 3; i++) {
        engine.candidateDelivered(requests.at(-1)!)
        nowMs += 61_000
        engine.evaluateDue()
      }
      const firstUnavailable = store.decisions.byThread('feishu:oc_chat:om_r1').at(-1)
      expect(firstUnavailable).toMatchObject({ kind: 'unavailable', reason: [{ code: 'timeout' }] })
      expect(recoverableTimeoutTriggers(store, nowMs)).toEqual(['r1'])
      expect(hasPendingMasterWork(store, nowMs)).toBe(true)

      // Recovery requeues r1 up to MAX_TIMEOUT_RECOVERIES times.
      const requestPass = vi.fn(() => { engine.evaluateDue() })
      for (let attempt = 1; attempt <= MAX_TIMEOUT_RECOVERIES; attempt++) {
        expect(recoverTimedOutEvals({ store, engine, requestPass, now: nowMs })).toEqual(['r1'])
        expect(store.get(KV.runtime.evalTimeoutRecovery('r1'))?.attempts).toBe(attempt)
        // Simulate it timing out again in each attempt.
        for (let i = 0; i < 3; i++) {
          engine.candidateDelivered(requests.at(-1)!)
          nowMs += 61_000
          engine.evaluateDue()
        }
      }

      // After MAX_TIMEOUT_RECOVERIES, it stops auto-recovering.
      expect(recoverableTimeoutTriggers(store, nowMs)).toEqual([])
      expect(hasPendingMasterWork(store, nowMs)).toBe(false)
      expect(recoverTimedOutEvals({ store, engine, requestPass, now: nowMs })).toEqual([])
    } finally {
      store.close()
    }
  })

  it('skips triggers whose thread already received a newer decision or were dismissed', () => {
    const store = openStore()
    try {
      const nowMs = Date.parse('2026-11-23T08:30:00.000Z')
      const t1 = makeFeishuTrigger('d1', '已处理', '2026-11-23T08:00:00.000Z')
      const t2 = makeFeishuTrigger('d2', '已忽略', '2026-11-23T08:00:00.000Z')
      store.triggers.save(t1)
      store.triggers.save(t2)
      store.threads.save({
        key: 'feishu:oc_chat:om_d1',
        ref: { source: 'feishu', id: 'oc_chat:om_d1' },
        createdAt: '2026-11-23T08:00:00.000Z',
        subscriptions: [],
        correlated: [],
        pending: [],
        meta: {},
      })
      store.threads.save({
        key: 'feishu:oc_chat:om_d2',
        ref: { source: 'feishu', id: 'oc_chat:om_d2' },
        createdAt: '2026-11-23T08:00:00.000Z',
        subscriptions: [],
        correlated: [],
        pending: [],
        meta: {},
      })
      store.decisions.save({
        id: 'u1',
        evalId: 'e1',
        threadKey: 'feishu:oc_chat:om_d1',
        triggerIds: ['d1'],
        policyVersion: 'v1',
        at: '2026-11-23T08:10:00.000Z',
        kind: 'unavailable',
        reason: [{ code: 'timeout' }],
        strength: 'explicit',
      })
      store.decisions.save({
        id: 'u1-later',
        evalId: 'e1b',
        threadKey: 'feishu:oc_chat:om_d1',
        triggerIds: ['d1'],
        policyVersion: 'v1',
        at: '2026-11-23T08:20:00.000Z',
        kind: 'ignore',
        reason: [{ code: 'said', values: { text: 'resolved' } }],
        strength: 'explicit',
      })
      store.decisions.save({
        id: 'u2',
        evalId: 'e2',
        threadKey: 'feishu:oc_chat:om_d2',
        triggerIds: ['d2'],
        policyVersion: 'v1',
        at: '2026-11-23T08:15:00.000Z',
        kind: 'unavailable',
        reason: [{ code: 'timeout' }],
        strength: 'explicit',
        dismissed: true,
      })

      expect(recoverableTimeoutTriggers(store, nowMs)).toEqual([])
      expect(hasPendingMasterWork(store, nowMs)).toBe(false)
    } finally {
      store.close()
    }
  })
})
