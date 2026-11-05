/**
 * Phase B3 visual-evidence integrity: every capture writes a frame of its own, every report names the
 * frame digests, sizes, capture times and tool responses it was computed from, and the same frame can
 * never decide two groups differently. The transports, inspector and PNG frames are real; the negative
 * cases are built from what a worker or a faulty tool could really do (reusing a file, renaming it,
 * leaving an old frame at the next capture path), never from a mocked verdict.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VisualEvidenceStore, assessVisual, runInspector, validateVisualEvidence, type CaptureBinding, type SettledReport, type VisualManifestEntry } from '../src/visual-host.ts'
import { McpStdioCaptureSession } from '../src/app/visual-stdio.ts'
import { createVisualContract } from '../src/visual-contract.ts'
import { SCRATCH_DIRECTORY, VISUAL_EVIDENCE_DIR, conflictReasons, findFrameConflicts, frameDigest, framePath } from '../src/visual.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const captureServer = path.join(here, 'fixtures', 'capture-server.mjs')
const inspector = path.join(here, '..', 'scripts', 'visual_inspector.py')
const python = execFileSync('python', ['-I', '-c', 'import sys, PIL; print(sys.executable)'], { encoding: 'utf8', env: interpreterEnv() }).trim()

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace(): string {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-visual-b3-')))
  roots.push(root)
  writeFileSync(path.join(root, 'source.ts'), 'export const value = 1\n')
  return root
}
function stateRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-visual-b3-state-'))
  roots.push(root)
  return root
}
function interpreterEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_REQUIRE
  return env
}
function store(): VisualEvidenceStore {
  return new VisualEvidenceStore(new McpStdioCaptureSession({ command: process.execPath, args: [captureServer] }), { mcpDatabase: stateRoot() })
}
type Overrides = { scenario?: string; capture?: { server: string; tool: string; arguments: Record<string, unknown> }; checks?: string[]; minimumFrames?: number }
/** The inventory contract; `shop` names the second real capture target of its own. */
function contractOf(overrides: Overrides = {}) {
  return createVisualContract({
    scenario: 'inventory-open',
    capture: { server: 'tpmcp', tool: 'capture_screenshot', arguments: { path: '{{path}}', scenario: 'default', widget: 'WBP_Inventory' } },
    inspector: { executable: python, args: [inspector, '--', JSON.stringify(interpreterEnv())] },
    checks: ['nonblank', 'readable'],
    minimumFrames: 1,
    ...overrides,
  })
}
const manifestFile = (root: string) => path.join(root, VISUAL_EVIDENCE_DIR, 'manifest.json')
function manifest(root: string): VisualManifestEntry[] { return JSON.parse(readFileSync(manifestFile(root), 'utf8')) as VisualManifestEntry[] }
function rewriteManifest(root: string, entries: VisualManifestEntry[]): void { writeFileSync(manifestFile(root), `${JSON.stringify(entries, null, 2)}\n`) }
/** A report becomes the ledger exactly as the Engine records it: the frame digests it judged. */
function settledFrom(evidence: Awaited<ReturnType<typeof assessVisual>>): SettledReport[] {
  return evidence.groups.filter(group => group.checks.length).map(group => ({ group: group.group, checks: group.checks, frames: group.frames }))
}

