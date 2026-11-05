/**
 * Phase B2 editor recovery: the TP environment exclusivity, TP-only identity, the real-handshake
 * readiness rule, one recovery chance per ticket, and the capture route that recovers before it
 * reports an endpoint unavailable. Every process/launch/kill/lock dependency is injected, so these
 * tests never start, stop or lock a real editor; the real entry points are exercised by name only.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TpEditorRecovery, isTpEditorProcess, portOwner, portOwnedBy, readinessOf, tpmcpCaptureCall, EXCLUSIVITY_FILE, fileExclusivity,
  type EditorProcess, type RecoveryOutcome, type RecoverySettings, type TpEditorEnvironment,
} from '../src/app/editor-recovery.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const PROJECT = 'F:\\TP\\TP.uproject'
const EDITOR = 'F:\\UnrealEngine\\Engine\\Binaries\\Win64\\UnrealEditor.exe'
const TOOL = 'CaptureWidgetBlueprintScreenshot'

function dir(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `dsh-recovery-${prefix}-`))
  roots.push(root)
  return root
}
/** A project file that really exists, so the adapter's existence check is the only thing being tested. */
function environment(overrides: Partial<TpEditorEnvironment> = {}): TpEditorEnvironment {
  const root = dir('project')
  const project = path.join(root, 'TP.uproject')
  writeFileSync(project, '{}')
  return { projectFile: project, editorExe: EDITOR, port: 55255, captureTool: TOOL, waitSeconds: 30, ...overrides }
}
const tpProcess = (pid = 4242): EditorProcess => ({ pid, name: 'UnrealEditor.exe', commandLine: `"${EDITOR}" "${PROJECT}"`, executablePath: EDITOR })
const foreignProcess = (pid = 99): EditorProcess => ({ pid, name: 'UnrealEditor.exe', commandLine: `"${EDITOR}" "E:/SADev/SAGame/SAGame.uproject"`, executablePath: EDITOR })

