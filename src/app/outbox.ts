/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import { key, type OutboundMessage, type Outbox as OutboxPort, type ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText, imSummary, imText } from '../infra/text.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Mirror } from './mirror.ts'
import type { Store } from './store.ts'

/** Where a reply's full text goes when it is too long for the IM; inside the project's git-ignored \.temp\, never a tracked folder. */
export const REPORT_DIRECTORY = join('.temp', 'superagent-reports')

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  /** Copies the replies of tickets that started on the local panel into Feishu; without it nothing is mirrored. */
  readonly mirror?: Pick<Mirror, 'eligible' | 'channel'>
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 * A reply to a local-panel ticket is also copied, as a receipt of its own, to the ticket's Feishu topic (see `Mirror`), so
 * that a failing Feishu never holds back the panel's copy.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Feishu's chat limit is checked before a receipt is kept, so a reply that is too long fails visibly instead of silently.
    // Acknowledgements were checked when the decision made them, and other Sources bound their own message lengths.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    // A reply over the IM limit is sent as a summary with the full text written beside the project, rather than refused:
    // a refused message stays pending forever, and the person would never learn what the ticket found.
    if (message.kind === 'reply') message = { ...message, text: imText(message.text, full => this.writeFullText(message.ticketId, full)) }
    const { store, effects } = this.host
    store.atomic(() => {
      if (!store.receipts.add(message)) return
      effects.enqueue('reply', message.id, {})
      this.copy(message)
    })
  }
  /**
   * Writes a reply's full text under the checkout's `.temp/superagent-reports/` and returns the path a person can open;
   * `undefined` on failure. `.temp` is git-ignored in the project, so a report never shows up as an uncommitted change that
   * blocks a ticket's completion or lands in a commit. (It used to be `AICraft/`, which git did not ignore.)
   */
  private writeFullText(ticketId: string | undefined, full: string): string | undefined {
    if (!ticketId) return undefined
    try {
      const dir = join(process.env.DSH_SUPERAGENT_WORKSPACE || process.cwd(), REPORT_DIRECTORY)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `ticket-${ticketId.slice(0, 8)}-report.md`)
      writeFileSync(file, `# 工单 ${ticketId}\n\n${full}\n`, 'utf8')
      return file
    } catch {
      return undefined
    }
  }
  /** Queue the Feishu copy of a reply to a local-panel ticket; its address names the ticket, whose topic is made when it is sent. */
  private copy(message: OutboundMessage): void {
    const { store, effects, mirror } = this.host
    if (!mirror || message.kind !== 'reply' || message.channel.source !== 'local' || !message.ticketId || !mirror.eligible(message.ticketId)) return
    const id = key('mirror', message.id)
    const channel = { source: 'feishu', thread: `feishu:mirror:${message.ticketId}`, address: { mirror: message.ticketId } }
    if (store.receipts.add({ id, channel, text: imSummary(message.text), kind: 'reply', ticketId: message.ticketId })) effects.enqueue('reply', id, {})
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => {
      for (const target of [id, key('mirror', id)]) if (store.receipts.withdraw(target)) effects.cancel('reply', target)
    })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands, mirror } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    let target = receipt
    const mirrored = receipt.channel.address.mirror
    if (mirrored) {
      // The topic of a mirrored ticket is made on first use; it lies in the operator's direct chat, which the bot reaches by user ID.
      if (!mirror) throw new Later('The Feishu mirror is not available')
      const channel = await mirror.channel(mirrored)
      if (channel === 'waiting') throw new Later('The Feishu bot is not ready')
      if (channel === 'none') { store.receipts.settle(receipt, 'channelGone'); return }
      target = { ...receipt, channel }
    } else if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await sources.send(target, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
