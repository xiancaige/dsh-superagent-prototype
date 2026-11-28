/** Regression and contract tests for Feishu-Orchestrator-Worker interaction optimizations (from c4c8307a). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifySlowEvals } from '../src/app/eval-recovery.ts'
import { parseFastStatusQuery } from '../src/app/feishu-commands.ts'
import { consecutiveModelFailures, FOLLOWUP_UNCONSUMED_STALLED_MS, isTicketStalledForFollowup, ticketFailedNotices } from '../src/app/notices.ts'
import { collectProgressSnapshot, formatProgressSyncMessage, progressFingerprint } from '../src/app/progress-sync.ts'
import { allowlistHealth } from '../src/app/views/overview.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { receive } from '../src/sources/feishu-loops.ts'
import { extractFeishuPostText, feishuTrigger, historyText } from '../src/sources/feishu-trigger.ts'
import { sourceContext } from '../src/sources/host.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => {
  vi.useRealTimers()
  await h?.stop()
  h = undefined
})

describe('Item 1: blocked ticket stalled detection and unconsumed human follow-up', () => {
  it('flags blocked tickets as stalled while waiting for person, clears on fresh human input, and re-flags once unconsumed past threshold', async () => {
    h = await startRuntime()
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修复登录问题'))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: '请选择方案 A 或 B' })
    const blocked = h.runtime.store.tickets.get(ticket.id)!
    expect(isTicketStalledForFollowup(blocked)).toBe(true)

    // Immediately after a human follow-up arrives, the worker gets a window to consume it.
    const follow = feishu('2', 'A', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(follow)
    const afterInput = h.runtime.store.tickets.get(ticket.id)!
    const inputAt = Date.parse(afterInput.inputs.at(-1)!.at)
    expect(isTicketStalledForFollowup(afterInput, inputAt + 10_000)).toBe(false)
    // Once the human follow-up sits unconsumed past FOLLOWUP_UNCONSUMED_STALLED_MS, stalled flips back to true.
    expect(isTicketStalledForFollowup(afterInput, inputAt + FOLLOWUP_UNCONSUMED_STALLED_MS + 1000)).toBe(true)
  })
})

describe('Items 2 & 3: Feishu parent_id/topic quotedTicket unicast routing and ended-ticket resume', () => {
  it('records outbound Feishu message_id -> ticketId, unicasts quote-replies, and resumes non-human-stopped ended tickets', async () => {
    h = await startRuntime()
    let replySeq = 0
    vi.mocked(Commands.prototype.lark).mockImplementation(async (args: readonly string[]) => {
      if (args.includes('+messages-reply')) return { message_id: `om_bot_reply_${++replySeq}`, chat_id: CHAT }
      if (args.includes('+messages-send')) return { message_id: 'om_topic_new', chat_id: CHAT }
      return {}
    })

    const first = await h.acceptedTicket(feishu('10', '@bot 任务一'))
    await h.runtime.sendReplies()
    expect(h.runtime.store.get(KV.feishu.messageTicket('om_bot_reply_1'))).toBe(first.ticket.id)

    // Create a second live ticket subscribed to the same legacy thread to verify unicast prevents fanout.
    const second = await h.acceptedTicket(feishu('11', '@bot 任务二'))
    const thread = h.runtime.store.threads.get(`feishu:${CHAT}:om_10`)!
    thread.subscriptions = [first.ticket.id, second.ticket.id]
    h.runtime.store.threads.save(thread)

    // Quote-replying to first's bot reply unicasts ONLY to first, not second.
    const ctx = sourceContext(h.runtime, feishuKind)
    const quoteReply = feishu('12', 'A', { mentions: [], root_id: 'om_10', parent_id: 'om_bot_reply_1' })
    await receive(ctx, quoteReply)
    await h.runtime.idle()
    const disp = h.runtime.store.triggers.disposition(quoteReply.id)!
    expect(disp.fanout).toEqual([first.ticket.id])

    // End first cleanly (executor completed/dropped) and send a short reply quoting its bot message -> resumes automatically!
    await h.runTool(first.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'done' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(first.ticket.id)!.ended?.by).toBe('executor')

    const resumeReply = feishu('13', '放到项目根目录下', { mentions: [], root_id: 'om_10', parent_id: 'om_bot_reply_1' })
    await receive(ctx, resumeReply)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(first.ticket.id)!.ended).toBeUndefined()

    // Human-stopped ticket MUST NOT auto-resume even when quote-replied.
    h.runtime.engine.stopTicket(first.ticket.id, '人手停止')
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(first.ticket.id)!.ended?.by).toBe('human')

    const afterStop = feishu('14', '继续处理', { mentions: [], root_id: 'om_10', parent_id: 'om_bot_reply_1' })
    await receive(ctx, afterStop)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(first.ticket.id)!.ended?.by).toBe('human')
  })
})

describe('Item 4: deterministic Feishu fast-path for status queries and slow-eval queued notice', () => {
  it('parses short status queries accurately and rejects substantive work requests', () => {
    expect(parseFastStatusQuery('进度')).toEqual({})
    expect(parseFastStatusQuery('状态？')).toEqual({})
    expect(parseFastStatusQuery('结束成功了吗?')).toEqual({})
    expect(parseFastStatusQuery('进度 82963adc')).toEqual({ target: '82963adc' })
    expect(parseFastStatusQuery('82963adc 状态怎么样')).toEqual({ target: '82963adc' })
    expect(parseFastStatusQuery('进度不对，帮我改成30秒')).toBeUndefined()
    expect(parseFastStatusQuery('继续开单修复')).toBeUndefined()
  })

  it('answers Feishu status queries deterministically via fast-path without entering Eval', async () => {
    h = await startRuntime()
    const { ticket } = await h.acceptedTicket(feishu('20', '@bot 编译验证'))
    await h.runtime.sendReplies()
    vi.mocked(Commands.prototype.lark).mockClear()

    const ctx = sourceContext(h.runtime, feishuKind)
    const probe = feishu('21', '@bot 进度', { root_id: 'om_20' })
    await receive(ctx, probe)
    await h.runtime.sendReplies()

    // Handled by FeishuCommands fast-path: trigger was never stored in Intake/Eval, and a reply was sent.
    expect(h.runtime.store.triggers.get(probe.id)).toBeUndefined()
    const replyArgs = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args).find(args => args.includes('+messages-reply'))
    expect(replyArgs).toBeDefined()
    const markdown = replyArgs![replyArgs!.indexOf('--markdown') + 1]
    expect(markdown).toContain(ticket.id.slice(0, 8))
  })

  it('sends a single lightweight Feishu queued notice when an explicit evaluation waits past threshold', async () => {
    h = await startRuntime()
    const trigger = feishu('30', '@bot 分析打包问题')
    h.runtime.receive(trigger)
    const threadKeyStr = `feishu:${CHAT}:om_30`
    const thread = h.runtime.store.threads.get(threadKeyStr)!
    expect(thread.evaluating).toBeDefined()
    const startedMs = Date.parse(thread.evaluating!.startedAt)

    // Before 25s -> no notice
    expect(notifySlowEvals({ store: h.runtime.store, outbox: h.runtime.outbox, paused: false, now: startedMs + 10_000 })).toBe(0)
    // While paused -> no notice
    expect(notifySlowEvals({ store: h.runtime.store, outbox: h.runtime.outbox, paused: true, now: startedMs + 30_000 })).toBe(0)
    // Past 25s -> sends once, deduplicated on subsequent calls
    expect(notifySlowEvals({ store: h.runtime.store, outbox: h.runtime.outbox, paused: false, now: startedMs + 30_000 })).toBe(1)
    expect(notifySlowEvals({ store: h.runtime.store, outbox: h.runtime.outbox, paused: false, now: startedMs + 45_000 })).toBe(0)
  })
})

describe('Item 5: progress-sync todo_write extraction and unchanged-state backoff', () => {
  it('extracts todo_write completed/total and in_progress item and formats concise milestone text', () => {
    const startedMs = Date.parse('2026-11-28T00:00:00.000Z')
    const snapshot = collectProgressSnapshot({
      ticket: { id: 'abcdef123456', title: '优化飞书交互', assignments: [], inputs: [], undelivered: [], channels: [] } as never,
      assignment: { id: 'a1', state: 'running', createdAt: '2026-11-28T00:00:00.000Z', startedAt: '2026-11-28T00:00:00.000Z' },
      events: [
        {
          type: 'tool/call',
          time: startedMs + 10_000,
          data: {
            callId: 'c1',
            name: 'todo_write',
            arguments: JSON.stringify({
              todos: [
                { content: '定位问题', status: 'completed' },
                { content: '修改核心路由', status: 'completed' },
                { content: '补充单元测试', status: 'in_progress' },
                { content: '构建并重启验证', status: 'pending' },
              ],
            }),
          },
        } as never,
      ],
      jobs: [],
      subagentsCount: 0,
      startedMs,
      sinceMs: startedMs,
      nowMs: startedMs + 600_000,
      chinese: true,
    })
    expect(snapshot.todo).toEqual({ completed: 2, total: 4, current: '补充单元测试' })
    const message = formatProgressSyncMessage({ id: 'abcdef123456', title: '优化飞书交互' }, snapshot, true)
    expect(message).toContain('进度 2/4（进行中：补充单元测试）')
    expect(progressFingerprint(snapshot)).toContain('补充单元测试')
  })

  it('backs off progress sync interval (1x -> 2x -> 3x) when state fingerprint is unchanged', async () => {
    h = await startRuntime()
    const { ticket } = await h.acceptedTicket(feishu('40', '@bot 长任务打包'))
    const startedMs = Date.parse(h.runtime.store.tickets.get(ticket.id)!.assignments[0]!.startedAt!)
    vi.mocked(Commands.prototype.lark).mockClear()

    // 1st sync at +10m (600s) -> sent (streak becomes 0 -> next wait 1x = 10m)
    await h.runtime.progressSync.tick(startedMs + 600_000)
    await h.runtime.sendReplies()
    expect(h.runtime.store.get(KV.feishu.progressSync(ticket.id))?.syncCount).toBe(1)

    // 2nd sync at +20m (1200s) with identical state -> sent, streak becomes 1 -> next wait 2x = 20m
    await h.runtime.progressSync.tick(startedMs + 1_200_000)
    await h.runtime.sendReplies()
    const afterSecond = h.runtime.store.get(KV.feishu.progressSync(ticket.id))!
    expect(afterSecond.syncCount).toBe(2)
    expect(afterSecond.unchangedStreak).toBe(1)

    // At +30m (only +10m since 2nd sync) -> skipped due to 2x (20m) backoff!
    await h.runtime.progressSync.tick(startedMs + 1_800_000)
    expect(h.runtime.store.get(KV.feishu.progressSync(ticket.id))?.syncCount).toBe(2)

    // At +40m (+20m since 2nd sync) -> sent, streak becomes 2 -> next wait 3x = 30m
    await h.runtime.progressSync.tick(startedMs + 2_400_000)
    await h.runtime.sendReplies()
    const afterThird = h.runtime.store.get(KV.feishu.progressSync(ticket.id))!
    expect(afterThird.syncCount).toBe(3)
    expect(afterThird.unchangedStreak).toBe(2)
  })
})

describe('Item 6: Feishu post rich-text extraction, consecutive model failure detection, and allowlist health', () => {
  it('extracts plain text from localized and unwrapped Feishu post JSON without leaking JSON', () => {
    const localized = {
      zh_cn: {
        title: '发布检查',
        content: [
          [{ tag: 'text', text: '请检查 ' }, { tag: 'a', text: '构建日志', href: 'https://example.com/log' }],
          [{ tag: 'at', user_name: 'Win001' }, { tag: 'text', text: ' 确认结果' }],
        ],
      },
    }
    expect(extractFeishuPostText(localized)).toBe('发布检查\n请检查 构建日志 (https://example.com/log)\n@Win001 确认结果')

    const unwrapped = {
      title: '',
      content: [[{ tag: 'text', text: '第一行' }], [{ tag: 'md', text: '**第二行**' }]],
    }
    expect(historyText({
      message_id: 'om_p1', chat_id: CHAT, create_time: '1700000000000',
      sender: { id: 'ou_1', sender_type: 'user' },
      body: { content: JSON.stringify(unwrapped) },
    })).toBe('第一行\n**第二行**')

    const trig = feishuTrigger({
      message_id: 'om_p2', chat_id: CHAT, chat_type: 'p2p', sender_id: 'ou_1', sender_type: 'user',
      content: JSON.stringify(localized), create_time: '1700000000000', mentions: [],
    }, 'bot', 'app')
    expect(trig?.text).toBe('发布检查\n请检查 构建日志 (https://example.com/log)\n@Win001 确认结果')
  })

  it('counts consecutive model failures and includes model switch hint on repeated failures', () => {
    const ticket = {
      id: 'e67905d60000', title: '测试模型失败', channels: [{ source: 'feishu', thread: `feishu:${CHAT}`, address: { chatId: CHAT, messageId: 'om_1' } }],
      assignments: [
        { id: 'a1', state: 'ended', createdAt: '2026-11-28T00:00:00.000Z', modelFailure: { at: '2026-11-28T00:01:00.000Z', error: 'LlmError', hostResumeBudget: 0 } },
        { id: 'a2', state: 'ended', createdAt: '2026-11-28T00:02:00.000Z', modelFailure: { at: '2026-11-28T00:03:00.000Z', error: 'LlmError', hostResumeBudget: 0 } },
      ],
    } as never
    expect(consecutiveModelFailures(ticket)).toBe(2)
    const notices = ticketFailedNotices(ticket, '测试模型失败', 'Model turn failed; host automatic resume budget 0. LlmError', { assignmentId: 'a2', modelSwitchHint: true })
    expect(notices[0]!.text).toContain('/model')
  })

  it('surfaces error health when a historical operator is blocked by not_a_member and clears when restored', async () => {
    h = await startRuntime()
    await h.acceptedTicket(feishu('50', '@bot 历史工单'))
    expect(allowlistHealth(h.runtime.store).state).toBe('ready')

    // Remove the historical operator from the Feishu allowlist.
    const settings = h.runtime.store.settings()
    const origAllowed = settings.policy.sources.feishu!.allowed
    h.runtime.store.saveSettings({
      ...settings,
      policy: {
        ...settings.policy,
        sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu!, allowed: [] } },
      },
    })

    // The historical operator sends a new request -> ignored with not_a_member.
    h.runtime.receive(feishu('51', '@bot 再次请求'))
    await h.runtime.idle()
    const alert = allowlistHealth(h.runtime.store)
    expect(alert.state).toBe('error')
    expect(alert.detail).toContain('not_a_member')

    // Restoring the operator clears the alert immediately.
    const updated = h.runtime.store.settings()
    h.runtime.store.saveSettings({
      ...updated,
      policy: {
        ...updated.policy,
        sources: { ...updated.policy.sources, feishu: { ...updated.policy.sources.feishu!, allowed: origAllowed } },
      },
    })
    expect(allowlistHealth(h.runtime.store).state).toBe('ready')
  })
})
