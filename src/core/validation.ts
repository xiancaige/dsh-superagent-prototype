/** Strict acceptance is opt-in; only host management configures it and host test execution supplies evidence. */
import { assertValidationEvidence, type ValidationBinding, type ValidationContract, type ValidationEvidence } from '../validation.ts'
import { latestAssignment, type Ticket } from './model.ts'
import { assertTicketReviewed } from './review.ts'
import { assertTicketDesignApproved } from './design.ts'
import { assertTicketVisualValidated, type StrictVisual } from './visual.ts'

export type { StrictVisual } from './visual.ts'

export interface StrictValidation {
  enabled: true
  contract?: ValidationContract
  evidence?: ValidationEvidence
  /** Persisted before spawning: a crash or a second run cannot reuse an earlier green run. */
  running?: string
  /** A source close is a fact, not acceptance; expose why automatic completion was deferred. */
  blocked?: string
  /** Phase B: required real visual evidence, judged by the same completion gate under the same opt-in. */
  visual?: StrictVisual
}
export function validationBinding(ticket: Ticket): ValidationBinding {
  const assignment = latestAssignment(ticket)
  if (!assignment || !ticket.execution?.directory || !ticket.validation?.contract) throw new Error('Strict validation: missing assignment, workspace or contract')
  return { ticketId: ticket.id, assignmentId: assignment.id, workspace: ticket.execution.directory,
    contractRevision: ticket.validation.contract.revision, ...assignment.startedAt ? { assignmentStartedAt: assignment.startedAt } : {} }
}
export function assertTicketValidated(ticket: Ticket): void {
  assertTicketDesignApproved(ticket)
  // Review is independently opt-in: do not return early merely because tests are not required.
  assertTicketReviewed(ticket)
  const validation = ticket.validation
  if (!validation?.enabled) return
  // Enabling strict acceptance without any contract yet is itself an incomplete requirement, exactly as
  // phase A decided; a visual-only ticket simply has no unittest evidence to add.
  if (!validation.contract && !validation.visual?.contract) throw new Error('Strict validation: missing contract/evidence or tests still running')
  if (validation.contract) {
    if (!validation.evidence || validation.running) throw new Error('Strict validation: missing contract/evidence or tests still running')
    assertValidationEvidence(validation.contract, validationBinding(ticket), validation.evidence)
  }
  assertTicketVisualValidated(ticket)
}
