/** Normalizes Feishu live events, chat history items, and topic replies into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { FeishuMessage, FeishuRef } from './feishu-read.ts'
import { withFeishuFiles } from './feishu-content.ts'

export const SOURCE = 'feishu'
/** Constructs a Feishu reply channel address; records `direct` explicitly because both group and direct chat IDs start with `oc_`. */
export const feishuChannel = (chatId: string, messageId: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `feishu:${chatId}`, address: { chatId, messageId, ...direct ? { direct: 'true' } : {} } })
/** A message as the live event consumer prints it; the history and topic-page paths normalize what they read into this shape. */
const EventSchema = z.object({ message_id: z.string(), chat_id: z.string(), chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string(), sender_type: z.enum(['user', 'bot']), content: z.string(), create_time: z.string(),
  mentions: z.array(z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).default([]),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(), message_app_link: z.url().optional() })
export type FeishuEvent = z.infer<typeof EventSchema>
export const feishuThreadId = (chatId: string, rootId: string | undefined, messageId: string): string => `${chatId}:${rootId ?? messageId}`
/** Deterministic trigger ID for a Feishu message; every read path for this message produces the same ID. */
export const feishuTriggerId = (messageId: string): string => key('feishu', messageId)
export const withMentionNames = (text: string, mentions: { key?: string | undefined; name?: string | undefined }[]): string =>
  mentions.reduce((result, mention) => mention.key && mention.name ? result.replaceAll(mention.key, `@${mention.name}`) : result, text)
/**
 * Parses a Feishu message timestamp into an ISO-8601 string: live events and the history API return epoch milliseconds as a
 * string, whereas topic/thread pages return a local timestamp string such as `2026-09-11 12:00`.
 */
export function feishuTime(value: string): string {
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`Unreadable Feishu message time: ${value}`)
  return new Date(time).toISOString()
}
/** Extracts readable plain text from a Feishu `post` rich-text JSON object (either localized `{ zh_cn: { title, content } }` or unwrapped `{ title, content }`). */
export function extractFeishuPostText(content: unknown): string | undefined {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined
  const record = content as Record<string, unknown>
  let body: { title?: unknown; content?: unknown } | undefined
  if (Array.isArray(record.content)) {
    body = record
  } else {
    for (const keyName of ['zh_cn', 'en_us', 'ja_jp', ...Object.keys(record)]) {
      const candidate = record[keyName]
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && Array.isArray((candidate as { content?: unknown }).content)) {
        body = candidate as { title?: unknown; content?: unknown }
        break
      }
    }
  }
  if (!body || !Array.isArray(body.content)) return undefined
  const lines: string[] = []
  if (typeof body.title === 'string' && body.title.trim()) lines.push(body.title.trim())
  for (const paragraph of body.content) {
    if (!Array.isArray(paragraph)) continue
    const parts: string[] = []
    for (const node of paragraph) {
      if (!node || typeof node !== 'object') continue
      const item = node as Record<string, unknown>
      const tag = typeof item.tag === 'string' ? item.tag : ''
      if (tag === 'text' || tag === 'md' || tag === 'code_block') {
        if (typeof item.text === 'string') parts.push(item.text)
      } else if (tag === 'a') {
        const label = typeof item.text === 'string' ? item.text.trim() : ''
        const href = typeof item.href === 'string' ? item.href.trim() : ''
        if (label && href && label !== href) parts.push(`${label} (${href})`)
        else if (label || href) parts.push(label || href)
      } else if (tag === 'at') {
        const name = typeof item.user_name === 'string' && item.user_name.trim() ? item.user_name.trim()
          : typeof item.user_id === 'string' && item.user_id.trim() ? item.user_id.trim() : ''
        if (name) parts.push(`@${name}`)
      } else if (tag === 'emotion') {
        if (typeof item.emoji_type === 'string' && item.emoji_type.trim()) parts.push(`[${item.emoji_type.trim()}]`)
      } else if (tag !== 'img' && tag !== 'media' && typeof item.text === 'string') {
        parts.push(item.text)
      }
    }
    const line = parts.join('').trimEnd()
    if (line.trim()) lines.push(line)
  }
  return lines.length ? lines.join('\n') : undefined
}
function unwrapFeishuContent(raw: string): string {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('{')) return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      if ('text' in parsed && typeof (parsed as { text?: unknown }).text === 'string') return (parsed as { text: string }).text
      const post = extractFeishuPostText(parsed)
      if (post !== undefined) return post
    }
  } catch { /* Not JSON; return raw text as-is. */ }
  return raw
}
/** Converts a normalized Feishu event into a Trigger, returning undefined for messages sent by the bot itself. */
export function feishuTrigger(input: unknown, botId: string, botAppId: string): Trigger | undefined {
  const event = EventSchema.parse(input)
  if (event.sender_id === botId || event.sender_id === botAppId) return
  const direct = event.chat_type === 'p2p'
  const mentioned = event.mentions.some(mention => mention.id === botId || mention.id === botAppId)
  const thread = feishuThreadId(event.chat_id, event.root_id, event.message_id)
  return { id: feishuTriggerId(event.message_id), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: event.sender_id }, human: event.sender_type === 'user',
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: feishuTime(event.create_time), text: withMentionNames(unwrapFeishuContent(event.content), event.mentions),
    channel: feishuChannel(event.chat_id, event.message_id, direct), ...(event.message_app_link ? { url: event.message_app_link } : {}),
    meta: { chatId: event.chat_id, messageId: event.message_id, direct, mentioned, ...(event.root_id ? { rootId: event.root_id } : {}),
      ...(event.parent_id ? { parentId: event.parent_id } : {}), ...(event.thread_id ? { threadId: event.thread_id } : {}) } }
}
export const feishuParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined
export function feishuRef(trigger: Trigger): FeishuRef | undefined {
  const meta = trigger.meta as { chatId?: string; messageId?: string }
  if (trigger.source !== SOURCE || !meta.chatId || !meta.messageId) return undefined
  return { triggerId: trigger.id, chatId: meta.chatId, messageId: meta.messageId, at: trigger.at }
}