describe('phase B3 every capture is one unique, recorded frame', () => {
  it('writes a fresh frame per capture and records its digest, size, time and the tool response', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store()
    try {
      const binding: CaptureBinding = { ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract, group: 'g1' }
      expect(await writer.capture(binding, 1, { at: 'prepared' }, new AbortController().signal)).toMatchObject({ status: 'captured', frames: 1 })
      const entry = manifest(root)[0]!
      expect(entry.frames).toHaveLength(1)
      const frame = entry.frames[0]!
      const file = framePath(root, frame.path)
      // The report names the frame file it was computed from, and that file really holds those bytes.
      expect(frame.path).toBe('g1/inventory-open-01.png')
      expect(frame.sha256).toBe(frameDigest(readFileSync(file)))
      expect(frame.bytes).toBe(readFileSync(file).length)
      expect([frame.width, frame.height]).toEqual([320, 180])
      expect(Number.isNaN(Date.parse(frame.capturedAt))).toBe(false)
      expect(frame.captureDigest).toMatch(/^[0-9a-f]{64}$/)
      // What the trusted tool really answered: the call it got, its text, and the response digests.
      expect(frame.response!.arguments.path).toBe(file)
      expect(frame.response!.text).toContain('WBP_Inventory 320x180')
      expect(frame.response!.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', bytes: frame.bytes })
      expect(frame.response!.responseDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(frame.response!.rawDigest).toMatch(/^[0-9a-f]{64}$/)

      // A second capture of the same instruction writes a second frame of its own, never the first one.
      // This double renders one fixed image, so its bytes are identical: the ledger must say so.
      expect(await writer.capture({ ...binding, group: 'g2' }, 1, { at: 'prepared' }, new AbortController().signal)).toMatchObject({ status: 'captured' })
      const later = manifest(root)[1]!.frames[0]!
      expect(later.path).toBe('g2/inventory-open-01.png')
      expect(later.sha256).toBe(frameDigest(readFileSync(framePath(root, later.path))))
      expect(later.captureDigest).not.toBe(frame.captureDigest)
      expect(later.sha256).toBe(frame.sha256)
    } finally { await writer.close() }
  }, 90_000)

  it('never reads a file already at the frame path as the frame of the next capture', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store()
    try {
      await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract, group: 'g1' }, 1, { at: 'now' }, new AbortController().signal)
      const first = manifest(root)[0]!.frames[0]!
      // What a worker can really do: leave the first capture's frame at the next capture's path.
      mkdirSync(path.join(root, VISUAL_EVIDENCE_DIR, 'g2'), { recursive: true })
      copyFileSync(framePath(root, first.path), framePath(root, 'g2/inventory-open-01.png'))
      expect(await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract, group: 'g2' }, 1, { at: 'now' }, new AbortController().signal))
        .toMatchObject({ status: 'captured' })
      const second = manifest(root)[1]!.frames[0]!
      // The planted file was set aside: the capture's frame is the one the tool just wrote.
      expect(second.path).toBe('g2/inventory-open-01.png')
      expect(second.sha256).toBe(frameDigest(readFileSync(framePath(root, second.path))))
      // A planted symlink is removed the same way, never read through.
      mkdirSync(path.join(root, VISUAL_EVIDENCE_DIR, 'g3'), { recursive: true })
      symlinkSync(framePath(root, first.path), framePath(root, 'g3/inventory-open-01.png'))
      expect(await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract, group: 'g3' }, 1, { at: 'now' }, new AbortController().signal))
        .toMatchObject({ status: 'captured' })
      const third = manifest(root)[2]!.frames[0]!
      expect(third.sha256).toBe(frameDigest(readFileSync(framePath(root, third.path))))
      expect(readdirSync(path.join(root, VISUAL_EVIDENCE_DIR, SCRATCH_DIRECTORY)).length).toBeGreaterThanOrEqual(2)
    } finally { await writer.close() }
  }, 90_000)
})

