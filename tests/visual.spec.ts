/**
 * Phase B visual evidence against real tools: a real MCP screenshot server over stdio, the real PNG
 * header check, and the harness-owned image inspector (Pillow) reading the frames it is given. The
 * unreachable editor endpoint is exercised too, because "no real capture" must stay visible and
 * blocking instead of being absorbed as a pass.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpCaptureSession, VisualEvidenceStore, assessVisual, validateVisualEvidence } from '../src/visual-host.ts'
import type { CaptureBinding, VisualManifestEntry } from '../src/visual-host.ts'
import { McpStdioCaptureSession } from '../src/app/visual-stdio.ts'
import { captureArgumentsFor, canonicalJson, createVisualContract, visualContractStillValid } from '../src/visual-contract.ts'
import { DEFAULT_VISUAL_ENDPOINT, HostVisualCapture, type VisualCaptureSettings } from '../src/app/visual-capture.ts'
import { VISUAL_EVIDENCE_DIR, framePath, readImageHeader } from '../src/visual.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const captureServer = path.join(here, 'fixtures', 'capture-server.mjs')
const inspector = path.join(here, '..', 'scripts', 'visual_inspector.py')
// Real interpreters only: a missing Python, Pillow or node fails this suite rather than a mocked pass.
// Pillow is an installed site-package, so this check (and the inspector it will run) does not use -S.
// The runner's loader variables (process.execArgv, as tsx sets them) are cleared for each inspector call:
// otherwise the interpreter would receive a Node loader meant for this test process.
const python = execFileSync('python', ['-I', '-c', 'import sys, PIL; print(sys.executable)'], { encoding: 'utf8', env: interpreterEnv() }).trim()

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace(source = 'export const value = 1\n'): string {
  // `realpathSync.native` gives the long path form: the temp dir's 8.3 short name is not what a tool reads.
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-visual-test-')))
  roots.push(root)
  writeFileSync(path.join(root, 'source.ts'), source)
  return root
}
function stateRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-visual-state-'))
  roots.push(root)
  return root
}
type Overrides = { scenario?: string; capture?: { server: string; tool: string; arguments: Record<string, unknown> }; checks?: string[]; minimumFrames?: number }
function contractOf(overrides: Overrides = {}) {
  return createVisualContract({
    scenario: 'inventory-open',
    capture: { server: 'tpmcp', tool: 'capture_screenshot', arguments: { path: '{{path}}', scenario: 'default' } },
    inspector: { executable: python, args: [inspector, '--', JSON.stringify(interpreterEnv())] },
    checks: ['nonblank', 'readable'],
    minimumFrames: 1,
    ...overrides,
  })
}
function interpreterEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_REQUIRE
  return env
}
function binding(root: string, contract: ReturnType<typeof contractOf>, group = 'g1'): CaptureBinding {
  return { ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract, group }
}
/** The stdio route, pointed at a real MCP server; the same route the host uses where no editor exists. */
function store(state: string): VisualEvidenceStore {
  return new VisualEvidenceStore(new McpStdioCaptureSession({ command: process.execPath, args: [captureServer] }), { mcpDatabase: state })
}

describe('phase B contract and frame rules', () => {
  it('requires a fixed scenario, tool, inspector, named checks and a frame minimum', () => {
    expect(contractOf()).toMatchObject({ scenario: 'inventory-open', checks: ['nonblank', 'readable'], minimumFrames: 1 })
    const raw = { ...contractOf(), digest: '' }
    for (const change of [{ scenario: 'Not A Slug' }, { checks: [] }, { checks: ['a', 'a'] }, { minimumFrames: 0 }, { minimumFrames: 21 },
      { capture: { server: '', tool: 'x', arguments: {} } }, { capture: { server: 's', tool: 't', arguments: { path: '{{path}}' }, extra: 1 } },
      { inspector: { executable: 'python' } }, { inspector: { executable: inspector, args: [inspector], shell: true } }, { unexpected: true }]) {
      expect(() => createVisualContract({ ...raw, ...change } as never), JSON.stringify(change)).toThrow()
    }
    // A restored contract re-derives its digest from its own fields, and that must round-trip.
    expect(visualContractStillValid(contractOf())).toBe(true)
    expect(visualContractStillValid({ ...contractOf(), scenario: 'other-open' })).toBe(false)
    expect(() => captureArgumentsFor({ path: 'fixed.png' }, 'C:/frames/one.png')).toThrow(/place \{\{path\}\}/)
  })

  it('rejects a frame that is not a complete PNG', () => {
    const root = workspace()
    const file = path.join(root, 'fake.png')
    writeFileSync(file, 'not an image')
    expect(readImageHeader(readFileSync(file))).toBeUndefined()
    // A real capture, truncated before its IEND, is not a decodable frame either.
    const real = readFileSync(path.join(here, 'fixtures', 'capture-server.mjs'))
    expect(readImageHeader(real)).toBeUndefined()
  })
})

