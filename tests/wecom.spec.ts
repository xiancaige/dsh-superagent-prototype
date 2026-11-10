/** The WeCom Source: callbacks as Triggers, the receiving scope, the Channel's reply and push, and the bot's account. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import { key } from '../src/core/index.ts'
import { resolveWecomBot } from '../src/deployment.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { SourceHost } from '../src/sources/host.ts'
import { apply as applyWecom, wecomKind, type WecomConfig } from '../src/sources/wecom.ts'
import { sendWecom, wecomLink } from '../src/sources/wecom-channel.ts'
import { setWecomSender, wecomSender, type WecomSender } from '../src/sources/wecom-connection.ts'
import { runWecom, useWecomClient } from '../src/sources/wecom-loops.ts'
import { WecomMessageSchema, WecomApiError, type WecomSdkClient, type WecomSdkFrame, type WecomSdkModule } from '../src/sources/wecom-protocol.ts'
import { wecomTrigger } from '../src/sources/wecom-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const MEMBER = 'zhangsan'
const GROUP = 'wr_group'
/** One `aibot_msg_callback` body as the long connection delivers it; a group message mentions the bot. */
const message = (overrides: Record<string, unknown> = {}) => ({ msgid: 'MSG1234567890ab', aibotid: 'bot_1', chatid: GROUP, chattype: 'group',
  from: { userid: MEMBER }, create_time: 1_757_376_000, msgtype: 'text', text: { content: 'fix the margin' }, ...overrides })
/** A frame as the server pushes it; `req_id` is what a reply answers. */
const frame = (body: Record<string, unknown>, reqId = 'req-1'): WecomSdkFrame => ({ cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body })
/** The Trigger a callback produces, read the way the connection reads it. */
const triggerOf = (body: Record<string, unknown>): Trigger => wecomTrigger(WecomMessageSchema.parse(body))!
/** Store directories a test made, removed when it ends so a run leaves nothing behind. */
const stores = new Set<{ store: Store; dir: string }>()
afterEach(() => {
  setWecomSender(undefined)
  for (const { store, dir } of stores) {
    // The Store holds the database open until its test is done; a Windows handle left by it must not fail a passing test.
    try { store.close() } catch { /* Already closed by its test. */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* Removed by the system later. */ }
  }
  stores.clear()
})
/** A Store whose WeCom Source is on, the kind registered, and a context bound to it. */
function host(config: Partial<WecomConfig> = {}, overrides: Partial<SourceContextDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-'))
  const store = new Store(join(dir, 'db.sqlite'))
  stores.add({ store, dir })
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { wecom: { allowed: [{ id: MEMBER, name: 'Zhang' }] } } }, eval: { mode: 'auto' },
    sources: { wecom: { enabled: true, config: { botId: 'bot_1', secretVariable: 'WECOM_BOT_SECRET', chats: [{ chatId: GROUP, listen: 'mentions' }], ...config } } } }))
  const board = new HealthBoard()
  /** Registers the WeCom kind on a fresh registry and returns what a plugin entry needs to replace it. */
  const sources = new SourceRegistry(() => store.settings(), board)
  const unregister = sources.register(wecomKind)
  const deployment = testDeployment({ wecom: { botId: 'bot_1', secret: 's3cret' } })
  const receive = vi.fn<SourceContextDeps['receive']>(trigger => { void trigger; return 'stored' })
  const deps: SourceContextDeps = { store, engine: { bindThread: () => undefined as never, threadClosed: () => {} }, outbox: { send: () => {} },
    commands: new Commands(() => deployment, {}, new AbortController().signal), sources, deployment, ready: Promise.resolve(), configured: () => true,
    receive, ...overrides }
  return { store, sources, board, receive, deps, ctx: sourceContextOf(deps, wecomKind), unregister }
}
/** A client whose replies and pushes answer as `answer` says, or reject with `failure` when one is given. */
function client(overrides: { answer?: WecomSdkFrame | undefined; failure?: unknown; rows?: unknown[][] } = {}): WecomSdkClient {
  const reply = vi.fn(async (...args: unknown[]) => {
    overrides.rows?.push(args)
    if (overrides.failure) throw overrides.failure
    return overrides.answer ?? { headers: { req_id: 'r' }, errcode: 0 }
  })
  const sendMessage = vi.fn(async (...args: unknown[]) => {
    overrides.rows?.push(args)
    if (overrides.failure) throw overrides.failure
    return overrides.answer ?? { headers: { req_id: 'r' }, errcode: 0 }
  })
  return { reply, sendMessage, isConnected: true } as unknown as WecomSdkClient
}
const replyOf = (client: WecomSdkClient) => client.reply as unknown as { mock: { calls: unknown[][] } }
/** A sender over `client`; `held` is the callback frame it still holds for `MSG1`. */
const sender = (client: WecomSdkClient, held: WecomSdkFrame | undefined = frame({}), overrides: Partial<WecomSender> = {}): WecomSender =>
  ({ client: () => client, frame: () => held, reqId: () => 'req-stored', openRoot: () => {}, pushTarget: chatId => chatId.replace(/^single:/, ''), ...overrides })