describe('phase B3 two real captures reproduce their own transitions', () => {
  it('recomputes each report from its own frame, and a different widget really gives a different frame', async () => {
    const root = workspace()
    const inventory = contractOf()
    const shop = contractOf({ capture: { server: 'tpmcp', tool: 'capture_screenshot', arguments: { path: '{{path}}', scenario: 'default', widget: 'WBP_Shop', size: 640 } } })
    const writer = store()
    try {
      expect(await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract: inventory, group: 'inventory' }, 1, { at: 'now' }, new AbortController().signal))
        .toMatchObject({ status: 'captured' })
      expect(await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract: shop, group: 'shop' }, 1, { at: 'now' }, new AbortController().signal))
        .toMatchObject({ status: 'captured' })
      const frames = manifest(root).flatMap(entry => entry.frames)
      expect(frames).toHaveLength(2)
      // Two real captures are two frames: different bytes and different sizes.
      expect(frames[0]!.sha256).not.toBe(frames[1]!.sha256)
      expect([frames[0]!.width, frames[0]!.height, frames[1]!.width, frames[1]!.height]).toEqual([320, 180, 640, 360])

      // A read judges every frame this ticket and assignment captured, so the read taken before the
      // second capture already judges the inventory group; each one is then re-read against the ledger.
      const first = await assessVisual(inventory, 'ticket-1', 'assignment-1', root, new AbortController().signal)
      expect(first).toMatchObject({ passed: true, reasons: [] })
      const second = await assessVisual(shop, 'ticket-1', 'assignment-1', root, new AbortController().signal, settledFrom(first))
      expect(second).toMatchObject({ passed: true, reasons: [] })
      // Each group's verdict names its own frame only, in both reads.
      for (const evidence of [first, second]) {
        expect(evidence.groups.find(group => group.group === 'inventory')!.frames.map(frame => frame.sha256)).toEqual([frames[0]!.sha256])
        expect(evidence.groups.find(group => group.group === 'shop')!.frames.map(frame => frame.sha256)).toEqual([frames[1]!.sha256])
      }

      // Each published transitions figure is recomputed from the frame file alone.
      const recorded = new Map(frames.map(frame => [framePath(root, frame.path), frame.sha256]))
      const published: { frame: string; transitions: number }[] = []
      for (const evidence of [first, second]) {
        for (const group of evidence.groups) {
          for (const check of group.checks) {
            // The nonblank judgement is checked by name; readable only says the frame is big enough.
            if (check.check !== 'nonblank') continue
            const match = /maximum pixel transitions (\d+)/.exec(check.reason)
            expect(match, check.reason).not.toBeNull()
            expect(check.frames.length, check.reason).toBeGreaterThan(0)
            published.push({ frame: check.frames[0]!, transitions: Number(match![1]) })
          }
        }
      }
      // One transitions figure per capture group per read, each citing the frame of that very group.
      const relative = (file: string) => path.relative(path.join(root, VISUAL_EVIDENCE_DIR), file).split(path.sep).join('/')
      expect(published.map(item => relative(item.frame))).toEqual(['inventory/inventory-open-01.png', 'shop/inventory-open-01.png',
        'inventory/inventory-open-01.png', 'shop/inventory-open-01.png'])
      // The second read re-derives the very same figures from the very same frames.
      expect(published.map(item => item.transitions)).toEqual([3600, 14400, 3600, 14400])
      for (const item of published) {
        const file = framePath(root, item.frame)
        expect(frameDigest(readFileSync(file))).toBe(recorded.get(file))
        const report = await runInspector(contractOf(), [{ group: 'again', frames: [file] }], new AbortController().signal)
        const check = (report.groups[0]!.checks as { check: string; reason: string }[]).find(item => item.check === 'nonblank')!
        // The inspector's own recount on the same file is exactly the published figure.
        expect(check.reason).toBe(`maximum pixel transitions ${item.transitions}`)
      }
    } finally { await writer.close() }
  }, 120_000)
})

