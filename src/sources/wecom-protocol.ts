/**
 * The WeCom intelligent bot's protocol, as dsh-superagent reads it: the WebSocket command names of its long connection,
 * the frames the server pushes, and the small surface of the official `@wecom/aibot-node-sdk` client this Source uses.
 * The frames are validated here so a changed payload fails on its own frame rather than inside the connection.
 */
import type { WSClient as WecomOfficialClient, WSClientEventMap as WecomOfficialEvents } from '@wecom/aibot-node-sdk'
import { z } from 'zod'

/** Commands of the long connection (doc 101463); dsh-superagent only replies to a callback, it never pushes unasked. */
export const WECOM_COMMANDS = { subscribe: 'aibot_subscribe', ping: 'ping', respond: 'aibot_respond_msg', send: 'aibot_send_msg',
  callback: 'aibot_msg_callback', event: 'aibot_event_callback' } as const
/** Public long connection; a private deployment sets its own address through `DSH_SUPERAGENT_WECOM_WS_URL`. */
export const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
/** The reply window of a callback: replies go through its `req_id`, and the connection drops that id after 48 hours. */
export const WECOM_REPLY_WINDOW_MS = 48 * 3600_000
/** Two minutes between heartbeats is the documented ceiling; the SDK pings every 30 seconds by default. */
export const WECOM_HEARTBEAT_MS = 120_000

const ItemSchema = z.looseObject({ msgtype: z.enum(['text', 'image']), text: z.looseObject({ content: z.string() }).optional() })
const QuoteSchema = z.looseObject({ msgtype: z.string(),
  text: z.looseObject({ content: z.string() }).optional(), mixed: z.looseObject({ msg_item: z.array(ItemSchema) }).optional() })
/**
 * One `aibot_msg_callback` (doc 101834). `chatid` is present on group messages only and a direct message carries none, so
 * the source keys a direct chat by its sender; `from.userid` is an opaque id (plain only for a super administrator).
 */
export const WecomMessageSchema = z.looseObject({
  msgid: z.string().min(1), aibotid: z.string().optional(), chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']), from: z.looseObject({ userid: z.string().default('') }),
  create_time: z.number().optional(), msgtype: z.string(),
  text: z.looseObject({ content: z.string() }).optional(), voice: z.looseObject({ content: z.string() }).optional(),
  mixed: z.looseObject({ msg_item: z.array(ItemSchema) }).optional(),
  image: z.looseObject({ url: z.string().optional(), aeskey: z.string().optional() }).optional(),
  quote: QuoteSchema.nullish(),
})
export type WecomMessage = z.infer<typeof WecomMessageSchema>
/** The event callbacks the connection also sends; none of them is a person asking for work, so none becomes a Trigger. */
export const WecomEventSchema = z.looseObject({ msgid: z.string().min(1), msgtype: z.literal('event'), event: z.looseObject({ eventtype: z.string().optional() }) })
/**
 * The official client, as this Source uses it: connecting, authenticating and reconnecting are the client's own work, and
 * this interface narrows it to what the Source calls. Frame and event types are the SDK's, so a payload change it ships
 * shows up here rather than in a cast; a test drives the same surface through `useWecomClient` of the loop.
 */
export type WecomSdkClient = {
  connect(): unknown
  disconnect(): void
  on<E extends keyof WecomSdkEventMap>(event: E, listener: WecomSdkEventMap[E]): unknown
  /** Replies through the callback's own frame, so WeCom attaches the answer to the message it answers. */
  reply(frame: WecomFrame, body: Record<string, unknown>): Promise<WecomFrame>
  /** Posts to a chat without a callback; WeCom accepts it for a chat whose bot was written to before. */
  sendMessage(chatid: string, body: Parameters<WecomOfficialClient['sendMessage']>[1]): Promise<WecomFrame>
  /** Uploads a media file in the chunks the long connection carries, and returns its `media_id`, valid three days. */
  uploadMedia(file: Buffer, options: { type: WecomMediaType; filename: string }): Promise<{ media_id: string }>
  /** Attaches an uploaded image to a callback's answer, which is the only way a message carries a picture. */
  replyMedia(frame: WecomFrame, mediaType: WecomMediaType, mediaId: string): Promise<WecomFrame>
  /** Sends an uploaded image to a chat without a callback, for a chat whose bot was written to before. */
  sendMediaMessage(chatid: string, mediaType: WecomMediaType, mediaId: string): Promise<WecomFrame>
  readonly isConnected: boolean
}
/** The media kinds WeCom accepts; dsh-superagent sends images, the pictures a ticket's own screenshots give it. */
export type WecomMediaType = 'image' | 'file' | 'voice' | 'video'
/** A frame the server pushes or the client answers with; `headers.req_id` is what a reply addresses. */
export type WecomFrame = Awaited<ReturnType<WecomOfficialClient['reply']>>
/** A frame this Source typed itself, kept as an alias for the SDK's frame. */
export type WecomSdkFrame = WecomFrame
/** Which events exist and what each listener receives, as the SDK's own event map declares them. */
export type WecomSdkEventMap = WecomOfficialEvents
export interface WecomSdkModule { WSClient: new (options: WecomSdkOptions) => WecomSdkClient }
export interface WecomSdkOptions { botId: string; secret: string; wsUrl?: string; heartbeatInterval?: number;
  logger: { debug(): void; info(): void; warn(): void; error(): void } }
/**
 * The official SDK may keep packets and errors from the connection alive; its logger is silenced because a secret or a
 * session key must never reach a log, and this Source reports what it needs through its health entries instead.
 */
export const silentLogger = { debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {} }
/**
 * Loads the official client lazily, so a deployment without the WeCom Source never imports it. The client is a CommonJS
 * package, so its class is taken from the module or its `default` export, whichever the loader produced.
 */
export const loadWecomSdk = async (): Promise<WecomSdkModule> => {
  const loaded = await import('@wecom/aibot-node-sdk') as unknown as WecomSdkModule & { default?: WecomSdkModule }
  return loaded.WSClient ? loaded : loaded.default!
}
/** Applies the `errcode` an answer carries, which the client resolves rather than rejects for a refused command. */
export function wecomAck(answer: WecomSdkFrame | undefined): void {
  // A command that returned nothing at all says nothing; the Channel treats that as delivered rather than inventing a failure.
  const code = answer?.errcode ?? 0
  if (code !== 0) throw new WecomApiError(code, answer?.errmsg ?? 'WeCom command failed')
}
/** A WeCom answer with a nonzero `errcode`; `846608` is an expired reply window, `93006` an unmatched `req_id`. */
export class WecomApiError extends Error {
  constructor(readonly code: number, message: string) { super(`${message} (${code})`); this.name = 'WecomApiError' }
}
/** Codes that say the reply can never be delivered: the window closed, or the `req_id` is unknown (doc 101463). */
export const goneCode = (code: number): boolean => code === 846608 || code === 93006