describe('phase B real capture and inspection', () => {
  it('captures through a real MCP server and passes on frames the inspector really read', async () => {
    const root = workspace()
    const contract = contractOf()
    const evidence = await (async () => {
      const writer = store(stateRoot())
      try {
        expect(await writer.capture(binding(root, contract), 1, { at: new Date().toISOString() }, new AbortController().signal)).toMatchObject({ status: 'captured', frames: 1 })
        const manifest = writer.readManifest(root)
        expect(manifest).toHaveLength(1)
        expect(readImageHeader(readFileSync(framePath(root, manifest[0]!.frames[0]!.path)))).toMatchObject({ width: 320, height: 180 })
      } finally { await writer.close() }
      return assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    })()
    expect(evidence.groups.map(group => group.verdict)).toEqual(['passed'])
    expect(evidence.groups[0]!.checks.map(check => [check.check, check.verdict])).toEqual([['nonblank', 'passed'], ['readable', 'passed']])
    expect(evidence.passed).toBe(true)
    expect(evidence.reasons).toEqual([])
    expect(validateVisualEvidence(contract, root, evidence, 'ticket-1', 'assignment-1').valid).toBe(true)
  }, 90_000)

  it('fails a blank capture instead of counting the file as success', async () => {
    const root = workspace()
    const contract = contractOf({ capture: { server: 'tpmcp', tool: 'capture_screenshot', arguments: { path: '{{path}}', blank: true } } })
    const writer = store(stateRoot())
    try {
      const blank = await writer.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal)
      expect(blank).toMatchObject({ status: 'captured', frames: 1 })
    }
    finally { await writer.close() }
    const evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    expect(evidence.passed).toBe(false)
    expect(evidence.groups[0]!.verdict).toBe('failed')
    expect(evidence.groups[0]!.checks.find(check => check.check === 'nonblank')).toMatchObject({ verdict: 'failed' })
  }, 90_000)

  it('records a trusted tool that returned no image as a failed capture, never as a frame', async () => {
    const root = workspace()
    const contract = contractOf({ capture: { server: 'tpmcp', tool: 'not_a_screenshot', arguments: { path: '{{path}}' } } })
    const writer = store(stateRoot())
    try { expect(await writer.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal)).toMatchObject({ status: 'failed', frames: 0 }) }
    finally { await writer.close() }
    const evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    expect(evidence.passed).toBe(false)
    expect(evidence.groups[0]).toMatchObject({ status: 'failed', verdict: 'undetermined' })
  }, 90_000)

  it('reports the unreachable editor endpoint as unavailable with no frame written', async () => {
    const root = workspace()
    const contract = contractOf()
    const session = new McpCaptureSession(DEFAULT_VISUAL_ENDPOINT)
    const writer = new VisualEvidenceStore(session, { mcpDatabase: stateRoot() })
    try {
      expect(await writer.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal)).toMatchObject({ status: 'unavailable', frames: 0 })
      expect(writer.readManifest(root)[0]!.frames).toEqual([])
    } finally { await writer.close() }
    const evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    expect(evidence.passed).toBe(false)
    expect(evidence.groups[0]).toMatchObject({ status: 'unavailable', verdict: 'undetermined' })
  }, 90_000)

  it('refuses a capture without host preparation, outside the contract minimum, or twice for one group', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store(stateRoot())
    try {
      expect(await writer.capture(binding(root, contract), 1, undefined, new AbortController().signal)).toMatchObject({ status: 'failed', frames: 0 })
      await expect(writer.capture(binding(root, contract, 'g2'), 5, { at: 'now' }, new AbortController().signal)).rejects.toThrow(/1\.\.1/)
      expect(await writer.capture(binding(root, contract, 'g3'), 1, { at: 'now' }, new AbortController().signal)).toMatchObject({ status: 'captured' })
      await expect(writer.capture(binding(root, contract, 'g3'), 1, { at: 'now' }, new AbortController().signal)).rejects.toThrow(/already exists/)
      await expect(writer.capture(binding(root, contract, '../escape'), 1, { at: 'now' }, new AbortController().signal)).rejects.toThrow(/path-safe/)
    } finally { await writer.close() }
  }, 90_000)

  it('reports multi-frame evidence short of the minimum as undetermined', async () => {
    const root = workspace()
    const contract = contractOf({ minimumFrames: 2 })
    const writer = store(stateRoot())
    try { await writer.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal) }
    finally { await writer.close() }
    const evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    expect(evidence.groups[0]).toMatchObject({ verdict: 'undetermined' })
    expect(evidence.groups[0]!.reason).toMatch(/requires 2/)
  }, 90_000)

  it('fails a group whose frame was edited after capture', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store(stateRoot())
    try { await writer.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal) }
    finally { await writer.close() }
    const frame = writer.readManifest(root)[0]!.frames[0]!
    const file = framePath(root, frame.path)
    const bytes = readFileSync(file)
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff
    writeFileSync(file, bytes)
    const evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    expect(evidence.passed).toBe(false)
    expect(evidence.groups[0]!.verdict).toBe('failed')
  }, 90_000)

  it('expires passing evidence after the workspace changes and never shares it with another ticket or assignment', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store(stateRoot())
    try { await writer.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal) }
    finally { await writer.close() }
    const evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
        expect(evidence.reasons).toEqual([])
    expect(evidence.passed).toBe(true)
    writeFileSync(path.join(root, 'source.ts'), 'export const value = 2\n')
    const stale = validateVisualEvidence(contract, root, evidence, 'ticket-1', 'assignment-1')
    expect(stale.valid).toBe(false)
    expect(stale.reasons).toContain('Visual evidence is stale: workspace changed after the capture')
    expect(validateVisualEvidence(contract, root, evidence, 'ticket-1', 'assignment-2').valid).toBe(false)
    expect(validateVisualEvidence(contract, root, evidence, 'ticket-2', 'assignment-1').valid).toBe(false)
  }, 90_000)

  it('keeps a check the inspector could not judge undetermined instead of passing it', async () => {
    const root = workspace()
    const contract = contractOf({ checks: ['nonblank', 'an unknown check'] })
    const writer = store(stateRoot())
    try { await writer.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal) }
    finally { await writer.close() }
    const evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    expect(evidence.groups[0]!.checks.find(check => check.check === 'an unknown check')).toMatchObject({ verdict: 'undetermined' })
    expect(evidence.passed).toBe(false)
  }, 90_000)

  it('refuses a workspace holding the tool state, and a contract whose inspector moved', async () => {
    const root = workspace()
    const contract = contractOf()
    const inside = new VisualEvidenceStore(new McpStdioCaptureSession({ command: process.execPath, args: [captureServer] }), { mcpDatabase: path.join(root, 'state.db') })
    try {
      // A tool whose own state sits in the worker directory would let worker files pose as tool state.
      await expect(inside.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal)).rejects.toThrow(/outside the ticket workspace/)
    } finally { await inside.close() }
    const moved = { ...contract, inspector: { executable: path.join(root, 'missing-python.exe'), args: [] } }
    const writer = store(stateRoot())
    try { await expect(writer.capture(binding(root, moved), 1, { at: 'now' }, new AbortController().signal)).rejects.toThrow(/digest|changed/) }
    finally { await writer.close() }
  }, 90_000)

  it('records every group, including failed ones, bound to its instruction and assignment', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store(stateRoot())
    try { await writer.capture(binding(root, contract, 'first'), 1, undefined, new AbortController().signal) }
    finally { await writer.close() }
    const manifest = writer.readManifest(root) as VisualManifestEntry[]
    expect(manifest[0]).toMatchObject({ ticketId: 'ticket-1', assignmentId: 'assignment-1', instruction: 'inventory-open', status: 'failed', sequence: 1, frames: [] })
    expect(manifest[0]!.groupDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(existsSync(path.join(root, VISUAL_EVIDENCE_DIR, '.owned'))).toBe(true)
  }, 90_000)

  it('switches between real transports through the host adapter and refuses a missing one', async () => {
    const root = workspace()
    const state = stateRoot()
    const contract = contractOf()
    let settings: VisualCaptureSettings = { transport: 'stdio', command: process.execPath, args: [captureServer] }
    const host = new HostVisualCapture({ settings: () => settings, statePath: () => state })
    expect(await host.capture(binding(root, contract), 1, { at: 'now' }, new AbortController().signal)).toMatchObject({ status: 'captured' })
    const evidence = await host.assess(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    expect(host.current('ticket-1', 'assignment-1', root, contract, evidence)).toBe(true)
    settings = { transport: 'none' }
    await expect(host.capture(binding(root, contractOf(), 'g2'), 1, { at: 'now' }, new AbortController().signal)).rejects.toThrow(/no trusted capture transport/)
  }, 90_000)
})
