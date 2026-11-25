/** Formats background notices and steering relays delivered to the main Session via the effect queue. */
import { randomUUID } from 'node:crypto'
import { blockedForEnvironment, canAdvanceTicket, followupOwners, key, latestAssignment, latestReport, liveTicket, type Decision, type DomainEvent, type OutboundMessage, type Ticket, type Trigger, type WorkerReport } from '../core/index.ts'
import { triggerMessage } from '../executor/dsh.ts'
import { IM_WORDS, imSummary } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { repliedTo } from './links.ts'
import type { Store } from './store.ts'
import { ticketCard } from './cards.ts'

/**
 * A background notice tuple for the main Session: `[name, value, summary]`, where `name` is the coalescing key in
 * `Effects` (a newer notice with the same `name` overwrites an unsent waiting one, rather than permanently deduplicating future notices).
 */
export type Notice = readonly [name: string, value: Record<string, unknown>, summary: string]
/** Builds a notice for a saved prompt configuration revision, coalescing under `'prompts'`. */
export const promptsNotice = (revision: number): Notice =>
  ['prompts', { prompt_config_saved: revision, effect: 'next-request', read: `prompts/${revision}` }, `Prompt configuration saved (revision ${revision})`]
/**
 * Builds a notice for a saved settings block with the changed dot-separated paths (coalescing per block under
 * `settings:<block>`), or for the whole settings on legacy saves that recorded no block.
 */
export const settingsNotice = (block?: string, changed: string[] = []): Notice => block
  ? [`settings:${block}`, { settings_saved: block, changed, read: `settings/${block}` }, `Settings saved: ${block}`]
  : ['settings', { settings_saved: true, read: 'settings' }, 'Settings saved']
/** Returns up to 20 dot-separated paths where two values differ (e.g. `eval.mode` or `policy.rules.1.enabled`). */
export function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [path]
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const at = (value: object, name: string) => (value as Record<string, unknown>)[name]
  return keys.flatMap(name => changedPaths(at(before, name), at(after, name), path ? `${path}.${name}` : name)).slice(0, 20)
}
/** Strips the latest report preview from a ticket card when the relay already carries or does not need the summary. */
function brief(ticket: Ticket) {
  const { preview: _preview, ...card } = ticketCard(ticket)
  return card
}
/** Creates a one-off receipt notice with a unique `name` key so repeated occurrences of the same event are each delivered instead of coalescing. */
export const receiptNotice = (value: Record<string, unknown>, summary: string): Notice => [key('receipt', randomUUID()), value, summary]
/** Builds a notice that a person removed a thread's subscriptions at `at`; a later removal of the same thread replaces an unsent waiting notice. */
export const subscriptionNotice = (thread: string, at?: string): Notice => [`subscription:${thread}`,
  { subscription_changes: [{ thread, removed: true }], ...at ? { at } : {} }, `Removed the subscriptions on thread ${thread}`]

/**
 * Converts an unsolicited domain event into a main-Session notice (`ticket.ended`, `trigger.requeued`, or
 * `thread.unsubscribed` by a person or executor); returns `undefined` for events that require no notice.
 */
export function eventNotice(event: DomainEvent, ticket: (id: string) => Ticket | undefined = () => undefined): Notice | undefined {
  const { at } = event
  if (event.type === 'ticket.ended') {
    const { ticketId, by, outcome, reason = outcome } = event.data
    const ended = ticket(ticketId)
    return receiptNotice(ended ? { ticket_ended: brief(ended) } : { ticket_ended: ticketId, by, outcome, reason, at }, `Ticket ${ticketId} ended (${reason})`)
  }
  if (event.type === 'trigger.requeued') {
    const id = event.data.triggerId
    return receiptNotice({ trigger_requeued: id, read: `trigger/${id}`, at }, `Trigger ${id} queued for a fresh assessment`)
  }
  if (event.type === 'thread.unsubscribed' && event.data.by === 'person') return subscriptionNotice(event.data.threadKey, at)
  if (event.type === 'thread.unsubscribed') {
    const { ticketId, threadKey: thread, reason } = event.data
    const note = 'Its Executor found this thread unrelated after reading it; attach later triggers there to this ticket only when they '
      + 'point at it explicitly.'
    return receiptNotice({ thread_unrelated: { ticket_id: ticketId, thread, reason }, at, note },
      `Ticket ${ticketId} no longer follows thread ${thread}: ${reason}`)
  }
  return undefined
}

