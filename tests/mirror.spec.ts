/** Feishu mirror of tickets that started on the local panel: root message, copied replies, and replies coming back. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { imSummary, wordCount, IM_WORDS } from '../src/infra/text.ts'
import { KV } from '../src/kv.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { receive } from '../src/sources/feishu-loops.ts'
import { sourceContext } from '../src/sources/host.ts'
import { localKind } from '../src/sources/local.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => {
  h = await startRuntime()
  // The fixture installs only the GitHub and Feishu kinds; local tickets need their own.
  h.runtime.sources.register(localKind(sourceContext(h.runtime, { kind: 'local', health: [] })))
})
afterEach(async () => { await h.stop() })

const OPERATOR = 'ou_alice'
/** A ticket accepted from the local panel, by the operator the Feishu Policy lists. */
async function localTicket() {
  const trigger: Trigger = { id: 'local:message:m1', source: 'local', threads: [{ source: 'local', id: 'topic-1' }], actor: { source: 'local', id: 'operator' },
    human: true, addressed: 'direct', at: new Date().toISOString(), text: '修一下登录页',
    channel: { source: 'local', thread: 'topic-1', address: { thread: 'topic-1' } }, meta: { messageId: 'm1' } }
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, local: { allowed: [{ id: 'operator' }], admission: {} } } },
    sources: { ...settings.sources, local: { enabled: true, config: {} } } })
  return h.acceptedTicket(trigger)
}
const sentTo = () => vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
function sends(response: Record<string, unknown> = { message_id: 'om_root', chat_id: 'oc_dm' }) {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  lark.mockImplementation(async args => (args.includes('+messages-send') ? response : {}) as never)
}

it('copies a reply of a local ticket into a Feishu topic of the operator\'s direct chat, made on first use', async () => {
  const { ticket } = await localTicket()
  sends()
  h.runtime.outbox.send({ id: 'asked', channel: ticket.channels[0]!, text: '要不要改注册页？', kind: 'reply', ticketId: ticket.id })
  await h.runtime.sendReplies(); await h.runtime.sendReplies()
  const calls = sentTo()
  expect(calls.find(args => args.includes('+messages-send'))).toEqual(expect.arrayContaining(['--user-id', OPERATOR]))
  expect(calls.find(args => args.includes('+messages-reply'))).toEqual(expect.arrayContaining(['--message-id', 'om_root', '要不要改注册页？']))
  expect(h.runtime.store.get(KV.feishu.mirrorRoot('om_root'))).toMatchObject({ ticketId: ticket.id, chatId: 'oc_dm', thread: { source: 'local', id: 'topic-1' } })
  // The panel's own copy is not held back by Feishu.
  expect(h.runtime.outbox.status('asked')).toBe('sent')
})

it('makes the topic once, and leaves a ticket that did not start on the local panel alone', async () => {
  const { ticket } = await localTicket()
  sends()
  for (const id of ['a', 'b']) h.runtime.outbox.send({ id, channel: ticket.channels[0]!, text: id, kind: 'reply', ticketId: ticket.id })
  await h.runtime.sendReplies(); await h.runtime.sendReplies()
  expect(sentTo().filter(args => args.includes('+messages-send'))).toHaveLength(1)
  expect(sentTo().filter(args => args.includes('+messages-reply'))).toHaveLength(2)
  const other = await h.acceptedTicket(feishu('9', '另一件事'))
  sends()
  h.runtime.outbox.send({ id: 'plain', channel: other.trigger.channel!, text: '好的', kind: 'reply', ticketId: other.ticket.id })
  await h.runtime.sendReplies()
  expect(sentTo().filter(args => args.includes('+messages-send'))).toHaveLength(0)
})

it('takes a person\'s reply in the topic as a message on the local ticket, and answers it back in the topic', async () => {
  const { ticket } = await localTicket()
  sends()
  h.runtime.outbox.send({ id: 'asked', channel: ticket.channels[0]!, text: '要不要改注册页？', kind: 'reply', ticketId: ticket.id })
  await h.runtime.sendReplies(); await h.runtime.sendReplies()
  const reply = feishu('7', '要', { chat_id: 'oc_dm', chat_type: 'p2p', mentions: [], root_id: 'om_root', parent_id: 'om_root' })
  await receive(sourceContext(h.runtime, feishuKind), reply); await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.inputs.some(input => input.kind === 'trigger' && input.triggerId === reply.id && input.human)).toBe(true)
  expect(h.runtime.store.triggers.get(reply.id)!.threads).toEqual([{ source: 'local', id: 'topic-1' }])
  expect(h.runtime.store.triggers.get(reply.id)!.channel).toMatchObject({ source: 'feishu', address: { chatId: 'oc_dm', messageId: 'om_7' } })
})

it('shortens a long copy to the IM limit and points at the panel', () => {
  const long = '修复'.repeat(300)
  const short = imSummary(long)
  expect(wordCount(short)).toBeLessThanOrEqual(IM_WORDS)
  expect(short).toContain('本地面板')
  expect(imSummary('好的')).toBe('好的')
})
