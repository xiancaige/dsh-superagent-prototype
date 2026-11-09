/** Deterministic operator commands run before intake, even when no model has quota.
 * Normal requests still use Passes.receive; this is not a second chat/session bridge.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readFile, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolve, relative, isAbsolute } from 'node:path'
import { key, type Trigger } from '../core/index.ts'
import { allowedSender, type RoleModel } from '../policy.ts'
import { family } from '../kv.ts'
import { resolveRoleModel } from './role-models.ts'
import { imSummary } from '../infra/text.ts'
import type { Store } from './store.ts'
import type { Settings } from './settings.ts'
import type { Sessions } from './sessions.ts'
import type { Outbox } from './outbox.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { ModelCardTarget } from '../sources/feishu-model-card.ts'
import { workerSessionId } from '../executor/dsh.ts'

const MODEL_CARD_MAX = 20
/** Who a model card was sent to: only that person's click counts. A menu click names no chat, so `chatId` may be learned from the click. */
interface CardOwner { actor: string; chatId?: string; direct: boolean; at: number }
const cards = family<CardOwner>('feishu-model-card:')
const callbackSchema = z.object({ token: z.string().min(1), operator: z.object({ open_id: z.string().min(1) }),
  context: z.object({ open_chat_id: z.string(), open_message_id: z.string().optional() }),
  action: z.object({ value: z.object({ cmd: z.literal('model'), request: z.string(), provider: z.string().min(1), model: z.string().min(1) }).strict() }) })
export function buildModelCard(catalog: Awaited<ReturnType<FeishuCommandsHost['context']['sessionController']['modelCatalog']>>, current?: RoleModel | null, request?: string): object {
  const rows = catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })))
  const active = current ? `${current.provider}/${current.model}` : ''
  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: `当前模型：${active || '默认'}\n${rows.length} 个模型，点击按钮切换` }]
  for (const row of rows.slice(0, MODEL_CARD_MAX)) {
    const selected = active === `${row.provider}/${row.model}`
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: `${selected ? '✓ ' : ''}${row.provider} / ${row.model}`.slice(0, 40) },
      type: selected ? 'primary' : 'default', width: 'fill', behaviors: [{ type: 'callback', value: { cmd: 'model', ...row, ...request ? { request } : {} } }] })
  }
  if (rows.length > MODEL_CARD_MAX) elements.push({ tag: 'markdown', content: `其余 ${rows.length - MODEL_CARD_MAX} 个模型未显示；使用 /model <provider> <model> 切换` })
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: '选择模型' } }, body: { elements } }
}

const receipts = family<{ text: string }>('feishu-command:')
const HELP = '/todo [编号]：项目待办；/model [页码]：模型目录；/model <provider> <model> [all|main|worker|工单ID]：切换，默认 all。兼容 /mode。'
export interface FeishuCommandsHost {
  context: Context
  store: Store
  settings: Settings
  sessions: Sessions
  outbox: Outbox
  sources: SourceRegistry
  masterId: string
  /** Explicit project root; never infer a random workspace from the host registry. */
  root?: string
  sendModelCard?(target: ModelCardTarget, card: object): Promise<void>
}