/** Builds a background notice when a ticket's worker subscribes to a related thread for context only. */
export const threadFollowedNotice = (ticketId: string, thread: string, reason: string): Notice =>
  receiptNotice({ thread_followed: { ticket_id: ticketId, thread, reason },
    note: 'For context only: its messages reach this ticket and grant nothing.' },
    `Ticket ${ticketId} follows thread ${thread} for context: ${reason}`)

/** Steering relay payload for the main Session: `id` is the request ID that makes delivery idempotent, and `text` is the message body. */
export interface Relay { id: string; text: string }
/** What a follow-up asks of the main Session: nothing but a stop the person asks for, since its ticket's worker decides it. */
const FOLLOWUP_NOTE = 'Its ticket\'s worker has it and decides; act only if the person asks to stop the work '
  + '(orchestrator_route kind stop with this trigger_id).'
const STALLED_FOLLOWUP_NOTE = `${FOLLOWUP_NOTE} When a listed ticket is stalled (environment-blocked or failed), answer the person directly with orchestrator_reply purpose=answer.`
/** Unanswered human follow-up trigger summarized inside a failed/blocked worker report relay. */
export interface UnansweredTrigger { trigger_id: string; preview: string }
const isTicketStalledForFollowup = (ticket: Ticket): boolean =>
  blockedForEnvironment(ticket) || !!ticket.delivery || latestAssignment(ticket)?.modelFailure?.hostResumeBudget === 0
/**
 * Builds a steering relay for a human follow-up trigger that reached at least one live ticket (including an ended ticket
 * that resumed on the follow-up), with the trigger rendered as workers read it, the replied-to message, and the open
 * tickets it reached; returns `undefined` while no ticket's worker decides it (see `followupOwners`) or it reached no live ticket.
 */
export function followupNotice(store: Store, sources: SourceRegistry, triggerId: string): Relay | undefined {
  const trigger = store.triggers.get(triggerId)
  const disposition = store.triggers.disposition(triggerId)
  if (!trigger || !followupOwners(trigger, store).length) return undefined
  let anyStalled = false
  const tickets = disposition!.fanout.flatMap(id => {
    const ticket = store.tickets.get(id)
    if (!ticket || !liveTicket(ticket)) return []
    const context = disposition!.context?.includes(id) ? { context: true } : {}
    const stalled = !disposition!.context?.includes(id) && isTicketStalledForFollowup(ticket)
    if (stalled) anyStalled = true
    return [{ ticket_id: id, title: ticket.title, state: ticketCard(ticket).state, ...context, ...stalled ? { stalled: true } : {} }]
  })
  if (!tickets.length) return undefined
  return followupRelay(triggerMessage(trigger, {}, undefined, repliedTo({ store, sources }, trigger)), tickets,
    anyStalled ? STALLED_FOLLOWUP_NOTE : FOLLOWUP_NOTE)
}
/**
 * A person's message that reached tickets, as the main Session hears of it: the message as their workers read it, and the
 * tickets it reached with their state. Their workers decide it; the main Session may only stop the work on it.
 */
export function followupRelay(message: { trigger_id: string },
  tickets: readonly { ticket_id: string; title: string; state: string; context?: boolean; stalled?: boolean }[],
  note = FOLLOWUP_NOTE): Relay {
  return { id: `followup:${message.trigger_id}`, text: JSON.stringify({ kind: 'follow_up', ...message, delivered_to: tickets, note }) }
}
/** Formats a worker report relay for the main Session (truncating summaries over 600 characters behind `ticket/<id>/result`), including `completion` and `can_advance` when applicable; `replyTo` names the human question trigger it answers. */
export function resultRelay(ticket: Ticket, state: string, text: string, replyTo?: string, unansweredTriggers?: readonly UnansweredTrigger[]): Relay {
  const id = key('worker-result', ticket.id, ticket.updatedAt, text)
  const summary = text.length > 600 ? { summary: text.slice(0, 600), chars: text.length } : { summary: text }
  const completion = state === 'ready' ? latestReport(ticket)?.completion : undefined
  const advanceable = canAdvanceTicket(ticket)
  const unanswered = unansweredTriggers?.length ? { unanswered_triggers: unansweredTriggers.slice(-5) } : {}
  const report = { kind: 'worker_report', ticket: brief(ticket), trigger_id: ticket.origin.triggerId, state,
    ...completion ? { completion } : {}, ...advanceable ? { can_advance: true } : {},
    ...replyTo ? { answer_to: replyTo } : {}, ...unanswered, ...summary, read: `ticket/${ticket.id}/result` }
  return { id: `report:${id}`, text: JSON.stringify(report) }
}
/**
 * Converts a worker report recorded on `ticket` into a main-Session relay: a question for a person produces a
 * `worker_attention` relay, and a result, blocker, end, or answer to a question produces a `worker_report` relay, while
 * routine `progress` reports without `answers` stay internal.
 * @returns The steering `Relay`, or `undefined` when the report is not relayed to the main Session.
 */
