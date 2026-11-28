/**
 * Feishu mirror of tickets that started on the local panel. A local ticket has no Feishu conversation, so the operator could
 * neither see its questions and results in Feishu nor answer them there. The mirror gives each such ticket one root message
 * in the operator's direct chat with the bot: the ticket's outbound messages are copied there as replies to it (see
 * `Outbox`), and the operator's replies to it reach the ticket as its own Thread's messages (see `feishu-loops`).
 * It adds no authority: a reply is a person's message on the ticket's Thread, exactly as one typed in the panel.
 */
import { z } from 'zod'
import { key, threadKey, type ChannelRef } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV, type FeishuTopic } from '../kv.ts'
import { feishuChatLink } from '../sources/feishu-channel.ts'
import { feishuChannel, feishuThreadId, feishuTriggerId, SOURCE } from '../sources/feishu-trigger.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from './store.ts'

/** The Source whose tickets are mirrored: those started on the local panel. */
export const MIRRORED_FROM = 'local'
const Sent = z.looseObject({ message_id: z.string().regex(/^om_[a-zA-Z0-9_-]+$/), chat_id: z.string().regex(/^oc_[a-zA-Z0-9_-]+$/) })

export interface MirrorHost {
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'get' | 'set' | 'atomic'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'policyPart'>
  readonly commands: Pick<Commands, 'lark'>
  /** True once setup resolved a working Feishu bot. */
  ready(): boolean
  /** Bot brand for deep links on newly created Feishu topic threads. */
  brand?(): 'feishu' | 'lark'
}

/** Resolves and creates the Feishu root message of a mirrored ticket and enforces 1-to-1 Feishu topic binding per ticket. */
export class Mirror {
  constructor(private readonly host: MirrorHost) {}

  /** The operator the mirror writes to: the first Feishu user the Policy lets originate work. */
  private operator(): string | undefined { return this.host.sources.policyPart(SOURCE)?.allowed[0]?.id }

  /** Whether outbound messages of the ticket are copied to Feishu: a local ticket, with the Feishu Source on and an operator to write to. */
  eligible(ticketId: string): boolean {
    const { store, sources } = this.host
    const ticket = store.tickets.get(ticketId)
    if (!ticket || store.triggers.get(ticket.origin.triggerId)?.source !== MIRRORED_FROM) return false
    return !!sources.instance(SOURCE)?.enabled && !!this.operator()
  }

  /**
   * The Feishu conversation of the ticket's mirror, created on first use. `waiting` while the bot is not ready or Feishu
   * refuses for now (the caller retries); `none` when the ticket cannot be mirrored.
   */
  async channel(ticketId: string): Promise<ChannelRef | 'waiting' | 'none'> {
    const { store, commands } = this.host
    const known = store.get(KV.feishu.mirror(ticketId))
    if (known) return feishuChannel(known.chatId, known.messageId, known.direct)
    const ticket = store.tickets.get(ticketId)
    const origin = ticket && store.triggers.get(ticket.origin.triggerId)
    const operator = this.operator()
    if (!ticket || !origin || origin.source !== MIRRORED_FROM || !operator) return 'none'
    if (!this.host.ready()) return 'waiting'
    const text = `**本地工单 ${ticket.id.slice(0, 8)}**：${ticket.title}\n\n它的提问和结果会发在这条消息下；回复这条消息，就会回到这张工单。`
    const sent = Sent.parse(await commands.lark(['im', '+messages-send', '--user-id', operator, '--markdown', text,
      '--idempotency-key', key('mirror-root', ticketId).slice(0, 50)]))
    const thread = origin.threads[0]!
    store.atomic(() => {
      const mirror = { ticketId, chatId: sent.chat_id, messageId: sent.message_id, direct: true, thread: { source: thread.source, id: thread.id } }
      store.set(KV.feishu.mirror(ticketId), mirror)
      store.set(KV.feishu.mirrorRoot(sent.message_id), mirror)
      // The operator's direct chat is recovered with the rest, so a reply the live stream missed is still read.
      store.set(KV.feishu.chats, { ...store.get(KV.feishu.chats), [sent.chat_id]: true })
    })
    return feishuChannel(sent.chat_id, sent.message_id, true)
  }

