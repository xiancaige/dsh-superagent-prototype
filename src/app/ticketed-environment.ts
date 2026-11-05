/**
 * Phase 2 C wiring: the ticket lifecycle around the persistent TP environment exclusivity.
 *
 * A ticket takes the environment when it is accepted, before its execution directory is prepared and
 * before any editor may be started for it, and holds it until the host completes it (its acceptance
 * passed), a person hands it over, or its work ends on its own (stopped, dropped, merged). Everything
 * between those facts keeps the lease: waiting for a person, a `waiting` report, an idle worker, a
 * released slot, a failed acceptance under rework, a runtime restart, and a ticket resumed after its
 * pull request closed.
 *
 * A deployment without a TP environment (no recovery configured) gets no port at all, so the engine
 * behaves exactly as it did before phase 2 C.
 */
import path from 'node:path'
import type { Environments, TicketHold } from '../core/index.ts'
import { EnvironmentExclusivity, type EnvironmentLease, type EnvironmentLeaseRecord, type ReleaseReason } from './environment-exclusive.ts'

/** The operator's TP environment, as the recovery configures it; the lease covers exactly these resources. */
export interface TpEnvironment {
  projectFile: string
  port: number
}

/** What the ticket lifecycle asks of the host (the B2 recovery adapter, through the runtime). */
export interface TicketedEnvironmentHost {
  /** Stop the TP editor this deployment started for the ticket; only that PID, never another project's. */
  stopEditor(ticketId: string): Promise<void>
  /** Whether the ticket still owns a TP editor this deployment started. */
  ownsEditor(ticketId: string): boolean
  /** The ticket's execution directory, when its execution is already prepared. */
  directory(ticketId: string): string | undefined
}

export interface HandoverResult { handedOver: boolean; export?: string; files: number; error?: string }

/** The ticket's key in the broker's record; a ticket id is a UUID, which also names the lock file's holder. */
const holderLabel = (title: string, id: string): string => title ? `${title} (${id})` : id

/**
 * Owns the ticket side of the environment: acquisition at acceptance, the heartbeat, a person's
 * handover with its export, and the releases the contract allows.
 */
export class TicketedEnvironment {
  /** Leases this host holds, by ticket; the broker's record is the truth and this is its handle. */
  private readonly leases = new Map<string, EnvironmentLease>()
  /** The TP editor each ticket started in this process, so a stop reaches exactly that PID. */
  private readonly editorPids = new Map<string, number | undefined>()

  constructor(readonly broker: EnvironmentExclusivity, private readonly environment: TpEnvironment, private readonly host: TicketedEnvironmentHost) {}

  /** The resources the lease covers: the TP editor, the port, the project, and this ticket's directory. */
  private resources(directory: string | undefined): EnvironmentLeaseRecord['resources'] {
    return [
      { name: 'tp-editor', value: this.environment.projectFile },
      { name: 'tpmcp-port', value: String(this.environment.port) },
      { name: 'tp-project', value: path.dirname(this.environment.projectFile) },
      ...directory ? [{ name: 'ticket-directory' as const, value: directory }] : [],
    ]
  }

  /** The lease this host holds for a ticket, provided the broker's record is still that lease. */
  lease(ticketId: string): EnvironmentLease | undefined {
    const lease = this.leases.get(ticketId)
    if (!lease) return undefined
    if (this.broker.current(lease.token)) return lease
    this.leases.delete(ticketId)
    return undefined
  }

  /** Whether the ticket holds the environment now: the engine's second line of defence beside the lock file. */
  holds(ticketId: string): boolean {
    if (!this.lease(ticketId)) return false
    return this.broker.owns('ticket', ticketId)
  }

  /**
   * Take the environment for a newly accepted ticket, before its directory or its editor exists. A
   * restart resumes this host's own persisted lease for the ticket instead of taking a second one.
   * @throws EnvironmentHeld naming the holder when another ticket or Session has it.
   */
  acquire(ticketId: string, title: string, purpose?: 'delivery'): EnvironmentLease {
    const existing = this.lease(ticketId)
    if (existing) return existing
    const lease = this.broker.acquireHolder({ kind: 'ticket', id: ticketId, label: holderLabel(title, ticketId), resources: this.resources(undefined) })
    this.leases.set(ticketId, lease)
    // A completed ticket that an operator takes the environment for again holds it for its delivery, which a restart
    // must not mistake for a release that never finished.
    if (purpose) lease.annotate({ purpose })
    return lease
  }


  /** Record the TP editor this deployment started for a ticket (`-1` when it reused one, which is no editor to stop). */
  recordStarted(ticketId: string, pid: number, startedAt?: string): void {
    const lease = this.lease(ticketId)
    if (!lease) return
    this.editorPids.set(ticketId, pid > 0 ? pid : undefined)
    lease.annotate(pid > 0 ? { editorPid: String(pid), ...startedAt ? { editorStartedAt: startedAt } : {} } : { editorPid: 'reused' })
  }

  /** The creation time the lease recorded with the editor's PID: what tells it from a process that reused the PID. */
  recordedStart(ticketId: string): string | undefined {
    return this.lease(ticketId)?.record.facts?.editorStartedAt
  }

