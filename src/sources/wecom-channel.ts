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
/** Tells a reader where the rest of a shortened message is. */
const SHORTENED = '…（全文见本地面板）'
/**
 * Trims a message to what WeCom renders. A reply or notice is shortened with an ellipsis and a pointer to the panel, because
 * a person must still be told what happened; an acknowledgement over the limit is refused instead, so the main Session
 * writes a shorter one, as on Feishu. Both are checked for the 100-word limit first, which asks for a summary, not a cut.
 */
function markdown(text: string): string {
  const checked = checkedImText(text)
  const limit = WECOM_MARKDOWN_BYTES - Buffer.byteLength(SHORTENED, 'utf8')
  if (Buffer.byteLength(checked, 'utf8') <= WECOM_MARKDOWN_BYTES) return checked
  let out = checked
  while (Buffer.byteLength(out, 'utf8') > limit) out = out.slice(0, Math.floor(out.length * 0.9))
  return `${out}${SHORTENED}`
}
/**
 * Posts one message to its chat. A reply goes through the callback's `req_id` while the connection holds it (WeCom keeps one
 * for 48 hours); after that window, and for a message meant for a chat rather than an answer, it goes through the chat's
 * push, which needs no callback. `message.id` names one reply, so a retried send reuses its `req_id` instead of posting twice.
 * @returns `gone` when the chat can never accept the message, such as a push WeCom refuses outright.
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
  if (frame) {
    const client = sender.client()
    if (client) {
      const reqId = (messageId && sender.reqId(messageId)) || frame.headers.req_id
      try {
        await ack(client.reply({ ...frame, headers: { ...frame.headers, req_id: reqId } }, { msgtype: 'markdown', markdown: { content } }))
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
  try {
    await ack(client.sendMessage(sender.pushTarget(chatId), { msgtype: 'markdown', markdown: { content } }))
  } catch (error) {
    // WeCom refuses a push to a chat it no longer has or that never wrote to the bot; that is permanent for this message.
    if (error instanceof WecomApiError && pushRefused(error.code)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Codes a push answers with when the chat cannot take it at all: no such chat, or the bot was never written to there. */
const pushRefused = (code: number): boolean => code === 86003 || code === 93000 || code === 93004 || code === 40058
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
