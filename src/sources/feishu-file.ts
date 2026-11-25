/** Materializes message-scoped Feishu files for workers, never during intake/assessment. */
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage } from './kind.ts'

const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_FILES = 10
export interface LocalFeishuFile {
  source_message_id: string
  file_key: string
  local_path?: string
  bytes?: number
  download_error?: string
}
export type FileMessage = ContextMessage & { local_files?: LocalFeishuFile[] }

/** The CLI exposes file keys in rendered links; raw history exposes them in JSON. Never treat URLs or filenames as paths. */
export function feishuFileKeys(text: string): string[] {
  return [...new Set(text.match(/\bfile_(?!key\b|name\b|size\b)[a-zA-Z0-9_-]+\b/g) ?? [])]
}

export async function materializeFeishuFiles(commands: Commands, message: ContextMessage, directory: string): Promise<FileMessage> {
  if (message.deleted) return message
  const keys = feishuFileKeys(message.text)
  if (!keys.length) return message
  const local_files: LocalFeishuFile[] = []
  for (const [index, file_key] of keys.entries()) {
    const file: LocalFeishuFile = { source_message_id: message.id, file_key }
    local_files.push(file)
    if (index >= MAX_FILES) {
      file.download_error = `At most ${MAX_FILES} files are downloaded per message; fetch additional required resources explicitly`
      continue
    }
    let temporary: string | undefined
    try {
      const id = z.string().regex(/^om_[a-zA-Z0-9_-]+$/).parse(message.id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      temporary = await mkdtemp(join(directory, 'file-'))
      const result = z.object({ saved_path: z.string() }).parse(await commands.lark([
        'im', '+messages-resources-download', '--message-id', id, '--file-key', file_key,
        '--type', 'file', '--output', './attachment',
      ], temporary))
      const path = await realpath(resolve(temporary, result.saved_path))
      if (dirname(path) !== await realpath(temporary)) throw new Error('File download returned a path outside its download directory')
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('File is not a regular file or exceeds the 100 MiB local file limit')
      file.local_path = path
      file.bytes = info.size
    } catch (error) {
      file.download_error = error instanceof Error ? error.message : String(error)
      if (temporary) await rm(temporary, { recursive: true, force: true })
    }
  }
  return { ...message, local_files }
}
