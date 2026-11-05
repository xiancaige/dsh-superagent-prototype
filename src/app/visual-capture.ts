/**
 * Real host capture routes. Two transports reach the same fixed screenshot tool:
 *
 * * `streamable-http`: an MCP endpoint such as a running editor's, as this deployment configures it;
 * * `stdio`: a local stdio MCP server, used where no editor endpoint exists and by the test suite.
 *
 * Both are real MCP calls into a real server. No route fabricates a frame, and `none` can only report
 * the trusted tool as unavailable.
 *
 * Phase B2: when the editor endpoint is unreachable, the recovery adapter is asked to recover the TP
 * editor before a capture is reported unavailable, as `knowledge/tpmcp/00-prerequisites-p1.md` requires.
 * Recovery is operator-enabled only; without it an unreachable endpoint stays `unavailable`.
 */
import path from 'node:path'
import type { Machine } from '../deployment.ts'
import type { VisualCapture } from '../core/part.ts'
import { McpCaptureSession, VisualEvidenceStore, assessVisual, validateVisualEvidence, EVIDENCE_DIRECTORY, type CaptureBinding,
  type CaptureOutcome, type CaptureSession, type CaptureTool, type SettledReport, type VisualContract, type VisualEvidence } from '../visual-host.ts'
import { McpStdioCaptureSession } from './visual-stdio.ts'
import type { RecoveryOutcome } from './editor-recovery.ts'

export type VisualCaptureSettings = {
  readonly transport: 'streamable-http' | 'stdio' | 'none'
  /** MCP endpoint of the trusted screenshot tool (streamable-http only). */
  readonly endpoint?: string
  /** Command of the trusted MCP server (stdio only). */
  readonly command?: string
  readonly args?: readonly string[]
}

/** What the host asks of an editor-recovery adapter; it acts only on the operator's TP environment. */
export interface EditorRecoveryHost {
  recover(ticketId: string, prior: unknown, signal: AbortSignal): Promise<RecoveryOutcome>
}

export interface VisualCaptureHost {
  /** The configured transport for this deployment. */
  settings(): VisualCaptureSettings
  /** Canonical path of the capture tool's own state, which must lie outside a ticket workspace. */
  statePath(): string
  /** Phase B2 editor recovery; absent keeps an unreachable endpoint `unavailable`, as phase B did. */
  recovery?(): EditorRecoveryHost | undefined
  /** The ticket's recorded recovery and how to record this attempt; both omitted keep recovery off. */
  recoveryRecord?(ticketId: string): { prior: unknown; save(prior: unknown, outcome: RecoveryOutcome): void } | undefined
}

/** The project's editor MCP endpoint, used when no deployment override names one. */
export const DEFAULT_VISUAL_ENDPOINT = 'http://127.0.0.1:55255/mcp'

/** The host adapter the Engine uses: capture through the configured real transport, read only by the inspector. */
export class HostVisualCapture implements VisualCapture {
  constructor(private readonly host: VisualCaptureHost, private readonly machine?: Pick<Machine, 'stateDir'>) {}

  private open(workspace: string): VisualEvidenceStore {
    const settings = this.host.settings()
    const tool: CaptureTool = { mcpDatabase: this.host.statePath() }
    const session: CaptureSession = settings.transport === 'streamable-http'
      ? new McpCaptureSession(settings.endpoint ?? DEFAULT_VISUAL_ENDPOINT)
      : settings.transport === 'stdio' && settings.command
        ? new McpStdioCaptureSession({ command: settings.command, args: [...settings.args ?? []], cwd: workspace })
        : (() => { throw new Error('Visual capture: no trusted capture transport is configured') })()
    return new VisualEvidenceStore(session, tool)
  }

  async capture(binding: CaptureBinding, count: number, prepared: { at: string } | undefined, signal: AbortSignal): Promise<CaptureOutcome> {
    const first = await this.attempt(binding, count, prepared, signal)
    // Only an unreachable editor endpoint is recovered: a tool error is the tool's own verdict.
    if (first.status !== 'unavailable' || signal.aborted) return first
    const recovery = this.host.recovery?.()
    const record = this.host.recoveryRecord?.(binding.ticketId)
    if (!recovery || !record) return first
    const outcome = await recovery.recover(binding.ticketId, record.prior, signal)
    record.save(record.prior, outcome)
    if (outcome.kind === 'unavailable') {
      return { ...first, reason: `${first.reason} (TP editor recovery: ${outcome.reason})` }
    }
    // The editor is ready and the host's own handshake named the capture tool; capture once more.
    const second = await this.attempt(binding, count, prepared, signal)
    return second.status === 'unavailable'
      ? { ...second, reason: `${second.reason} (TP editor recovery ${outcome.kind}, pid ${outcome.pid ?? 'unknown'})` }
      : second
  }

  /** One capture group over the configured transport: the same real MCP call, without recovery. */
  private async attempt(binding: CaptureBinding, count: number, prepared: { at: string } | undefined, signal: AbortSignal): Promise<CaptureOutcome> {
    const store = this.open(binding.workspace)
    try { return await store.capture(binding, count, prepared, signal) }
    finally { await store.close() }
  }

  /** Read the frames against the reports this ticket already settled; the ledger is what a pass rests on. */
  assess(contract: VisualContract, ticketId: string, assignmentId: string, workspace: string, signal: AbortSignal,
    settled: readonly SettledReport[] = []): Promise<VisualEvidence> {
    return assessVisual(contract, ticketId, assignmentId, workspace, signal, settled)
  }

  /** Re-check persisted evidence against the frames on disk; completion asks this before trusting it. */
  current(ticketId: string, assignmentId: string, workspace: string, contract: VisualContract, evidence: VisualEvidence): boolean {
    return validateVisualEvidence(contract, workspace, evidence, ticketId, assignmentId).valid
  }

  /** Where the adapter keeps its own state: the deployment state directory, never a ticket workspace. */
  get stateDirectory(): string { return path.join(this.machine?.stateDir ?? '.', EVIDENCE_DIRECTORY) }
}
