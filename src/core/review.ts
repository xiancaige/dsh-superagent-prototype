/** Host-managed independent review. Identities are operator-attested workflow labels, NOT OS authentication.
 * The trusted operator configures and transcribes review; workers cannot supply approval or fingerprints.
 */
import { realpathSync } from 'node:fs'
import { z } from 'zod'
import { fingerprintWorkspace } from '../validation.ts'
import { latestAssignment, type Ticket } from './model.ts'

const Identity = z.string().trim().min(1).max(200)
export const ReviewConfigurationRequest = z.discriminatedUnion('required', [
  z.object({ required: z.literal(false) }).strict(),
  z.object({ required: z.literal(true), implementerId: Identity, reviewerId: Identity }).strict(),
])
export const ReviewDecisionRequest = z.object({
  assignmentId: z.string().min(1), reviewerId: Identity,
  verdict: z.enum(['approved', 'rejected']), summary: z.string().trim().min(1).max(10_000),
}).strict()
export type ReviewConfiguration = z.infer<typeof ReviewConfigurationRequest>
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionRequest>
export interface ReviewDecision extends ReviewDecisionInput {
  ticketId: string
  revision: string
  workspace: string
  fingerprint: string
  at: string
  /** Trusted management surface recording the workflow identity, not an authenticated reviewer principal. */
  recordedBy: 'management-operator'
}
export type IndependentReview = ReviewConfiguration & { revision: string; decision?: ReviewDecision; blocked?: string }

/** Hash exactly the same conservative file set as test acceptance; fail closed on unreadable/symlink workspaces. */
export function reviewBinding(ticket: Ticket) {
  const assignment = latestAssignment(ticket)
  if (!assignment || !ticket.execution?.directory) throw new Error('Independent review: missing assignment or workspace')
  const workspace = realpathSync(ticket.execution.directory)
  return { ticketId: ticket.id, assignmentId: assignment.id, workspace, fingerprint: fingerprintWorkspace(workspace) }
}
export function assertTicketReviewed(ticket: Ticket): void {
  const review = ticket.review
  if (!review?.required) return
  if (review.implementerId === review.reviewerId) throw new Error('Independent review: implementer cannot self-sign')
  const decision = review.decision
  if (!decision || decision.verdict !== 'approved') throw new Error('Independent review: missing approval or review rejected')
  if (decision.reviewerId !== review.reviewerId || decision.reviewerId === review.implementerId
    || decision.revision !== review.revision || decision.recordedBy !== 'management-operator') {
    throw new Error('Independent review: approval identity or configuration mismatch')
  }
  const binding = reviewBinding(ticket)
  if (decision.ticketId !== binding.ticketId || decision.assignmentId !== binding.assignmentId
    || decision.workspace !== binding.workspace || decision.fingerprint !== binding.fingerprint) {
    throw new Error('Independent review: stale ticket, assignment or workspace content')
  }
}
