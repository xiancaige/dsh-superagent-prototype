/**
 * Phase 2 E: the TP environment's configuration entry point.
 *
 * The environment used to be configurable only through the host's process environment, which nothing
 * set, so `/environment` reported `held:false` and every acquire answered `noEnvironment`. The rollout
 * file now carries an `environment` section that setup-superagent.mjs turns into the profile patch.
 * These tests pin the two properties that matter: absent or disabled keeps the deployment exactly as
 * before (nothing pretends to be enabled), and a section that is present but wrong fails loudly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config, machineOf } from '../src/deployment.ts'

/**
 * setup-superagent.mjs is a plain `node` script outside this tsconfig project, so it has no type
 * declarations of its own. Its generated output is what these tests check, so the surface is narrowed here.
 */
interface RolloutEnvironment { recoveryEnabled?: unknown; projectFile?: string; editorExe?: string; mcpPort?: unknown
  captureTool?: string; captureToolset?: string; [key: string]: unknown }
interface RolloutConfig { enabled: boolean; graphEnabled: boolean; mode: string; stateDir: string; workDir: string; environment?: RolloutEnvironment }
interface SetupScript {
  renderEnvironment(environment: RolloutEnvironment | undefined, root?: string): Record<string, unknown> | undefined
  renderBlock(root: string, config: RolloutConfig): string
}
const script = await import('../../setup-superagent.mjs' as string) as SetupScript
const { renderBlock, renderEnvironment } = script

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tp-environment-config-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A real .uproject and a real UnrealEditor.exe beside it, so the path checks pass for the right reason. */
function files() {
  const project = join(dir, 'TP.uproject')
  const engine = join(dir, 'Engine', 'Binaries', 'Win64')
  mkdirSync(engine, { recursive: true })
  writeFileSync(project, '{}')
  writeFileSync(join(engine, 'UnrealEditor.exe'), '')
  return { projectFile: project, editorExe: join(engine, 'UnrealEditor.exe') }
}

const enabled = (): RolloutEnvironment => ({ recoveryEnabled: true, ...files(), mcpPort: 55255, captureTool: 'CaptureWidgetBlueprintScreenshot', captureToolset: 'TPEditor.TPEditorToolset' })
const rollout = (environment?: RolloutEnvironment): RolloutConfig => ({ enabled: true, graphEnabled: false, mode: 'local',
  stateDir: '.dsh/home/state/superagent', workDir: '.dsh/home/work/superagent', ...environment === undefined ? {} : { environment } })

