/**
 * Feishu mirror of tickets that started on the local panel. A local ticket has no Feishu conversation, so the operator could
 * neither see its questions and results in Feishu nor answer them there. The mirror gives each such ticket one root message
 * in the operator's direct chat with the bot: the ticket's outbound messages are copied there as replies to it (see
 * `Outbox`), and the operator's replies to it reach the ticket as its own Thread's messages (see `feishu-loops`).
 * It adds no authority: a reply is a person's message on the ticket's Thread, exactly as one typed in the panel.
 */
import { z } from 'zod'
import { key, type ChannelRef } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { feishuChannel, SOURCE } from '../sources/feishu-trigger.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from './store.ts'

/** The Source whose tickets are mirrored: those started on the local panel. */
export const MIRRORED_FROM = 'local'
const Sent = z.looseObject({ message_id: z.string().regex(/^om_[a-zA-Z0-9_-]+$/), chat_id: z.string().regex(/^oc_[a-zA-Z0-9]+$/) })

export interface MirrorHost {
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'get' | 'set' | 'atomic'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'policyPart'>
  readonly commands: Pick<Commands, 'lark'>
  /** True once setup resolved a working Feishu bot. */
  ready(): boolean
}

/** Resolves and creates the Feishu root message of a mirrored ticket. */
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
}