describe('phase B2 recovery rules', () => {
  it('recognises only the TP editor of exactly this project, never another UE project', () => {
    expect(isTpEditorProcess(tpProcess(), PROJECT)).toBe(true)
    expect(isTpEditorProcess(foreignProcess(), PROJECT)).toBe(false)
    // The SAgame editor is another project of the same engine: it is never TP's.
    expect(isTpEditorProcess(foreignProcess(), 'E:/SADev/SAGame/SAGame.uproject')).toBe(true)
    expect(isTpEditorProcess({ ...tpProcess(), name: 'UnrealEditor-Cmd.exe', commandLine: '' }, PROJECT)).toBe(false)
    // Same basename on another path is a different project.
    expect(isTpEditorProcess({ name: 'UnrealEditor.exe', executablePath: EDITOR, commandLine: '"E:\\Other\\TP.uproject"' }, PROJECT)).toBe(false)
    // A command line that really names the TP absolute project is the TP editor, whatever else it names.
    expect(isTpEditorProcess({ name: 'UnrealEditor.exe', executablePath: EDITOR, commandLine: '"E:\\Other\\Other.uproject" "F:\\TP\\TP.uproject"' }, PROJECT)).toBe(true)
    // A forward-slash spelling of the same absolute path is still this project.
    expect(isTpEditorProcess({ name: 'UnrealEditor.exe', executablePath: EDITOR, commandLine: `"${EDITOR}" "F:/TP/TP.uproject"` }, PROJECT)).toBe(true)
  })

  it('never treats a listening port as readiness, and requires the capture tool in tools/list', () => {
    const base = { endpoint: 'http://127.0.0.1:55255/mcp', sessionId: '', listened: true, tools: [] as string[] }
    expect(readinessOf({ ...base, listened: false }, TOOL)).toMatchObject({ ready: false, failure: 'port' })
    expect(readinessOf(base, TOOL)).toMatchObject({ ready: false, failure: 'handshake' })
    expect(readinessOf({ ...base, sessionId: 'sid' }, TOOL)).toMatchObject({ ready: false, failure: 'capture-tool' })
    expect(readinessOf({ ...base, sessionId: 'sid', tools: ['TPEditor.TPEditorToolset.ListMaps'] }, TOOL)).toMatchObject({ ready: false, failure: 'capture-tool' })
    expect(readinessOf({ ...base, sessionId: 'sid', tools: [`TPEditor.TPEditorToolset.${TOOL}`] }, TOOL)).toMatchObject({ ready: true, reason: '' })
    // An error that arrived before any session is a handshake failure, not a pass on a listed tool.
    expect(readinessOf({ ...base, sessionId: '', tools: [`TPEditor.TPEditorToolset.${TOOL}`], reason: 'boom' }, TOOL)).toMatchObject({ ready: false, failure: 'handshake' })
  })

  it('counts a tool reached through TPMcp’s dispatcher, and only for a named toolset', () => {
    // The real editor's tools/list shows only its dispatcher surface; the toolset is where capture lives.
    const dispatched = { endpoint: 'http://127.0.0.1:55255/mcp', sessionId: 'sid', listened: true, tools: ['list_toolsets', 'describe_toolset', 'call_tool'] }
    expect(readinessOf(dispatched, TOOL)).toMatchObject({ ready: false, failure: 'capture-tool' })
    expect(readinessOf({ ...dispatched, toolset: 'TPEditor.TPEditorToolset' }, TOOL)).toMatchObject({ ready: true, reason: '' })
    // A dispatcher without the toolset named proves nothing, and a port that never handshook proves less.
    expect(readinessOf({ ...dispatched, sessionId: '', toolset: 'TPEditor.TPEditorToolset' }, TOOL)).toMatchObject({ ready: false, failure: 'handshake' })
    expect(readinessOf({ ...dispatched, listened: false, toolset: 'TPEditor.TPEditorToolset' }, TOOL)).toMatchObject({ ready: false, failure: 'port' })
  })

  it('builds the capture call TPMcp really accepts, nesting a template under the dispatcher', () => {
    const template = { blueprintPath: '/Game/TP/UI/A.A', previewWidth: 1280, outputPath: 'frame.png' }
    // Measured on the running editor: tools/list shows only the dispatcher, so the call goes through it.
    expect(tpmcpCaptureCall({ tool: 'TPEditor.TPEditorToolset.CaptureWidgetBlueprintScreenshot', toolset: 'TPEditor.TPEditorToolset',
      template, listed: ['list_toolsets', 'describe_toolset', 'call_tool'] })).toEqual({ tool: 'call_tool', arguments: {
      toolset_name: 'TPEditor.TPEditorToolset', tool_name: 'CaptureWidgetBlueprintScreenshot', arguments: template } })
    // A server that lists the tool itself is called directly, without a dispatcher hop.
    expect(tpmcpCaptureCall({ tool: 'capture_screenshot', template, listed: ['capture_screenshot'] })).toEqual({ tool: 'capture_screenshot', arguments: template })
    // Without a toolset the contract's own tool name is used as-is, and no dispatcher is invented.
    expect(tpmcpCaptureCall({ tool: 'capture_screenshot', template })).toEqual({ tool: 'capture_screenshot', arguments: template })
    // A contract that already spells the dispatcher is passed through unchanged.
    expect(tpmcpCaptureCall({ tool: 'call_tool', toolset: 'TPEditor.TPEditorToolset', template })).toEqual({ tool: 'call_tool', arguments: template })
  })

  it('attributes a port only to the living TP editor that owns it', () => {
    const lines = [
      '  TCP    0.0.0.0:55255          0.0.0.0:0              LISTENING       4242',
      '  TCP    0.0.0.0:55255          0.0.0.0:0              LISTENING       77',
      '  TCP    [::]:55255             [::]:0                 LISTENING       4242',
    ]
    expect(portOwner(lines, 55255)).toBe(4242)
    expect(portOwner(lines, 55256)).toBeUndefined()
    expect(portOwnedBy(4242, [tpProcess()], PROJECT)).toBe(true)
    expect(portOwnedBy(4242, [foreignProcess()], PROJECT)).toBe(false)
    expect(portOwnedBy(undefined, [tpProcess()], PROJECT)).toBe(false)
  })
})

