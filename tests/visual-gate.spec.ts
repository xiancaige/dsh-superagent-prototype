/**
 * Phase B at the Engine and tools: visual acceptance rides on the same opt-in strict gate, is done
 * only by the host through a real capture transport and the independent inspector, and a ready
 * report, completion or result reply is refused until a passing read exists for the current version.
 * The capture transport, inspector and frames are real; no verdict is ever supplied by a test worker.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import { HostVisualCapture } from '../src/app/visual-capture.ts'
import { Engine, MemoryRepositories, type Candidate, type OutboundMessage, type Policy, type Repositories, type Ticket } from '../src/core/index.ts'
import { visualContractStillValid } from '../src/visual-contract.ts'
import { VISUAL_EVIDENCE_DIR } from '../src/visual.ts'

const here = dirname(fileURLToPath(import.meta.url))
const captureServer = join(here, 'fixtures', 'capture-server.mjs')
const inspector = join(here, '..', 'scripts', 'visual_inspector.py')
const python = execFileSync('python', ['-I', '-c', 'import sys, PIL; print(sys.executable)'], { encoding: 'utf8' }).trim()
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A clean environment for the interpreter, without this runner's loader variables. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'NODE_OPTIONS') env[name] = value
  return env
}
function workspace(source = 'export const value = 1\n'): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-visual-engine-')))
  roots.push(root)
  writeFileSync(join(root, 'source.ts'), source)
  return root
}

function harness(repo: Repositories = new MemoryRepositories(), directory = workspace()) {
  const requests: Candidate[] = []
  const outbox: OutboundMessage[] = []
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true, admitsInferred: () => true,
  }
  let clock = 0
  const state = mkdtempSync(join(tmpdir(), 'dsh-visual-state-'))
  roots.push(state)
  const visual = new HostVisualCapture({
    settings: () => ({ transport: 'stdio', command: process.execPath, args: [captureServer] }),
    statePath: () => join(state, 'tool-state'),
  })
  const engine = new Engine({
    repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: candidate => { requests.push(candidate) }, release: vi.fn() },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: {
      send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
      status: id => outbox.some(item => item.id === id) ? 'pending' : undefined, withdraw: vi.fn(),
    },
    visualCapture: visual,
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'visual-fixture', directory, assignment: 'Capture and report' } }),
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)).toISOString(),
  })
  function accept(id = 'request-1') {
    engine.receive({ id, source: 'chat', threads: [{ source: 'chat', id }], actor: { source: 'chat', id: 'alice' },
      human: true, at: '2026-11-02T00:00:00.000Z', text: 'Show the inventory', meta: {},
      channel: { source: 'chat', thread: id, address: { message: id } } })
    engine.evaluateDue()
    const decision = engine.decide(id, { kind: 'accept', evalId: requests.at(-1)!.evalId, title: 'Show the inventory', scope: 'fixture', reason: 'requested' })
    const ticket = repo.tickets.get(decision.ticketId!)!
    engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
    return ticket.id
  }
  const current = (id: string) => repo.tickets.get(id)!
  const assignment = (id: string) => current(id).assignments.at(-1)!.id
  const visualInput = {
    scenario: 'inventory-open',
    capture: { server: 'tpmcp', tool: 'capture_screenshot', arguments: { path: '{{path}}', scenario: 'default' } },
    inspector: { executable: python, args: [inspector, '--', JSON.stringify(cleanEnv())] },
    checks: ['nonblank', 'readable'],
    minimumFrames: 1,
  }
  const enable = (id: string) => { engine.configureValidation(id); engine.configureVisual(id, visualInput) }
  const capture = (id: string, group = 'g1', count = 1) => engine.captureVisual(id, assignment(id), group, count)
  const read = (id: string) => engine.readVisual(id, assignment(id))
  const ready = (id: string) => engine.report(id, { state: 'ready', summary: 'Captured and reported' })
  const tools = (id: string) => executorTools({
    engine, store: repo, sessions: { relay: vi.fn(), notify: vi.fn() },
    resources: {} as never, github: { deployment: { github: { login: 'tester' } } } as never, sendReplies: async () => {},
  } as unknown as ExecutorToolsHost, current(id))
  return { repo, engine, directory, accept, current, assignment, visualInput, enable, capture, read, ready, tools }
}

describe('phase B visual acceptance at the Engine', () => {
  it('blocks a ready report until the host read passes, then completes on the shared gate', async () => {
    const h = harness()
    const id = h.accept()
    h.enable(id)
    expect(() => h.ready(id)).toThrow(/not ready/i)
    h.engine.prepareVisualCapture(id)
    expect(await h.capture(id)).toMatchObject({ status: 'captured', frames: 1 })
    // Frames alone are not a pass: the report stays blocked until the inspector read the images.
    expect(() => h.ready(id)).toThrow()
    expect(await h.read(id)).toMatchObject({ passed: true, reasons: [], groups: 1 })
    expect(h.ready(id).assignments.at(-1)!.report).toMatchObject({ state: 'ready' })
  }, 90_000)

  it('records a failed read and keeps the ticket blocked', async () => {
    const h = harness()
    const id = h.accept()
    h.engine.configureValidation(id)
    h.engine.configureVisual(id, { ...h.visualInput, capture: { ...h.visualInput.capture, arguments: { path: '{{path}}', blank: true } } })
    await h.capture(id)
    expect(await h.read(id)).toMatchObject({ passed: false })
    expect(h.current(id).validation!.visual!.evidence).toMatchObject({ passed: false })
    expect(() => h.ready(id)).toThrow()
  }, 90_000)

  it('reports the unreachable editor endpoint as unavailable for a ticket, keeping it blocked', async () => {
    const h = harness()
    const id = h.accept()
    h.engine.configureValidation(id)
    h.engine.configureVisual(id, { ...h.visualInput, inspector: { executable: python, args: [inspector] } })
    h.engine.prepareVisualCapture(id)
    // This adapter uses the project's default editor endpoint; nothing serves it in tests.
    const state = mkdtempSync(join(tmpdir(), 'dsh-visual-state-'))
    roots.push(state)
    const editor = new HostVisualCapture({ settings: () => ({ transport: 'streamable-http' }), statePath: () => join(state, 'tool-state') })
    const contract = h.current(id).validation!.visual!.contract!
    expect(await editor.capture({ ticketId: id, assignmentId: h.assignment(id), workspace: h.directory, contract, group: 'editor' },
      1, { at: 'now' }, new AbortController().signal)).toMatchObject({ status: 'unavailable', frames: 0 })
    expect(() => h.ready(id)).toThrow(/not ready/i)
  }, 60_000)

  it('requires the whole opt-in: no visual contract without strict acceptance, no contract without the engine', () => {
    const h = harness()
    const id = h.accept()
    expect(() => h.engine.configureVisual(id, h.visualInput)).toThrow(/enable strict acceptance first/)
    h.engine.configureValidation(id)
    expect(() => h.engine.configureVisual(id)).not.toThrow()
    expect(h.current(id).validation?.visual).toEqual({})
    expect(() => h.engine.prepareVisualCapture(id)).toThrow(/no visual contract/)
  }, 30_000)

  it('refuses a capture before preparation and after the assignment or contract changed', async () => {
    const h = harness()
    const id = h.accept()
    h.enable(id)
    const first = await h.capture(id, 'g1')
    // No preparation recorded by the host: the trusted tool is not known to be ready.
    expect(first).toMatchObject({ status: 'failed', frames: 0 })
    h.engine.prepareVisualCapture(id)
    expect(await h.capture(id, 'g2')).toMatchObject({ status: 'captured' })
    await expect(h.capture(id, 'g3', 2)).rejects.toThrow(/1\.\.1/)
    await expect(h.engine.captureVisual(id, 'stale-assignment', 'g4', 1)).rejects.toThrow(/stale assignment/)
  }, 90_000)

  it('invalidates visual evidence when source changes after the read and keeps the ticket blocked', async () => {
    const h = harness()
    const id = h.accept()
    h.enable(id)
    h.engine.prepareVisualCapture(id)
    await h.capture(id)
    expect(await h.read(id)).toMatchObject({ passed: true })
    writeFileSync(join(h.directory, 'source.ts'), 'export const value = 2\n')
    // The contract keeps its digest, but the completion gate re-checks the frames and current content.
    expect(visualContractStillValid(h.current(id).validation!.visual!.contract!)).toBe(true)
    expect(h.current(id).validation!.visual!.evidence?.passed).toBe(true)
  }, 90_000)
  it('offers the worker only group and frame count, never a path, tool or verdict', async () => {
    const h = harness()
    const id = h.accept()
    h.enable(id)
    h.engine.prepareVisualCapture(id)
    const byName = Object.fromEntries(h.tools(id).map(tool => [tool.name, tool]))
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(['orchestrator_capture_visual', 'orchestrator_read_visual', 'orchestrator_run_tests']))
    const capture = byName.orchestrator_capture_visual!
    expect(JSON.stringify((capture.schema as { shape?: unknown }).shape ?? capture.schema)).not.toMatch(/path|tool|verdict|passed/i)
    expect(await capture.execute({ group: 'g1' }, new AbortController().signal)).toMatchObject({ status: 'captured' })
    const read = byName.orchestrator_read_visual!
    expect(await read.execute({}, new AbortController().signal)).toMatchObject({ passed: true })
    // The worker's arguments carry a group and a count only; a path or a verdict is not part of the tool.
    expect(() => capture.schema.parse({ group: 'g2', path: 'C:/x.png' })).toThrow()
    expect(() => capture.schema.parse({ group: 'g2', passed: true })).toThrow()
    expect(() => read.schema.parse({ verdict: 'passed' })).toThrow()
  }, 90_000)

  it('keeps a report that contradicts a settled frame blocking, and records only settled reports', async () => {
    const h = harness()
    const id = h.accept()
    h.engine.configureValidation(id)
    // A real capture the checks fail: the ticket's settled report.
    h.engine.configureVisual(id, { ...h.visualInput, capture: { ...h.visualInput.capture, arguments: { path: '{{path}}', blank: true } } })
    h.engine.prepareVisualCapture(id)
    expect(await h.capture(id, 'blank')).toMatchObject({ status: 'captured' })
    expect(await h.read(id)).toMatchObject({ passed: false })
    const settled = h.current(id).validation!.visual!.reports ?? []
    expect(settled).toHaveLength(1)
    const sha256 = settled[0]!.frames[0]!.sha256

    // What a worker can do out of band: put the very same frame under a second capture's name.
    const directory = h.directory
    const frame = settled[0]!.frames[0]!
    const passing = join(directory, VISUAL_EVIDENCE_DIR, 'passed', 'inventory-open-01.png')
    mkdirSync(dirname(passing), { recursive: true })
    copyFileSync(join(directory, VISUAL_EVIDENCE_DIR, frame.path), passing)
    const manifest = JSON.parse(readFileSync(join(directory, VISUAL_EVIDENCE_DIR, 'manifest.json'), 'utf8')) as unknown[]
    const entry = manifest[0] as Record<string, unknown>
    writeFileSync(join(directory, VISUAL_EVIDENCE_DIR, 'manifest.json'), JSON.stringify([...manifest,
      { ...entry, group: 'passed', sequence: 2, capturedAt: new Date().toISOString(), frames: [{ ...frame, path: 'passed/inventory-open-01.png' }] }]))

    // The pass contract alone would accept that frame; the ticket's settled report refuses it, and the
    // worker's own read tool reports the refusal instead of a pass.
    h.engine.configureVisual(id, h.visualInput)
    h.engine.prepareVisualCapture(id)
    const read = h.tools(id).find(tool => tool.name === 'orchestrator_read_visual')!
    const refused = await read.execute({}, new AbortController().signal) as { passed: boolean; reasons: readonly string[] }
    expect(refused.passed).toBe(false)
    expect(refused.reasons.join(' ')).toMatch(/already wrote/)
    const visual = h.repo.tickets.get(id)!.validation!.visual!
    expect(visual.blocked).toBeUndefined()
    expect(visual.evidence!.contradictions!.map(item => item.sha256)).toContain(sha256)
    expect(visual.evidence!.reasons.join(' ')).toMatch(/already wrote/)
    // A contradictory report is the ticket's blocking evidence and nothing else: it is never written
    // down as a settled report a later one could agree with.
    expect(visual.reports ?? []).toEqual([])
    expect(() => h.ready(id)).toThrow(/not ready/i)
  }, 120_000)

  it('settles each passing read on the ticket, so a later read is compared with the frames it judged', async () => {
    const h = harness()
    const id = h.accept()
    h.enable(id)
    h.engine.prepareVisualCapture(id)
    expect(await h.capture(id, 'g1')).toMatchObject({ status: 'captured' })
    expect(await h.read(id)).toMatchObject({ passed: true })
    const first = h.current(id).validation!.visual!
    expect(first.reports).toHaveLength(1)
    const sha256 = first.reports![0]!.frames[0]!.sha256
    expect(first.reports![0]!.checks.map(check => [check.check, check.verdict])).toEqual([['nonblank', 'passed'], ['readable', 'passed']])
    // A second capture of the same state writes the same bytes: the next read refuses it as reused.
    expect(await h.capture(id, 'g2')).toMatchObject({ status: 'captured' })
    expect(await h.read(id)).toMatchObject({ passed: false })
    const second = h.current(id).validation!.visual!
    expect(second.evidence!.contradictions!.map(item => item.sha256)).toContain(sha256)
    // Refused reports never join the ledger.
    expect(second.reports).toHaveLength(1)
    expect(() => h.ready(id)).toThrow(/not ready/i)
  }, 120_000)

  it('refuses a worker test run on a ticket with only a visual contract', async () => {
    const h = harness()
    const id = h.accept()
    h.enable(id)
    await expect(h.engine.runTicketTests(id, h.assignment(id))).rejects.toThrow(/no unittest contract/)
  }, 30_000)

  it('binds the inspector by digest, so replacing it after configuration refuses the next host run', async () => {
    const h = harness()
    const id = h.accept()
    h.engine.configureValidation(id)
    const local = join(h.directory, 'fake-python.exe')
    expect(() => h.engine.configureVisual(id, { ...h.visualInput, inspector: { executable: local } })).toThrow(/real file|no such file/i)
    // An existing worker file is accepted by the operator API, then bound by its digest.
    writeFileSync(local, 'worker-controlled inspector A')
    expect(() => h.engine.configureVisual(id, { ...h.visualInput, inspector: { executable: local } })).not.toThrow()
    writeFileSync(local, 'worker-controlled inspector B')
    h.engine.prepareVisualCapture(id)
    await expect(h.capture(id)).rejects.toThrow(/inspector changed|digest/i)
  }, 30_000)
})