describe('phase B3 the same frame can never obtain two verdicts', () => {
  it('refuses a renamed reuse of a judged frame, and never accepts its pass', async () => {
    const root = workspace()
    const blankContract = contractOf({ capture: { server: 'tpmcp', tool: 'capture_screenshot', arguments: { path: '{{path}}', blank: true } } })
    const writer = store()
    let first: Awaited<ReturnType<typeof assessVisual>>
    try {
      // A real capture the checks fail; it is the ticket's settled evidence.
      await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract: blankContract, group: 'failed' }, 1, { at: 'now' }, new AbortController().signal)
      first = await assessVisual(blankContract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
      expect(first.groups[0]!.verdict).toBe('failed')
      // What a worker can really do: copy the failed frame to another group's name and register it there.
      const original = first.groups[0]!.frames[0]!
      const entries = manifest(root)
      const reused = { ...original, path: 'passed/inventory-open-01.png' }
      mkdirSync(path.dirname(framePath(root, reused.path)), { recursive: true })
      copyFileSync(framePath(root, original.path), framePath(root, reused.path))
      rewriteManifest(root, [...entries, { ...entries[0]!, group: 'passed', sequence: 2, frames: [reused], capturedAt: new Date().toISOString() }])
    } finally { await writer.close() }
    // The pass contract would normally accept this frame (readable passes); it must still be refused.
    const evidence = await assessVisual(contractOf(), 'ticket-1', 'assignment-1', root, new AbortController().signal, settledFrom(first))
    const sha = first.groups[0]!.frames[0]!.sha256
    expect(evidence.passed).toBe(false)
    expect(evidence.groups.find(group => group.group === 'passed')!.verdict).toBe('failed')
    expect(evidence.contradictions!.map(item => item.sha256)).toContain(sha)
    expect(evidence.reasons.join(' ')).toMatch(/already wrote/)
    // The same frame judged by a second capture the inspector really read as a pass is a contradiction.
    const planted = { ...first.groups[0]!.frames[0]!, sha256: 'c'.repeat(64) }
    const settled: SettledReport[] = [{ group: 'failed', frames: [planted],
      checks: [{ check: 'nonblank', verdict: 'failed', reason: 'blank', frames: [planted.path] }] }]
    const same = await assessVisual(contractOf(), 'ticket-1', 'assignment-1', root, new AbortController().signal, settled)
    expect(same.passed).toBe(false)
    expect(same.reasons.join(' ')).toMatch(/Frame integrity refusal/)
    expect(same.contradictions).toHaveLength(1)
    // A ledger naming frames this ticket never captured proves nothing: the read stays empty.
    const absent = await assessVisual(contractOf(), 'ticket-2', 'assignment-2', root, new AbortController().signal, settled)
    expect(absent.passed).toBe(false)
    expect(absent.reasons).toEqual(['No screenshot was captured for this ticket and assignment'])
  }, 120_000)

  it('refuses a capture whose tool wrote the same bytes as an earlier capture', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store()
    try {
      await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract, group: 'first' }, 1, { at: 'now' }, new AbortController().signal)
      const original = manifest(root)[0]!.frames[0]!
      // A tool that "captures" by copying the frame it wrote before, under a new path.
      const entries = manifest(root)
      const copied = { ...original, path: 'second/inventory-open-01.png' }
      mkdirSync(path.dirname(framePath(root, copied.path)), { recursive: true })
      copyFileSync(framePath(root, original.path), framePath(root, copied.path))
      rewriteManifest(root, [...entries, { ...entries[0]!, group: 'second', sequence: 2, frames: [copied], capturedAt: new Date().toISOString() }])
    } finally { await writer.close() }
    const evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    expect(evidence.passed).toBe(false)
    expect(evidence.groups.find(group => group.group === 'second')!).toMatchObject({ verdict: 'failed' })
    expect(evidence.groups.find(group => group.group === 'second')!.reason).toMatch(/already existed/)
    expect(evidence.contradictions!.length).toBeGreaterThan(0)
  }, 90_000)

  it('names the conflict when one frame is judged two ways, in both directions', () => {
    const frame = { path: 'g/a.png', sha256: 'a'.repeat(64), bytes: 1, width: 64, height: 64, capturedAt: 'now' }
    const judged = (group: string, verdict: 'passed' | 'failed') => ({ group, frames: [frame], checks: [{ check: 'nonblank', verdict, reason: verdict, frames: [frame.path] }] })
    const forward = findFrameConflicts([judged('g1', 'passed')], [judged('g2', 'failed')])
    // A rename is reported twice: the frame was written again, and its verdict now disagrees.
    expect(conflictReasons(forward)).toHaveLength(2)
    expect(conflictReasons(forward).join('\n')).toMatch(/Contradictory verdict for one frame: frame a{64} was decided passed in g1 and failed in g2 for check nonblank/)
    expect(conflictReasons(forward).join('\n')).toMatch(/Capture reused a frame that already existed: capture g2 wrote frame a{64} that capture g1 already wrote/)
    const backward = findFrameConflicts([judged('g1', 'failed')], [judged('g2', 'passed')])
    expect(conflictReasons(backward)[0]).toMatch(/decided failed in g1 and passed in g2/)
    // A second capture of the same bytes is reused even when the verdicts agree.
    const same = findFrameConflicts([judged('g1', 'passed')], [judged('g2', 'passed')])
    expect(same.reused).toEqual([frame.sha256])
    expect(conflictReasons(same)).toHaveLength(1)
    expect(conflictReasons(same)[0]).toMatch(/already existed/)
    // Different frames never conflict.
    expect(conflictReasons(findFrameConflicts([], [judged('g1', 'passed'), { ...judged('g1', 'failed'), frames: [{ ...frame, sha256: 'b'.repeat(64) }] }]))).toEqual([])
  })
})