describe('phase B2 TP environment exclusivity', () => {
  it('holds across tickets and reports a live holder instead of taking the lock', async () => {
    const state = dir('state')
    const first = await fileExclusivity(state)(environment(), 'ticket-1', new AbortController().signal)
    expect(existsSync(path.join(state, EXCLUSIVITY_FILE))).toBe(true)
    // Another ticket in this very host is refused while the first lease is live.
    await expect(fileExclusivity(state)(environment(), 'ticket-2', new AbortController().signal)).rejects.toThrow(/held by live pid/)
    await first.release()
    expect(existsSync(path.join(state, EXCLUSIVITY_FILE))).toBe(false)
    // Released, the next ticket may hold it.
    const second = await fileExclusivity(state)(environment(), 'ticket-2', new AbortController().signal)
    await second.release()
  })

  it('reaps a dead holder so a restart recovers, and never deletes a later holder', async () => {
    const state = dir('state')
    const file = path.join(state, EXCLUSIVITY_FILE)
    mkdirSync(state, { recursive: true })
    // A crashed Session's lock: its pid no longer exists, so the next recovery may take it.
    writeFileSync(file, 'pid=999999\r\nholder=ticket-old\r\ntime=2026-11-02T00:00:00.000Z\r\ntoken=dead\r\n')
    const lease = await fileExclusivity(state)(environment(), 'ticket-new', new AbortController().signal)
    expect(readFileSync(file, 'utf8')).toMatch(/holder=ticket-new/)
    // A lock file rewritten by someone else is not removed by the stale lease's release.
    writeFileSync(file, 'pid=1\r\nholder=ticket-other\r\ntime=2026-11-02T00:00:00.000Z\r\ntoken=other\r\n')
    await lease.release()
    expect(readFileSync(file, 'utf8')).toMatch(/ticket-other/)
  })
})

