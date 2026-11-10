/** WeCom Source kind: the intelligent bot's chats, its policy, its replies, and the plugin entry that holds the long connection. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { WecomBotSchema } from '../deployment.ts'
import { sendWecom, wecomLink } from './wecom-channel.ts'
import { runWecom } from './wecom-loops.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'
import { SOURCE, wecomDirect, wecomTriggerId } from './wecom-trigger.ts'

export { SOURCE, wecomChat, wecomChannel, wecomDirect, wecomQuoteText, wecomText, wecomThreadId, wecomTrigger, wecomTriggerId } from './wecom-trigger.ts'
export type { WecomMessage } from './wecom-protocol.ts'
export { runWecom } from './wecom-loops.ts'

const WecomConfigSchema = WecomBotSchema.extend({
  chats: z.array(z.object({ chatId: z.string().trim().min(1).max(128), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs').default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type WecomConfig = z.infer<typeof WecomConfigSchema>
export const wecomKind: SourceKind<WecomConfig> = {
  kind: SOURCE,
  title: { zh: '企业微信', en: 'WeCom' },
  description: { zh: '企业微信智能机器人：接收群里 @ 机器人和私聊的消息，在同一个会话里回答。', en: 'The WeCom intelligent bot: receives messages that mention it in these chats and direct messages, and answers in the same chat.' },
  schema: WecomConfigSchema,
  fields: [
    { key: 'botId', type: 'text', label: { zh: '机器人 ID', en: 'Bot ID' },
      hint: { zh: '企业微信管理后台的智能机器人 ID，API 模式须为长连接。保存后重启 dsh-superagent 生效。', en: 'The intelligent bot ID from the WeCom admin console, whose API mode must be the long connection. Saving restarts dsh-superagent.' } },
    { key: 'secretVariable', type: 'text', advanced: true, label: { zh: '存放密钥的环境变量', en: 'Secret environment variable' },
      hint: { zh: '机器人密钥只从这个环境变量读取，不写进设置，也不进日志和会话。长连接模式下密钥与管理后台的展示一致。', en: 'The bot secret is read only from this environment variable; it is never written into the settings, the logs or a Session. In long-connection mode it is the secret the admin console shows.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的会话；“全部消息”也接收其余群消息，由策略决定它们能否成为候选。', en: '"@ only" receives messages that mention the bot and chats a ticket already holds; "All" also receives the rest, and the Policy decides whether they become candidates.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: '[A-Za-z0-9_@:\\-]+', choose: { zh: '选择收到过消息的群', en: 'Choose a chat that has written' }, refresh: { zh: '刷新群列表', en: 'Refresh chats' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'webhook', type: 'text', advanced: true, label: { zh: '群里推送用的群机器人', en: 'Group webhook for notifications' },
      hint: { zh: '可选。群机器人只能往群里发消息、不能收消息，所以它不作为来源，只用于主动通知：本来源发出的提醒和会话结束通知会同时发到这个群。留空则不发。', en: 'Optional. A group webhook can only post into a group and never receives, so it is not a Source but a notification outlet: reminders and end notices of this Source also go to it. Left empty, none are sent.' } },
  ],
  health: ['wecom'],
  scope({ meta }, config) {
    const chatId = String(meta.chatId ?? '')
    if (meta.direct === true || wecomDirect(chatId)) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === chatId || item.name === chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives, as in Feishu: a closed chat's messages are not sent.
  channel: {
    allowed: (address, config) => wecomKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendWecom, link: wecomLink,
  },
  // WeCom keeps no history and no membership: the Trigger's own text is the context an assessment can read.
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    read: async (_commands, trigger, part) => {
      const messages = [{ id: String(trigger.meta.messageId ?? ''), from: trigger.actor.id, at: trigger.at, text: trigger.text }]
      // A root and a parent are the message itself: WeCom has no reply link, so only the thread page exists.
      return part === 'thread' ? { messages, body: { messages } } : { messages, body: { message: messages[0] } }
    },
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/[A-Za-z0-9_-]{16,}/g) ?? [])] }),
  // A chat's later messages are follow-ups of the ticket the chat's topic holds, not replies WeCom links to each other.
  repliesTo: () => undefined,
  policy: {
    unnamed: { person: { zh: '企业微信用户', en: 'WeCom user' }, bot: { zh: '企业微信机器人', en: 'WeCom bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(128), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user IDs').default([]),
      syncChat: z.string().trim().max(128).default(''),
      bots: z.array(z.object({ id: z.string().trim().min(1).max(128), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的企业微信用户', en: 'WeCom users who may originate work' },
        hint: { zh: '填 userid：只有超级管理员能看到明文 userid，其余成员是企业内加密串，按管理后台或通讯录里显示的原样填。', en: 'Use the userid: only a super administrator sees plain text, so copy the encrypted in-enterprise id as the console or the contacts show it.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'userid', en: 'userid' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'syncChat', type: 'text', label: { zh: '同步来源群', en: 'Sync chat' }, choose: { zh: '不同步', en: 'Do not sync' },
        hint: { zh: '企业微信不提供群成员接口，留空即不同步；名单由人维护。', en: 'WeCom offers no chat-member interface, so this stays empty and the list is maintained by hand.' } },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '企业微信只把人的消息送进回调，所以这张表通常为空；留着以便将来接入机器人之间的消息。', en: 'WeCom delivers people\'s messages to the bot only, so this list is normally empty; it is kept for messages between bots.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'userid', en: 'userid' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = WecomConfigSchema.partial().parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...(config.chats ?? []).map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: !!config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_WECOM_BOT', description: { zh: '企业微信机器人；长连接以它订阅', en: 'The WeCom bot; the long connection subscribes as it' } },
      { key: 'DSH_SUPERAGENT_WECOM_CHAT', description: { zh: '接下工单的企业微信会话；工单不是从企业微信来的时为空', en: 'chat_id of the WeCom chat that started the ticket; empty when the ticket did not start on WeCom' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_WECOM_BOT: deployment.wecom?.botId ?? '', DSH_SUPERAGENT_WECOM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.wecom ? { botId: { zh: `当前机器人 ${deployment.wecom.botId}`, en: `Current bot ${deployment.wecom.botId}` } } : {},
}
/** Returns the WeCom Source's settings, falling back to schema defaults while the WeCom plugin is disabled. */
export const wecomSettings = (sources: SourceRegistry): WecomConfig => sources.instance<WecomConfig>(SOURCE)?.config ?? WecomConfigSchema.parse({})

export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind), 'wecom: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runWecom(sourceContext(ctx.orchestrator, wecomKind), controller.signal)
      .catch((error: unknown) => { ctx.logger.warn('dsh-superagent WeCom stopped: %s', String(error)) })
    return async () => { controller.abort(); await running }
  })
}
