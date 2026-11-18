/** Deterministic operator commands run before intake, even when no model has quota.
 * Normal requests still use Passes.receive; this is not a second chat/session bridge.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readFile, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolve, relative, isAbsolute } from 'node:path'
import { canRetry, key, latestReport, liveTicket, ticketStage, type EngineForMainSession, type EngineForPeople, type Ticket,
  type TicketOutcome, type Trigger } from '../core/index.ts'
import { allowedSender, type RoleModel } from '../policy.ts'
import { family } from '../kv.ts'
import { resolveRoleModel } from './role-models.ts'
import { IM_WORDS, imSummary, wordCount } from '../infra/text.ts'
import { pullOf } from '../sources/github-pull.ts'
import type { EnvironmentExclusivityView } from './environment-exclusive.ts'
import type { Store } from './store.ts'
import type { Settings } from './settings.ts'
import type { Sessions } from './sessions.ts'
import type { Outbox } from './outbox.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { ModelCardTarget } from '../sources/feishu-model-card.ts'
import { workerSessionId } from '../executor/dsh.ts'

const MODEL_CARD_MAX = 20
const TICKET_PAGE_SIZE = 5
const TICKET_CARD_PAGE_SIZE = 6
const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended', 'all'] as const
type TicketCommandFilter = typeof TICKET_FILTERS[number]
const FILTER_LABELS: Record<TicketCommandFilter, string> = {
  open: '进行中', person: '待人工', working: '执行中', idle: '空闲', ended: '已结束', all: '全部',
}
const OUTCOME_LABELS: Record<TicketOutcome, string> = {
  completed: '已完成', merged: '已合并', closed: '已关闭', dropped: '已放弃', stopped: '已停止',
}
const STAGE_LABELS: Record<string, string> = {
  'person/answer': '待回答', 'person/review': '待审阅', 'person/blocked': '已阻塞',
  'person/failed': '已失败', 'person/delivery': '投递失败',
  'working/queued': '排队中', working: '执行中', idle: '空闲',
}
const ticketStateText = (ticket: Ticket): string => {
  if (ticket.ended) return OUTCOME_LABELS[ticket.ended.outcome]
  const stage = ticketStage(ticket)
  const keyName = stage.stage === 'person' ? `person/${stage.action}` : stage.stage === 'working' && stage.action ? 'working/queued' : stage.stage
  return STAGE_LABELS[keyName] ?? keyName
}
const singleLine = (text: string, max = 60): string => {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}
const isTicketFilter = (value: string): value is TicketCommandFilter => (TICKET_FILTERS as readonly string[]).includes(value)
const newestTickets = (tickets: readonly Ticket[]): Ticket[] => tickets.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

/** Who a model or management card was sent to: only that person's click counts. A menu click names no chat, so `chatId` may be learned from the click. */
interface CardOwner { actor: string; chatId?: string; direct: boolean; at: number }
const cards = family<CardOwner>('feishu-model-card:')
const callbackSchema = z.object({ token: z.string().min(1), operator: z.object({ open_id: z.string().min(1) }),
  context: z.object({ open_chat_id: z.string(), open_message_id: z.string().optional() }),
  action: z.object({ value: z.discriminatedUnion('cmd', [
    z.object({ cmd: z.literal('model'), request: z.string(), provider: z.string().min(1), model: z.string().min(1) }).strict(),
    z.object({ cmd: z.literal('ticket'), request: z.string(),
      action: z.enum(['list', 'detail', 'stop', 'retry', 'ask', 'pause', 'resume']),
      ticketId: z.string().min(1).optional(),
      filter: z.enum(TICKET_FILTERS).optional(),
      page: z.number().int().min(1).optional() }).strict(),
  ]) }) })
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
export function buildTicketsCard(all: readonly Ticket[], options: { filter?: TicketCommandFilter; page?: number; paused?: boolean;
  maxWorkers?: number; env?: EnvironmentExclusivityView; request?: string } = {}): object {
  const filter = options.filter ?? 'open'
  const sorted = newestTickets(all)
  const filtered = sorted.filter(t => filter === 'all' ? true : filter === 'open' ? liveTicket(t) : ticketStage(t).stage === filter)
  const pages = Math.max(1, Math.ceil(filtered.length / TICKET_CARD_PAGE_SIZE))
  const page = Math.min(Math.max(1, options.page ?? 1), pages)
  const slice = filtered.slice((page - 1) * TICKET_CARD_PAGE_SIZE, page * TICKET_CARD_PAGE_SIZE)
  const openCount = sorted.filter(liveTicket).length
  const envText = options.env ? (options.env.held ? `环境锁：${options.env.holder?.label ?? '占用'}` : '环境锁：空闲') : ''
  const req = options.request ? { request: options.request } : {}
  const elements: Record<string, unknown>[] = [{
    tag: 'markdown',
    content: `状态：${options.paused ? '已暂停' : '运行中'} | 进行中 ${openCount} / 全部 ${sorted.length}${options.maxWorkers ? ` | 槽位上限 ${options.maxWorkers}` : ''}${envText ? ` | ${envText}` : ''}\n筛选：${FILTER_LABELS[filter]}（第 ${page}/${pages} 页，共 ${filtered.length} 个）`,
  }]
  if (!slice.length) {
    elements.push({ tag: 'markdown', content: filter === 'open' ? '当前无进行中工单，可点下方查看全部工单。' : '暂无符合条件的工单。' })
  }
  for (const ticket of slice) {
    const report = latestReport(ticket)
    const note = ticket.attention ? `待回答：${singleLine(ticket.attention.question, 40)}`
      : ticket.delivery ? `投递失败：${singleLine(ticket.delivery.error, 40)}`
      : report ? `${report.state}：${singleLine(report.summary, 40)}` : ''
    elements.push({
      tag: 'markdown',
      content: `**${ticket.id.slice(0, 8)}** [${ticketStateText(ticket)}] ${singleLine(ticket.title, 36)}${note ? `\n${note}` : ''}`,
    })
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `详情 ${ticket.id.slice(0, 8)}`.slice(0, 40) },
      type: 'default', width: 'fill',
      behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'detail', ticketId: ticket.id, ...req } }],
    })
    if (liveTicket(ticket)) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `停止 ${ticket.id.slice(0, 8)}`.slice(0, 40) },
        type: 'danger', width: 'fill',
        behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'stop', ticketId: ticket.id, ...req } }],
      })
    }
    if (canRetry(ticket)) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `重试 ${ticket.id.slice(0, 8)}`.slice(0, 40) },
        type: 'primary', width: 'fill',
        behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'retry', ticketId: ticket.id, ...req } }],
      })
    }
  }
  if (filter !== 'all') {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '查看全部工单' }, type: 'default', width: 'fill',
      behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'list', filter: 'all', page: 1, ...req } }] })
  } else {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '仅看进行中' }, type: 'default', width: 'fill',
      behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'list', filter: 'open', page: 1, ...req } }] })
  }
  if (page > 1) {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '上一页' }, type: 'default', width: 'fill',
      behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'list', filter, page: page - 1, ...req } }] })
  }
  if (page < pages) {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '下一页' }, type: 'default', width: 'fill',
      behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'list', filter, page: page + 1, ...req } }] })
  }
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: options.paused ? '恢复调度' : '暂停调度' },
    type: options.paused ? 'primary' : 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: options.paused ? 'resume' : 'pause', ...req } }],
  })
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: 'Superagent 工单管理' } }, body: { elements } }
}
export function buildTicketDetailCard(ticket: Ticket, request?: string): object {
  const req = request ? { request } : {}
  const report = latestReport(ticket)
  const pr = pullOf(ticket)
  const lines = [
    `**${ticket.id.slice(0, 8)}** [${ticketStateText(ticket)}] ${ticket.title}`,
    `ID：\`${ticket.id}\``,
    ...pr ? [`PR：#${pr}`] : [],
    ...ticket.ended ? [`结束：${OUTCOME_LABELS[ticket.ended.outcome]}（${ticket.ended.by === 'human' ? '人工' : '执行器'}）${ticket.ended.reason && ticket.ended.reason !== ticket.ended.outcome ? `：${ticket.ended.reason}` : ''}`] : [],
    ...ticket.attention ? [`待回答：${singleLine(ticket.attention.question, 100)}`] : [],
    ...ticket.delivery ? [`投递失败：${singleLine(ticket.delivery.error, 100)}`] : [],
    ...report ? [`最新回报（${report.state}）：${singleLine(report.summary, 120)}`] : [],
    `更新：${ticket.updatedAt}`,
  ]
  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: lines.join('\n') }]
  if (liveTicket(ticket)) {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '停止工单' }, type: 'danger', width: 'fill',
      behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'stop', ticketId: ticket.id, ...req } }] })
    if (ticketStage(ticket).stage === 'idle') {
      elements.push({ tag: 'button', text: { tag: 'plain_text', content: '催问状态' }, type: 'default', width: 'fill',
        behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'ask', ticketId: ticket.id, ...req } }] })
    }
  }
  if (canRetry(ticket)) {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '重试工单' }, type: 'primary', width: 'fill',
      behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'retry', ticketId: ticket.id, ...req } }] })
  }
  elements.push({ tag: 'button', text: { tag: 'plain_text', content: '返回工单列表' }, type: 'default', width: 'fill',
    behaviors: [{ type: 'callback', value: { cmd: 'ticket', action: 'list', filter: 'open', page: 1, ...req } }] })
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: `工单 ${ticket.id.slice(0, 8)}` } }, body: { elements } }
}