describe('phase B2 one recovery chance', () => {
  function harness(sources: { ready: boolean }, settings: RecoverySettings = { enabled: true, environment: environment() }) {
    const events: string[] = []
    const order: string[] = []
    // The fixtures must name the very project the adapter is configured with, or identity is rightly refused.
    const project = settings.environment?.projectFile ?? PROJECT
    const tp = (pid = 4242): EditorProcess => ({ pid, name: 'UnrealEditor.exe', commandLine: `"${EDITOR}" "${project.replace(/\\/g, '/')}"`, executablePath: EDITOR })
    let ready = sources.ready
    let owner = 4242
    let editors = [foreignProcess(), tp()]
    const deps = {
      processList: vi.fn(async () => editors),
      listening: vi.fn(async () => ready),
      portTable: vi.fn(async () => (owner ? [`  TCP    0.0.0.0:55255          0.0.0.0:0              LISTENING       ${owner}`] : [])),
      // A live readiness source: the value is read at call time, so a launch/attempt can change it.
      handshake: vi.fn(async (): Promise<{ ready: boolean; endpoint: string; sessionId: string; tools: string[]; reason: string; failure?: 'port' | 'handshake' | 'capture-tool'; listened: boolean }> => (ready
        ? { ready: true, endpoint: 'http://127.0.0.1:55255/mcp', sessionId: 'sid-run', tools: [`TPEditor.TPEditorToolset.${TOOL}`], reason: '', listened: true }
        : { ready: false, endpoint: 'http://127.0.0.1:55255/mcp', sessionId: '', tools: [], reason: 'wait-tp-mcp.ps1 did not reach readiness in 30s', failure: 'handshake', listened: true })),
      launch: vi.fn(async () => { events.push('launch'); order.push('launch'); ready = true; return 4242 }),
      killEditor: vi.fn(async (_environment: TpEditorEnvironment, pid: number | undefined) => { events.push(`kill:${pid ?? 'all-tp'}`); order.push('kill') }),
      exclusive: vi.fn(async (_environment: TpEditorEnvironment, holder: string) => { order.push('lock'); return { holder, release: async () => { order.push('unlock') } } }),
    }
    const recovery = new TpEditorRecovery(() => settings, deps, dir('state'))
    return { recovery, deps, events, order, setReady: (value: boolean) => { ready = value },
      setOwner: (pid: number | undefined) => { owner = pid ?? 0 }, setEditors: (list: EditorProcess[]) => { editors = list } }
  }

  it('recovers a down TP editor once, in the contract order, and records the real PID', async () => {
    const h = harness({ ready: false })
    const outcome = await h.recovery.recover('ticket-1', undefined, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'recovered', attempted: true, pid: 4242, startedPid: 4242, sessionId: 'sid-run', reason: '' })
    // Exclusivity first, then the TP-only kill, then the launch, then the real handshake.
    expect(h.order).toEqual(['lock', 'kill', 'launch', 'unlock'])
    expect(h.deps.killEditor).toHaveBeenCalledTimes(1)
    expect(h.deps.handshake).toHaveBeenCalledTimes(2)
  })

  it('reuses an already ready TP editor without launching or killing anything', async () => {
    const h = harness({ ready: true })
    expect(await h.recovery.recover('ticket-1', undefined, new AbortController().signal)).toMatchObject({ kind: 'reused', attempted: true, pid: 4242 })
    expect(h.deps.launch).not.toHaveBeenCalled()
    expect(h.deps.killEditor).not.toHaveBeenCalled()
  })

  it('refuses a second recovery for the same ticket and records an environment block', async () => {
    const h = harness({ ready: false })
    const prior = { attempts: 1, outcome: { kind: 'unavailable' as const, attempted: true, reason: 'wait-tp-mcp.ps1 did not reach readiness in 30s', tools: [], portListened: false, at: 'then' } }
    const second = await h.recovery.recover('ticket-1', prior, new AbortController().signal)
    expect(second).toMatchObject({ kind: 'unavailable', attempted: false })
    expect(second.reason).toMatch(/one TP editor recovery/)
    expect(h.deps.launch).not.toHaveBeenCalled()
  })

  it('blocks without launching when no exclusivity can be taken', async () => {
    const h = harness({ ready: false })
    h.deps.exclusive.mockImplementation(async () => { throw new Error('TP environment is held by live pid 123 (ticket-9)') })
    const outcome = await h.recovery.recover('ticket-1', undefined, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'unavailable', attempted: false })
    expect(outcome.reason).toMatch(/exclusivity/)
    expect(h.deps.processList).not.toHaveBeenCalled()
    expect(h.deps.launch).not.toHaveBeenCalled()
  })

  it('blocks one attempt when the handshake never completes, without a retry loop', async () => {
    const h = harness({ ready: false })
    h.deps.launch.mockImplementation(async () => 4242)
    // Whatever happens, readiness never arrives: the port may listen, the handshake never completes.
    h.deps.handshake.mockImplementation(async () => ({ ready: false, endpoint: '', sessionId: '', tools: [], reason: 'init timeout', failure: 'handshake', listened: true }))
    const outcome = await h.recovery.recover('ticket-1', undefined, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'unavailable', attempted: true, startedPid: 4242 })
    expect(outcome.reason).toMatch(/init timeout/)
    // One launch and two readiness attempts (before and after): a failure is reported, never looped.
    expect(h.deps.launch).toHaveBeenCalledTimes(1)
    expect(h.deps.handshake).toHaveBeenCalledTimes(2)
  })

  it('refuses to act when another project holds the port, and never kills it', async () => {
    const h = harness({ ready: false })
    // The only editor on the machine is another UE project, and it is the one serving the port.
    h.setEditors([foreignProcess(777)])
    h.setOwner(777)
    h.deps.handshake.mockImplementation(async () => ({ ready: false, endpoint: '', sessionId: '', tools: [], reason: 'handshake failed', failure: 'handshake', listened: true }))
    h.deps.portTable.mockImplementation(async () => ['  TCP    0.0.0.0:55255          0.0.0.0:0              LISTENING       777'])
    const outcome = await h.recovery.recover('ticket-1', undefined, new AbortController().signal)
    expect(outcome.kind).toBe('unavailable')
    expect(outcome.reason).toMatch(/not this TP editor/)
    expect(h.deps.killEditor).not.toHaveBeenCalled()
    expect(h.deps.launch).not.toHaveBeenCalled()
  })

  it('never treats a ready answer from another project as TP readiness', async () => {
    const h = harness({ ready: true })
    // The endpoint answers, but the owner is another UE project's editor.
    h.setEditors([foreignProcess(777)])
    h.setOwner(777)
    const outcome = await h.recovery.recover('ticket-1', undefined, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'unavailable', attempted: true })
    expect(outcome.reason).toMatch(/no TP editor of .* owns it/)
    expect(h.deps.killEditor).not.toHaveBeenCalled()
  })

  it('refuses recovery entirely when the operator did not enable it', async () => {
    const h = harness({ ready: false }, { enabled: false })
    const outcome = await h.recovery.recover('ticket-1', undefined, new AbortController().signal)
    expect(outcome).toMatchObject({ kind: 'unavailable', attempted: false })
    expect(outcome.reason).toMatch(/not configured/)
    // Nothing was even taken: an unconfigured host does not lock or inspect the environment.
    expect(h.deps.exclusive).not.toHaveBeenCalled()
    expect(h.deps.processList).not.toHaveBeenCalled()
    expect(h.deps.launch).not.toHaveBeenCalled()
    expect(h.recovery.enabled()).toBe(false)
  })

  it('starts no process for a missing project file or a relative editor path', async () => {
    const missing = environment({ projectFile: path.join(dir('none'), 'Absent.uproject') })
    const h = harness({ ready: false }, { enabled: true, environment: missing })
    expect(await h.recovery.recover('ticket-1', undefined, new AbortController().signal)).toMatchObject({ kind: 'unavailable', attempted: false })
    expect(h.deps.launch).not.toHaveBeenCalled()
    const relative = harness({ ready: false }, { enabled: true, environment: environment({ editorExe: 'UnrealEditor.exe' }) })
    expect((await relative.recovery.recover('ticket-1', undefined, new AbortController().signal)).reason).toMatch(/absolute/)
    expect(relative.deps.launch).not.toHaveBeenCalled()
  })

  it('cleans up only the PID it started, and only while that PID is still the TP editor', async () => {
    const settings: RecoverySettings = { enabled: true, environment: environment() }
    const project = settings.environment!.projectFile
    const tp = (pid: number): EditorProcess => ({ pid, name: 'UnrealEditor.exe', commandLine: `"${EDITOR}" "${project.replace(/\\/g, '/')}"`, executablePath: EDITOR })
    const events: string[] = []
    let alive: EditorProcess[] = []
    const deps = {
      processList: async () => alive,
      listening: async () => false,
      portTable: async () => (alive.some(item => item.pid === 4242) ? [`  TCP    0.0.0.0:55255          0.0.0.0:0              LISTENING       4242`] : []),
      handshake: async () => ({ ready: false, endpoint: '', sessionId: '', tools: [], reason: 'down', failure: 'port' as const, listened: false }),
      launch: async () => 4242,
      killEditor: async (_environment: TpEditorEnvironment, pid: number | undefined) => { events.push(`kill:${pid ?? 'all-tp'}`) },
      exclusive: async (_environment: TpEditorEnvironment, holder: string) => ({ holder, release: async () => {} }),
    }
    const recovery = new TpEditorRecovery(() => settings, deps, dir('state'))
    // A failed recovery leaves no recorded PID: cleanup does nothing.
    await recovery.recover('ticket-failed', undefined, new AbortController().signal)
    await recovery.cleanup('ticket-failed', settings.environment!)
    expect(events).toEqual(['kill:all-tp'])
    events.length = 0
    // A successful recovery records its PID; cleanup stops exactly that PID.
    alive = [tp(4242)]
    deps.handshake = async () => ({ ready: true, endpoint: '', sessionId: 'sid', tools: [`TPEditor.TPEditorToolset.${TOOL}`], reason: '', listened: true }) as never
    expect(await recovery.recover('ticket-ok', undefined, new AbortController().signal)).toMatchObject({ kind: 'reused' })
    await recovery.cleanup('ticket-ok', settings.environment!)
    expect(events).toEqual([])
    // A recovery that started the editor records that PID, and cleanup stops it.
    alive = [tp(4242)]
    const started = new TpEditorRecovery(() => settings, { ...deps, handshake: (() => {
      let first = true
      return async () => {
        if (first) { first = false; return { ready: false, endpoint: '', sessionId: '', tools: [], reason: 'down', failure: 'port' as const, listened: false } }
        return { ready: true, endpoint: '', sessionId: 'sid', tools: [`TPEditor.TPEditorToolset.${TOOL}`], reason: '', listened: true }
      }
    })() }, dir('state'))
    expect(await started.recover('ticket-started', undefined, new AbortController().signal)).toMatchObject({ kind: 'recovered', startedPid: 4242 })
    events.length = 0
    await started.cleanup('ticket-started', settings.environment!)
    expect(events).toEqual(['kill:4242'])
    // The same PID reused by another project's editor is not ours to stop.
    alive = [foreignProcess(4242)]
    events.length = 0
    const other = new TpEditorRecovery(() => settings, { ...deps, processList: async () => [foreignProcess(4242)] }, dir('state'))
    await other.cleanup('ticket-ok', settings.environment!)
    expect(events).toEqual([])
  })
})

