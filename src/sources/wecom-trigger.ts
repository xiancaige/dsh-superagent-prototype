/** Normalizes WeCom intelligent-bot callbacks into domain Triggers, and derives the chat, topic and reply addresses they use. */
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { WecomMessage } from './wecom-protocol.ts'

export const SOURCE = 'wecom'
/** WeCom sends times in epoch seconds; `create_time` is absent when the server omits it. */
const at = (seconds: number | undefined): string => new Date((seconds ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
/** WeCom has no thread or topic object: a group is a chat, and a direct chat is keyed by its sender. */
export const wecomThreadId = (chatId: string): string => chatId
/** A chat id as the rest of dsh-superagent names it: a direct message carries no `chatid`, so its chat is the sender. */
export const wecomChat = (message: Pick<WecomMessage, 'chatid' | 'chattype' | 'from'>): string =>
  message.chattype === 'group' ? message.chatid ?? '' : `single:${message.from.userid}`
/** Whether a chat id names a direct chat, which is keyed by its sender rather than by a `chatid`. */
export const wecomDirect = (chatId: string): boolean => chatId.startsWith('single:')
/** Deterministic trigger ID for one callback; WeCom may push the same `msgid` again, and the Engine stores it once. */
export const wecomTriggerId = (msgid: string): string => key('wecom', msgid)
/**
 * Replies address one callback through its `req_id` (`respond`), quoting the message they answer; `push` is the long
 * connection's message for a chat, which needs no callback and is the only way to answer once the reply window closed.
 */
export const wecomChannel = (chatId: string, messageId: string, direct = false, delivery: 'respond' | 'push' = 'respond'): ChannelRef =>
  ({ source: SOURCE, thread: `wecom:${chatId}`, address: { chatId, messageId, delivery, ...direct ? { direct: 'true' } : {} } })
/** The text of one callback: what the person typed, the speech WeCom transcribed, or a placeholder for media it carries. */
export function wecomText(message: WecomMessage): string {
  const items = message.mixed?.msg_item ?? []
  // A mixed message keeps its parts in order, so a reply to a text-and-image message reads as the person saw it.
  if (items.length) return items.map(item => item.msgtype === 'text' ? item.text?.content ?? '' : '[图片]').filter(Boolean).join('\n')
  if (message.msgtype === 'text') return message.text?.content ?? ''
  if (message.msgtype === 'voice') return message.voice?.content ?? ''
  return { image: '[图片]', file: '[文件]', video: '[视频]' }[message.msgtype] ?? `[${message.msgtype}]`
}
/** A quote names the message a person answered; it is context only, and never an address to reply to. */
export function wecomQuoteText(message: WecomMessage): string | undefined {
  const quote = message.quote
  if (!quote) return undefined
  const text = quote.text?.content ?? quote.mixed?.msg_item.map(item => item.msgtype === 'text' ? item.text?.content ?? '' : '[图片]').join('\n')
  return text ? `> ${text.slice(0, 500)}` : `>[${quote.msgtype}]`
}
/**
 * The ticket a quote points at: a reply this Source sent carries `工单 #<id>` in its card title and source line, so a
 * person quoting that reply names that ticket even though WeCom has no thread object. Read here and handed to the core,
 * which lets a quoted question reach its own ticket while a plain message always asks for new work.
 */
export function wecomQuotedTicket(message: WecomMessage): string | undefined {
  const quoted = wecomQuoteText(message)
  if (!quoted) return undefined
  return /工单\s*#([0-9a-fA-F]{4,32})/.exec(quoted)?.[1]?.toLowerCase()
}
/**
 * Converts one callback into a Trigger. Callbacks reach dsh-superagent for people only, so the sender is `human`; a direct
 * message always addresses the bot, whereas a group message reaches it only when someone mentions it. A message with no
 * readable text (a bare file, for instance) still arrives, as its placeholder, so the person is answered rather than ignored.
 */
export function wecomTrigger(message: WecomMessage): Trigger | undefined {
  if (!message.msgid || !message.from) return undefined
  const direct = message.chattype === 'single'
  const chatId = wecomChat(message)
  if (!chatId) return undefined
  const text = wecomText(message)
  if (!text) return undefined
  const quote = wecomQuoteText(message)
  const quotedTicket = wecomQuotedTicket(message)
  return { id: wecomTriggerId(message.msgid), source: SOURCE, threads: [{ source: SOURCE, id: wecomThreadId(chatId) }],
    actor: { source: SOURCE, id: message.from.userid || chatId }, human: true,
    // A quote that names a ticket carries only that address: its body is an older reply, which would otherwise bury
    // what the person is saying now. Any other quote stays as context ahead of the message.
    addressed: direct ? 'direct' : 'mention', at: at(message.create_time), text: quote && !quotedTicket ? `${quote}\n${text}` : text,
    channel: wecomChannel(chatId, message.msgid, direct),
    meta: { chatId, messageId: message.msgid, direct, chattype: message.chattype, msgtype: message.msgtype,
      ...(quotedTicket ? { quotedTicket } : {}) } }
}