export function reportRelay(ticket: Ticket, report: Pick<WorkerReport, 'state' | 'summary' | 'question' | 'answers'>,
  unansweredTriggers?: readonly UnansweredTrigger[]): Relay | undefined {
  const asked = report.question ? ticket.attention : undefined
  if (asked) {
    const advanceable = canAdvanceTicket(ticket)
    return { id: `attention:${ticket.id}:${asked.id}`,
      text: JSON.stringify({ kind: 'worker_attention', ticket: brief(ticket), state: report.state,
        ...advanceable ? { can_advance: true } : {}, read: `ticket/${ticket.id}/result` }) }
  }
  if (report.state === 'progress' && !report.answers) return undefined
  return resultRelay(ticket, report.state, report.summary, report.answers, unansweredTriggers)
}

const ENV_LOCK_PATTERN = /(?:\bEnvironmentHeld(?:BySelf)?\b|\btp-environment\.lock\b|\bTPCompileRestart\.lock\b|\btp-source-operation\.lock\b|source checkout is busy|TP environment is held by|环境锁|共享引擎.*?(?:占用|锁)|编译流程被占用|编辑器(?:进程)?.*?占用|\beditor lock\b)/i
/** Whether a worker's `blocked` summary describes an environment, editor, or shared-engine lock block. */
export function isEnvironmentLockSummary(summary: string): boolean {
  return ENV_LOCK_PATTERN.test(summary)
}
const chineseRequest = (request: string, reason: string): boolean =>
  (/\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request))
  || /\p{Script=Han}/u.test(reason)
function formatLockReason(reason: string, chinese: boolean): string {
  const cleaned = reason
    .replace(/^(?:Error:\s*The prepare command failed:\s*|TP environment block:\s*|Waiting for the TP environment:\s*|EnvironmentHeld(?:BySelf)?:\s*)+/i, '')
    .trim()
  const sourceBusy = /source checkout is busy \(([^)]+)\):\s*(\{[\s\S]*\})/i.exec(cleaned)
  if (sourceBusy) {
    try {
      const payload = JSON.parse(sourceBusy[2]!) as { pid?: unknown; ticket?: unknown }
      const pid = typeof payload.pid === 'number' || typeof payload.pid === 'string' ? String(payload.pid) : ''
      const holderTicket = typeof payload.ticket === 'string' && payload.ticket ? payload.ticket.slice(0, 8) : ''
      if (chinese) {
        const who = holderTicket ? `工单 ${holderTicket}${pid ? `（PID ${pid}）` : ''}` : pid ? `PID ${pid}` : '其他操作'
        return `源工程锁被${who}占用，请确认无运行中的源工程操作后清理锁`
      }
      const who = holderTicket ? `ticket ${holderTicket}${pid ? ` (pid ${pid})` : ''}` : pid ? `pid ${pid}` : 'another operation'
      return `source checkout lock held by ${who}`
    } catch { /* Fall back to cleaned text below. */ }
  }
  const held = /TP environment is held by (\S+) (.*?) \(Session pid (\d+)\) since ([^;]+)/i.exec(cleaned)
  if (held) {
    const [, kind, label, pid, since] = held
    const kindZh = kind === 'ticket' ? '工单' : kind === 'session' ? '会话' : kind!
    return chinese ? `当前由${kindZh} ${label}（PID ${pid}）自 ${since} 起持有` : `held by ${kind} ${label} (pid ${pid}) since ${since}`
  }
  return cleaned || (chinese ? '共享环境或编辑器正在被占用' : 'the shared environment or editor is currently occupied')
}
/**
 * Builds idempotent IM notices when a ticket is blocked or refused by an environment/editor/compile lock.
 * Keeps messages concise within `IM_WORDS` so Feishu delivery never rejects them.
 */