  /** The PID the ticket's lease records for the editor it started, which a restarted host still stops. */
  recordedPid(ticketId: string): string | undefined {
    return this.lease(ticketId)?.record.facts?.editorPid
  }

  /** Whether the ticket started a TP editor this deployment still owns. */
  ownsEditor(ticketId: string): boolean {
    return !!this.host.ownsEditor(ticketId) || !!this.recordedPid(ticketId)
  }

  /** One heartbeat for every lease this host holds; a released or taken-over lease stops beating. */
  beat(): void {
    for (const [ticketId, lease] of this.leases) {
      if (!this.broker.current(lease.token)) { this.leases.delete(ticketId); continue }
      lease.beat()
    }
  }

  /**
   * A person's explicit handover of a ticket's environment. The scene is exported first: a ticket
   * directory with uncommitted changes is written to the state directory's `handovers/` (a sketch and a
   * bundle, never applied, never stashed away), and every written export is listed with its digest.
   * When the export fails the handover is refused and the ticket keeps the lock, so no uncommitted
   * change is lost to a handover.
   * @throws when the ticket does not hold the environment.
   */
  async handover(ticketId: string): Promise<HandoverResult> {
    const lease = this.lease(ticketId)
    if (!lease) throw new Error('TP environment exclusivity: this ticket does not hold the environment')
    const directory = this.host.directory(ticketId)
    let exportPath: string | undefined
    let files = 0
    try {
      if (directory) {
        const exported = await this.broker.export(directory, ticketId)
        if (!exported) throw new Error(`the ticket directory is not a git work tree, so its scene cannot be exported (${directory})`)
        exportPath = exported.bundle ?? exported.patch
        files = exported.files.length
      }
    } catch (error) {
      return { handedOver: false, files: 0, error: error instanceof Error ? error.message : String(error) }
    }
    try { await this.stopEditor(ticketId) } catch (error) {
      // The editor this ticket started is still running: the lock stays with the ticket, never handed to the next holder.
      return { handedOver: false, files: 0, error: `the editor this ticket started could not be stopped: ${error instanceof Error ? error.message : String(error)}` }
    }
    lease.release('handover', ticketId, exportPath)
    this.leases.delete(ticketId)
    return { handedOver: true, ...exportPath ? { export: exportPath } : {}, files }
  }


  /** Stop exactly the editor this deployment started for the ticket, before the environment goes to another holder. */
  private async stopEditor(ticketId: string): Promise<void> {
    if (this.recordedPid(ticketId) === 'reused') { this.editorPids.delete(ticketId); return }
    if (!this.host.ownsEditor(ticketId) && this.editorPids.get(ticketId) === undefined) return
    // A failed stop throws and keeps the ownership record: the lock is released only after the editor is really gone.
    await this.host.stopEditor(ticketId)
    this.editorPids.delete(ticketId)
  }

  /**
   * The ticket's work ended: release for the facts the contract names, and nothing else. `acceptance`
   * needs the host's own passing acceptance (`acceptancePassed`), so a worker's ready report or a failed
   * check never returns the environment; a stop, a dropped report, a merged or closed pull request and a
   * human's end of an unfinished ticket return it, since no worker is left to change the environment.
   * @returns whether this call released the environment.
   */
  async end(ticketId: string, ended: { by: 'executor' | 'human'; outcome: string }, acceptancePassed: boolean): Promise<boolean> {
    const lease = this.lease(ticketId)
    if (!lease) return false
    // The ticket's work is complete and its acceptance passed: `acceptance`. A person stopping it:
    // `stopped`. An end by itself (dropped, merged, closed) leaves no worker that may touch the
    // environment, so it is a stop of the work as well. Anything else keeps the lock.
    const reason: ReleaseReason | undefined = ended.outcome === 'completed'
      ? (acceptancePassed ? 'acceptance' : undefined)
      : ['stopped', 'dropped', 'merged', 'closed'].includes(ended.outcome) ? 'stopped' : undefined
    if (!reason) return false
    await this.stopEditor(ticketId)
    lease.release(reason, ticketId)
    this.leases.delete(ticketId)
    return true
  }
}

/** The port the engine holds for ticket environments: its own line of defence, beside the lock file. */
export function environmentPort(host: TicketedEnvironment | undefined): Environments | undefined {
  if (!host) return undefined
  return {
    // Acquired before the ticket exists in the store (see `Tickets.create`), so no record is read or saved here.
    acquire: (ticketId: string, title: string, purpose?: 'delivery') => { host.acquire(ticketId, title, purpose) },
    describe: (ticketId: string): TicketHold | undefined => {
      const lease = host.lease(ticketId)
      if (!lease) return undefined
      return { ticketId, held: { at: lease.record.acquiredAt } }
    },
    holds: (ticketId: string) => host.holds(ticketId),
    handover: (ticketId: string) => host.handover(ticketId),
    end: (ticketId: string, ended: { by: 'executor' | 'human'; outcome: string }, acceptancePassed: boolean) => host.end(ticketId, ended, acceptancePassed),
  }
}
