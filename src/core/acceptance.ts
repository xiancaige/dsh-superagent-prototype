/**
 * Which strict-acceptance evidence a ticket's worker role can be held to.
 *
 * Until now every ticket was judged by the same gate whatever its `workspaceRole`, so an `ops` ticket (dsh plugins,
 * knowledge, plans, build scripts, CI) could be configured with an Unreal CQTest contract it can never satisfy: it does
 * not start the editor, so no report is ever written. The profile names, per role, the adapters a contract may use and
 * whether a worker-recorded visual verdict counts. It is consulted when a contract is configured, not when a ticket ends,
 * so a record saved before profiles existed is judged exactly as it was and no ticket is locked out by this change.
 */
import { UserError } from './errors.ts'
import type { Ticket, WorkspaceRole } from './model.ts'

export interface AcceptanceProfile {
  readonly role: WorkspaceRole
  /** Contract adapters a ticket of this role may be configured with; empty when no trusted adapter fits the role yet. */
  readonly adapters: readonly string[]
  /** Whether a worker-recorded visual verdict can satisfy strict acceptance for this role. */
  readonly visual: boolean
  /** Why the set is what it is, shown beside the ticket's validation so an operator can read the gate's basis. */
  readonly note: string
}

const PROFILES: Readonly<Record<WorkspaceRole, AcceptanceProfile>> = {
  game: { role: 'game', adapters: ['cqtest-report'], visual: true,
    note: 'Gameplay, assets and project C++/Config: Unreal CQTest report, optionally with a recorded visual verdict.' },
  ops: { role: 'ops', adapters: [], visual: true,
    note: 'Tooling and AI files never start the editor, so no CQTest report can exist; a trusted command adapter for build/typecheck/tests is not available yet.' },
}

/** The profile of a role; a ticket recorded before `workspaceRole` existed is `game`. */
export const acceptanceProfile = (role: WorkspaceRole | undefined): AcceptanceProfile => PROFILES[role ?? 'game']

/** The profile a ticket is held to. */
export const ticketAcceptanceProfile = (ticket: Pick<Ticket, 'workspaceRole'>): AcceptanceProfile => acceptanceProfile(ticket.workspaceRole)

/**
 * Refuse a contract whose adapter does not fit the ticket's role, naming the role and what it may use instead of
 * silently judging an ops ticket by game evidence.
 * @throws UserError `adapterNotForRole` when the role's profile does not list the adapter.
 */
export function assertAdapterForRole(ticket: Pick<Ticket, 'workspaceRole'>, adapter: string): void {
  const profile = ticketAcceptanceProfile(ticket)
  if (profile.adapters.includes(adapter)) return
  throw new UserError('adapterNotForRole', { adapter, role: profile.role,
    allowed: profile.adapters.length ? profile.adapters.join(', ') : 'none yet' })
}
