/**
 * The WeCom group bot's message push: a webhook URL that only posts into one group and never receives, so it is not a
 * Source but an outlet for notices. It renders `markdown_v2`, the only WeCom format with tables, lists, code blocks and
 * inline images, which the intelligent bot's messages cannot carry.
 */
import { WecomBotSchema } from '../deployment.ts'
import type { SourceContext } from './host.ts'

/** WeCom renders at most this many bytes of a `markdown_v2` message, and the platform refuses a longer one. */
export const WECOM_V2_BYTES = 4096
/** The group bot accepts at most this many messages a minute. */
export const WECOM_WEBHOOK_PER_MINUTE = 20
/** Answers a group bot gives when its URL is stale or its group is gone, which no retry fixes. */
const LOST = new Set([93000, 93004, 40058])

/** The webhook URL the settings name, or undefined when the operator configured no group push. */
export const wecomWebhook = (config: unknown): string | undefined => WecomBotSchema.parse(config ?? {}).webhook || undefined
/** True when `text` fits what a `markdown_v2` message renders. */
export const fitsMarkdownV2 = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= WECOM_V2_BYTES
/** Shortens `text` to what a `markdown_v2` message renders, marking it as shortened rather than letting WeCom refuse it. */
export function clipMarkdownV2(text: string, tail = '…'): string {
  if (fitsMarkdownV2(text)) return text
  const limit = WECOM_V2_BYTES - Buffer.byteLength(tail, 'utf8')
  let out = text
  while (Buffer.byteLength(out, 'utf8') > limit) out = out.slice(0, Math.floor(out.length * 0.9))
  return `${out}${tail}`
}
/**
 * Posts one `markdown_v2` message to the group bot.
 * @returns `lost` when WeCom says the group or its webhook is gone, so the caller stops trying.
 * @throws when the push failed but a later attempt may succeed.
 */
export async function pushWecomGroup(url: string, text: string, signal?: AbortSignal): Promise<'sent' | 'lost'> {
  const response = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown_v2', markdown_v2: { content: clipMarkdownV2(text) } }) })
  if (!response.ok) throw new Error(`The WeCom group push answered HTTP ${response.status}`)
  const answer = await response.json().catch(() => undefined) as { errcode?: number; errmsg?: string } | undefined
  const code = answer?.errcode ?? 0
  if (LOST.has(code)) return 'lost'
  if (code !== 0) throw new Error(`The WeCom group push failed: ${answer?.errmsg ?? 'unknown error'} (${code})`)
  return 'sent'
}
/**
 * Sends a notice of a ticket to the Source's configured group bot, so the group learns of a result the intelligent bot
 * answered elsewhere. A Source without one sends nothing; a lost webhook is not retried.
 */
export async function notifyGroup(ctx: SourceContext, text: string): Promise<void> {
  const url = wecomWebhook(ctx.config<Record<string, unknown>>('wecom'))
  if (!url) return
  await pushWecomGroup(url, text)
}
