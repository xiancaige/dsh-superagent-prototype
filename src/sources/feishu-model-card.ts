/** lark-cli card and bot-menu projections. The CLI's SDK acknowledges callbacks within three seconds.
 * Each event has one consumer; model choices still run in the deterministic command service, never intake.
 */
import { z } from 'zod'
import { key } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'

/** Where a model card goes: the chat a command came from, or the operator's own bot chat (a menu click names no chat). */
export interface ModelCardTarget { id: string; chatId?: string; userId?: string }
/** Exact JSON passthrough uses the same interactive message endpoint as the legacy SDK adapter. */
export async function sendModelCard(commands: Pick<Commands, 'lark'>, target: ModelCardTarget, card: object): Promise<void> {
  const to = target.chatId ? ['--chat-id', target.chatId] : target.userId ? ['--user-id', target.userId] : undefined
  if (!to) throw new Error('Missing model card target')
  await commands.lark(['im', '+messages-send', ...to, '--msg-type', 'interactive', '--content', JSON.stringify(card),
    '--idempotency-key', key('model-card', target.id)])
}
const CardEvent = z.object({ type: z.literal('card.action.trigger'), operator_id: z.string().min(1),
  chat_id: z.string().min(1), action_value: z.string(), token: z.string().min(1) })
export function modelCardAction(input: unknown): unknown | undefined {
  const event = CardEvent.safeParse(input)
  if (!event.success) return
  let value: unknown
  try { value = JSON.parse(event.data.action_value) } catch { return }
  return { token: event.data.token, operator: { open_id: event.data.operator_id },
    context: { open_chat_id: event.data.chat_id }, action: { value } }
}
const MenuEvent = z.object({ type: z.literal('application.bot.menu_v6'), event_key: z.string().min(1),
  operator_id: z.string().min(1), event_id: z.string().min(1) })
/** The CLI's flat bot-menu event, or undefined when it is not one. It names the operator but no chat. */
export function modelMenuAction(input: unknown): { key: string; operator: string; id: string } | undefined {
  const event = MenuEvent.safeParse(input)
  if (!event.success) return
  return { key: event.data.event_key, operator: event.data.operator_id, id: event.data.event_id }
}
