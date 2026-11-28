/** Per-ticket Feishu topic 1-to-1 binding: prevents cross-topic replies and auto-creates a dedicated topic when none exists. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { receive, threadRef } from '../src/sources/feishu-loops.ts'
import { sourceContext } from '../src/sources/host.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

const larkCalls = () => vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)

it('binds a fresh top-level Feishu ticket to its own root message without creating an extra root message', async () => {
  const first = await h.acceptedTicket(feishu('1', '@bot 修复登录'))
  await h.runtime.sendReplies()
  const calls = larkCalls()
  expect(calls.filter(args => args.includes('+messages-send'))).toHaveLength(0)
  expect(calls.find(args => args.includes('+messages-reply'))).toEqual(expect.arrayContaining(['--message-id', 'om_1', '--reply-in-thread']))
  expect(h.runtime.store.get(KV.feishu.topic(first.ticket.id))).toMatchObject({ ticketId: first.ticket.id, chatId: CHAT, messageId: 'om_1' })
  expect(h.runtime.store.get(KV.feishu.topicRoot('om_1'))).toMatchObject({ ticketId: first.ticket.id, chatId: CHAT, messageId: 'om_1' })

  // A follow-up inside the ticket's own topic still quote-replies to the follow-up message in the same topic.
  vi.mocked(Commands.prototype.lark).mockClear()
  const follow = feishu('2', '顺便看下日志', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(follow); await h.runtime.idle()
  h.runtime.outbox.send({ id: 'ans-own', channel: follow.channel!, text: '好的，一起看。', kind: 'reply', ticketId: first.ticket.id })
  await h.runtime.sendReplies()
  expect(larkCalls().filter(args => args.includes('+messages-send'))).toHaveLength(0)
  expect(larkCalls().find(args => args.includes('+messages-reply'))).toEqual(expect.arrayContaining(['--message-id', 'om_2', '--reply-in-thread']))
})

it('auto-creates and binds a dedicated Feishu topic when a new ticket starts inside another ticket\'s topic (prevents mixup)', async () => {
  // Ticket A owns topic om_1 (like worker-db771db7).
  const first = await h.acceptedTicket(feishu('1', '@bot 新建本地编译启动脚本'))
  await h.runtime.sendReplies()
  await h.runTool(first.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'done' })
  await h.runtime.idle()

  // User sends a new request inside Ticket A's topic om_1; Orchestrator accepts Ticket B (like worker-fea109dd).
  vi.mocked(Commands.prototype.lark).mockClear()
  const secondTrigger = feishu('2', '@bot 修复肉鸽蘑菇攻速', { root_id: 'om_1', thread_id: 'omt_first' })
  const second = await h.acceptedTicket(secondTrigger)
  await h.runtime.sendReplies()

  // Ticket B MUST auto-create its own topic via +messages-send and reply there, NEVER into om_1 / om_2.
  const calls = larkCalls()
  const sendCall = calls.find(args => args.includes('+messages-send'))
  expect(sendCall).toEqual(expect.arrayContaining(['--chat-id', CHAT]))
  const replyCall = calls.find(args => args.includes('+messages-reply'))
  expect(replyCall).toEqual(expect.arrayContaining(['--message-id', 'om_topic_1', '--reply-in-thread']))
  expect(replyCall).not.toContain('om_1')
  expect(replyCall).not.toContain('om_2')

  // Persistent 1-to-1 binding, dedicated thread subscription, threadRef for polling, and updated ticket.channels.
  expect(h.runtime.store.get(KV.feishu.topic(second.ticket.id))).toMatchObject({ ticketId: second.ticket.id, chatId: CHAT, messageId: 'om_topic_1' })
  expect(h.runtime.store.get(KV.feishu.topicRoot('om_topic_1'))).toMatchObject({ ticketId: second.ticket.id, chatId: CHAT, messageId: 'om_topic_1' })
  const dedicatedThread = h.runtime.store.threads.get(`feishu:${CHAT}:om_topic_1`)!
  expect(dedicatedThread.subscriptions).toEqual([second.ticket.id])
  expect(threadRef(sourceContext(h.runtime, feishuKind), dedicatedThread)).toMatchObject({ chatId: CHAT, messageId: 'om_topic_1' })
  expect(h.runtime.store.tickets.get(second.ticket.id)!.channels).toEqual([
    expect.objectContaining({ source: 'feishu', address: expect.objectContaining({ chatId: CHAT, messageId: 'om_topic_1' }) }),
  ])

  // Subsequent replies for Ticket B reuse om_topic_1 without creating another root message, even if channel points at om_2.
  vi.mocked(Commands.prototype.lark).mockClear()
  h.runtime.outbox.send({ id: 'b-result', channel: secondTrigger.channel!, text: '已修复完成。', kind: 'reply', ticketId: second.ticket.id })
  await h.runtime.sendReplies()
  expect(larkCalls().filter(args => args.includes('+messages-send'))).toHaveLength(0)
  expect(larkCalls().find(args => args.includes('+messages-reply'))).toEqual(expect.arrayContaining(['--message-id', 'om_topic_1', '--reply-in-thread']))

  // Replies inside Ticket B's new topic route ONLY to Ticket B.
  const followInB = feishu('3', '再补一组测试', { mentions: [], root_id: 'om_topic_1', parent_id: 'om_topic_1' })
  await receive(sourceContext(h.runtime, feishuKind), followInB); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(second.ticket.id)!.inputs.some(i => i.kind === 'trigger' && i.triggerId === followInB.id)).toBe(true)
  expect(h.runtime.store.tickets.get(first.ticket.id)!.inputs.some(i => i.kind === 'trigger' && i.triggerId === followInB.id)).toBe(false)

  // Unaddressed messages inside Ticket A's topic om_1 do NOT cross-talk into Ticket B.
  const msgInA = feishu('4', '在旧话题里说一句', { mentions: [], root_id: 'om_1' })
  await receive(sourceContext(h.runtime, feishuKind), msgInA); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(second.ticket.id)!.inputs.some(i => i.kind === 'trigger' && i.triggerId === msgInA.id)).toBe(false)
})

it('detects legacy thread ownership when KV.feishu.topicRoot is absent and still creates a new topic for the second ticket', async () => {
  const first = await h.acceptedTicket(feishu('10', '@bot 历史工单'))
  await h.runtime.sendReplies()
  // Simulate pre-fix state where KV.feishu.topic / topicRoot did not exist yet.
  h.runtime.store.delete(KV.feishu.topic(first.ticket.id))
  h.runtime.store.delete(KV.feishu.topicRoot('om_10'))

  vi.mocked(Commands.prototype.lark).mockClear()
  await h.runTool(first.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'done' })
  await h.runtime.idle()
  const second = await h.acceptedTicket(feishu('11', '@bot 第二个工单', { root_id: 'om_10' }))
  await h.runtime.sendReplies()

  expect(larkCalls().filter(args => args.includes('+messages-send'))).toHaveLength(1)
  expect(larkCalls().find(args => args.includes('+messages-reply'))).toEqual(expect.arrayContaining(['--message-id', 'om_topic_1', '--reply-in-thread']))
  expect(h.runtime.store.get(KV.feishu.topic(second.ticket.id))).toMatchObject({ ticketId: second.ticket.id, messageId: 'om_topic_1' })
})

it('auto-creates and binds a topic on first reply when a ticket\'s Feishu channel has no topic yet (delivery=chat)', async () => {
  const first = await h.acceptedTicket(feishu('20', '@bot 聊天触发'))
  await h.runtime.sendReplies()
  // Clear binding to simulate a ticket with a chat-only Feishu channel and no topic created yet.
  h.runtime.store.delete(KV.feishu.topic(first.ticket.id))
  h.runtime.store.delete(KV.feishu.topicRoot('om_20'))
  vi.mocked(Commands.prototype.lark).mockClear()

  h.runtime.outbox.send({
    id: 'chat-only-reply',
    channel: { source: 'feishu', thread: `feishu:${CHAT}`, address: { chatId: CHAT, delivery: 'chat' } },
    text: '首次自动创建话题并回复。',
    kind: 'reply',
    ticketId: first.ticket.id,
  })
  await h.runtime.sendReplies()

  expect(larkCalls().filter(args => args.includes('+messages-send'))).toHaveLength(1)
  expect(larkCalls().find(args => args.includes('+messages-reply'))).toEqual(expect.arrayContaining(['--message-id', 'om_topic_1', '--reply-in-thread']))
  expect(h.runtime.store.get(KV.feishu.topic(first.ticket.id))).toMatchObject({ ticketId: first.ticket.id, chatId: CHAT, messageId: 'om_topic_1' })
})