const outbound = (address: Record<string, string>): OutboundMessage =>
  ({ id: 'reply-1', kind: 'reply', text: 'Working on it.', ticketId: 't', channel: { source: 'wecom', thread: 'wecom:x', address } })

describe('wecom source', () => {
  it('translates a group callback into a Trigger on its chat, addressed by its mention', () => {
    expect(triggerOf(message())).toEqual({ id: key('wecom', 'MSG1234567890ab'), source: 'wecom', threads: [{ source: 'wecom', id: GROUP }],
      actor: { source: 'wecom', id: MEMBER }, human: true, addressed: 'mention', at: '2025-09-09T00:00:00.000Z', text: 'fix the margin',
      channel: { source: 'wecom', thread: `wecom:${GROUP}`, address: { chatId: GROUP, messageId: 'MSG1234567890ab', delivery: 'respond' } },
      meta: { chatId: GROUP, messageId: 'MSG1234567890ab', direct: false, chattype: 'group', msgtype: 'text' } })
  })
  it('keys a direct chat by its sender, and reads speech, images and quotes as text', () => {
    // A direct message carries no chatid, and it always addresses the bot.
    const direct = triggerOf(message({ chatid: undefined, chattype: 'single' }))
    expect(direct.addressed).toBe('direct')
    expect(direct.threads).toEqual([{ source: 'wecom', id: `single:${MEMBER}` }])
    expect(direct.channel!.address).toMatchObject({ chatId: `single:${MEMBER}`, direct: 'true' })
    // WeCom transcribes speech itself, so a voice message arrives as what the person said.
    expect(triggerOf(message({ msgtype: 'voice', text: undefined, voice: { content: '修一下边距' } })).text).toBe('修一下边距')
    // A mixed message keeps its parts in order, and a quote is shown above the answer's text.
    expect(triggerOf(message({ msgtype: 'mixed', text: undefined, mixed: { msg_item: [{ msgtype: 'text', text: { content: 'look' } }, { msgtype: 'image', image: {} }] } })).text)
      .toBe('look\n[图片]')
    expect(triggerOf(message({ quote: { msgtype: 'text', text: { content: 'earlier' } } })).text).toBe('> earlier\nfix the margin')
    // An image alone still reaches the Source, as a placeholder, so its sender is answered.
    expect(triggerOf(message({ msgtype: 'image', text: undefined, image: { url: 'https://x', aeskey: 'k' } })).text).toBe('[图片]')
  })
  it('accepts only the chats the Source receives, and only direct messages while they are allowed', () => {
    const config = wecomKind.schema.parse({ botId: 'bot_1', secretVariable: 'WECOM_BOT_SECRET', chats: [{ chatId: GROUP, listen: 'mentions' }], directMessages: false })
    expect(wecomKind.scope!({ meta: { chatId: GROUP, direct: false } }, config)).toEqual({ listened: true, observed: false, row: GROUP })
    expect(wecomKind.scope!({ meta: { chatId: 'wr_other', direct: false } }, config)).toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(wecomKind.scope!({ meta: { chatId: `single:${MEMBER}`, direct: true } }, config)).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    // "All messages" is the only setting that lets unaddressed messages in a listed chat become candidates.
    const all = wecomKind.schema.parse({ ...config, chats: [{ chatId: GROUP, listen: 'all' }], directMessages: true })
    expect(wecomKind.scope!({ meta: { chatId: GROUP, direct: false } }, all)).toEqual({ listened: true, observed: true, row: GROUP })
    expect(wecomKind.policy!.rows!({ chats: [{ chatId: GROUP, listen: 'all' }] }).map(row => row.id)).toEqual([GROUP, 'other', 'direct'])
    // A reply goes only to a chat the Source still receives, as on Feishu.
    expect(wecomKind.channel!.allowed!({ chatId: GROUP }, all)).toBe(true)
    expect(wecomKind.channel!.allowed!({ chatId: 'wr_other' }, all)).toBe(false)
  })
  it('answers through the callback frame, and pushes to the chat once the reply window has passed', async () => {
    const rows: unknown[][] = []
    const connected = client({ rows })
    const openRoot = vi.fn()
    setWecomSender(sender(connected, frame({}, 'req-1'), { openRoot }))
    expect(await sendWecom(undefined, outbound({ chatId: GROUP, messageId: 'MSG1', delivery: 'respond' }))).toBe('sent')
    // The stored req_id, not the frame's, so a retried reply answers the same callback rather than posting twice.
    expect(replyOf(connected).mock.calls[0]).toEqual([expect.objectContaining({ headers: expect.objectContaining({ req_id: 'req-stored' }) }),
      { msgtype: 'markdown', markdown: { content: 'Working on it.' } }])
    // An expired window (846608) falls back to the chat's push, which needs no callback.
    const openRootPushed = vi.fn()
    const pushed = client({ rows })
    const refusing: WecomSdkClient = { reply: vi.fn(async () => { throw new WecomApiError(846608, 'expired') }), sendMessage: pushed.sendMessage,
      isConnected: true } as unknown as WecomSdkClient
    setWecomSender(sender(refusing, frame({}), { openRoot: openRootPushed }))
    expect(await sendWecom(undefined, outbound({ chatId: GROUP, messageId: 'MSG2', delivery: 'respond' }))).toBe('sent')
    expect(pushed.sendMessage).toHaveBeenCalledWith(GROUP, expect.objectContaining({ msgtype: 'markdown' }))
    expect(openRootPushed).toHaveBeenCalledWith(GROUP, 'MSG2')
    // A push to a direct chat addresses the sender rather than the chat id, which only the sender can name.
    expect(await sendWecom(undefined, outbound({ chatId: `single:${MEMBER}`, delivery: 'push' }))).toBe('sent')
    expect(pushed.sendMessage).toHaveBeenLastCalledWith(MEMBER, expect.anything())
  })
  it('reports a refused command with its code, and keeps a network failure retryable', async () => {
    setWecomSender(sender(client({ answer: { headers: { req_id: 'r' }, errcode: 45009, errmsg: 'api freq out of limit' } }), frame({})))
    const one = outbound({ chatId: GROUP, messageId: 'M', delivery: 'respond' })
    await expect(sendWecom(undefined, one)).rejects.toMatchObject({ code: 45009 })
    setWecomSender(sender(client({ failure: new Error('socket hang up') }), frame({})))
    await expect(sendWecom(undefined, one)).rejects.toThrow('socket hang up')
    // A push WeCom refuses outright settles the message as gone, so it is never retried in a loop.
    setWecomSender(sender(client({ failure: new WecomApiError(93000, 'no such conversation') }), undefined))
    expect(await sendWecom(undefined, outbound({ chatId: GROUP, delivery: 'push' }))).toBe('gone')
    // Without a connection the message waits rather than being dropped.
    setWecomSender(undefined)
    await expect(sendWecom(undefined, one)).rejects.toThrow(/not running/)
  })
  it('bounds a message to the bytes and words WeCom renders', async () => {
    const connected = client({ rows: [] })
    setWecomSender(sender(connected, frame({})))
    // 100 single-letter words (at the word limit) followed by one unbroken run, so the text passes the word check at 4198
    // bytes and only the 4096-byte limit applies.
    const long = `${'x '.repeat(99)}${'x'.repeat(4000)}`
    await sendWecom(undefined, { id: 'i', kind: 'reply', text: long, ticketId: 't',
      channel: { source: 'wecom', thread: 'wecom:x', address: { chatId: GROUP, messageId: 'M', delivery: 'respond' } } })
    const body = replyOf(connected).mock.calls.at(-1)![1] as { markdown: { content: string } }
    // The panel pointer is what a reader sees in place of the rest, and the whole body still fits what WeCom renders.
    expect(body.markdown.content.endsWith('…（全文见本地面板）')).toBe(true)
    expect(Buffer.byteLength(body.markdown.content)).toBeLessThanOrEqual(4096)
    // The 100-word limit is checked first: a message over it asks for a summary instead of being cut.
    await expect(sendWecom(undefined, { id: 'j', kind: 'reply', text: 'word '.repeat(101), ticketId: 't',
      channel: { source: 'wecom', thread: 'wecom:x', address: { chatId: GROUP, messageId: 'M', delivery: 'respond' } } }))
      .rejects.toThrow(/maximum is 100/)
  })
  it('links a chat through the WeCom scheme and names the Trigger of its message', () => {
    expect(wecomLink({ chatId: `single:${MEMBER}`, messageId: 'M1' })).toEqual({ url: `wxwork://message?chatid=${MEMBER}`,
      label: { zh: '企业微信会话', en: 'WeCom chat' }, triggerId: key('wecom', 'M1') })
  })
  it('resolves the bot from the settings and an environment variable, and names the field to fix', () => {
    const env: Record<string, string> = { WECOM_BOT_SECRET: 'secret', DSH_SUPERAGENT_WECOM_WS_URL: 'wss://private.example/ws' }
    const lookup = (name: string): string | undefined => env[name]
    expect(resolveWecomBot({ botId: 'bot_1', secretVariable: 'WECOM_BOT_SECRET' }, lookup)).toEqual({ botId: 'bot_1', secret: 'secret', wsUrl: 'wss://private.example/ws' })
    // No bot named at all leaves the Source unconfigured rather than failing the deployment.
    expect(resolveWecomBot({}, lookup)).toBeUndefined()
    expect(() => resolveWecomBot({ botId: 'bot_1' }, lookup)).toThrow(/names no environment variable/)
    expect(() => resolveWecomBot({ botId: 'bot_1', secretVariable: 'MISSING' }, lookup)).toThrow(/MISSING is empty/)
    expect(() => resolveWecomBot({ botId: 'bot_1', secretVariable: 'WECOM_BOT_SECRET' }, name => name === 'DSH_SUPERAGENT_WECOM_WS_URL' ? 'https://x' : 's'))
      .toThrow(/not a wss:\/\/ URL/)
  })
  it('registers its kind with the plugin, and releases it when the plugin is disposed', async () => {
    const harness = host()
    // Each test reads the context from the kind's own registration; the plugin below registers the kind again on its own registry.
    harness.unregister()
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => harness.store.settings(), board)
    // The plugin enters the host as the `orchestrator` service and asks it for each kind's context.
    const orchestrator: SourceHost = { sources, context: kind => sourceContextOf({ ...harness.deps, sources }, kind) }
    const disposers: (() => unknown)[] = []
    applyWecom({ orchestrator, effect: (effect: () => () => unknown) => { disposers.push(effect()) }, logger: { warn: () => {} } } as never)
    expect(sources.kind('wecom')).toBe(wecomKind)
    // The entry claims the kind's single health entry, so a second claim of the same name would be refused.
    expect(board.all.wecom).toBeDefined()
    // Disposal unregisters the kind and stops the loop with it.
    for (const dispose of disposers.reverse()) await dispose()
    expect(sources.kind('wecom')).toBeUndefined()
  })
  it('starts no connection while the Source is off, and says so', async () => {
    const harness = host({}, {})
    harness.store.saveSettings(SettingsSchema.parse({ sources: { wecom: { enabled: false, config: {} } } }))
    const controller = new AbortController()
    const running = runWecom(harness.ctx, controller.signal)
    await vi.waitFor(() => expect(harness.board.all.wecom).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    controller.abort()
    await running
    // A stopped loop withdraws the sender, so no message is sent through a connection that no longer runs.
    expect(wecomSender()).toBeUndefined()
  })
  it('records a callback\'s req_id so its reply answers the same message, and pushes by sender in a direct chat', () => {
    const harness = host()
    harness.ctx.state.set(KV.wecom.reply('MSG1234567890ab'), 'req-7')
    expect(harness.ctx.state.get(KV.wecom.reply('MSG1234567890ab'))).toBe('req-7')
    // The Channel's sender joins the chat topic and the user ID of a direct chat from the records the intake wrote.
    expect(harness.sources.instance<WecomConfig>('wecom')!.config.chats).toEqual([{ chatId: GROUP, listen: 'mentions' }])
  })
  it('subscribes through the official client, files each callback under its chat, and answers it through the same frame', async () => {
    const harness = host()
    // A stand-in client that authenticates at once and remembers how the loop drove it.
    const listeners = new Map<string, (value: never) => void>()
    const opened: { connected: boolean; disconnected: boolean; options: unknown } = { connected: false, disconnected: false, options: undefined }
    const pushed: unknown[][] = []
    let delivered: Promise<unknown> = Promise.resolve()
    const stand = {
      connect(): void { opened.connected = true; void Promise.resolve().then(() => listeners.get('authenticated')!(undefined as never)) },
      disconnect(): void { opened.disconnected = true },
      on(event: string, listener: (value: never) => void): void { listeners.set(event, listener) },
      reply: async () => ({ headers: { req_id: 'r' }, errcode: 0 }),
      sendMessage: async (...args: unknown[]) => { pushed.push(args); return { headers: { req_id: 'r' }, errcode: 0 } },
      get isConnected(): boolean { return opened.connected && !opened.disconnected },
    }
    useWecomClient(async () => ({ WSClient: function (options: unknown) { opened.options = options; return stand } }) as unknown as WecomSdkModule)
    const controller = new AbortController()
    const running = runWecom(harness.ctx, controller.signal)
    await vi.waitFor(() => expect(opened.connected).toBe(true))
    // The subscription names the bot and its secret, and nothing else does.
    expect(opened.options).toMatchObject({ botId: 'bot_1', secret: 's3cret', wsUrl: 'wss://openws.work.weixin.qq.com' })
    await vi.waitFor(() => expect(harness.board.all.wecom).toMatchObject({ state: 'ready' }))
    delivered = Promise.resolve(listeners.get('message')!({ headers: { req_id: 'req-42' }, body: WecomMessageSchema.parse(message()) } as never))
    await vi.waitFor(() => expect(harness.receive).toHaveBeenCalled())
    // The callback becomes the Source's Trigger, and its reply target is kept for the Channel.
    expect(harness.receive.mock.calls[0]![0]).toMatchObject({ source: 'wecom', threads: [{ source: 'wecom', id: GROUP }], meta: { chatId: GROUP } })
    expect(harness.ctx.state.get(KV.wecom.reply('MSG1234567890ab'))).toBe('req-42')
    expect(harness.ctx.state.get(KV.wecom.chats)).toEqual({ [GROUP]: false })
    // The Channel answers through the frame the callback arrived on, without a push.
    expect(await sendWecom(undefined, outbound({ chatId: GROUP, messageId: 'MSG1234567890ab', delivery: 'respond' }))).toBe('sent')
    expect(pushed).toEqual([])
    // An event callback is not a request for work.
    ;(listeners.get('event')!)({ headers: { req_id: 'e' }, body: { msgid: 'E1', msgtype: 'event', event: { eventtype: 'enter_chat' } } } as never)
    await delivered
    expect(harness.receive).toHaveBeenCalledTimes(1)
    controller.abort()
    await running
    expect(opened.disconnected).toBe(true)
    useWecomClient()
  })
})
