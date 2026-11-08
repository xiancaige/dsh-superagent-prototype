import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuCommands, type FeishuCommandsHost } from '../src/app/feishu-commands.ts'
import { receive } from '../src/sources/feishu-loops.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuTrigger } from '../src/sources/feishu-trigger.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger, OutboundMessage } from '../src/core/index.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function fixture() {
  const values = new Map(), replies: { text: string }[] = []
  let settings = SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_operator' }] } } } })
  const cancel = vi.fn(), prompt = vi.fn(), selectModel = vi.fn(), resolveCallConfig = vi.fn(async (model: object) => model)
  const save = vi.fn(async (block: 'eval' | 'executor', value) => { settings = { ...settings, [block]: value } })
  const host = {
    context: { llm: { resolveCallConfig }, sessionController: {
      modelCatalog: vi.fn(async () => ({ groups: [{ id: 'provider', models: [{ id: 'model' }] }], default: { provider: 'provider', model: 'default' } })),
      resolveAgent: vi.fn(async () => ({ agent: { cancel } })), selectModel,
    } },
    store: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), atomic: <T>(work: () => T) => work(), settings: () => settings,
      tickets: { open: () => [{ id: 'ticket' }], get: (id: string) => id === 'ticket' ? { id } : undefined } },
    sources: { scope: () => ({ listened: true }) },
    settings: { block: (block: 'eval' | 'executor') => ({ value: settings[block], revision: 0 }), save },
    sessions: { modelRetry: () => ({}), prompt }, outbox: { send: (reply: OutboundMessage) => replies.push(reply) }, masterId: 'master',
  } as unknown as FeishuCommandsHost
  const trigger = (text: string, id = 'om_one') => feishuTrigger({ message_id: id, chat_id: 'oc_chat', chat_type: 'p2p', sender_id: 'ou_operator',
    sender_type: 'user', content: text, create_time: '1794140000000' }, 'ou_bot', 'cli_bot')!
  return { host, trigger, replies, save, cancel, selectModel, resolveCallConfig, prompt, values }
}
it('routes ordinary requests unchanged and consumes commands before mirrored-thread rewriting', async () => {
  const { host, trigger } = fixture(), commands = new FeishuCommands(host)
  expect(await commands.receive(trigger('实现新功能'))).toBe(false)
  const context = { command: (t: Trigger) => commands.receive(t), receive: vi.fn(), state: { get: vi.fn() } } as unknown as SourceContext
  await receive(context, trigger('/model'))
  expect(context.receive).not.toHaveBeenCalled()
  expect(context.state.get).not.toHaveBeenCalled()
})
it('requires a listed human, addressed message, and listened scope even on subscribed threads', async () => {
  const { host, trigger, selectModel, replies } = fixture(), commands = new FeishuCommands(host), good = trigger('/model p m')
  for (const bad of [{ ...good, human: false }, { ...good, actor: { source: 'feishu', id: 'ou_stranger' } }, { ...good, addressed: undefined }]) {
    expect(await commands.receive(bad)).toBe(true)
  }
  host.sources.scope = () => ({ listened: false, reason: 'off' })
  expect(await commands.receive(good)).toBe(true)
  expect(selectModel).not.toHaveBeenCalled(); expect(replies).toHaveLength(0)
})
it('lists catalog without any generation and supports /mode alias and duplicate delivery', async () => {
  const { host, trigger, replies, save, selectModel, cancel } = fixture(), commands = new FeishuCommands(host)
  await commands.receive(trigger('/model'))
  expect(replies[0]!.text).toContain('provider model')
  const change = trigger('/mode other new-model', 'om_change')
  await Promise.all([commands.receive(change), commands.receive(change)])
  expect(save).toHaveBeenCalledTimes(2)
  expect(selectModel.mock.calls.map(call => call[0].sessionId)).toEqual(['master', 'worker-ticket'])
  expect(replies).toHaveLength(2)
  expect(cancel).not.toHaveBeenCalled()
  await new FeishuCommands(host).receive(change)
  expect(save).toHaveBeenCalledTimes(2)
})
it('switches only the specified ticket, and resumes quota waiting but never productive work', async () => {
  const { host, trigger, save, cancel, prompt, selectModel } = fixture()
  host.sessions.modelRetry = () => ({ model_retry: {} }) as never
  await new FeishuCommands(host).receive(trigger('/model p m ticket'))
  expect(save).not.toHaveBeenCalled()
  expect(selectModel).toHaveBeenCalledWith({ sessionId: 'worker-ticket', provider: 'p', model: 'm' })
  expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  expect(prompt).toHaveBeenCalledTimes(1)
})
it('rejects unavailable models and invalid targets without saving or selecting', async () => {
  const { host, trigger, save, selectModel, resolveCallConfig, replies } = fixture(), commands = new FeishuCommands(host)
  resolveCallConfig.mockRejectedValueOnce(new Error('unavailable'))
  await commands.receive(trigger('/model bad missing'))
  await commands.receive(trigger('/model p m unknown', 'om_unknown'))
  expect(save).not.toHaveBeenCalled(); expect(selectModel).not.toHaveBeenCalled()
  expect(replies.every(reply => reply.text.includes('命令未完成'))).toBe(true)
})
it('reads TODO details across blank index gaps, strips checkpoints, rejects traversal and symlinks', async () => {
  const { host, trigger, replies } = fixture(), root = await mkdtemp(join(tmpdir(), 'feishu-commands-'))
  roots.push(root); host.root = root
  await mkdir(join(root, 'plans', 'todo'), { recursive: true })
  await writeFile(join(root, 'plans', 'TODO.md'), '| 1 | First | [one](todo/one.md) |\n\n| 2 | Second | [two](todo/two.md) |\n| 3 | Escape | [x](../secret.md) |')
  await writeFile(join(root, 'plans', 'todo', 'two.md'), '# Second\nDetails\n<!-- walk-checkpoint hidden -->')
  await writeFile(join(root, 'secret.md'), 'secret')
  const commands = new FeishuCommands(host)
  await commands.receive(trigger('/todo'))
  expect(replies.at(-1)!.text).toContain('#2 Second')
  await commands.receive(trigger('todo 2', 'om_two'))
  expect(replies.at(-1)!.text).toContain('Details'); expect(replies.at(-1)!.text).not.toContain('hidden')
  await commands.receive(trigger('/todo 3', 'om_three'))
  expect(replies.at(-1)!.text).toContain('越界'); expect(replies.at(-1)!.text).not.toContain('secret')
  await symlink(join(root, 'secret.md'), join(root, 'plans', 'todo', 'link.md'))
  await writeFile(join(root, 'plans', 'TODO.md'), '| 4 | Link | [link](todo/link.md) |')
  await commands.receive(trigger('/todo 4', 'om_four'))
  expect(replies.at(-1)!.text).toContain('越界')
})
