/** Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing. */
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/** Explicit identifiers, not guesses about natural-language intent. Ambiguous identifiers grant no resumption. */
export function explicitTicketTarget(trigger: Trigger, tickets: readonly Ticket[]): string | undefined {
  const quoted = typeof trigger.meta.quotedTicket === 'string' ? trigger.meta.quotedTicket : ''
  const tokens = quoted ? [quoted] : trigger.text.match(/\b[0-9a-f]{6,64}\b/gi) ?? []
  const matches = tickets.filter(ticket => tokens.some(token => ticket.id.toLowerCase().startsWith(token.toLowerCase())))
  return matches.length === 1 ? matches[0]!.id : undefined
}

/**
 * Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
 * Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
 * ticket's worker decides (see `followupOwners`).
 * Engine delegates trigger reception to this part.
 */
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  receive(received: Trigger): ReceiveResult {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // Track reached tickets and whether they were reached only via context threads (a ticket's own thread makes `context` false).
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    // A WeCom chat is one thread for every ticket ever raised in it, and the Source has no topic object to split them. The
    // operator's rule for that Source: a plain message always asks for new work, and only a quote of a tagged reply
    // (`工单 #<id>`, read into `meta.quotedTicket`) addresses an existing ticket. So a ticket reaches a plain WeCom message
    // only when the quote names it — otherwise the fan-out would hand it to every ticket in the chat and Eval would call it
    // already delivered.
    const quoted = trigger.source === 'wecom' && typeof trigger.meta.quotedTicket === 'string' ? trigger.meta.quotedTicket : ''
    const addressed = (ticketId: string): boolean => trigger.source !== 'wecom' || (!!quoted && ticketId.toLowerCase().startsWith(quoted))
    const target = explicitTicketTarget(trigger, this.repo.tickets.list())
    const feishuChatId = trigger.source === 'feishu' && typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : ''
    const feishuRootId = trigger.source === 'feishu'
      ? (typeof trigger.meta.rootId === 'string' && trigger.meta.rootId ? trigger.meta.rootId : String(trigger.meta.messageId ?? ''))
      : ''
    // Once a ticket that originated in another ticket's Feishu topic has moved to its own dedicated Feishu topic,
    // unaddressed messages in the colliding origin topic must not cross-talk into it (explicitly attached threads stay active).
    const movedToOwnFeishuTopic = (ticket: Ticket, currentThreadKey: string, subscriptions: readonly string[]): boolean => {
      if (!feishuChatId || !feishuRootId || target === ticket.id) return false
      if (!subscriptions.length || subscriptions[0] === ticket.id) return false
      const origin = this.repo.triggers.get(ticket.origin.triggerId)
      if (!origin?.threads.some(ref => threadKey(ref) === currentThreadKey)) return false
      return ticket.channels.some(channel => {
        if (channel.source !== 'feishu' || channel.address.chatId !== feishuChatId) return false
        const dedicatedRoot = channel.address.messageId
        if (!dedicatedRoot || dedicatedRoot === feishuRootId) return false
        return !!this.repo.threads.get(threadKey({ source: 'feishu', id: `${feishuChatId}:${dedicatedRoot}` }))?.subscriptions.includes(ticket.id)
      })
    }
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      for (const ticketId of thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // Only a person's message on a non-context thread resumes an ended ticket; bots and CI do not (the Executor re-reads
        // threads when it resumes), and a human-stopped ticket receives nothing because its Mandate was withdrawn.
        const followed = !!thread.context?.includes(ticketId)
        const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        if (!addressed(ticketId)) continue
        if (movedToOwnFeishuTopic(ticket, thread.key, thread.subscriptions)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    // Shared thread membership is context, not authority to restart ended work. Even a
    // one-word probe formerly resumed every completed ticket subscribed to this chat.
    for (const [id, item] of reached) if (!liveTicket(item.ticket) && id !== target) reached.delete(id)
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.tickets.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
        ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
    }
    const fanout = [...reached.keys()], context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // A person's message that no ticket decides, such as one that reached only tickets a person stopped or that follow the
    // Thread for context, and every bot's, goes to Eval.
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}
