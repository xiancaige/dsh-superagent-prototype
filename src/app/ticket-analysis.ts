/** Direct orchestrator -> evolution service calls, dispatched through the existing durable effect queue. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolve } from 'node:path'
import type { TicketEndBy, TicketOutcome } from '../core/index.ts'
import { KV } from '../kv.ts'
import { Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface TicketAnalysisSource {
  ticketId: string
  sessionId: string
  projectRoot: string
  workspaceRoot: string
  outcome: Exclude<TicketOutcome, 'stopped'>
}

const samePath = (a?: string, b?: string): boolean => {
  if (!a || !b) return false
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}

export type TicketAnalysisSourceRefusal =
  | 'ticket-not-found'
  | 'ticket-not-ended'
  | 'stopped-by-person'
  | 'ticket-ended-by-non-executor'
  | 'ticket-never-started'
  | 'missing-worker-binding'
  | 'session-id-mismatch'
  | 'binding-project-root-missing'
  | 'binding-workspace-mismatch'

/** Returns a specific fixed refusal code when a ticket is not authorized for evolution analysis, or undefined when valid. */
export function diagnoseTicketAnalysisSource(store: Pick<Store, 'tickets'>, input: { ticketId: string; sessionId: string }): TicketAnalysisSourceRefusal | undefined {
  const ticket = store.tickets.get(input.ticketId)
  if (!ticket) return 'ticket-not-found'
  if (!ticket.ended) return 'ticket-not-ended'
  if (ticket.ended.outcome === 'stopped') return 'stopped-by-person'
  if (ticket.ended.by !== 'executor') return 'ticket-ended-by-non-executor'
  if (!ticket.assignments.some(item => item.startedAt)) return 'ticket-never-started'
  const binding = ticket.execution?.workerBinding
  if (!binding) return 'missing-worker-binding'
  if (input.sessionId !== `worker-${ticket.id}` || binding.sessionId !== input.sessionId) return 'session-id-mismatch'
  if (!binding.projectRoot || !binding.workspaceRoot) return 'binding-project-root-missing'
  if (!samePath(binding.workspaceRoot, ticket.execution?.directory)) return 'binding-workspace-mismatch'
  return undefined
}

/** Only persisted host bindings authorize automatic worker analysis. Legacy tickets fail closed. */
export function resolveTicketAnalysisSource(store: Pick<Store, 'tickets'>, input: { ticketId: string; sessionId: string }): TicketAnalysisSource | undefined {
  if (diagnoseTicketAnalysisSource(store, input)) return undefined
  const ticket = store.tickets.get(input.ticketId)!
  const binding = ticket.execution!.workerBinding!
  return { ticketId: ticket.id, sessionId: binding.sessionId, projectRoot: binding.projectRoot,
    workspaceRoot: binding.workspaceRoot, outcome: ticket.ended!.outcome as Exclude<TicketOutcome, 'stopped'> }
}

const WORKER_SETTLE_WAIT_MS = 2000

function settleWorkerSession(ctx: Context, sessionId: string): Promise<void> | undefined {
  const agent = ctx.get('agents')?.get(sessionId as SessionId)
  const running = agent && agent.status === 'running' && typeof agent.whenIdle === 'function' ? agent : undefined
  const persistence = ctx.get('sessionPersistence')
  const flush = typeof persistence?.flush === 'function' ? persistence : undefined
  if (!running && !flush) return undefined
  return (async () => {
    if (running) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          running.whenIdle(),
          new Promise<void>(done => { timer = setTimeout(done, WORKER_SETTLE_WAIT_MS) }),
        ])
      } catch { /* Proceed to persistence flush and analysis with whatever events exist. */ }
      finally { if (timer) clearTimeout(timer) }
    }
    if (flush) {
      try { await flush.flush() } catch { /* Best-effort flush before reading session log. */ }
    }
  })()
}

export interface TicketAnalysisInput {
  ticketId: string
  sessionId: string
  by: TicketEndBy
  outcome: TicketOutcome
  reason?: string
  at: string
}
export interface TicketAnalysisResult {
  ok: boolean
  reason?: string
  jobId?: string
  status?: string
}
export interface EvolutionAnalyzer {
  analyzeTicket(input: TicketAnalysisInput): Promise<TicketAnalysisResult>
}
declare module '@deepseek-ai/cordis' { interface Context { evolveReflect: EvolutionAnalyzer } }

/** No event bus or LLM prompt relay: one named service, one durable queue, one inspectable result. */
export function installTicketAnalysis(ctx: Context, store: Store, effects: Effects): void {
  effects.handle('ticketAnalysis', async input => {
    const service = ctx.get('evolveReflect')
    if (!service?.analyzeTicket) throw new Error('Evolution analysis service evolveReflect is unavailable')
    // Ending via orchestrator_report fires ticket.ended while the worker's turn is still settling its tool/result and final text.
    const settling = settleWorkerSession(ctx, input.sessionId)
    if (settling) await settling
    const result = await service.analyzeTicket(input)
    if (!result || typeof result.ok !== 'boolean') throw new Error('Evolution analysis returned an invalid result')
    if (!result.ok && result.reason === 'busy') throw new Later('Evolution analysis is busy')
    // A completed LLM attempt is never automatically rebilled on failure. Its result stays beside the ticket.
    store.set(KV.runtime.ticketAnalysis(input.ticketId), { input, result, finishedAt: new Date().toISOString() })
    if (!result.ok) ctx.logger.warn('dsh-superagent: evolution analysis failed for ticket %s: %s', input.ticketId, result.reason ?? result.status ?? 'unknown')
  }, { retry: [5000, 60_000] })
}
