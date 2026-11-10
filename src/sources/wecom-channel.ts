/** The WeCom Channel: answers the callback a message came from, falls back to the chat's push, and builds chat links. */
import type { OutboundMessage } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import { wecomSender } from './wecom-connection.ts'
import { WecomApiError, WECOM_COMMANDS, wecomAck, type WecomSdkFrame } from './wecom-protocol.ts'
import { wecomTriggerId } from './wecom-trigger.ts'
import type { ChannelLink } from './kind.ts'

/** Codes that say the callback's reply can never be delivered, so the chat's push is the only way left (doc 101463). */
const gone = (error: unknown): boolean => error instanceof WecomApiError && (error.code === 846608 || error.code === 93006)
/** WeCom renders at most 4096 bytes of a markdown message, so the text is bounded in bytes as well as in words. */
export const WECOM_MARKDOWN_BYTES = 4096
function markdown(text: string): string {
  const checked = checkedImText(text)
  let out = checked
  // An ellipsis marks a shortened message rather than letting WeCom refuse or cut it silently.
  while (Buffer.byteLength(out, 'utf8') > WECOM_MARKDOWN_BYTES) out = out.slice(0, Math.floor(out.length * 0.9))
  return out === checked ? out : `${out.slice(0, -1)}…`
}
/**
 * Posts one message to its chat. A reply goes through the callback's `req_id` while the connection holds it (WeCom keeps one
 * for 48 hours); after that window, and for a message meant for a chat rather than an answer, it goes through the chat's
 * push, which needs no callback. `message.id` names one reply, so a retried send reuses its `req_id` instead of posting twice.
 * @throws when delivery failed but may succeed on a later retry.
 */
export async function sendWecom(_host: unknown, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const sender = wecomSender()
  if (!sender) throw new Error('The WeCom long connection is not running')
  const { chatId, messageId, delivery } = message.channel.address
  if (!chatId) throw new Error('Missing WeCom chat target')
  const frame = delivery === 'respond' && messageId ? sender.frame(messageId) : undefined
  // Markdown is what a WeCom answer renders; the same body answers the callback and, after its window, the chat's push.
  const content = markdown(message.text)
  const body = { msgtype: 'markdown' as const, markdown: { content } }
  if (frame) {
    const client = sender.client()
    if (client) {
      const reqId = (messageId && sender.reqId(messageId)) || frame.headers.req_id
      try {
        await ack(client.reply({ ...frame, headers: { ...frame.headers, req_id: reqId } }, body))
        return 'sent'
      } catch (error) {
        // Only an expired window or an unknown req_id rules the reply out; anything else may pass on a retry.
        if (!gone(error)) throw error
      }
    }
  }
  const client = sender.client()
  // A reconnect in progress is not a reason to call the destination gone: the next attempt pushes instead.
  if (!client) throw new Error('The WeCom long connection is reconnecting')
  if (messageId) sender.openRoot(chatId, messageId)
  await ack(client.sendMessage(sender.pushTarget(chatId), { msgtype: 'markdown', markdown: { content } }))
  return 'sent'
}
/** Applies the answer's `errcode`, which the client resolves instead of rejecting for a refused command. */
async function ack(answer: Promise<WecomSdkFrame | undefined>): Promise<void> { wecomAck(await answer) }
/**
 * A chat's link: WeCom opens a conversation in its own client from the `wxwork://` scheme; a direct chat is named by its
 * sender and a group by its `chatid`.
 */
export const wecomLink = (address: Record<string, string>): ChannelLink => {
  const chatId = address.chatId ?? ''
  const target = chatId.startsWith('single:') ? chatId.slice('single:'.length) : chatId
  return { url: `wxwork://message?chatid=${encodeURIComponent(target)}`, label: { zh: '企业微信会话', en: 'WeCom chat' },
    ...address.messageId ? { triggerId: wecomTriggerId(address.messageId) } : {} }
}
