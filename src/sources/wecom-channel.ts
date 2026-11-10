/** The WeCom Channel: answers the callback a message came from, falls back to the chat's push, and builds chat links. */
import type { OutboundMessage } from '../core/index.ts'
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
 * Trims a message to what a WeCom card renders. The 100-word ceiling is applied upstream, where a long reply becomes a
 * summary plus a file path; this only bounds the bytes WeCom accepts, shortening with a pointer to the panel.
 */
function markdown(text: string): string {
  const limit = WECOM_MARKDOWN_BYTES - Buffer.byteLength(SHORTENED, 'utf8')
  if (Buffer.byteLength(text, 'utf8') <= WECOM_MARKDOWN_BYTES) return text
  let out = text
  while (Buffer.byteLength(out, 'utf8') > limit) out = out.slice(0, Math.floor(out.length * 0.9))
  return `${out}${SHORTENED}`
}
/**
 * The ticket tag a person can quote to address that ticket again. WeCom has no thread or topic object, and its `quote`
 * carries text only, so the tag travels as text inside both the card title and its source line: a quote that contains
 * it names the ticket exactly, which is the only way a chat can address one of its earlier tickets.
 */
export const wecomTicketTag = (ticketId: string | undefined): string => (ticketId ? `工单 #${ticketId.slice(0, 8)}` : '')

/** One reply as a `text_notice` template card; without a ticket it is a plain card with the bot's name. */
export function wecomTicketCard(text: string, ticketId: string | undefined): Record<string, unknown> {
  const tag = wecomTicketTag(ticketId)
  return {
    card_type: 'text_notice',
    main_title: { title: tag ? `${tag} 更新` : '超级智能体' },
    sub_title_text: text.trim().slice(0, WECOM_MARKDOWN_BYTES),
    ...(tag ? { source: { desc: tag, desc_color: 1 } } : {}),
  }
}

/** The reply as plain markdown carrying the same tag, for a client that refuses the card or a test that reads text. */
export function wecomTicketMarkdown(text: string, ticketId: string | undefined): string {
  const tag = wecomTicketTag(ticketId)
  return tag ? `${text}\n\n> ${tag}` : text
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
  // The card is what a person sees; the markdown body is the same reply for a client that refuses it.
  // The reply is markdown text carrying `> 工单 #<id>`, which is what a person's quote returns; a template card was
  // tried and refused by this bot, and text keeps the tag in the one field WeCom gives back for a quote.
  const content = markdown(wecomTicketMarkdown(message.text, message.ticketId))
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