const receipts = family<{ text: string }>('feishu-command:')
const HELP = '工单：/tickets [筛选] [页] 列表；/ticket <ID> 状态；/stop <ID> [原因] 结束；/retry <ID> 重试；/ask <ID> 催报；/note <ID> <内容> 备注。控制：/status 总览；/pause|/resume 暂停恢复；/env 环境锁；/sync 名单；/todo [编号]；/model 模型。'
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
  engine?: Pick<EngineForPeople, 'stopTicket' | 'retryTicket' | 'handOverEnvironment' | 'releaseEndedEnvironment'>
    & Pick<EngineForMainSession, 'requestStatus' | 'note'>
  environment?(): EnvironmentExclusivityView
}

/**
 * TP operator commands of the Feishu Source, run before ordinary intake so they work even when no model has quota.
 * Only a listed operator in a listened chat may run one, and a receipt keyed by the callback keeps a replayed event from
 * running it twice. Ordinary requests never reach this class; they keep the usual intake path.
 */
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
      if (value.cmd === 'model') {
        const catalog = await this.host.context.sessionController.modelCatalog()
        if (!catalog.groups.some(group => group.id === value.provider && group.models.some(model => model.id === value.model))) return false
      }
      const receipt = receipts(key('card-action', event.token))
      if (store.get(receipt)) return true
      const chatAddress = { chatId: event.context.open_chat_id, delivery: 'chat', ...owner.direct ? { direct: 'true' } : {} }
      const chatChannel = { source: 'feishu', thread: `feishu:${event.context.open_chat_id}`, address: chatAddress }
      if (value.cmd === 'ticket' && (value.action === 'list' || value.action === 'detail') && this.host.sendModelCard) {
        try {
          const request = randomUUID()
          let card: object
          if (value.action === 'list') {
            card = this.ticketsCard({ filter: value.filter ?? 'open', page: value.page ?? 1 }, request)
          } else {
            if (!value.ticketId) return false
            card = buildTicketDetailCard(this.resolveTicket(value.ticketId), request)
          }
          store.set(cards(request), { actor: event.operator.open_id, chatId: event.context.open_chat_id, direct: owner.direct, at: Date.now() })
          await this.host.sendModelCard({ id: event.token, chatId: event.context.open_chat_id }, card)
          store.set(receipt, { text: 'card sent' })
        } catch (error) {
          const text = imSummary(`卡片操作失败：${error instanceof Error ? error.message.slice(0, 120) : '执行失败'}`)
          store.atomic(() => {
            store.set(receipt, { text })
            this.host.outbox.send({ id: key('feishu-ticket-choice', event.token), kind: 'reply', text, channel: chatChannel })
          })
        }
        return true
      }
      let text: string
      try {
        text = imSummary(value.cmd === 'model'
          ? await this.model([value.provider, value.model], event.token)
          : await this.ticketCardAction(value))
      } catch (error) {
        const hint = value.cmd === 'model' ? '可重新点击或发 /model 重试。' : '可发 /tickets 重试。'
        text = imSummary(`命令未完成：${error instanceof Error ? error.message.slice(0, 120) : '执行失败'}。${hint}`)
      }
      store.atomic(() => {
        store.set(receipt, { text })
        this.host.outbox.send({
          id: key(value.cmd === 'model' ? 'feishu-model-choice' : 'feishu-ticket-choice', event.token),
          kind: 'reply', text, channel: chatChannel,
        })
      })
      return true
    })
    this.chain = run.catch(() => {})
    return run
  }
  /**
   * A bot-menu click (`event_key` `model`, `tickets`, `status`, or `overview`). It names the person but no chat, so the card
   * goes to their own bot chat. Same allowlist and listening rules as a typed command: a stranger, or direct messages being off, gets nothing.
   */
  menuAction(input: { key: string; operator: string; id: string }): Promise<boolean> {
    const run = this.chain.then(async () => {
      const actionKey = input.key.trim().toLowerCase()
      if (!['model', 'tickets', 'status', 'overview'].includes(actionKey) || !this.host.sendModelCard) return false
      const { store, sources } = this.host
      if (!allowedSender(store.settings(), { source: 'feishu', id: input.operator })
        || !sources.scope({ source: 'feishu', meta: { direct: true } }).listened) return false
      const receipt = receipts(key('menu-action', input.id))
      if (store.get(receipt)) return true
      const request = randomUUID()
      let card: object
      if (actionKey === 'model') {
        const catalog = await this.host.context.sessionController.modelCatalog()
        card = buildModelCard(catalog, store.settings().eval.model ?? catalog.default, request)
      } else {
        card = this.ticketsCard({ filter: 'open', page: 1 }, request)
      }
      store.set(cards(request), { actor: input.operator, direct: true, at: Date.now() })
      try {
        await this.host.sendModelCard({ id: input.id, userId: input.operator }, card)
        store.set(receipt, { text: 'card sent' })
      } catch (error) {
        // No chat id is known, so the failure cannot be shown to the person; keep it out of any topic and log it for the operator.
        throw new Error(`${actionKey} menu card failed: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown'}`)
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
    const match = /^(\/?todo|\/model|\/mode|\/tickets?|\/status|\/overview|\/stop|\/end|\/retry|\/ask|\/ping|\/note|\/pause|\/resume|\/env|\/sync|\/h|\/help)(?:\s+([\s\S]*))?$/i.exec(text)
    if (!match) return false
    const { store, sources, outbox } = this.host
    // Thread subscriptions do NOT grant command privileges. Bots, unlisted people and unaddressed group messages cannot act.
    if (!trigger.human || !allowedSender(store.settings(), trigger.actor) || !trigger.addressed || !sources.scope(trigger).listened) return true
    if (!trigger.channel) return true
    const rawCommand = match[1]!.toLowerCase(), rawArgs = (match[2] ?? '').trim()
    const args = rawArgs.split(/\s+/).filter(Boolean)
    if (rawCommand === '/model' && !rawArgs && this.host.sendModelCard) {
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
    if ((rawCommand === '/tickets' || rawCommand === '/ticket') && args.at(-1)?.toLowerCase() === 'card' && this.host.sendModelCard) {
      try {
        if (store.get(receipts(trigger.id))) return true
        const cardArgs = args.slice(0, -1)
        const request = randomUUID()
        const card = rawCommand === '/ticket' && cardArgs.length === 1
          ? buildTicketDetailCard(this.resolveTicket(cardArgs[0]!), request)
          : this.ticketsCard(this.parseTicketsArgs(cardArgs), request)
        const chatId = String(trigger.meta.chatId)
        store.set(cards(request), { actor: trigger.actor.id, chatId, direct: trigger.meta.direct === true, at: Date.now() })
        await this.host.sendModelCard({ id: trigger.id, chatId }, card)
        store.set(receipts(trigger.id), { text: 'card sent' })
      } catch (error) {
        this.host.outbox.send({ id: key('feishu-ticket-card-error', trigger.id), channel: { ...trigger.channel, address: { ...trigger.channel.address, delivery: 'chat' } },
          text: imSummary(`工单卡片发送失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`), kind: 'reply' })
      }
      return true
    }
    const receipt = receipts(trigger.id)
    let response = store.get(receipt)?.text
    if (response === undefined) {
      try {
        response = await this.dispatch(rawCommand, args, rawArgs, trigger.id)
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
  private async dispatch(command: string, args: string[], rawArgs: string, triggerId: string): Promise<string> {
    if (command.replace(/^\//, '') === 'todo') return this.todo(args)
    if (command === '/h' || command === '/help') return HELP
    if (command === '/model' || command === '/mode') return this.model(args, triggerId)
    if (command === '/tickets') return this.tickets(args)
    if (command === '/ticket') return args.length ? this.ticketDetail(args) : this.tickets([])
    if (command === '/status') return args.length ? this.ticketDetail(args) : this.overview()
    if (command === '/overview') return this.overview()
    if (command === '/stop' || command === '/end') return this.stop(args, rawArgs)
    if (command === '/retry') return this.retry(args)
    if (command === '/ask' || command === '/ping') return this.ask(args)
    if (command === '/note') return this.note(args, rawArgs)
    if (command === '/pause') return this.pause(true)
    if (command === '/resume') return this.pause(false)
    if (command === '/env') return this.env(args)
    if (command === '/sync') return this.sync(args)
    return HELP
  }
  private requireEngine() {
    if (!this.host.engine) throw new Error('工单管理引擎未就绪')
    return this.host.engine
  }
  private allTickets(): Ticket[] {
    const { tickets } = this.host.store
    const list = typeof tickets.list === 'function' ? tickets.list() : tickets.open()
    return newestTickets(list)
  }
  private resolveTicket(target: string): Ticket {
    const list = this.allTickets()
    const exact = list.find(ticket => ticket.id === target)
    if (exact) return exact
    const needle = target.toLowerCase()
    if (needle.length < 4) throw new Error(`工单前缀 ${target} 过短，至少提供 4 位`)
    const matches = list.filter(ticket => ticket.id.toLowerCase().startsWith(needle))
    if (!matches.length) throw new Error(`未找到工单 ${target}`)
    if (matches.length > 1) {
      const candidates = matches.slice(0, 4).map(ticket => ticket.id.slice(0, 8)).join('、')
      throw new Error(`前缀 ${target} 匹配到 ${matches.length} 个工单（${candidates}），请提供更长前缀`)
    }
    return matches[0]!
  }
  private parseTicketsArgs(args: string[]): { filter: TicketCommandFilter; page: number } {
    let filter: TicketCommandFilter = 'open', page = 1
    for (const arg of args) {
      const lower = arg.toLowerCase()
      if (isTicketFilter(lower)) filter = lower
      else if (/^\d+$/.test(arg)) page = Math.max(1, Number(arg))
      else throw new Error('用法：/tickets [open|person|working|idle|ended|all] [页码]')
    }
    return { filter, page }
  }
  private ticketsCard(options: { filter: TicketCommandFilter; page: number }, request: string): object {
    const settings = this.host.store.settings()
    return buildTicketsCard(this.allTickets(), {
      ...options, paused: settings.paused, maxWorkers: settings.executor.maxWorkers,
      ...this.host.environment ? { env: this.host.environment() } : {}, request,
    })
  }
  private async ticketCardAction(value: Extract<z.infer<typeof callbackSchema>['action']['value'], { cmd: 'ticket' }>): Promise<string> {
    if (value.action === 'pause') return this.pause(true)
    if (value.action === 'resume') return this.pause(false)
    if (value.action === 'list') return this.tickets([value.filter ?? 'open', String(value.page ?? 1)])
    if (!value.ticketId) throw new Error('缺少工单ID')
    if (value.action === 'detail') return this.ticketDetail([value.ticketId])
    if (value.action === 'stop') return this.stop([value.ticketId, '飞书卡片停止'], `${value.ticketId} 飞书卡片停止`)
    if (value.action === 'retry') return this.retry([value.ticketId])
    if (value.action === 'ask') return this.ask([value.ticketId])
    return HELP
  }
  private tickets(args: string[]): string {
    const { filter, page } = this.parseTicketsArgs(args)
    const all = this.allTickets()
    const filtered = all.filter(ticket => filter === 'all' ? true : filter === 'open' ? liveTicket(ticket) : ticketStage(ticket).stage === filter)
    if (!filtered.length) {
      if (filter === 'open' && all.length) return `当前无进行中工单（已结束 ${all.length} 个），发 /tickets all 查看全部。`
      return `暂无${FILTER_LABELS[filter]}工单。`
    }
    const pages = Math.max(1, Math.ceil(filtered.length / TICKET_PAGE_SIZE))
    const current = Math.min(page, pages)
    const items = filtered.slice((current - 1) * TICKET_PAGE_SIZE, current * TICKET_PAGE_SIZE)
    const rows = items.map((ticket, index) =>
      `${(current - 1) * TICKET_PAGE_SIZE + index + 1}. ${ticket.id.slice(0, 8)} [${ticketStateText(ticket)}] ${singleLine(ticket.title, 20)}`)
    return `工单列表(${FILTER_LABELS[filter]}) ${current}/${pages} 共${filtered.length}个\n${rows.join('\n')}\n详情：/ticket <ID>；结束：/stop <ID>`
  }
  private ticketDetail(args: string[]): string {
    if (args.length !== 1) return '用法：/ticket <工单ID或前缀>'
    const ticket = this.resolveTicket(args[0]!)
    const pr = pullOf(ticket), report = latestReport(ticket)
    const lines = [
      `工单 ${ticket.id.slice(0, 8)} [${ticketStateText(ticket)}] ${singleLine(ticket.title, 40)}`,
      `ID：${ticket.id}`,
      ...pr ? [`PR：#${pr}`] : [],
      ...ticket.ended ? [`结束：${OUTCOME_LABELS[ticket.ended.outcome]}（${ticket.ended.by === 'human' ? '人工' : '执行器'}）${ticket.ended.reason && ticket.ended.reason !== ticket.ended.outcome ? ` ${singleLine(ticket.ended.reason, 40)}` : ''}`] : [],
      ...ticket.attention ? [`待回答：${singleLine(ticket.attention.question, 50)}`] : [],
      ...ticket.delivery ? [`投递失败：${singleLine(ticket.delivery.error, 50)}`] : [],
      ...report ? [`回报(${report.state})：${singleLine(report.summary, 50)}`] : [],
    ]
    if (liveTicket(ticket)) {
      const ops = [`/stop ${ticket.id.slice(0, 8)}`, ...canRetry(ticket) ? [`/retry ${ticket.id.slice(0, 8)}`] : []]
      lines.push(`操作：${ops.join(' | ')}`)
    }
    return lines.join('\n')
  }
  private overview(): string {
    const settings = this.host.store.settings()
    const all = this.allTickets(), open = all.filter(liveTicket)
    let working = 0, queued = 0, person = 0, idle = 0
    for (const ticket of open) {
      const stage = ticketStage(ticket)
      if (stage.stage === 'person') person++
      else if (stage.stage === 'idle') idle++
      else if (stage.action === 'queued') queued++
      else working++
    }
    const env = this.host.environment?.()
    const envLine = env ? (env.held ? `环境锁：${env.holder?.label} (${env.holder?.id.slice(0, 8)})` : '环境锁：空闲') : undefined
    return [
      `Superagent：${settings.paused ? '已暂停' : '运行中'} | 槽位上限 ${settings.executor.maxWorkers}`,
      `工单：进行中 ${open.length}（执行 ${working}/排队 ${queued}/待人工 ${person}/空闲 ${idle}），已结束 ${all.length - open.length}`,
      ...envLine ? [envLine] : [],
      `列表：/tickets；暂停：${settings.paused ? '/resume' : '/pause'}`,
    ].join('\n')
  }
  private stop(args: string[], rawArgs: string): string {
    if (!args.length) return '用法：/stop <工单ID或前缀> [原因]'
    const ticket = this.resolveTicket(args[0]!)
    if (!liveTicket(ticket)) return `工单 ${ticket.id.slice(0, 8)} 已结束（${ticketStateText(ticket)}），无需重复停止。`
    const reason = rawArgs.slice(args[0]!.length).trim()
    this.requireEngine().stopTicket(ticket.id, reason || '飞书操作者停止')
    return `已停止工单 ${ticket.id.slice(0, 8)}：${singleLine(ticket.title, 30)}${reason ? `（原因：${singleLine(reason, 30)}）` : ''}`
  }
  private retry(args: string[]): string {
    if (args.length !== 1) return '用法：/retry <工单ID或前缀>'
    const ticket = this.resolveTicket(args[0]!)
    this.requireEngine().retryTicket(ticket.id)
    return `已重试工单 ${ticket.id.slice(0, 8)}：${singleLine(ticket.title, 30)}，新派工已入队。`
  }
  private ask(args: string[]): string {
    if (args.length !== 1) return '用法：/ask <工单ID或前缀>'
    const ticket = this.resolveTicket(args[0]!)
    const asked = this.requireEngine().requestStatus(ticket.id)
    return asked ? `已向工单 ${ticket.id.slice(0, 8)} 发送状态催报请求。`
      : `工单 ${ticket.id.slice(0, 8)} 当前状态为「${ticketStateText(ticket)}」，仅等待状态可催报。`
  }
  private note(args: string[], rawArgs: string): string {
    if (args.length < 2) return '用法：/note <工单ID或前缀> <内容>'
    const text = rawArgs.slice(args[0]!.length).trim()
    if (!text) return '用法：/note <工单ID或前缀> <内容>'
    if (wordCount(text) > IM_WORDS) throw new Error(`备注不能超过 ${IM_WORDS} 词`)
    const ticket = this.resolveTicket(args[0]!)
    this.requireEngine().note(ticket.id, text)
    return `已向工单 ${ticket.id.slice(0, 8)} 发送备注。`
  }
  private async pause(paused: boolean): Promise<string> {
    await this.host.settings.pause(paused, 'tool')
    return paused ? '已暂停 Superagent 调度（停止新评估、派工与回复发送，仍接收消息）。发 /resume 恢复。'
      : '已恢复 Superagent 调度。'
  }
  private async env(args: string[]): Promise<string> {
    if (!args.length) {
      if (!this.host.environment) return '当前部署未配置环境锁查询。'
      const view = this.host.environment()
      if (view.held) return `环境锁占用中：${view.holder?.label} (${view.holder?.id.slice(0, 8)})，自 ${view.acquiredAt}`
      return `环境锁空闲。${view.lastRelease ? `上次释放：${view.lastRelease.reason} (${view.lastRelease.holder})` : ''}`
    }
    const [action, target] = args
    if (args.length !== 2 || (action !== 'handover' && action !== 'release')) return '用法：/env 或 /env handover <ID> 或 /env release <ID>'
    const ticket = this.resolveTicket(target!)
    if (action === 'handover') {
      const result = await this.requireEngine().handOverEnvironment(ticket.id)
      return result.handedOver ? `已交接工单 ${ticket.id.slice(0, 8)} 的环境锁（导出 ${result.files} 个文件）。`
        : `环境锁交接未完成：${result.error ?? '未知原因'}`
    }
    const result = await this.requireEngine().releaseEndedEnvironment(ticket.id)
    return result.released ? `已释放已结束工单 ${ticket.id.slice(0, 8)} 的环境锁。`
      : `环境锁释放失败：${result.error ?? '未知原因'}`
  }
  private async sync(args: string[]): Promise<string> {
    if (args.length > 1) return '用法：/sync [来源，默认 feishu]'
    const source = args[0] ?? 'feishu'
    const part = await this.host.settings.sync(source) as { allowed?: unknown[] }
    return `已同步 ${source} 授权名单，当前共 ${part.allowed?.length ?? 0} 人。`
  }
  private async todo(args: string[]): Promise<string> {
    if (args.length > 1 || args[0] && !/^\d+$/.test(args[0])) return '用法：/todo 或 /todo <编号>'
    if (!this.host.root) throw new Error('未配置项目 sourceRoot，无法读取项目 TODO')
    const plans = await realpath(resolve(this.host.root, '.dsh', 'plugins', 'tp-planboard', 'data')) // TODO data is self-contained in the planboard plugin
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
