/** Periodic Feishu intermediate progress synchronization for long-running tickets. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { basename } from 'node:path'
import { key, liveTicket, runningAssignment, ticketStage, type Assignment, type ChannelRef, type OutboundMessage, type Ticket }
  from '../core/index.ts'
import { runningJobs } from '../executor/background.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { IM_WORDS, imSummary } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { DEFAULT_PROGRESS_INTERVAL_SECONDS, feishuSettings } from '../sources/feishu.ts'
import { SOURCE as FEISHU_SOURCE } from '../sources/feishu-trigger.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Mirror } from './mirror.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export { DEFAULT_PROGRESS_INTERVAL_SECONDS }
/** How often the host checks running tickets for due Feishu progress updates. */
const SWEEP_EVERY_MS = 30_000

interface SubagentsService {
  listDescendants?(rootSessionId: SessionId): Promise<readonly { id: string; activity?: string }[]>
  listChildren?(parentSessionId: string): Promise<readonly { id: string; activity?: string }[]>
}

export interface ProgressSyncHost {
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'get' | 'set' | 'delete' | 'atomic' | 'replyStatus'>
  readonly sources: SourceRegistry
  readonly outbox: Pick<Outbox, 'send'>
  readonly mirror?: Pick<Mirror, 'eligible'>
  configured(): boolean
  paused(): boolean
  closing(): boolean
  now?(): number
  sweepEveryMs?: number
}

export interface ProgressSnapshot {
  elapsedMs: number
  isNewReport: boolean
  reportSummary?: string
  lastAssistantText?: string
  inFlightTools: string[]
  toolCount: number
  recentFiles: string[]
  jobs: string[]
  subagentsCount: number
  validationRunning: boolean
  decisionSummary?: string
}

const chineseRequest = (request: string, title: string): boolean =>
  (/\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request))
  || /\p{Script=Han}/u.test(title)

