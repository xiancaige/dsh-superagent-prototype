/** Direct orchestrator -> evolution service calls, dispatched through the existing durable effect queue. */
import type { Context } from '@deepseek-ai/cordis'
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

/** Only persisted host bindings authorize automatic worker analysis. Legacy tickets fail closed. */
export function resolveTicketAnalysisSource(store: Pick<Store, 'tickets'>, input: { ticketId: string; sessionId: string }): TicketAnalysisSource | undefined {
  const ticket = store.tickets.get(input.ticketId)
  const binding = ticket?.execution?.workerBinding
  if (!ticket?.ended || ticket.ended.by !== 'executor' || ticket.ended.outcome === 'stopped'
    || !ticket.assignments.some(item => item.startedAt) || !binding
    || input.sessionId !== `worker-${ticket.id}` || binding.sessionId !== input.sessionId
    || binding.workspaceRoot !== ticket.execution?.directory || !binding.projectRoot || !binding.workspaceRoot) return undefined
  return { ticketId: ticket.id, sessionId: binding.sessionId, projectRoot: binding.projectRoot,
    workspaceRoot: binding.workspaceRoot, outcome: ticket.ended.outcome }
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
    const result = await service.analyzeTicket(input)
    if (!result || typeof result.ok !== 'boolean') throw new Error('Evolution analysis returned an invalid result')
    if (!result.ok && result.reason === 'busy') throw new Later('Evolution analysis is busy')
    // A completed LLM attempt is never automatically rebilled on failure. Its result stays beside the ticket.
    store.set(KV.runtime.ticketAnalysis(input.ticketId), { input, result, finishedAt: new Date().toISOString() })
    if (!result.ok) ctx.logger.warn('dsh-superagent: evolution analysis failed for ticket %s: %s', input.ticketId, result.reason ?? result.status ?? 'unknown')
  }, { retry: [5000, 60_000] })
}