describe('rollout environment section', () => {
  it('is absent, and therefore inert, when the rollout has no environment section', () => {
    expect(renderEnvironment(undefined)).toBeUndefined()
    expect(renderBlock(dir, rollout(undefined))).not.toMatch(/environment:/)
  })
  it('keeps the shipped disabled section inert rather than pretending to be enabled', () => {
    // The repository's own section, as it ships: disabled with empty paths is valid and enables nothing.
    const shipped = { recoveryEnabled: false, projectFile: '', editorExe: '', mcpPort: 55255, captureTool: 'CaptureWidgetBlueprintScreenshot', captureToolset: 'TPEditor.TPEditorToolset' }
    expect(renderEnvironment(shipped)).toBeUndefined()
    expect(renderBlock(dir, rollout(shipped))).not.toMatch(/environment:/)
  })
  it('renders an enabled section as the plugin config, with absolute paths', () => {
    const environment = renderEnvironment(enabled())
    expect(environment).toMatchObject({ recoveryEnabled: true, mcpPort: 55255, captureTool: 'CaptureWidgetBlueprintScreenshot' })
    const block = renderBlock(dir, rollout(enabled()))
    expect(block).toMatch(/ {4}environment:\n {6}recoveryEnabled: true\n {6}projectFile: /)
    expect(block).toMatch(/mcpPort: 55255/)
    // The generated block must be a real YAML document the profile can load, not merely a plausible string.
    const parsed = parseYaml(block) as { id?: string; config?: { environment?: Record<string, unknown> } }[]
    expect(Array.isArray(parsed), String(parsed)).toBe(true)
    const entry = parsed.find(item => item?.id === 'dsh-superagent')
    expect(entry?.config?.environment).toMatchObject({ recoveryEnabled: true, mcpPort: 55255,
      projectFile: join(dir, 'TP.uproject').replaceAll('\\', '/'), captureTool: 'CaptureWidgetBlueprintScreenshot' })
  })
  it('resolves repository-relative paths against the explicit root and writes only absolute machine paths', () => {
    const { projectFile, editorExe } = files()
    const relative = { ...enabled(), projectFile: 'TP.uproject', editorExe: 'Engine/Binaries/Win64/UnrealEditor.exe' }
    expect(() => renderEnvironment(relative)).toThrow(/must be an absolute path/)
    expect(renderEnvironment(relative, dir)).toMatchObject({ projectFile: projectFile.replaceAll('\\', '/'), editorExe: editorExe.replaceAll('\\', '/') })
    const parsed = parseYaml(renderBlock(dir, rollout(relative))) as { id?: string; config?: { environment?: Record<string, unknown> } }[]
    expect(parsed.find(item => item?.id === 'dsh-superagent')?.config?.environment?.projectFile).toBe(projectFile.replaceAll('\\', '/'))
  })
  it('does not accept a relative path outside the root that points to a missing file', () => {
    expect(() => renderEnvironment({ ...enabled(), editorExe: '../missing/UnrealEditor.exe' }, dir)).toThrow(/does not exist/)
  })
  it.each([
    ['a directory that does not exist', () => ({ projectFile: join(dir, 'nope', 'TP.uproject') }), /does not exist/],
    ['a relative project that does not exist under the root', () => ({ projectFile: 'missing/TP.uproject' }), /must be an absolute path|does not exist/],
    ['a missing project', () => ({ projectFile: '' }), /projectFile is required/],
    ['a non-.uproject file', () => ({ projectFile: join(dir, 'TP.uproject.txt') }), /must be a \.uproject|does not exist/],
    ['an editor that is not UnrealEditor.exe', () => ({ editorExe: join(dir, 'TP.uproject') }), /must be UnrealEditor\.exe/],
    ['port 0', () => ({ mcpPort: 0 }), /mcpPort must be an integer 1-65535/],
    ['a port above 65535', () => ({ mcpPort: 70000 }), /mcpPort must be an integer 1-65535/],
    ['a port that is not a number', () => ({ mcpPort: 'abc' }), /mcpPort must be an integer 1-65535/],
    ['an unsupported key', () => ({ port: 55255 }), /unsupported keys: port/],
    ['a non-boolean recoveryEnabled', () => ({ recoveryEnabled: 'yes' }), /recoveryEnabled must be true or false/],
  ])('fails loudly, never silently disabled, for %s', (_label, change, message) => {
    // A wrong section must be an error: a deployment that quietly lost its environment looks exactly like
    // one that never had one, and an operator would never learn that a typo took the TP editor away.
    expect(() => renderEnvironment({ ...enabled(), ...change() })).toThrow(message)
    expect(() => renderBlock(dir, rollout({ ...enabled(), ...change() }))).toThrow(message)
  })
})

describe('plugin configuration', () => {
  /** The `environment` field of the plugin's own config schema, so these cases stay type-checked against it. */
  type PluginEnvironment = NonNullable<ReturnType<typeof Config>['environment']>
  const machine = (environment?: Omit<PluginEnvironment, 'projectFile' | 'editorExe'> & { projectFile?: string; editorExe?: string }) =>
    machineOf(Config({ stateDir: join(dir, 'state'), executionMode: 'local', ...environment === undefined ? {} : { environment } }))

  it('reads no environment at all when the profile omits the section', () => {
    // schemastery materialises the nested object; the contract is that it stays disabled.
    expect(machine(undefined).environment?.recoveryEnabled).toBe(false)
  })
  it('reads a disabled section as disabled, even with paths present', () => {
    expect(machine({ recoveryEnabled: false, ...files() }).environment?.recoveryEnabled).toBe(false)
  })
  it('carries an enabled section through to the runtime, paths and port intact', () => {
    const read = machine({ recoveryEnabled: true, ...files(), mcpPort: 55256 }).environment
    expect(read).toMatchObject({ recoveryEnabled: true, mcpPort: 55256 })
    expect(read?.projectFile).toBe(join(dir, 'TP.uproject'))
  })
  it('rejects an illegal port in the profile rather than loading it', () => {
    expect(() => Config({ stateDir: join(dir, 'state'), environment: { recoveryEnabled: true, mcpPort: 70000 } })).toThrow(/mcpPort|65535/)
  })
})

/** Load the generated block as the profile's real YAML loader would, so a malformed block fails here. */
function parseYaml(block: string): unknown[] {
  try { return parse(block) as unknown[] } catch (error) { throw new Error(`generated block is not valid YAML: ${String(error)}`) }
}
