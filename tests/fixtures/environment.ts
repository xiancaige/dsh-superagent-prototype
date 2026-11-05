/** Phase 2 C test helpers: an environment broker whose Session process and clocks are injected, and a ticket side over it. */
import { EnvironmentExclusivity } from '../../src/app/environment-exclusive.ts'
import { TicketedEnvironment } from '../../src/app/ticketed-environment.ts'

/** The operator's TP environment every test names. */
export const TP = { projectFile: 'F:\\TP\\TP.uproject', port: 55255 }

/** A deployment whose Session process is `pid` on `host`, with `alive` deciding what a PID means and a clock that moves on. */
export function broker(host: string, pid: number, alive: (candidate: number) => boolean = () => false, state = ''): EnvironmentExclusivity {
  let clock = Date.parse('2026-11-03T06:00:00.000Z')
  return new EnvironmentExclusivity(state, { self: () => ({ pid, host }), alive, now: () => new Date(clock += 1000).toISOString() })
}

/**
 * A ticketed host whose editor is "started" by recording it, so no real process is touched: the
 * `editors` map is what a recovery would have started, and the `directories` map is the ticket's
 * execution directory a handover exports.
 */
export function ticketed(state: string, events: string[] = []) {
  // The host's Session is this process, as it is when the supervisor and the worker hosts share one process.
  const instance = broker('host-1', process.pid, pid => pid === process.pid, state)
  const editors = new Map<string, string>()
  const directories = new Map<string, string>()
  const tickets = new TicketedEnvironment(instance, TP, {
    stopEditor: async (ticketId: string) => { events.push(`stop:${ticketId}`); editors.delete(ticketId) },
    ownsEditor: (ticketId: string) => editors.has(ticketId),
    directory: (ticketId: string) => directories.get(ticketId),
  })
  return { instance, tickets, events, editors, directories }
}