describe('phase B2 capture recovers before reporting unavailable', () => {
  it('captures after recovery and names the outcome of a failed recovery', async () => {
    const { HostVisualCapture } = await import('../src/app/visual-capture.ts')
    const state = dir('state')
    const outcomes: RecoveryOutcome[] = []
    let calls = 0
    const host = new HostVisualCapture({
      settings: () => ({ transport: 'streamable-http', endpoint: 'http://127.0.0.1:1/mcp' }),
      statePath: () => path.join(state, 'tool'),
      recovery: () => ({ recover: async () => { calls++; return { kind: 'unavailable', attempted: true, reason: 'launch failed: no editor binary', tools: [], portListened: false, at: 'now' } } }),
      recoveryRecord: () => ({ prior: undefined, save: (_prior, outcome) => { outcomes.push(outcome) } }),
    })
    const { createVisualContract } = await import('../src/visual-contract.ts')
    const workspace = dir('ws')
    const contract = createVisualContract({ scenario: 'inventory-open', capture: { server: 'tpmcp', tool: 'capture_screenshot', arguments: { path: '{{path}}' } },
      inspector: { executable: process.execPath }, checks: ['nonblank'], minimumFrames: 1 })
    const result = await host.capture({ ticketId: 't', assignmentId: 'a', workspace, contract, group: 'g' }, 1, { at: 'now' }, new AbortController().signal)
    expect(calls).toBe(1)
    expect(outcomes).toHaveLength(1)
    expect(result).toMatchObject({ status: 'unavailable' })
    // The reason keeps both facts: the endpoint was unreachable and the recovery's own block.
    expect(result.reason).toMatch(/recovery: launch failed/)
  })
})
