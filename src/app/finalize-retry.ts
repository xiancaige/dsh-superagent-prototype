/** Management-only recovery of an existing completion cleanup; never resumes or rewrites the ticket. */
import { UserError } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface FinalizeRetryHost {
  readonly store: Pick<Store, 'atomic' | 'tickets' | 'settings'>
  readonly effects: Pick<Effects, 'pending' | 'enqueue'>
  readonly executor: Pick<DshExecutor, 'workspaceBusy'>
  readonly mounted: Pick<Machine, 'workspaceMode'>
}
function refuse(message: string): never {
  const error = new UserError('notRetryable')
  error.message = message
  throw error
}
/**
 * Finalize commands are snapshotted at ticket end: correcting settings does not repair queued payloads.
 * Refresh only an existing pending effect, retaining its completion identity and Effects' generation protection.
 * Do not stat the directory: the finalizer's already-gone case is idempotent, and its script still owns safety checks.
 */
export function retryFinalize(runtime: FinalizeRetryHost, id: string): { retried: true } {
  return runtime.store.atomic(() => {
    const ticket = runtime.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    if (runtime.mounted.workspaceMode === 'source') refuse('Workspace finalization is disabled in source workspace mode')
    if (ticket.ended?.outcome !== 'completed') refuse('Only a completed ticket can retry workspace finalization')
    if (!runtime.effects.pending('finalize', id)) refuse('No pending workspace finalization to retry')
    if (!ticket.execution?.directory.trim()) refuse('The completed ticket has no workspace directory')
    const command = runtime.store.settings().executor.finalize.trim()
    if (!command) refuse('The current executor.finalize command is empty')
    if (runtime.executor.workspaceBusy(id)) refuse('Workspace finalization is currently running')
    runtime.effects.enqueue('finalize', id, { ticketId: id, endedAt: ticket.ended.at, command })
    return { retried: true }
  })
}
