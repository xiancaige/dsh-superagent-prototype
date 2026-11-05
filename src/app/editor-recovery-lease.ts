/**
 * Phase 2 C: the B2 recovery's borrow of the one TP environment lock.
 *
 * B2 wrote `tp-environment.lock` for the length of an attempt. Phase 2 C keeps that same file as the
 * ticket's long lease (`environment-exclusive.ts`), so the recovery must not create a second lock and
 * must not take over a held one: it borrows the environment only while no holder has it, names the
 * holder when one does, and hands the borrow back at the end of the attempt exactly as B2 did. A ticket
 * that already holds the environment is borrowed inside its own lease, which the attempt does not touch.
 */
import { EnvironmentExclusivity } from './environment-exclusive.ts'
import type { ExclusiveLease, ExclusivityPort, TpEditorEnvironment } from './editor-recovery.ts'

/** How a running recovery names itself in the record while it borrows the environment. */
export const RECOVERY_HOLDER_PREFIX = 'tp-editor-recovery'

/** Where a borrow stops: the contract's handover fact, since a borrow belongs to the lock's own use, as in B2. */
const BORROW_REASON = 'handover' as const

/**
 * The recovery's exclusivity over the phase 2 C broker. `own` names the ticket whose persisted lease the
 * attempt runs inside (the ticket's own recovery); without it, the attempt borrows the lock for its own
 * `ticketId`, which is also how B2's recovery ran.
 */
export function recoveryLease(broker: EnvironmentExclusivity, own?: { kind: 'ticket'; id: string }): (environment: TpEditorEnvironment, ticketId: string, signal: AbortSignal) => Promise<ExclusiveLease> {
  return async (_environment, ticketId, signal) => {
    signal.throwIfAborted()
    const holder = own ?? { kind: 'ticket' as const, id: ticketId }
    const current = broker.held()?.holder
    // The ticket's own long lease is the borrow: the attempt acts inside it and does not release it.
    if (current && current.kind === holder.kind && current.id === holder.id) return { holder: `${holder.kind}:${holder.id}`, release: async () => {} }
    // Anyone else holding the environment refuses the borrow with their name; nothing is detected or killed.
    const lease = broker.acquire({ kind: 'session', id: `${RECOVERY_HOLDER_PREFIX}:${ticketId}`, label: `${RECOVERY_HOLDER_PREFIX} for ${ticketId}`, resources: [] })
    return { holder: lease.record.holder.label, release: async () => { broker.release(lease.token, BORROW_REASON, undefined, 'lock-borrow') } }
  }
}

/** The broker as the recovery's port: one borrow per attempt, over the same lock everything else uses. */
export function exclusivityPort(broker: EnvironmentExclusivity): ExclusivityPort {
  const lease = recoveryLease(broker)
  return { borrow: (ticketId, signal) => lease(undefined as unknown as TpEditorEnvironment, ticketId, signal) }
}
