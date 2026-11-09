/** lark-cli card callback projection. The CLI's SDK acknowledges callbacks within three seconds.
 * Each event has one consumer; model choices still run in the deterministic command service, never intake.
 */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'

/** Exact JSON passthrough uses the same interactive message endpoint as the legacy SDK adapter. */
export async function sendModelCard(commands: Pick<Commands, 'lark'>, trigger: Trigger, card: object): Promise<void> {
  const chatId = trigger.channel?.address.chatId
  if (!chatId) throw new Error('Missing model card chat')
  await commands.lark(['im', '+messages-send', '--chat-id', chatId, '--msg-type', 'interactive', '--content', JSON.stringify(card),
    '--idempotency-key', key('model-card', trigger.id)])
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
