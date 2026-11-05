/** Strict acceptance is opt-in; only host management configures it and host test execution supplies evidence. */
import { assertValidationEvidence, type ValidationBinding, type ValidationContract, type ValidationEvidence } from '../validation.ts'
import { latestAssignment, type Ticket } from './model.ts'
import { assertTicketReviewed } from './review.ts'
import { assertTicketDesignApproved } from './design.ts'

/**
 * Visual acceptance as recorded by the worker that performed it.
 *
 * The project editor owns screenshots (TPMCP `CaptureWidgetBlueprintScreenshot`), so the worker
 * captures and reads the frames itself; the host only keeps the conclusion and the frame digests so
 * a later reader can tell what was judged and whether those frames are still the ones on disk. This
 * deliberately replaces an earlier host-driven contract/capture/inspector framework (TODO72).
 */
export interface VisualFrame {
  /** Workspace-relative or absolute path of the frame the worker judged. */
  path: string
  /** sha256 of the exact file that was read; a changed file invalidates the conclusion. */
  sha256: string
  bytes?: number
}
export interface StrictVisual {
  /** The worker's own verdict for the acceptance it performed. */
  verdict: 'passed' | 'failed'
  /** Why, in the worker's words; required so a reader can check the reasoning. */
  reason: string
  /** Frames the verdict was computed from; empty is allowed only for a `failed` verdict. */
  frames: VisualFrame[]
  /** Which worker/assignment recorded it. */
  recordedBy: string
  at: string
}

export interface StrictValidation {
  enabled: true
  contract?: ValidationContract
  evidence?: ValidationEvidence
  /** Persisted before spawning: a crash or a second run cannot reuse an earlier green run. */
  running?: string
  /** A source close is a fact, not acceptance; expose why automatic completion was deferred. */
  blocked?: string
  /** Visual acceptance the worker performed and recorded. */
  visual?: StrictVisual
}
export function validationBinding(ticket: Ticket): ValidationBinding {
  const assignment = latestAssignment(ticket)
  if (!assignment || !ticket.execution?.directory || !ticket.validation?.contract) throw new Error('Strict validation: missing assignment, workspace or contract')
  return { ticketId: ticket.id, assignmentId: assignment.id, workspace: ticket.execution.directory,
    contractRevision: ticket.validation.contract.revision, ...assignment.startedAt ? { assignmentStartedAt: assignment.startedAt } : {} }
}
/** A recorded visual conclusion blocks completion unless it says `passed`. */
export function assertTicketVisualValidated(ticket: Ticket): void {
  const visual = ticket.validation?.visual
  if (!visual) return
  if (visual.verdict !== 'passed') throw new Error(`Visual acceptance was recorded as ${visual.verdict}: ${visual.reason}`)
}
export function assertTicketValidated(ticket: Ticket): void {
  assertTicketDesignApproved(ticket)
  // Review is independently opt-in: do not return early merely because tests are not required.
  assertTicketReviewed(ticket)
  const validation = ticket.validation
  if (!validation?.enabled) return
  // Enabling strict acceptance without any contract yet is itself an incomplete requirement, exactly as
  // phase A decided; a ticket with only a recorded visual conclusion has no unittest evidence to add.
  if (!validation.contract && !validation.visual) throw new Error('Strict validation: missing contract/evidence or tests still running')
  if (validation.contract) {
    if (!validation.evidence || validation.running) throw new Error('Strict validation: missing contract/evidence or tests still running')
    assertValidationEvidence(validation.contract, validationBinding(ticket), validation.evidence)
  }
  assertTicketVisualValidated(ticket)
}
