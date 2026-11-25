import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readResource, type ResourceHost } from '../src/app/resources.ts'
import { TextCache } from '../src/app/cache.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'feishu-resource-test-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
function fixture(chat = 'oc_chat', post = false) {
  const source = { message_id: 'om_source', chat_id: chat, ...post ? { body: { content: JSON.stringify({ title: '',
    content: [[{ tag: 'text', text: 'calculate' }]], files: [{ file_key: 'file_v3_test', file_name: 'moke.txt' }] }) } } : {} }
  const trigger = { id: 'source', source: 'feishu', meta: { chatId: 'oc_chat', messageId: 'om_source' } }
  const ticket = { id: 'ticket', origin: { triggerId: 'source' } }
  const commands = new Commands(() => testDeployment({ stateDir: root }), {}, new AbortController().signal)
  const lark = vi.spyOn(commands, 'lark').mockImplementation(async (args, cwd) => {
    if (args[0] === 'api') return { items: [source] } as never
    if (args[1] === '+messages-mget') return { messages: [{ ...source, msg_type: post ? 'post' : 'file', content: post ? 'calculate attached file' : '[说明.txt](file_v3_test)', sender: { id: 'ou_user', sender_type: 'user' }, create_time: '2026-11-25T08:00:00Z' }] } as never
    await writeFile(join(cwd!, 'attachment.txt'), 'local file contents')
    return { saved_path: join(cwd!, 'attachment.txt') } as never
  })
  const host = { commands, masterId: 'master', pages: new TextCache(100000), feishuPageSize: () => 20,
    store: { triggers: { get: () => trigger }, tickets: { get: (id: string) => id === 'ticket' ? ticket : undefined } } } as unknown as ResourceHost
  return { host, lark }
}
it('authorized worker reads download first and return readable local paths; pagination does not redownload', async () => {
  const { host, lark } = fixture()
  const page = await readResource(host, 'feishu/source/message', 0, 8000, 'ticket') as { text: string }
  const body = JSON.parse(page.text)
  expect(body.message.local_files[0].source_message_id).toBe('om_source')
  expect(await readFile(body.message.local_files[0].local_path, 'utf8')).toBe('local file contents')
  expect(body.message.local_files[0].local_path).toContain(join('feishu-files', 'ticket'))
  await readResource(host, 'feishu/source/message', 1, 8000, 'ticket')
  expect(lark).toHaveBeenCalledTimes(3)
})
it('restores CLI-hidden post files for main and materializes the same attachment on authorized worker read', async () => {
  const { host, lark } = fixture('oc_chat', true)
  const main = JSON.parse((await readResource(host, 'feishu/source/message', 0, 8000) as { text: string }).text)
  expect(main.message.text).toContain('moke.txt')
  expect(main.message.text).toContain('file_v3_test')
  expect(main.message.local_files).toBeUndefined()
  const worker = JSON.parse((await readResource(host, 'feishu/source/message', 0, 8000, 'ticket') as { text: string }).text)
  expect(await readFile(worker.message.local_files[0].local_path, 'utf8')).toBe('local file contents')
  expect(worker.message.local_files[0].source_message_id).toBe('om_source')
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-resources-download'))).toHaveLength(1)
})
it('main context reads do not download; worker authorization and source-chat checks precede downloads', async () => {
  const { host, lark } = fixture()
  const page = await readResource(host, 'feishu/source/message', 0, 8000) as { text: string }
  expect(JSON.parse(page.text).message.local_files).toBeUndefined()
  expect(lark).toHaveBeenCalledTimes(2)
  await expect(readResource(host, 'feishu/source/message', 0, 8000, 'other')).rejects.toThrow()
  expect(lark).toHaveBeenCalledTimes(2)
  const outside = fixture('oc_elsewhere')
  await expect(readResource(outside.host, 'feishu/source/message', 0, 8000, 'ticket')).rejects.toThrow('chat does not match')
  expect(outside.lark).toHaveBeenCalledTimes(1)
})
