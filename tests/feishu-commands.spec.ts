import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModelCard, FeishuCommands, type FeishuCommandsHost } from '../src/app/feishu-commands.ts'
import { receive } from '../src/sources/feishu-loops.ts'
import { modelCardAction, modelMenuAction, sendModelCard as sendCard } from '../src/sources/feishu-model-card.ts'
import { sendFeishu } from '../src/sources/feishu-channel.ts'
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
it('renders an interactive JSON 2.0 model-selection card with provider/model callback values', () => {
  const card = buildModelCard({ groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }], default: { provider: 'provider', model: 'model' }, routableProviders: [], failures: [] }, { provider: 'provider', model: 'model' }) as { schema: string; body: { elements: { tag: string; type?: string; text?: { content: string }; behaviors?: { value: unknown }[] }[] } }
  expect(card.schema).toBe('2.0')
  const button = card.body.elements.find(element => element.tag === 'button')!
  expect(button.type).toBe('primary')
  expect(button.text?.content).toContain('provider / model')
  expect(button.behaviors?.[0]?.value).toEqual({ cmd: 'model', provider: 'provider', model: 'model' })
})
it('uses the legacy callback shape and preserves owner checks before model selection', async () => {
  const { host, trigger, selectModel, save } = fixture()
  const command = new FeishuCommands(host)
  await command.receive(trigger('/model provider model'))
  expect(save).toHaveBeenCalledTimes(2)
  expect(selectModel).toHaveBeenCalledWith({ sessionId: 'master', provider: 'provider', model: 'model' })
})
it('routes ordinary requests unchanged and consumes commands before mirrored-thread rewriting', async () => {
  const { host, trigger } = fixture(), commands = new FeishuCommands(host)
  expect(await commands.receive(trigger('实现新功能'))).toBe(false)
  const context = { command: (t: Trigger) => commands.receive(t), receive: vi.fn(), state: { get: vi.fn() } } as unknown as SourceContext
  await receive(context, trigger('/model'))
  expect(context.receive).not.toHaveBeenCalled()
  expect(context.state.get).not.toHaveBeenCalled()
})
it('sends /model cards directly in the triggering chat', async () => {
  const { host, trigger, replies } = fixture(), sendModelCard = vi.fn(async () => {})
  host.sendModelCard = sendModelCard
  await new FeishuCommands(host).receive(trigger('/model'))
  expect(sendModelCard).toHaveBeenCalledOnce()
  expect(sendModelCard).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_chat' }), expect.any(Object))
  expect(replies).toHaveLength(0)
})
it('normalizes real CLI clicks, survives restart, deduplicates clicks and checks operator/chat/catalog/scope', async () => {
  const { host, trigger, save, selectModel, replies } = fixture()
  let card: any
  host.sendModelCard = async (_trigger, value) => { card = value }
  const commands = new FeishuCommands(host)
  await commands.receive(trigger('/model'))
  await commands.receive(trigger('/model'))
  const value = card.body.elements.find((element: any) => element.tag === 'button').behaviors[0].value
  expect(value.request).toEqual(expect.any(String))
  const event = { type: 'card.action.trigger', operator_id: 'ou_operator', chat_id: 'oc_chat', token: 'click1', action_value: JSON.stringify(value) }
  const resumed = new FeishuCommands(host)
  expect(await resumed.cardAction(modelCardAction({ ...event, operator_id: 'ou_stranger' }))).toBe(false)
  expect(await resumed.cardAction(modelCardAction({ ...event, chat_id: 'oc_else' }))).toBe(false)
  expect(await resumed.cardAction(modelCardAction({ ...event, action_value: JSON.stringify({ ...value, model: 'missing' }) }))).toBe(false)
  expect(await resumed.cardAction(modelCardAction({ ...event, action_value: '{' }))).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(await resumed.cardAction(modelCardAction(event))).toBe(true)
  expect(await resumed.cardAction(modelCardAction(event))).toBe(true)
  expect(save).toHaveBeenCalledTimes(2)
  expect(selectModel).toHaveBeenCalledTimes(2)
  expect(replies).toHaveLength(1)
  expect((replies[0] as OutboundMessage).channel.address.delivery).toBe('chat')
  host.sources.scope = () => ({ listened: false, reason: 'off' })
  expect(await resumed.cardAction(modelCardAction({ ...event, token: 'click2' }))).toBe(false)
})
it('normalizes the real CLI bot-menu event, which names the operator but no chat', () => {
  const event = { type: 'application.bot.menu_v6', event_key: 'model', operator_id: 'ou_operator', event_id: 'ev1', operator_name: 'x' }
  expect(modelMenuAction(event)).toEqual({ key: 'model', operator: 'ou_operator', id: 'ev1' })
  expect(modelMenuAction({ ...event, type: 'card.action.trigger' })).toBeUndefined()
  expect(modelMenuAction({ ...event, operator_id: '' })).toBeUndefined()
})
it('answers the /model menu with a card to the operator, and lets only that person use it', async () => {
  const { host, selectModel, save, replies } = fixture()
  let sent: { target: any; card: any } | undefined
  host.sendModelCard = async (target, card) => { sent = { target, card } }
  const commands = new FeishuCommands(host)
  const menu = { key: 'model', operator: 'ou_operator', id: 'ev1' }
  // A stranger, another key, or direct messages being off get nothing.
  expect(await commands.menuAction({ ...menu, operator: 'ou_stranger' })).toBe(false)
  expect(await commands.menuAction({ ...menu, key: 'todo' })).toBe(false)
  host.sources.scope = () => ({ listened: false, reason: 'direct_messages_not_allowed' })
  expect(await commands.menuAction(menu)).toBe(false)
  expect(sent).toBeUndefined()
  host.sources.scope = () => ({ listened: true, observed: false })
  expect(await commands.menuAction(menu)).toBe(true)
  expect(await commands.menuAction(menu)).toBe(true) // the same event delivered twice sends one card
  expect(sent!.target).toEqual({ id: 'ev1', userId: 'ou_operator' })
  const value = sent!.card.body.elements.find((e: any) => e.tag === 'button').behaviors[0].value
  const click = (operator_id: string, token: string, chat_id = 'oc_dm') => modelCardAction({ type: 'card.action.trigger', operator_id, chat_id, token, action_value: JSON.stringify(value) })
  // The menu names no chat, so the click's own chat is accepted — but only from the person the card was sent to.
  expect(await commands.cardAction(click('ou_stranger', 't0'))).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(await commands.cardAction(click('ou_operator', 't1'))).toBe(true)
  expect(selectModel).toHaveBeenCalled()
  expect((replies.at(-1) as OutboundMessage).channel.address).toMatchObject({ chatId: 'oc_dm', delivery: 'chat', direct: 'true' })
})
it('starts a bot-menu consumer only where the host handles menu clicks', async () => {
  const { runFeishu } = await import('../src/sources/feishu-loops.ts')
  const reports: number[] = []
  for (const menuAction of [undefined, async () => true]) {
    const ctx = { ready: Promise.resolve(), configured: () => false, report: vi.fn(), problem: undefined, deployment: {}, config: () => undefined, state: { get: vi.fn(), set: vi.fn() }, ...menuAction ? { menuAction } : {} } as unknown as SourceContext
    const controller = new AbortController(); controller.abort()
    await runFeishu(ctx, controller.signal)
    reports.push((ctx.report as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[0] === 'feishu').length)
  }
  expect(reports[1]! - reports[0]!).toBe(1)
})
it('sends a card to a chat, or to a user when only the operator is known', async () => {
  const lark = vi.fn(async (_args: string[]) => ({}))
  await sendCard({ lark } as never, { id: 'a', chatId: 'oc_x' }, { c: 1 })
  await sendCard({ lark } as never, { id: 'b', userId: 'ou_x' }, { c: 1 })
  expect(lark.mock.calls[0]![0]).toEqual(expect.arrayContaining(['--chat-id', 'oc_x', '--msg-type', 'interactive']))
  expect(lark.mock.calls[1]![0]).toEqual(expect.arrayContaining(['--user-id', 'ou_x', '--msg-type', 'interactive']))
  await expect(sendCard({ lark } as never, { id: 'c' }, {})).rejects.toThrow('Missing model card target')
})
it('reports a rejected selection into the chat and keeps the card usable', async () => {
  const { host, trigger, replies, resolveCallConfig } = fixture()
  let card: any
  host.sendModelCard = async (_t, value) => { card = value }
  const commands = new FeishuCommands(host)
  await commands.receive(trigger('/model'))
  const value = card.body.elements.find((e: any) => e.tag === 'button').behaviors[0].value
  const click = (token: string) => modelCardAction({ type: 'card.action.trigger', operator_id: 'ou_operator', chat_id: 'oc_chat', token, action_value: JSON.stringify(value) })
  resolveCallConfig.mockRejectedValueOnce(new Error('unavailable'))
  expect(await commands.cardAction(click('bad'))).toBe(true)
  expect(replies.at(-1)!.text).toContain('命令未完成')
  expect(await commands.cardAction(click('good'))).toBe(true)
  expect(replies.at(-1)!.text).toContain('已切换')
})
it('does not start a card consumer unless the host handles card actions', async () => {
  const { runFeishu } = await import('../src/sources/feishu-loops.ts')
  const ready = Promise.resolve()
  const reports: number[] = []
  for (const cardAction of [undefined, async () => true]) {
    const ctx = { ready, configured: () => false, report: vi.fn(), problem: undefined, deployment: {}, config: () => undefined, state: { get: vi.fn(), set: vi.fn() }, ...cardAction ? { cardAction } : {} } as unknown as SourceContext
    const controller = new AbortController(); controller.abort()
    await runFeishu(ctx, controller.signal)
    reports.push((ctx.report as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[0] === 'feishu').length)
  }
  // Without a handler no extra consumer exists; with one, exactly one more consumer loop starts.
  expect(reports[1]! - reports[0]!).toBe(1)
})
it('sends failures and selection confirmations to the chat, not a new topic', async () => {
  const { host, trigger, replies } = fixture()
  host.sendModelCard = async () => { throw new Error('rejected') }
  await new FeishuCommands(host).receive(trigger('/model'))
  const lark = vi.fn(async (_args: string[]) => ({}))
  await sendFeishu({ commands: { lark } } as never, replies[0] as OutboundMessage)
  expect(lark).toHaveBeenCalledWith(expect.arrayContaining(['+messages-send', '--chat-id', 'oc_chat']))
  expect(lark.mock.calls[0]?.[0]).not.toContain('--reply-in-thread')
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
  await mkdir(join(root, '.dsh', 'plugins', 'tp-planboard', 'data', 'todo'), { recursive: true })
  await writeFile(join(root, '.dsh', 'plugins', 'tp-planboard', 'data', 'TODO.md'), '| 1 | First | [one](todo/one.md) |\n\n| 2 | Second | [two](todo/two.md) |\n| 3 | Escape | [x](../secret.md) |')
  await writeFile(join(root, '.dsh', 'plugins', 'tp-planboard', 'data', 'todo', 'two.md'), '# Second\nDetails\n<!-- walk-checkpoint hidden -->')
  await writeFile(join(root, '.dsh', 'plugins', 'tp-planboard', 'secret.md'), 'secret') // '../secret.md' from the data dir
  const commands = new FeishuCommands(host)
  await commands.receive(trigger('/todo'))
  expect(replies.at(-1)!.text).toContain('#2 Second')
  await commands.receive(trigger('todo 2', 'om_two'))
  expect(replies.at(-1)!.text).toContain('Details'); expect(replies.at(-1)!.text).not.toContain('hidden')
  await commands.receive(trigger('/todo 3', 'om_three'))
  expect(replies.at(-1)!.text).toContain('越界'); expect(replies.at(-1)!.text).not.toContain('secret')
  await symlink(join(root, '.dsh', 'plugins', 'tp-planboard', 'secret.md'), join(root, '.dsh', 'plugins', 'tp-planboard', 'data', 'todo', 'link.md'))
  await writeFile(join(root, '.dsh', 'plugins', 'tp-planboard', 'data', 'TODO.md'), '| 4 | Link | [link](todo/link.md) |')
  await commands.receive(trigger('/todo 4', 'om_four'))
  expect(replies.at(-1)!.text).toContain('越界')
})
