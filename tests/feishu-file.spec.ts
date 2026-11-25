import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Commands } from '../src/infra/commands.ts'
import { feishuFileKeys, materializeFeishuFiles } from '../src/sources/feishu-file.ts'
import { testDeployment } from './fixtures/deployment.ts'

let root: string
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const message = { id: 'om_file', from: 'User', at: '2026-11-25T08:25:00Z', text: '[需求说明.txt](file_v3_test)' }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'feishu-file-test-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it('extracts and deduplicates rendered and raw file keys without using filenames as paths', () => {
  expect(feishuFileKeys('[../危险.txt](file_v3_test) {"file_key":"file_v3_test"} file_other img_one'))
    .toEqual(['file_v3_test', 'file_other'])
})
it('downloads to a persistent absolute local path before returning it to the model', async () => {
  const lark = vi.spyOn(commands, 'lark').mockImplementation(async (_args, cwd) => {
    await writeFile(join(cwd!, 'attachment.txt'), '依据文件进行分析，不自动执行')
    return { saved_path: 'attachment.txt' } as never
  })
  const result = await materializeFeishuFiles(commands, message, root)
  const file = result.local_files![0]!
  expect(file).toMatchObject({ source_message_id: 'om_file', file_key: 'file_v3_test', bytes: Buffer.byteLength('依据文件进行分析，不自动执行') })
  expect(await readFile(file.local_path!, 'utf8')).toBe('依据文件进行分析，不自动执行')
  expect(lark.mock.calls[0]![0]).toEqual(['im', '+messages-resources-download', '--message-id', 'om_file', '--file-key', 'file_v3_test', '--type', 'file', '--output', './attachment'])
  expect(result.text).toBe(message.text)
})
it('does not download deleted messages, images or plain messages', async () => {
  const lark = vi.spyOn(commands, 'lark')
  for (const row of [{ ...message, deleted: true as const }, { ...message, text: 'img_one' }, { ...message, text: 'hello' }]) {
    expect(await materializeFeishuFiles(commands, row, root)).toEqual(row)
  }
  expect(lark).not.toHaveBeenCalled()
})
it('returns explicit errors without local paths and cleans failed transfers', async () => {
  vi.spyOn(commands, 'lark').mockRejectedValue(new Error('permission denied'))
  const result = await materializeFeishuFiles(commands, message, root)
  expect(result.local_files).toEqual([{ source_message_id: 'om_file', file_key: 'file_v3_test', download_error: 'permission denied' }])
  expect(await readdir(root)).toEqual([])
})
it('rejects escaped paths without deleting the outside file', async () => {
  const outside = join(root, 'outside.txt')
  await writeFile(outside, 'outside')
  vi.spyOn(commands, 'lark').mockResolvedValue({ saved_path: outside })
  const result = await materializeFeishuFiles(commands, message, root)
  expect(result.local_files![0]!.download_error).toContain('outside')
  expect(result.local_files![0]!.local_path).toBeUndefined()
  expect(await readFile(outside, 'utf8')).toBe('outside')
})
it('rejects oversized files and cleans them without reading bytes into model context', async () => {
  vi.spyOn(commands, 'lark').mockImplementation(async (_args, cwd) => {
    const path = join(cwd!, 'attachment.bin')
    await writeFile(path, '')
    await truncate(path, 100 * 1024 * 1024 + 1)
    return { saved_path: path } as never
  })
  const result = await materializeFeishuFiles(commands, message, root)
  expect(result.local_files![0]!.download_error).toContain('100 MiB')
  expect(await readdir(root)).toEqual([])
})
it('limits per-message downloads and identifies untransferred files explicitly', async () => {
  const lark = vi.spyOn(commands, 'lark').mockRejectedValue(new Error('unavailable'))
  const result = await materializeFeishuFiles(commands, { ...message, text: Array.from({ length: 11 }, (_, i) => `file_${i}`).join(' ') }, root)
  expect(lark).toHaveBeenCalledTimes(10)
  expect(result.local_files![10]!.download_error).toContain('At most 10')
})
