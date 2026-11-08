/** Deterministic operator commands run before intake, even when no model has quota.
 * Normal requests still use Passes.receive; this is not a second chat/session bridge.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readFile, realpath } from 'node:fs/promises'
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
import { workerSessionId } from '../executor/dsh.ts'

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