function cleanSnippet(text: string, maxChars = 120): string {
  const cleaned = text.replace(/[`#*>\[\]]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`
}

function cleanJobName(name: string): string {
  const match = /^[^\s()]+\s*\((.+)\)$/.exec(name)
  return cleanSnippet(match ? match[1]! : name, 48)
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function fileBase(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const name = basename(value.trim().replace(/\\/g, '/'))
  return name || undefined
}

function summarizeToolCall(name: string, rawArgs: string, chinese: boolean): string {
  const args = parseArgs(rawArgs)
  if (name === 'pwsh' || name === 'bash') {
    if (typeof args.description === 'string' && args.description.trim()) return cleanSnippet(args.description, 44)
    if (typeof args.command === 'string' && args.command.trim()) {
      const firstLine = args.command.trim().split(/\r?\n/)[0] ?? ''
      return cleanSnippet(firstLine, 36)
    }
    return name
  }
  if (name === 'subagent') {
    if (typeof args.description === 'string' && args.description.trim()) return cleanSnippet(args.description, 44)
    if (typeof args.name === 'string' && args.name.trim()) return cleanSnippet(args.name, 36)
    return chinese ? '子任务' : 'subagent'
  }
  if (name === 'read') {
    const file = fileBase(args.file_path)
    return file ? (chinese ? `读取 ${file}` : `read ${file}`) : (chinese ? '读取文件' : 'read file')
  }
  if (name === 'edit' || name === 'write') {
    const file = fileBase(args.file_path)
    return file ? (chinese ? `修改 ${file}` : `edit ${file}`) : (chinese ? '修改文件' : 'edit file')
  }
  if (name === 'glob' || name === 'grep') return chinese ? '搜索代码' : 'search code'
  if (name === 'orchestrator_run_tests') return chinese ? '运行严格验收测试' : 'run strict tests'
  if (name === 'orchestrator_acquire_editor') return chinese ? '申请编辑器锁' : 'acquire editor lock'
  if (name === 'orchestrator_read') return chinese ? '读取工单上下文' : 'read ticket context'
  if (name === 'orchestrator_report') return chinese ? '提交阶段汇报' : 'report progress'
  if (name === 'job_output' || name === 'job_list') return chinese ? '检查后台任务' : 'check background job'
  return name
}

/**
 * Start timestamp of the current uninterrupted active work stretch on `assignment`,
 * resetting the progress timer after idle/blocked/waiting periods so resuming work does not fire immediately.
 */
export function activeStretchStartMs(ticket: Ticket, assignment: Assignment): number {
  const startedMs = Date.parse(assignment.startedAt ?? assignment.createdAt)
  if (!Number.isFinite(startedMs)) return NaN
  const idleMs = assignment.idleAt ? Date.parse(assignment.idleAt) : NaN
  const reportMs = assignment.report && assignment.report.state !== 'progress' ? Date.parse(assignment.report.at) : NaN
  const pauseEndMs = Math.max(Number.isFinite(idleMs) ? idleMs : -Infinity, Number.isFinite(reportMs) ? reportMs : -Infinity)
  if (pauseEndMs > -Infinity) {
    const candidates: number[] = []
    if (assignment.deliveredAt) {
      const deliveredMs = Date.parse(assignment.deliveredAt)
      if (Number.isFinite(deliveredMs) && deliveredMs > pauseEndMs) candidates.push(deliveredMs)
    }
    for (const input of ticket.inputs) {
      if (input.kind === 'orchestrator-decision') {
        const atMs = Date.parse(input.at)
        if (Number.isFinite(atMs) && atMs > pauseEndMs) candidates.push(atMs)
      }
    }
    if (candidates.length) return Math.max(startedMs, ...candidates)
  }
  return startedMs
}

function targetChannels(ticket: Ticket, mirror?: Pick<Mirror, 'eligible'>): ChannelRef[] {
  const seen = new Set<string>()
  const direct = ticket.channels.filter(channel => {
    if (channel.source !== FEISHU_SOURCE) return false
    const sig = JSON.stringify(channel.address)
    if (seen.has(sig)) return false
    seen.add(sig)
    return true
  })
  if (direct.length) return direct
  if (mirror?.eligible(ticket.id)) {
    return [{ source: FEISHU_SOURCE, thread: `feishu:mirror:${ticket.id}`, address: { mirror: ticket.id } }]
  }
  return []
}

async function activeSubagentCount(ctx: Context, sessionId: string): Promise<number> {
  const subagents = ctx.get('subagents') as SubagentsService | undefined
  if (!subagents) return 0
  try {
    const children = subagents.listDescendants
      ? await subagents.listDescendants(sessionId as SessionId)
      : await subagents.listChildren?.(sessionId) ?? []
    return children.filter(child => {
      const childAgent = ctx.agents?.get(child.id as SessionId)
      return childAgent ? childAgent.status !== 'idle' : child.activity === 'running'
    }).length
  } catch {
    return 0
  }
}

function assistantText(event: SessionEvent): string {
  if (event.type !== 'assistant/message') return ''
  return event.data.message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
}

/** Collects live intermediate progress facts from the ticket record, worker session events, background jobs, and subagents. */
export function collectProgressSnapshot(input: {
  ticket: Ticket
  assignment: Assignment
  events: readonly SessionEvent[]
  jobs: readonly { id: string; name: string }[]
  subagentsCount: number
  startedMs: number
  sinceMs: number
  nowMs: number
  chinese: boolean
}): ProgressSnapshot {
  const { ticket, assignment, events, jobs, subagentsCount, startedMs, sinceMs, nowMs, chinese } = input
  const assignmentEvents = events.filter(event => !event.time || event.time >= startedMs)
  const openCalls = new Map<string, { name: string; arguments: string }>()
  for (const event of assignmentEvents) {
    if (event.type === 'tool/call') openCalls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
    else if (event.type === 'tool/result') openCalls.delete(event.data.message.toolCallId)
    else if (event.type === 'turn/end') openCalls.clear()
  }
  const recentEvents = assignmentEvents.filter(event => !event.time || event.time >= sinceMs)
  let toolCount = 0
  const recentFiles: string[] = []
  let lastAssistantText: string | undefined
  for (const event of recentEvents) {
    if (event.type === 'tool/call') {
      toolCount++
      if (event.data.name === 'edit' || event.data.name === 'write') {
        const file = fileBase(parseArgs(event.data.arguments).file_path)
        if (file && !recentFiles.includes(file) && recentFiles.length < 3) recentFiles.push(file)
      }
    } else if (event.type === 'assistant/message') {
      const text = cleanSnippet(assistantText(event), 80)
      if (text) lastAssistantText = text
    }
  }
  const inFlightTools = [...openCalls.values()].slice(-2).map(call => summarizeToolCall(call.name, call.arguments, chinese))
  const report = assignment.report
  const reportSummary = report?.state === 'progress' && report.summary.trim() ? cleanSnippet(report.summary, 120) : undefined
  const reportMs = report?.state === 'progress' ? Date.parse(report.at) : NaN
  const isNewReport = !!reportSummary && (!Number.isFinite(reportMs) || reportMs >= sinceMs)
  const latestDecision = ticket.orchestratorDecisions?.at(-1)
  const decisionMs = latestDecision ? Date.parse(latestDecision.at) : NaN
  const decisionSummary = latestDecision && Number.isFinite(decisionMs) && decisionMs >= sinceMs
    ? cleanSnippet(latestDecision.decision, 80) : undefined

  return {
    elapsedMs: Math.max(0, nowMs - startedMs),
    isNewReport,
    ...(reportSummary ? { reportSummary } : {}),
    ...(lastAssistantText ? { lastAssistantText } : {}),
    inFlightTools,
    toolCount,
    recentFiles,
    jobs: jobs.slice(0, 2).map(job => cleanJobName(job.name)),
    subagentsCount,
    validationRunning: !!ticket.validation?.running,
    ...(decisionSummary ? { decisionSummary } : {}),
  }
}

function formatDuration(elapsedMs: number, chinese: boolean): string {
  if (elapsedMs < 60_000) {
    const seconds = Math.max(1, Math.round(elapsedMs / 1000))
    return chinese ? `${seconds} 秒` : `${seconds}s`
  }
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000))
  return chinese ? `${minutes} 分钟` : `${minutes}m`
}

/** Formats a concise IM-bounded Feishu progress sync notice from `snapshot`. */
export function formatProgressSyncMessage(ticket: Pick<Ticket, 'id' | 'title'>, snapshot: ProgressSnapshot, chinese: boolean): string {
  const shortId = ticket.id.slice(0, 8)
  const shortTitle = imSummary(ticket.title || shortId, 16, '…')
  const duration = formatDuration(snapshot.elapsedMs, chinese)
  const prefix = chinese
    ? `工单 ${shortId}（${shortTitle}）进度同步（已执行 ${duration}）：`
    : `Ticket ${shortId} (${shortTitle}) progress (${duration} elapsed): `

  const parts: string[] = []
  if (snapshot.isNewReport && snapshot.reportSummary) {
    parts.push(imSummary(snapshot.reportSummary, 45, '…'))
  } else if (snapshot.lastAssistantText) {
    parts.push(imSummary(snapshot.lastAssistantText, 40, '…'))
  }

  if (snapshot.validationRunning) {
    parts.push(chinese ? '正在运行严格验收测试' : 'running strict validation tests')
  } else if (snapshot.jobs.length > 0) {
    const names = snapshot.jobs.join(chinese ? '、' : ', ')
    parts.push(chinese ? `后台任务运行中（${names}）` : `background job running (${names})`)
  } else if (snapshot.inFlightTools.length > 0) {
    const tools = snapshot.inFlightTools.join(chinese ? '、' : ', ')
    parts.push(chinese ? `正在执行 ${tools}` : `running ${tools}`)
  } else if (snapshot.subagentsCount > 0) {
    parts.push(chinese ? `${snapshot.subagentsCount} 个子任务执行中` : `${snapshot.subagentsCount} subagent(s) running`)
  } else if (snapshot.toolCount > 0) {
    const files = snapshot.recentFiles.length
      ? (chinese ? `（涉及 ${snapshot.recentFiles.join('、')}）` : ` (${snapshot.recentFiles.join(', ')})`)
      : ''
    parts.push(chinese ? `本阶段已执行 ${snapshot.toolCount} 步操作${files}` : `${snapshot.toolCount} step(s) in this interval${files}`)
  } else if (snapshot.decisionSummary && !parts.length) {
    parts.push(chinese ? `调度推进：${imSummary(snapshot.decisionSummary, 40, '…')}` : `orchestrator advance: ${imSummary(snapshot.decisionSummary, 40, '…')}`)
  } else if (snapshot.reportSummary && !parts.length) {
    parts.push(chinese ? `当前阶段：${imSummary(snapshot.reportSummary, 40, '…')}（仍在处理中）` : `current phase: ${imSummary(snapshot.reportSummary, 40, '…')} (still working)`)
  } else if (!parts.length) {
    parts.push(chinese ? '任务仍在持续执行中' : 'still actively working')
  }

  const sep = chinese ? '；' : '; '
  const end = chinese ? '。' : '.'
  const raw = `${prefix}${parts.join(sep)}${end}`
  return imSummary(raw, IM_WORDS - 5, '…')
}

/**
 * Periodically checks active long-running tickets and sends concise intermediate progress updates to their Feishu conversations.
 */
export class FeishuProgressSync {
  private timer?: ReturnType<typeof setInterval>
  private ticking?: Promise<void>

  constructor(private readonly host: ProgressSyncHost) {}

  start(): void {
    if (this.timer || this.host.closing()) return
    const every = Math.max(1000, this.host.sweepEveryMs ?? SWEEP_EVERY_MS)
    this.timer = setInterval(() => { void this.tick() }, every)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.ticking
  }

  /** Evaluates all open working tickets once and queues due Feishu intermediate progress notices. */
  async tick(nowMsOverride?: number): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.runTick(nowMsOverride).finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private async runTick(nowMsOverride?: number): Promise<void> {
    if (this.host.closing() || this.host.paused() || !this.host.configured()) return
    const { store, sources, context, outbox, mirror } = this.host
    if (!sources.instance(FEISHU_SOURCE)?.enabled) return
    const intervalSeconds = feishuSettings(sources).progressIntervalSeconds
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return
    const intervalMs = intervalSeconds * 1000
    const nowMs = nowMsOverride ?? this.host.now?.() ?? Date.now()

    const candidates = store.tickets.open()
    for (const ticket of candidates) {
      if (this.host.closing() || this.host.paused()) return
      const stage = ticketStage(ticket)
      if (stage.stage !== 'working' || stage.action === 'queued') continue
      const assignment = runningAssignment(ticket)
      if (!assignment) continue
      const channels = targetChannels(ticket, mirror)
      if (!channels.length) continue

      const startedMs = Date.parse(assignment.startedAt ?? assignment.createdAt)
      if (!Number.isFinite(startedMs)) continue
      const stretchStartMs = activeStretchStartMs(ticket, assignment)
      const prev = store.get(KV.feishu.progressSync(ticket.id))
      const sameAssignment = prev?.assignmentId === assignment.id
      const anchorMs = sameAssignment ? Math.max(prev.lastSentAt, stretchStartMs) : stretchStartMs
      if (!Number.isFinite(anchorMs) || nowMs < anchorMs || nowMs - anchorMs < intervalMs) continue
      if (sameAssignment && prev.lastReceiptIds?.some(id => store.replyStatus(id) === 'pending')) continue

      const sessionId = workerSessionId(ticket.id)
      const agent = context.agents?.get(sessionId as SessionId) as Agent | undefined
      const events = agent?.session?.snapshotEvents?.() ?? []
      const jobs = runningJobs(context, sessionId)
      const subagentsCount = await activeSubagentCount(context, sessionId)
      if (this.host.closing() || this.host.paused()) return

      store.atomic(() => {
        const current = store.tickets.get(ticket.id)
        if (!current || !liveTicket(current)) return
        const currentStage = ticketStage(current)
        if (currentStage.stage !== 'working' || currentStage.action === 'queued') return
        const currentAssignment = runningAssignment(current)
        if (!currentAssignment || currentAssignment.id !== assignment.id) return
        const currentPrev = store.get(KV.feishu.progressSync(current.id))
        const currentSame = currentPrev?.assignmentId === currentAssignment.id
        const currentStretch = activeStretchStartMs(current, currentAssignment)
        const currentAnchor = currentSame ? Math.max(currentPrev.lastSentAt, currentStretch) : currentStretch
        if (!Number.isFinite(currentAnchor) || nowMs < currentAnchor || nowMs - currentAnchor < intervalMs) return
        if (currentSame && currentPrev.lastReceiptIds?.some(id => store.replyStatus(id) === 'pending')) return

        const currentChannels = targetChannels(current, mirror)
        if (!currentChannels.length) return

        const originText = store.triggers.get(current.origin.triggerId)?.text ?? ''
        const chinese = chineseRequest(originText, current.title)
        const sinceMs = currentSame ? currentPrev.lastSentAt : currentStretch
        const snapshot = collectProgressSnapshot({
          ticket: current,
          assignment: currentAssignment,
          events,
          jobs,
          subagentsCount,
          startedMs,
          sinceMs,
          nowMs,
          chinese,
        })
        const text = formatProgressSyncMessage(current, snapshot, chinese)
        const syncCount = (currentSame ? currentPrev.syncCount : 0) + 1
        const receiptIds: string[] = []
        for (const channel of currentChannels) {
          const id = key('progress-sync', current.id, currentAssignment.id, String(syncCount), channel.source, JSON.stringify(channel.address))
          const message: OutboundMessage = { id, channel, text, kind: 'notice', ticketId: current.id }
          outbox.send(message)
          receiptIds.push(id)
        }
        store.set(KV.feishu.progressSync(current.id), {
          assignmentId: currentAssignment.id,
          lastSentAt: nowMs,
          syncCount,
          lastReceiptIds: receiptIds,
        })
      })
    }
  }
}