export class FeishuCommands {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly host: FeishuCommandsHost) {}
  /** Serialize live/history copies so a message executes at most once in this host. */
  receive(trigger: Trigger): Promise<boolean> {
    const run = this.chain.then(() => this.handle(trigger))
    this.chain = run.catch(() => {})
    return run
  }
  /** CLI normalizes the SDK callback; serialize clicks with text commands and reuse their selection path. */
  cardAction(input: unknown): Promise<boolean> {
    const run = this.chain.then(async () => {
      const parsed = callbackSchema.safeParse(input)
      if (!parsed.success) return false
      const event = parsed.data, value = event.action.value, { store, sources } = this.host
      const owner = store.get(cards(value.request))
      const actor = { source: 'feishu', id: event.operator.open_id }
      if (!owner || Date.now() - owner.at > 24 * 60 * 60 * 1000) return false
      // Only the person the card was sent to may use it, in the chat it was sent to, and only while still allowed and listened to.
      if (event.operator.open_id !== owner.actor || owner.chatId && event.context.open_chat_id !== owner.chatId
        || !allowedSender(store.settings(), actor) || !sources.scope({ source: 'feishu', meta: { chatId: event.context.open_chat_id, direct: owner.direct } }).listened) return false
      const catalog = await this.host.context.sessionController.modelCatalog()
      if (!catalog.groups.some(group => group.id === value.provider && group.models.some(model => model.id === value.model))) return false
      const receipt = receipts(key('card-action', event.token))
      if (store.get(receipt)) return true
      let text: string
      try { text = imSummary(await this.model([value.provider, value.model], event.token)) }
      catch (error) { text = imSummary(`命令未完成：${error instanceof Error ? error.message.slice(0, 120) : '执行失败'}。可重新点击或发 /model 重试。`) }
      store.atomic(() => {
        store.set(receipt, { text })
        this.host.outbox.send({ id: key('feishu-model-choice', event.token), kind: 'reply', text,
          channel: { source: 'feishu', thread: `feishu:${event.context.open_chat_id}`,
            address: { chatId: event.context.open_chat_id, delivery: 'chat', ...owner.direct ? { direct: 'true' } : {} } } })
      })
      return true
    })
    this.chain = run.catch(() => {})
    return run
  }
  /**
   * A bot-menu click (`event_key` `model`). It names the person but no chat, so the card goes to their own bot chat.
   * Same allowlist and listening rules as a typed command: a stranger, or direct messages being off, gets nothing.
   */
  menuAction(input: { key: string; operator: string; id: string }): Promise<boolean> {
    const run = this.chain.then(async () => {
      if (input.key.trim().toLowerCase() !== 'model' || !this.host.sendModelCard) return false
      const { store, sources } = this.host
      if (!allowedSender(store.settings(), { source: 'feishu', id: input.operator })
        || !sources.scope({ source: 'feishu', meta: { direct: true } }).listened) return false
      const receipt = receipts(key('menu-action', input.id))
      if (store.get(receipt)) return true
      const catalog = await this.host.context.sessionController.modelCatalog(), request = randomUUID()
      store.set(cards(request), { actor: input.operator, direct: true, at: Date.now() })
      try {
        await this.host.sendModelCard({ id: input.id, userId: input.operator }, buildModelCard(catalog, store.settings().eval.model ?? catalog.default, request))
        store.set(receipt, { text: 'card sent' })
      } catch (error) {
        // No chat id is known, so the failure cannot be shown to the person; keep it out of any topic and log it for the operator.
        throw new Error(`model menu card failed: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown'}`)
      }
      return true
    })
    this.chain = run.catch(() => {})
    return run
  }
  private async handle(trigger: Trigger): Promise<boolean> {
    if (trigger.source !== 'feishu') return false
    // Feishu puts the bot mention before the command. Do not strip arbitrary quoted text.
    const text = trigger.text.trim().replace(trigger.addressed === 'mention' ? /^@\S+\s+/ : /$^/, '')
    const match = /^(\/?todo|\/model|\/mode|\/h|\/help)(?:\s+(.*))?$/i.exec(text)
    if (!match) return false
    const { store, sources, outbox } = this.host
    // Thread subscriptions do NOT grant command privileges. Bots, unlisted people and unaddressed group messages cannot act.
    if (!trigger.human || !allowedSender(store.settings(), trigger.actor) || !trigger.addressed || !sources.scope(trigger).listened) return true
    if (!trigger.channel) return true
    if (match[1]!.toLowerCase() === '/model' && !(match[2] ?? '').trim() && this.host.sendModelCard) {
      try {
        if (store.get(receipts(trigger.id))) return true
        const catalog = await this.host.context.sessionController.modelCatalog(), request = randomUUID()
        const chatId = String(trigger.meta.chatId)
        store.set(cards(request), { actor: trigger.actor.id, chatId, direct: trigger.meta.direct === true, at: Date.now() })
        await this.host.sendModelCard({ id: trigger.id, chatId }, buildModelCard(catalog, store.settings().eval.model ?? catalog.default, request))
        store.set(receipts(trigger.id), { text: 'card sent' })
      } catch (error) {
        this.host.outbox.send({ id: key('feishu-model-card-error', trigger.id), channel: { ...trigger.channel, address: { ...trigger.channel.address, delivery: 'chat' } },
          text: imSummary(`模型卡片发送失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`), kind: 'reply' })
      }
      return true
    }
    const receipt = receipts(trigger.id)
    let response = store.get(receipt)?.text
    if (response === undefined) {
      try {
        const command = match[1]!.toLowerCase(), args = (match[2] ?? '').trim().split(/\s+/).filter(Boolean)
        response = command.replace(/^\//, '') === 'todo' ? await this.todo(args)
          : command === '/h' || command === '/help' ? HELP : await this.model(args, trigger.id)
      } catch (error) {
        // Errors are not silently converted into successful selections. No secrets or CLI diagnostics in IM.
        response = `命令未完成：${error instanceof Error ? error.message.slice(0, 180) : '执行失败'}。可重发命令重试。`
      }
      response = imSummary(response)
      store.atomic(() => {
        store.set(receipt, { text: response! })
        outbox.send({ id: key('feishu-command', trigger.id), channel: trigger.channel!, text: response!, kind: 'reply' })
      })
    }
    return true
  }
  private async todo(args: string[]): Promise<string> {
    if (args.length > 1 || args[0] && !/^\d+$/.test(args[0])) return '用法：/todo 或 /todo <编号>'
    if (!this.host.root) throw new Error('未配置项目 sourceRoot，无法读取项目 TODO')
    const plans = await realpath(resolve(this.host.root, 'plans'))
    const index = await readFile(resolve(plans, 'TODO.md'), 'utf8')
    // The index can have blank gaps; only numbered Markdown rows are entries, not analysis records.
    const rows = [...index.matchAll(/^\|\s*(\d+)\s*\|\s*(.*?)\s*\|[^\n]*?\[[^\]]*\]\(([^)]+)\)/gm)]
    if (!args.length) return `TODO 列表：\n${rows.map(row => `#${row[1]} ${row[2]}`).join('\n')}\n发 /todo <编号> 看详情；完整列表见计划板。`
    const row = rows.find(row => Number(row[1]) === Number(args[0]))
    if (!row) return `未找到 TODO #${args[0]}`
    // realpath also rejects symlink escapes, not just ../ traversal.
    const file = await realpath(resolve(plans, row[3]!)), path = relative(plans, file)
    if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\')) throw new Error('TODO 详情路径越界')
    const body = (await readFile(file, 'utf8')).replace(/<!--\s*walk-checkpoint\b[\s\S]*?-->/gi, '')
    return `TODO #${row[1]}\n${body}`
  }
  private async model(args: string[], commandId: string): Promise<string> {
    const { context, store, settings, sessions, masterId } = this.host
    if (!args.length || args.length === 1 && /^\d+$/.test(args[0]!)) {
      const catalog = await context.sessionController.modelCatalog()
      const rows = catalog.groups.flatMap(group => group.models.map(model => `${group.id} ${model.id}`))
      const page = Math.max(1, Number(args[0] ?? 1)), size = 5
      return `模型目录 ${page}/${Math.max(1, Math.ceil(rows.length / size))}\n${rows.slice((page - 1) * size, page * size).join('\n') || '无模型'}\n主：${JSON.stringify(store.settings().eval.model ?? catalog.default)}\n执行：${JSON.stringify(store.settings().executor.model ?? catalog.default)}\n切换：/model <provider> <model> [all|main|worker|工单ID]；翻页：/model <页码>`
    }
    if (args.length < 2 || args.length > 3) return HELP
    const [provider, model, target = 'all'] = args as [string, string, string?]
    const chosen: RoleModel = { provider, model }
    // Validate locally via the provider configuration, never send a paid generation to test quota.
    await resolveRoleModel(context, chosen)
    const ticket = ['all', 'main', 'worker'].includes(target) ? undefined : store.tickets.get(target)
    if (!['all', 'main', 'worker'].includes(target) && (!ticket || ticket.ended)) throw new Error('目标须为 all、main、worker 或未结束的完整工单ID')
    const ids = ticket ? [workerSessionId(ticket.id)] : [
      ...target === 'all' || target === 'main' ? [masterId] : [],
      ...target === 'all' || target === 'worker' ? store.tickets.open().map(ticket => workerSessionId(ticket.id)) : [],
    ]
    // Defaults cover future Sessions; existing managed Sessions require explicit selection as well.
    for (const block of ticket ? [] : target === 'all' ? ['eval', 'executor'] as const : [target === 'main' ? 'eval' : 'executor'] as const) {
      const current = settings.block(block)
      await settings.save(block, { ...(current.value as object), model: chosen }, current.revision, 'tool')
    }
    let applied = 0
    for (const id of ids) {
      const resolved = await context.sessionController.resolveAgent(id as SessionId)
      if ('error' in resolved) {
        if (resolved.error.code === 'session/not-found') continue // not dispatched yet: uses the saved default
        throw new Error(`Session ${id} 无法切换；默认模型可能已保存`)
      }
      await context.sessionController.selectModel({ sessionId: id as SessionId, ...chosen })
      applied++
      // SelectModel changes the next request. A budget backoff cannot observe it until its current wait ends.
      // Only a known budget retry is interrupted; productive turns/tools are never cancelled.
      if (sessions.modelRetry(id).model_retry) {
        resolved.agent.cancel({ kind: 'user' }, { keepInbox: true })
        await sessions.prompt(id, `model-command:${key(commandId, id)}`,
          '操作者已切换模型，请从现有上下文继续未完成的工作；不要重复已经完成的副作用。', 'queue')
      }
    }
    return `已切换 ${target} 为 ${provider}/${model}，已应用 ${applied} 个会话；新请求使用新模型，额度等待中的会话已请求继续。`
  }
}
