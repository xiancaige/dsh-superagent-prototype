/** WeCom background work: the long connection's lifecycle, callback intake, and how each message is replied to. */
import { threadKey, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { loadWecomSdk, silentLogger, WecomMessageSchema, WECOM_HEARTBEAT_MS, WECOM_REPLY_WINDOW_MS, WECOM_WS_URL, type WecomSdkClient,
  type WecomSdkFrame } from './wecom-protocol.ts'
import type { WecomSender } from './wecom-connection.ts'
import { setWecomSender } from './wecom-connection.ts'
import { SOURCE, wecomChat, wecomDirect, wecomThreadId, wecomTrigger } from './wecom-trigger.ts'
import type { WecomConfig } from './wecom.ts'

/** A callback kept while WeCom holds its `req_id`, so a reply inside that window answers the message itself. */
interface Remembered { frame: WecomSdkFrame; at: number }
/** The one connection this plugin holds; replaced on every subscribe so a dropped client is never replied through. */
const live: { client: WecomSdkClient | undefined; window: Map<string, Remembered> } = { client: undefined, window: new Map() }
/** Opens connections: the official client by default, and a test's stand-in where one is set. */
let opener: typeof loadWecomSdk = loadWecomSdk
/** Replaces how the loop opens a connection, so a test drives callbacks without the WeCom server. */
export const useWecomClient = (loader?: typeof loadWecomSdk): void => { opener = loader ?? loadWecomSdk }
const sweep = (now = Date.now()): void => { for (const [id, item] of live.window) if (now - item.at > WECOM_REPLY_WINDOW_MS) live.window.delete(id) }
const enabled = (ctx: SourceContext): WecomConfig | undefined => ctx.config<WecomConfig>(SOURCE)

/** Publishes the Channel's sender and starts watching the connection; disposal withdraws both. */
export function runWecom(ctx: SourceContext, signal: AbortSignal): Promise<unknown> {
  setWecomSender(sender(ctx))
  return watch(ctx, signal).finally(() => setWecomSender(undefined))
}
/** What the Channel reads from the connection: the live client, a callback's frame, and where a push and a chat's topic go. */
function sender(ctx: SourceContext): WecomSender {
  return {
    client: () => live.client,
    frame: messageId => { sweep(); return live.window.get(messageId)?.frame },
    reqId: messageId => ctx.state.get(KV.wecom.reply(messageId)),
    // The chat's topic moves to the message a push answers, so the next message there continues that conversation.
    openRoot: (chatId, messageId) => { if (messageId) ctx.state.set(KV.wecom.root(chatId), messageId) },
    pushTarget: chatId => wecomDirect(chatId) ? chatId.slice('single:'.length) : chatId,
  }
}
/**
 * Runs the bot's long connection while the plugin is mounted. WeCom allows one live connection per bot, and a second one
 * makes the server drop the first, so this loop reconnects with a growing delay instead of fighting another process.
 */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let retry = 1000
  while (!signal.aborted) {
    if (!enabled(ctx)) { ctx.report('wecom', health('paused', 'sourceOff')); await pause(5000, signal); continue }
    if (ctx.problem) { ctx.report('wecom', { state: 'paused', detail: ctx.problem.detail, at: new Date().toISOString() }); await pause(5000, signal); continue }
    const bot = ctx.deployment.wecom
    if (!bot) { ctx.report('wecom', health('paused', 'wecomBotMissing')); await pause(5000, signal); continue }
    const began = Date.now()
    try { await consume(ctx, signal, bot) }
    catch (error) { if (!signal.aborted) ctx.report('wecom', { state: 'error', detail: String(error), at: new Date().toISOString() }) }
    // A connection that stayed up a minute restarts at once; a repeated failure backs off to one retry a minute.
    retry = Date.now() - began >= 60_000 ? 1000 : Math.min(retry * 2, 60_000)
    await pause(retry, signal)
  }
  live.client = undefined
}
/** Opens one connection, takes in its callbacks until it drops or the plugin stops, and reports each state change. */
async function consume(ctx: SourceContext, signal: AbortSignal, bot: { botId: string; secret: string; wsUrl?: string }): Promise<void> {
  const { WSClient } = await opener()
  const client = new WSClient({ botId: bot.botId, secret: bot.secret, wsUrl: bot.wsUrl ?? WECOM_WS_URL, heartbeatInterval: WECOM_HEARTBEAT_MS, logger: silentLogger })
  // Resolves the moment the server drops this connection, so the loop below does not wait out a dead socket.
  let dropped: () => void = () => {}
  const closed = new Promise<void>(resolve => { dropped = resolve })
  let ready = false
  client.on('authenticated', () => { ready = true; live.client = client; ctx.report('wecom', { state: 'ready', detail: 'Listening for bot callbacks', at: new Date().toISOString() }) })
  client.on('message', frame => {
    // DSH ends its process on an unhandled rejection, so a failure escaping one callback becomes the Source's health instead.
    intake(ctx, frame).catch((error: unknown) => { ctx.report('wecom', { state: 'error', detail: String(error), at: new Date().toISOString() }) })
  })
  // Enter-chat, card and feedback events are not requests for work, so none of them is answered with a welcome.
  client.on('event', () => {})
  client.on('disconnected', (reason: string) => {
    live.client = undefined
    // The server drops this connection when another process subscribes as the same bot; the health says so rather than
    // fighting for the bot, and the loop below reconnects after the SDK's own attempts have run out.
    ctx.report('wecom', { state: 'starting', detail: `Disconnected: ${reason}`, at: new Date().toISOString() })
    dropped()
  })
  client.on('error', (error: Error) => { ctx.report('wecom', { state: 'error', detail: String(error), at: new Date().toISOString() }) })
  client.connect()
  try {
    // The SDK reconnects by itself for up to 30 seconds, so a drop ends this connection only after that grace;
    // a connection that never authenticates still ends when the plugin stops.
    await Promise.race([closed.then(() => waitFor(RECONNECT_GRACE_MS, signal)), never(signal)])
  } finally { client.disconnect(); live.client = undefined }
  if (!ready) throw new Error('The WeCom bot did not authenticate within a minute')
}
/** How long a dropped connection is given back to the SDK's own reconnect before this loop opens a fresh one. */
const RECONNECT_GRACE_MS = 30_000
/** Waits `ms` or until `signal` aborts, and resolves either way. */
function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}
/** A promise that settles only when `signal` aborts, so a connection that never authenticates still ends with the plugin. */
const never = (signal: AbortSignal): Promise<void> => new Promise(resolve => signal.addEventListener('abort', () => { resolve() }, { once: true }))
/** Turns one delivered callback into a Trigger and files it under its chat's topic; the Engine stores a duplicate once. */
async function intake(ctx: SourceContext, frame: WecomSdkFrame): Promise<void> {
  const parsed = WecomMessageSchema.safeParse(frame.body)
  if (!parsed.success) { ctx.report('wecom', { state: 'error', detail: `Unreadable WeCom callback: ${parsed.error.message}` }); return }
  if (!enabled(ctx)) return
  const message = parsed.data
  const trigger = wecomTrigger(message)
  if (!trigger) return
  const chatId = wecomChat(message)
  const messageId = trigger.meta.messageId as string
  // The reply's req_id is kept before intake, so an answer that follows the acknowledgement finds its message.
  sweep()
  live.window.set(messageId, { frame, at: Date.now() })
  ctx.state.set(KV.wecom.reply(messageId), frame.headers.req_id)
  const chats = ctx.state.get(KV.wecom.chats) ?? {}
  chats[chatId] = trigger.meta.direct === true
  ctx.state.set(KV.wecom.chats, chats)
  // The chat's topic changes only when a ticket is opened here; a message joining it keeps the topic it found.
  if (!ctx.state.get(KV.wecom.root(chatId))) ctx.state.set(KV.wecom.root(chatId), messageId)
  ctx.threads.describe(threadKey({ source: SOURCE, id: wecomThreadId(chatId) }), { facts: { chat: message.chattype === 'group' ? { value: chatId } : { value: { zh: '私聊', en: 'Direct message' } } } })
  await ctx.receive(trigger)
}
/** Waits `ms` or until `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const stop = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}
/** Marks a Trigger's chat as seen for the policy's admission rows, which read the stores' chat map. */
export const knownChats = (ctx: SourceContext): Record<string, boolean> => ctx.state.get(KV.wecom.chats) ?? {}
export type { Trigger }