export function environmentLockNotices(ticket: Ticket, request: string, reason: string,
  options: { assignmentId?: string; holder?: string } = {}): OutboundMessage[] {
  const chinese = chineseRequest(request, reason)
  const detail = formatLockReason(reason, chinese)
  const shortTitle = imSummary(ticket.title || ticket.id.slice(0, 8), 20, '…')
  const raw = chinese
    ? `工单 ${ticket.id.slice(0, 8)}（${shortTitle}）遇到环境锁阻塞：${detail}。`
    : `Ticket ${ticket.id.slice(0, 8)} (${shortTitle}) hit an environment lock: ${detail}.`
  const text = imSummary(raw, IM_WORDS - 5, '…')
  const dedup = options.holder || detail.slice(0, 120)
  return ticket.channels.filter(channel => channel.source !== 'github').map(channel => ({
    id: key('env-lock', ticket.id, options.assignmentId ?? '', dedup, channel.source, JSON.stringify(channel.address)),
    channel, text, kind: 'notice', ticketId: ticket.id,
  }))
}
function formatFailureReason(summary: string, chinese: boolean): string {
  const cleaned = summary
    .replace(/^Model turn failed; host automatic resume budget 0\. Explicit human retry required\.\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const interrupted = /^Worker session interrupted \(([^)]+)\);/.exec(cleaned)
  if (interrupted) {
    const why = interrupted[1]!.trim()
    if (chinese) {
      if (why === 'has no Session') return '工作会话丢失'
      const stale = /^stopped without reporting (\d+) minutes ago$/i.exec(why)
      if (stale) return `工作会话超时未汇报（${stale[1]} 分钟）`
    }
    return imSummary(why, 35, '…')
  }
  if (!cleaned) return chinese ? '执行异常' : 'execution error'
  return imSummary(cleaned, 35, '…')
}
/**
 * Builds idempotent IM notices when a ticket assignment terminally fails (e.g. prepare failure or terminal model failure)
 * or is interrupted and auto-restarted by the watchdog, so Feishu operators never sit without notice even before or without an orchestrator follow-up reply.
 */
export function ticketFailedNotices(ticket: Ticket, request: string, summary: string,
  options: { assignmentId?: string; restarted?: boolean } = {}): OutboundMessage[] {
  const chinese = chineseRequest(request, summary)
  const detail = formatFailureReason(summary, chinese)
  const shortTitle = imSummary(ticket.title || ticket.id.slice(0, 8), 18, '…')
  const raw = options.restarted
    ? chinese
      ? `工单 ${ticket.id.slice(0, 8)}（${shortTitle}）工作会话中断（${detail}），宿主已自动重新排队恢复。`
      : `Ticket ${ticket.id.slice(0, 8)} (${shortTitle}) session interrupted (${detail}); host requeued it for automatic recovery.`
    : chinese
      ? `工单 ${ticket.id.slice(0, 8)}（${shortTitle}）执行失败（${detail}），已暂停等待恢复或重试。`
      : `Ticket ${ticket.id.slice(0, 8)} (${shortTitle}) failed (${detail}) and is paused for recovery or retry.`
  const text = imSummary(raw, IM_WORDS - 5, '…')
  return ticket.channels.filter(channel => channel.source !== 'github').map(channel => ({
    id: key('ticket-failed', ticket.id, options.assignmentId ?? '', channel.source, JSON.stringify(channel.address)),
    channel, text, kind: 'notice', ticketId: ticket.id,
  }))
}
/**
 * Builds idempotent IM notices when an explicit human request times out in Eval (`unavailable` with `timeout`),
 * so Feishu/local operators are not left with silent drops during upstream model outages.
 */
export function evalTimeoutNotices(decision: Decision, triggers: readonly Trigger[]): OutboundMessage[] {
  if (decision.kind !== 'unavailable' || decision.strength !== 'explicit') return []
  if (!decision.reason.some(item => item.code === 'timeout')) return []
  const seenChannels = new Set<string>()
  const notices: OutboundMessage[] = []
  for (const trigger of triggers) {
    if (!trigger.human || !trigger.channel || trigger.channel.source === 'github') continue
    const channelKey = `${trigger.channel.source}:${JSON.stringify(trigger.channel.address)}`
    if (seenChannels.has(channelKey)) continue
    seenChannels.add(channelKey)
    const chinese = chineseRequest(trigger.text, '')
    const raw = chinese
      ? '当前主控评估超时（上游模型响应异常或排队过久），消息已保留，模型恢复后会自动重新评估处理。'
      : 'Assessment timed out (upstream model error or queue delay). Your message is saved and will be retried automatically once the model recovers.'
    notices.push({
      id: key('eval-timeout', decision.id, trigger.channel.source, JSON.stringify(trigger.channel.address)),
      channel: trigger.channel,
      text: imSummary(raw, IM_WORDS - 5, '…'),
      kind: 'notice',
    })
  }
  return notices
}