describe('phase B3 a refused report never becomes a pass', () => {
  it('keeps a replaced frame and a contradictory report invalid on re-check', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store()
    let evidence: Awaited<ReturnType<typeof assessVisual>>
    try {
      await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract, group: 'g1' }, 1, { at: 'now' }, new AbortController().signal)
      evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
      expect(evidence.passed).toBe(true)
    } finally { await writer.close() }
    expect(validateVisualEvidence(contract, root, evidence, 'ticket-1', 'assignment-1').valid).toBe(true)
    // The frame the pass rested on was replaced after the read: the completion gate must refuse it.
    const frame = evidence.groups[0]!.frames[0]!
    const other = readFileSync(framePath(root, frame.path))
    other[other.length - 20] = other[other.length - 20]! ^ 0xff
    writeFileSync(framePath(root, frame.path), other)
    const stale = validateVisualEvidence(contract, root, evidence, 'ticket-1', 'assignment-1')
    expect(stale.valid).toBe(false)
    expect(stale.reasons.join(' ')).toMatch(/stale|changed/)
  }, 90_000)

  it('never states a pass for a report that carries a contradictory frame verdict', async () => {
    const root = workspace()
    const contract = contractOf()
    const writer = store()
    let evidence: Awaited<ReturnType<typeof assessVisual>>
    try {
      await writer.capture({ ticketId: 'ticket-1', assignmentId: 'assignment-1', workspace: root, contract, group: 'g1' }, 1, { at: 'now' }, new AbortController().signal)
      evidence = await assessVisual(contract, 'ticket-1', 'assignment-1', root, new AbortController().signal)
    } finally { await writer.close() }
    expect(evidence.passed).toBe(true)
    // The same frames and workspace, with one frame decided two ways: the evidence is no longer valid,
    // and the recorded contradiction alone must be enough to refuse it.
    const frame = evidence.groups[0]!.frames[0]!
    const contradicted = { ...evidence, contradictions: [{ sha256: frame.sha256, group: 'g1', earlier: 'passed in g1', later: 'failed in g2', reason: 'x' }] }
    const checked = validateVisualEvidence(contract, root, contradicted, 'ticket-1', 'assignment-1')
    expect(checked.valid).toBe(false)
    expect(checked.reasons).toEqual(['Visual evidence carries a contradictory frame verdict'])
    // Evidence the core holds therefore never proves readiness, even with every group passing.
    expect(contradicted.groups.every(group => group.verdict === 'passed')).toBe(true)
  }, 90_000)
})
