/** Loopback operator source: real Engine intake and durable, idempotent local replies. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { OutboundMessage, ReceiveResult, Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const LOCAL = 'local'
export const LocalId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const LocalMessageRequest = z.object({ id: LocalId, text: z.string().trim().min(1).max(24000), thread: LocalId.optional() }).strict()
export interface LocalMessage { id: string; thread: string; from: 'operator' | 'agent'; at: string; text: string; kind?: OutboundMessage['kind']; ticketId?: string }
export interface LocalReceipt { id: string; thread: string; triggerId: string; result: ReceiveResult }
/** A retry reused a message ID for different immutable input; the HTTP API reports a conflict. */
export class LocalConflict extends Error {}
// Source-owned typed keys, intentionally separate from core KV families.
const messages = family<LocalMessage[]>('local-messages:')
export function localMessages(host: Pick<SourceContext, 'state'>, thread: string): LocalMessage[] {
  return host.state.get(messages(LocalId.parse(thread))) ?? []
}
function append(host: Pick<SourceContext, 'state' | 'atomic'>, message: LocalMessage): void {
  host.atomic(() => {
    const saved = localMessages(host, message.thread)
    if (!saved.some(item => item.id === message.id && item.from === message.from)) host.state.set(messages(message.thread), [...saved, message])
  })
}
/** Intake receipt is not acceptance: only the ordinary Eval may create a Ticket. */
export async function receiveLocal(host: SourceContext, body: unknown): Promise<LocalReceipt> {
  const input = LocalMessageRequest.parse(body), thread = input.thread ?? input.id
  const triggerId = `local:message:${input.id}`
  const previous = host.triggers.get(triggerId)
  if (previous && (previous.text !== input.text || previous.threads[0]?.id !== thread)) throw new LocalConflict('Message ID already used with different text or thread')
  const trigger: Trigger = previous ?? { id: triggerId, source: LOCAL, threads: [{ source: LOCAL, id: thread }],
    actor: { source: LOCAL, id: 'operator' }, human: true, addressed: 'direct', at: new Date().toISOString(), text: input.text,
    channel: { source: LOCAL, thread, address: { thread } }, meta: { messageId: input.id } }
  // Engine deduplicates by trigger ID; replay also repairs a transcript write interrupted after intake.
  const result = await host.receive(trigger)
  append(host, { id: input.id, thread, from: 'operator', at: trigger.at, text: trigger.text })
  return { id: input.id, thread, triggerId, result }
}
export function localKind(host: SourceContext): SourceKind {
  return {
    kind: LOCAL, title: { zh: '本地任务', en: 'Local tasks' },
    description: { zh: '通过本机面板发起任务并接收回复；仍需策略准入和评估。', en: 'Submit tasks and read replies through the local panel; Policy and Eval still apply.' },
    schema: z.object({}).strict(), fields: [], health: [],
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: LocalId, name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的本地用户', en: 'Local users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
      explicit: { zh: '面板请求以 operator 身份直接发给智能体。', en: 'Panel requests directly address the agent as operator.' },
    },
    channel: {
      allowed: address => LocalId.safeParse(address.thread).success,
      async send(_context, message) {
        const thread = LocalId.parse(message.channel.address.thread)
        append(host, { id: message.id, thread, from: 'agent', at: new Date().toISOString(), text: message.text,
          kind: message.kind, ...message.ticketId ? { ticketId: message.ticketId } : {} })
        return 'sent'
      },
      link: address => ({ url: `/orchestrator/threads/${encodeURIComponent(`local:${address.thread}`)}`, label: { zh: '本地任务', en: 'Local task' } }),
    },
    threadContext: {
      messageId: trigger => String(trigger.meta.messageId),
      async read(_commands, trigger, part) {
        const all = localMessages(host, trigger.threads[0]!.id)
        const selected = part === 'root' ? all.slice(0, 1) : part === 'parent' ? [] : all.slice(-100)
        return { messages: selected.map(item => ({ id: item.id, from: item.from, at: item.at, text: item.text, ...item.from === 'agent' ? { bot: true as const } : {} })), body: {} }
      },
    },
  }
}
export const name = 'dsh-superagent-local'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(localKind(ctx.orchestrator.context({ kind: LOCAL, health: [] }))), 'local: source kind')
}
