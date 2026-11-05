/**
 * Phase B visual acceptance inside the phase A strict gate: the same opt-in `StrictValidation`
 * record, the same single `assertTicketValidated` completion guard, and the phase A binding rules
 * (one ticket, its current assignment, its canonical workspace). Only the evidence source differs:
 * host-captured frames read by the host-trusted inspector.
 */
import { UserError } from './errors.ts'
import { latestAssignment, type Ticket } from './model.ts'
import type { FrameRecord, VisualCheckVerdict, VisualContractView as VisualContract, VisualEvidenceView as VisualEvidence } from '../visual.ts'

/** One report a ticket settled: the frame digests it judged and the per-check verdicts it gave them. */
export type VisualSettledReport = { readonly group: string; readonly checks: readonly VisualCheckVerdict[]; readonly frames: readonly FrameRecord[] }

/** Contract + latest real assessment for a ticket's required visual acceptance. */
export type StrictVisual = {
  contract?: VisualContract
  evidence?: VisualEvidence
  /** Persisted before the host captures: a crash leaves the ticket blocked until the operator reconfigures. */
  running?: string
  /** Why a capture or read failed, or why the TP editor environment blocked it; kept visible instead of silently blocking. */
  blocked?: string
  /**
   * Phase B2: the ticket's one TP editor recovery, kept with the ticket so a restart cannot grant a
   * second chance; an `unavailable` outcome is an environment block, never a test failure.
   */
  recovery?: { attempts: number; outcome?: unknown; startedPid?: number }
  /**
   * Phase B3: every report this ticket settled, so the next one can be refused for contradicting a
   * frame it already judged. The host adapter appends to it; a pass is only ever a result of that guard.
   */
  reports?: readonly VisualSettledReport[]
}

/** The visual binding reuses the A ticket/assignment/workspace rules. */
export function visualBinding(ticket: Ticket) {
  const assignment = latestAssignment(ticket)
  if (!assignment || !ticket.execution?.directory || !ticket.validation?.visual?.contract) {
    throw new UserError('unknownTicket')
  }
  return { ticketId: ticket.id, assignmentId: assignment.id, workspace: ticket.execution.directory,
    contractDigest: ticket.validation.visual.contract.digest }
}

/**
 * A ticket that needs visual acceptance is ready/complete only with a passing, current visual
 * assessment bound to the current assignment and contract. Called from `assertTicketValidated`, so
 * phase B adds no second gate to keep in sync.
 */
export function assertTicketVisualValidated(ticket: Ticket): void {
  const validation = ticket.validation
  if (!validation?.enabled) return
  const visual = validation.visual
  if (!visual) return
  if (!visual.contract || !visual.evidence || visual.running) throw new UserError('notReady')
  const binding = visualBinding(ticket)
  const evidence = visual.evidence
  if (evidence.ticketId !== binding.ticketId || evidence.assignmentId !== binding.assignmentId
    || evidence.workspace !== binding.workspace || evidence.contractDigest !== binding.contractDigest) throw new UserError('notReady')
  if (!evidence.passed || evidence.reasons.length) throw new UserError('notReady')
  if (!evidence.groups.some(group => group.verdict === 'passed')) throw new UserError('notReady')
  // Phase B3: evidence that a frame was judged two ways, or a frame reused, is never ready.
  if (evidence.contradictions?.length) throw new UserError('notReady')
}
export type { VisualContract, VisualEvidence }
