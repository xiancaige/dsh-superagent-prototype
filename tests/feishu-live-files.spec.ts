import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { SourceContext } from '../src/sources/host.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { triggerMessage } from '../src/executor/dsh.ts'
import type { Trigger } from '../src/core/index.ts'

const transport = vi.hoisted(() => ({ start: undefined as (() => unknown) | undefined }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => transport.start!()) }))
afterEach(() => vi.restoreAllMocks())

function fixture(hold = false) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: { end: vi.fn() }, kill: vi.fn(() => { child.emit('close', 0); return true }) })
  transport.start = () => {
    queueMicrotask(() => {
      child.stderr.write('[event] ready\n')
      child.stdout.write(JSON.stringify({ message_id: 'om_file', chat_id: 'oc_chat', chat_type: 'p2p',
        sender_id: 'ou_user', sender_type: 'user', content: 'calculate moke.txt', create_time: '1795597038624' }) + '\n')
    })
    return child
  }
  let enabled = true, release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  const lark = vi.fn(async (args: string[]) => {
    if (args[0] === 'im') return { chats: [] }
    if (hold) await waiting
    return { items: [{ message_id: 'om_file', chat_id: 'oc_chat', body: { content: JSON.stringify({
      content: [[{ tag: 'text', text: 'calculate moke.txt' }]], files: [{ file_key: 'file_v3_live', file_name: 'moke.txt' }],
    }) } }] }
  })
  const records = new Map()
  const receive = vi.fn(async (_trigger: Trigger) => 'stored')
  const commands = { lark, withSignal: () => commands }
  const ctx = { ready: Promise.resolve(), configured: () => true, deployment: { feishu: { cli: 'fake-bot', botId: 'ou_bot', appId: 'cli_bot' } },
    config: () => enabled ? { chats: [], directMessages: true } : undefined, commands, report: vi.fn(), receive,
    state: { get: (key: string) => records.get(key), set: (key: string, value: unknown) => records.set(key, value) },
    threads: { subscribed: () => [], describe: vi.fn() }, triggers: { latest: () => undefined },
  } as unknown as SourceContext
  return { ctx, lark, receive, disable: () => { enabled = false }, release: () => release!() }
}
it('restores CLI-hidden files before live main intake and worker trigger delivery, without downloading', async () => {
  const f = fixture(), controller = new AbortController()
  const running = runFeishu(f.ctx, controller.signal)
  try {
    await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce())
    const trigger = f.receive.mock.calls[0]![0]
    expect(trigger.text).toContain('file_v3_live')
    expect(triggerMessage(trigger, {}).text).toContain('moke.txt')
    expect(f.lark.mock.calls.some(([args]) => args.includes('+messages-resources-download'))).toBe(false)
  } finally { controller.abort(); await running }
})
it('does not deliver an event when the Source is disabled during raw metadata lookup', async () => {
  const f = fixture(true), controller = new AbortController()
  const running = runFeishu(f.ctx, controller.signal)
  try {
    await vi.waitFor(() => expect(f.lark.mock.calls.some(([args]) => args[0] === 'api')).toBe(true))
    f.disable(); f.release()
  } finally { controller.abort(); await running }
  expect(f.receive).not.toHaveBeenCalled()
})
