/** Restore attachment metadata omitted by the CLI's rich-text renderer. Never downloads during intake. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'

const fileSchema = z.object({ file_key: z.string().regex(/^file_[a-zA-Z0-9_-]+$/), file_name: z.string().optional(), is_folder: z.boolean().optional() })
export function withFeishuFiles(text: string, raw: string): string {
  let body: unknown
  try { body = JSON.parse(raw) } catch { return text }
  const parsed = z.object({ files: z.array(z.unknown()).optional() }).safeParse(body)
  if (!parsed.success) return text
  const seen = new Set<string>()
  const files = (parsed.data.files ?? []).flatMap(value => {
    const file = fileSchema.safeParse(value)
    if (!file.success || seen.has(file.data.file_key) || text.includes(file.data.file_key)) return []
    seen.add(file.data.file_key)
    return [file.data]
  })
  return files.length ? `${text}\nFeishu attached files (source metadata): ${JSON.stringify(files)}` : text
}

/** Scope every raw result to its requested message and chat before merging it with rendered text. */
export async function rawFeishuBodies(commands: Commands, chatId: string, ids: string[]): Promise<Map<string, string>> {
  const bodies = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    const result = z.object({ items: z.array(z.object({ message_id: z.string(), chat_id: z.string(), deleted: z.boolean().optional(),
      body: z.object({ content: z.string() }).optional() })) }).parse(await commands.lark([
      'api', 'GET', '/open-apis/im/v1/messages/mget', '--params', JSON.stringify({ message_ids: batch }),
    ]))
    for (const item of result.items) {
      if (!batch.includes(item.message_id) || item.chat_id !== chatId) throw new Error('Feishu returned attachment metadata outside the requested messages or chat')
      bodies.set(item.message_id, item.deleted ? '' : item.body?.content ?? '')
    }
    if (batch.some(id => !bodies.has(id))) throw new Error('Feishu attachment metadata unavailable; message read is incomplete')
  }
  return bodies
}
