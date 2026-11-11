/**
 * Acceptance profile by worker role: the same ticket data judged under `game` and `ops` gets different adapter
 * sets, an ops ticket cannot be given an Unreal CQTest contract, and a game ticket's CQTest path is unchanged.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, acceptanceProfile, ticketAcceptanceProfile,
  type Candidate, type OutboundMessage, type Policy, type Ticket } from '../src/core/index.ts'
import { CQTEST_PASSING_ID, writeCqtestReport } from './fixtures/cqtest-report.ts'

const executable = realpathSync(process.execPath)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function harness(role?: 'game' | 'ops') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-acceptance-profile-')))
  roots.push(directory)
  writeFileSync(join(directory, 'source.ts'), 'export const answer = () => 42\n')
  writeCqtestReport(directory)
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const outbox: OutboundMessage[] = []
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  let clock = 0
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: candidate => { requests.push(candidate) }, release: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
      status: id => outbox.some(item => item.id === id) ? 'pending' : undefined, withdraw: vi.fn() },
    prepareTicket: ticket => ({ ...ticket, ...role ? { workspaceRole: role } : {}, execution: { name: 'profile', directory, assignment: 'Check' } }),
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)).toISOString() })
  engine.receive({ id: 'r1', source: 'chat', threads: [{ source: 'chat', id: 'r1' }], actor: { source: 'chat', id: 'alice' }, human: true,
    at: '2026-11-02T00:00:00.000Z', text: 'Fix', meta: {}, channel: { source: 'chat', thread: 'r1', address: { message: 'r1' } } })
  engine.evaluateDue()
  const decision = engine.decide('r1', { kind: 'accept', evalId: requests.at(-1)!.evalId, title: 'Fix', scope: 'fixture', reason: 'requested' })
  const id = decision.ticketId!
  engine.assignmentStarted(id, repo.tickets.get(id)!.assignments.at(-1)!.id)
  const contract = { adapter: 'cqtest-report' as const, executable, workspace: directory, requiredTestIds: [CQTEST_PASSING_ID], timeoutMs: 10_000 }
  return { engine, repo, id, contract, current: (): Ticket => repo.tickets.get(id)! }
}

describe('acceptance profile by workspace role', () => {
  it('gives game and ops different adapter sets from the same ticket data', () => {
    const base: Pick<Ticket, 'workspaceRole'> = {}
    expect(ticketAcceptanceProfile(base)).toBe(acceptanceProfile('game'))
    expect(ticketAcceptanceProfile({ workspaceRole: 'game' }).adapters).toEqual(['cqtest-report'])
    expect(ticketAcceptanceProfile({ workspaceRole: 'ops' }).adapters).toEqual([])
    expect(ticketAcceptanceProfile({ workspaceRole: 'ops' })).not.toEqual(ticketAcceptanceProfile({ workspaceRole: 'game' }))
  })

  it('refuses a CQTest contract on an ops ticket, naming the role, and leaves the ticket unchanged', () => {
    const h = harness('ops')
    expect(() => h.engine.configureValidation(h.id, h.contract)).toThrow(UserError)
    expect(() => h.engine.configureValidation(h.id, h.contract)).toThrow(/cqtest-report.*cannot judge a ops ticket/)
    expect(h.current().validation).toBeUndefined()
  })

  it('still lets an ops ticket enable strict acceptance without a contract (visual-only), as before', () => {
    const h = harness('ops')
    expect(h.engine.configureValidation(h.id).validation).toEqual({ enabled: true })
  })

  it('keeps the game CQTest contract path unchanged, for an explicit and for an omitted role', () => {
    for (const role of ['game', undefined] as const) {
      const h = harness(role)
      const configured = h.engine.configureValidation(h.id, h.contract)
      expect(configured.validation?.enabled).toBe(true)
      expect(configured.validation?.contract?.adapter).toBe('cqtest-report')
    }
  })

  it('does not lock out an ops ticket whose contract was recorded before profiles existed', async () => {
    const h = harness('game')
    h.engine.configureValidation(h.id, h.contract)
    const evidence = await h.engine.runTicketTests(h.id, h.current().assignments.at(-1)!.id)
    expect(evidence.passed).toBe(true)
    // The same record re-read under the ops role: completion is judged by its stored evidence, not by the profile.
    const stored: Ticket = JSON.parse(JSON.stringify(h.current()))
    stored.workspaceRole = 'ops'
    h.repo.tickets.save(stored)
    expect(h.engine.report(h.id, { state: 'ready', summary: 'done' }).ended?.outcome).toBe('completed')
  })
})