/** A message from the history API; a deleted message may have no body/content. */
export const HistoricalMessageSchema = z.looseObject({
  message_id: z.string(), chat_id: z.string(), create_time: z.string(),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(),
  deleted: z.boolean().optional(), message_app_link: z.string().optional(),
  sender: z.looseObject({ id: z.string().default(''), sender_type: z.string() }),
  body: z.looseObject({ content: z.string() }).optional(),
  mentions: z.array(z.looseObject({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).optional(),
})
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>
/** One page of the history API; items are validated individually so an unreadable item is skipped alone. */
export const HistoryPageSchema = z.looseObject({
  items: z.array(z.unknown()).default([]), has_more: z.boolean().default(false), page_token: z.string().optional(),
})
export function historyText(message: HistoricalMessage): string {
  let content: unknown
  try { content = JSON.parse(message.body?.content ?? '') }
  catch { content = message.body?.content ?? '' /* Feishu also returns plain-text system messages. */ }
  const plain = content && typeof content === 'object' && 'text' in content && typeof content.text === 'string'
    ? content.text
    : extractFeishuPostText(content)
  return withFeishuFiles(typeof content === 'string' ? content : plain ?? JSON.stringify(content), message.body?.content ?? '')
}
export function historyEvent(message: HistoricalMessage, chatId: string, direct: boolean): unknown {
  return { message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot', content: historyText(message),
    mentions: message.mentions ?? [], root_id: message.root_id, parent_id: message.parent_id, thread_id: message.thread_id,
    message_app_link: message.message_app_link }
}
/**
 * Adapts a topic-page message into the live-event schema, falling back to `root` when Feishu omits `root_id` on replies;
 * an app's message carries its bot's `open_bot_id`, and a deleted message may have no content.
 */
export function topicEvent(message: FeishuMessage, chatId: string, direct: boolean, root: string): unknown {
  return { message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.open_bot_id ?? message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot',
    content: message.content ?? '', mentions: message.mentions ?? [], parent_id: message.parent_id, thread_id: message.thread_id,
    root_id: message.root_id ?? (message.message_id === root ? undefined : root), message_app_link: message.message_app_link }
}
