/** Automatic recovery and IM timeout notifications for evaluations that timed out (`unavailable` with `timeout`). */
import { followupOwners, key, type Decision, type Engine, type Outbox } from '../core/index.ts'
import { KV } from '../kv.ts'
import { evalTimeoutNotices } from './notices.ts'
import type { Store } from './store.ts'

/** Maximum automatic re-evaluation cycles per trigger after hitting `unavailable (timeout)`. */
export const MAX_TIMEOUT_RECOVERIES = 3
/** Only auto-recover `unavailable (timeout)` decisions from the last 24 hours. */
export const TIMEOUT_RECOVERY_WINDOW_MS = 24 * 60 * 60_000
/** Minimum interval between timeout notices sent to the same thread during prolonged outages. */
export const TIMEOUT_NOTICE_COOLDOWN_MS = 30 * 60_000
/** How long an explicit Feishu evaluation may wait in queue before sending a lightweight queued notice. */
export const EVAL_QUEUE_NOTICE_DELAY_MS = 25_000

export type EvalRecoveryStore = Pick<Store, 'read' | 'decisions' | 'threads' | 'triggers' | 'tickets' | 'get' | 'set'>

/** Returns trigger IDs from recent undismissed `unavailable (timeout)` decisions eligible for automatic re-evaluation. */
export function recoverableTimeoutTriggers(store: EvalRecoveryStore, now = Date.now()): string[] {
  const cutoff = new Date(now - TIMEOUT_RECOVERY_WINDOW_MS).toISOString()
  const seenThreads = new Set<string>()
  const result: string[] = []
  for (const decision of store.read.decisionsOfKinds(['unavailable'], 50)) {
    if (decision.at < cutoff) continue
    if (seenThreads.has(decision.threadKey)) continue
    seenThreads.add(decision.threadKey)
    if (decision.dismissed) continue
    if (!decision.reason.some(item => item.code === 'timeout')) continue
    if (store.decisions.byThread(decision.threadKey).at(-1)?.id !== decision.id) continue
    const thread = store.threads.get(decision.threadKey)
    if (!thread || thread.evaluating || thread.pending.length) continue
    for (const triggerId of decision.triggerIds) {
      const trigger = store.triggers.get(triggerId)
      if (!trigger || followupOwners(trigger, store).length) continue
      const state = store.get(KV.runtime.evalTimeoutRecovery(triggerId))
      if ((state?.attempts ?? 0) >= MAX_TIMEOUT_RECOVERIES) continue
      result.push(triggerId)
    }
  }
  return result
}

/** Whether the main Session still has pending evaluations, queued triggers, or recoverable timed-out evaluations. */
export function hasPendingMasterWork(store: EvalRecoveryStore, now = Date.now()): boolean {
  if (store.threads.active().some(thread => !!thread.evaluating || thread.pending.length > 0)) return true
  return recoverableTimeoutTriggers(store, now).length > 0
}

/** Re-queues eligible `unavailable (timeout)` triggers after the main Session completes a turn cleanly. */
export function recoverTimedOutEvals(options: {
  store: EvalRecoveryStore
  engine: Pick<Engine, 'reevaluate'>
  requestPass: () => void
  now?: number
}): string[] {
  const now = options.now ?? Date.now()
  const at = new Date(now).toISOString()
  const triggerIds = recoverableTimeoutTriggers(options.store, now)
  const requeued: string[] = []
  for (const triggerId of triggerIds) {
    const prev = options.store.get(KV.runtime.evalTimeoutRecovery(triggerId))?.attempts ?? 0
    try {
      if (options.engine.reevaluate(triggerId)) {
        options.store.set(KV.runtime.evalTimeoutRecovery(triggerId), { attempts: prev + 1, lastAt: at })
        requeued.push(triggerId)
      }
    } catch { /* Ignore triggers that cannot be requeued concurrently. */ }
  }
  if (requeued.length) options.requestPass()
  return requeued
}

/** Sends at most one concise IM notice per thread cooldown window when an explicit request hits `unavailable (timeout)`. */
export function notifyEvalTimeout(options: {
  store: Pick<Store, 'triggers' | 'get' | 'set'>
  outbox: Pick<Outbox, 'send'>
  decision: Decision
  now?: number
}): boolean {
  const { store, outbox, decision } = options
  if (decision.kind !== 'unavailable' || decision.strength !== 'explicit') return false
  if (!decision.reason.some(item => item.code === 'timeout')) return false
  const now = options.now ?? Date.now()
  const lastNoticeAt = store.get(KV.runtime.evalTimeoutNotice(decision.threadKey))
  if (lastNoticeAt && now - Date.parse(lastNoticeAt) < TIMEOUT_NOTICE_COOLDOWN_MS) return false
  if (decision.triggerIds.some(id => (store.get(KV.runtime.evalTimeoutRecovery(id))?.attempts ?? 0) > 0)) return false
  const triggers = decision.triggerIds.flatMap(id => {
    const trigger = store.triggers.get(id)
    return trigger ? [trigger] : []
  })
  const notices = evalTimeoutNotices(decision, triggers)
  if (!notices.length) return false
  store.set(KV.runtime.evalTimeoutNotice(decision.threadKey), new Date(now).toISOString())
  for (const message of notices) outbox.send(message)
  return true
}

/** Sends a lightweight one-time Feishu notice when an explicit evaluation has waited past `EVAL_QUEUE_NOTICE_DELAY_MS`. */
export function notifySlowEvals(options: {
  store: Pick<Store, 'threads' | 'triggers' | 'receipts'>
  outbox: Pick<Outbox, 'send'>
  paused: boolean
  now?: number
  delayMs?: number
}): number {
  if (options.paused) return 0
  const { store, outbox } = options
  const now = options.now ?? Date.now()
  const delayMs = options.delayMs ?? EVAL_QUEUE_NOTICE_DELAY_MS
  let sent = 0
  for (const thread of store.threads.active()) {
    const evalState = thread.evaluating
    if (!evalState || evalState.strength !== 'explicit' || evalState.pausedAt) continue
    const startedMs = Date.parse(evalState.startedAt)
    if (!Number.isFinite(startedMs) || now - startedMs < delayMs) continue
    const trigger = evalState.triggerIds.map(id => store.triggers.get(id)).find(item => item?.channel?.source === 'feishu')
    if (!trigger?.channel) continue
    const id = key('eval-queue', evalState.id, JSON.stringify(trigger.channel.address))
    if (store.receipts.get(id)) continue
    const chinese = /\p{Script=Han}/u.test(trigger.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trigger.text)
    const text = chinese
      ? '已收到请求，主调度正在排队评估中，请稍候。'
      : 'Request received; queued for orchestrator evaluation, please wait.'
    outbox.send({ id, channel: trigger.channel, text, kind: 'notice' })
    sent++
  }
  return sent
}