  /**
   * Resolves the dedicated Feishu topic for `ticketId`, ensuring no two tickets share the same Feishu topic:
   * - If `ticketId` is already bound to a topic (or mirror), replies stay strictly inside that topic.
   * - If the target message's topic root is unowned (or owned by `ticketId`), binds it 1-to-1 to `ticketId`.
   * - If the target has no topic yet or its topic root is already owned by another ticket, automatically creates a new
   *   top-level topic root message in that chat, binds it to `ticketId`, subscribes `ticketId` to its thread, and replies there.
   */
  async topic(ticketId: string, channel: ChannelRef): Promise<ChannelRef | 'waiting' | 'none'> {
    const { store, commands } = this.host
    const chatId = channel.address.chatId
    const direct = channel.address.direct === 'true'
    const messageId = channel.address.delivery === 'chat' ? undefined : channel.address.messageId
    const trigger = messageId ? store.triggers.get(feishuTriggerId(messageId)) : undefined
    const triggerRootId = typeof trigger?.meta.rootId === 'string' && trigger.meta.rootId ? trigger.meta.rootId : undefined

    const bound = store.get(KV.feishu.topic(ticketId)) ?? store.get(KV.feishu.mirror(ticketId))
    if (bound) {
      // Preserve quote-reply when the message is already inside this ticket's own bound topic; otherwise redirect to the topic root.
      const insideBoundTopic = chatId === bound.chatId && !!messageId
        && (messageId === bound.messageId || triggerRootId === bound.messageId)
      return feishuChannel(bound.chatId, insideBoundTopic ? messageId : bound.messageId, bound.direct)
    }

    if (!chatId) return 'none'
    const candidateRootId = messageId ? (triggerRootId ?? messageId) : undefined
    const owner = candidateRootId ? this.topicOwner(chatId, candidateRootId) : undefined

    if (candidateRootId && (!owner || owner === ticketId)) {
      const binding: FeishuTopic = { ticketId, chatId, messageId: candidateRootId, direct }
      store.atomic(() => {
        store.set(KV.feishu.topic(ticketId), binding)
        store.set(KV.feishu.topicRoot(candidateRootId), binding)
      })
      return feishuChannel(chatId, messageId!, direct)
    }

    // No topic exists yet, or the target topic already belongs to another ticket: auto-create and bind a dedicated topic.
    const ticket = store.tickets.get(ticketId)
    if (!ticket) return channel
    if (!this.host.ready()) return 'waiting'
    const text = `**工单 ${ticket.id.slice(0, 8)}**：${ticket.title}\n\n本工单的进度、提问和结果会回复在此话题下；回复此消息即可直接跟进本工单。`
    const sent = Sent.parse(await commands.lark([
      'im', '+messages-send', '--chat-id', chatId, '--markdown', text,
      '--idempotency-key', key('feishu-topic-root', ticketId).slice(0, 50),
    ]))
    const binding: FeishuTopic = { ticketId, chatId: sent.chat_id, messageId: sent.message_id, direct }
    const dedicatedChannel = feishuChannel(sent.chat_id, sent.message_id, direct)
    const dedicatedRef = { source: SOURCE, id: feishuThreadId(sent.chat_id, undefined, sent.message_id) }
    const dedicatedKey = threadKey(dedicatedRef)
    store.atomic(() => {
      store.set(KV.feishu.topic(ticketId), binding)
      store.set(KV.feishu.topicRoot(sent.message_id), binding)
      store.set(KV.feishu.chats, { ...store.get(KV.feishu.chats), [sent.chat_id]: direct })
      const existingThread = store.threads.get(dedicatedKey)
      const chatName = store.get(KV.sources.labels(SOURCE))?.[sent.chat_id] ?? sent.chat_id
      const chatFact = direct ? { value: { zh: '私聊', en: 'Direct message' } } : { value: chatName }
      const brand = this.host.brand?.() ?? 'feishu'
      const thread = existingThread ?? {
        key: dedicatedKey,
        ref: dedicatedRef,
        createdAt: new Date().toISOString(),
        subscriptions: [],
        correlated: [],
        pending: [],
        meta: {
          chatId: sent.chat_id,
          messageId: sent.message_id,
          sourceTriggerId: feishuTriggerId(sent.message_id),
          url: feishuChatLink(brand, sent.chat_id),
          facts: { chat: chatFact },
        },
      }
      if (!thread.subscriptions.includes(ticketId)) thread.subscriptions = [...thread.subscriptions, ticketId]
      store.threads.save(thread)
      const current = store.tickets.get(ticketId)
      if (current) {
        const others = current.channels.filter(item => item.source !== SOURCE || item.address.chatId !== chatId)
        store.tickets.save({ ...current, channels: [...others, dedicatedChannel] })
      }
    })
    return dedicatedChannel
  }

  /** Returns the ticket ID that owns the Feishu topic rooted at `rootId` (explicit binding or existing thread owner). */
  private topicOwner(chatId: string, rootId: string): string | undefined {
    const { store } = this.host
    const explicit = store.get(KV.feishu.topicRoot(rootId))?.ticketId ?? store.get(KV.feishu.mirrorRoot(rootId))?.ticketId
    if (explicit) return explicit
    const thread = store.threads.get(threadKey({ source: SOURCE, id: feishuThreadId(chatId, undefined, rootId) }))
    if (!thread?.subscriptions.length) return undefined
    for (const id of thread.subscriptions) {
      const candidate = store.tickets.get(id)
      const origin = candidate && store.triggers.get(candidate.origin.triggerId)
      if (origin?.source === SOURCE && origin.meta.messageId === rootId) return id
    }
    return thread.subscriptions[0]
  }
}
