/** Host-only, one-shot repair adapter. No SQL, HTTP route, tool or automatic scan. */
import type { Ticket } from '../core/index.ts'
import { KV, family } from '../kv.ts'
import type { Store } from './store.ts'
import type { Effects } from './effects.ts'
import type { TicketAnalysisInput } from './ticket-analysis.ts'

export interface HistoryState { ticket?: Ticket; analysis?: { input: TicketAnalysisInput; result: { ok: boolean; reason?: string; jobId?: string }; finishedAt: string } }
export interface HistoryMutation {
  ticketId: string; expectedStateHash: string
  binding: NonNullable<NonNullable<Ticket['execution']>['workerBinding']>
  audit: Record<string, unknown>
}
export interface HistoryMigrationRequest { ticketIds: string[]; dryRun: boolean; authorization: string }
export interface HistoryMigrationService {
  migrateHistory(options: { allowlist: string[]; apply: boolean; authorization: string;
    store: ReturnType<typeof historyMigrationStore>;
    resolver: (input: { ticketId: string; sessionId: string }) => { ticketId: string; sessionId: string; projectRoot: string } }): Promise<unknown>
  historyStateHash(state: HistoryState): string
}
export const historyMigrationAudit = family<{ audit: Record<string, unknown>; originalAnalysis: HistoryState['analysis']; requeue: 'requested' }, [string]>('ticket-history-source-migration:')

/** Called only by the validated helper; CAS, binding, audit and durable requeue commit together. */
export function historyMigrationStore(store: Store, effects: Effects, hash: (state: HistoryState) => string) {
  const read = (id: string): HistoryState => ({ ticket: store.tickets.get(id), analysis: store.get(KV.runtime.ticketAnalysis(id)) })
  return {
    read,
    atomicMigrate(mutation: HistoryMutation): boolean {
      return store.atomic(() => {
        const { ticketId, expectedStateHash, binding, audit } = mutation
        const current = read(ticketId), ticket = current.ticket, analysis = current.analysis
        if (hash(current) !== expectedStateHash || !ticket?.execution || ticket.execution.workerBinding
          || !ticket.ended || ticket.ended.by !== 'executor' || ticket.ended.outcome === 'stopped'
          || analysis?.result.ok !== false || analysis.result.reason !== 'session-not-a-source' || analysis.result.jobId
          || store.get(historyMigrationAudit(ticketId)) || effects.pending('ticketAnalysis', ticketId)) return false
        ticket.execution.workerBinding = binding
        store.tickets.save(ticket)
        store.set(historyMigrationAudit(ticketId), { audit, originalAnalysis: analysis, requeue: 'requested' })
        effects.enqueue('ticketAnalysis', ticketId, analysis.input)
        return true
      })
    },
  }
}
