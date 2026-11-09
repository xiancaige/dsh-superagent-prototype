/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Runtime } from './app/runtime.ts'
import { Store } from './app/store.ts'
import type { Settings } from './policy.ts'

/**
 * Constructs the Runtime once. A fresh heartbeat lock left by a hard host restart is waited for inside the
 * constructor, never stolen, so this helper does not retry: cordis keeps a service registered by a constructor
 * that then threw, and a second `new Runtime` would fail with "service orchestrator has been registered",
 * leaving the plugin inactive. A failed construction is reported (`apply` writes the activation error) and the
 * host unloads this fiber, which is what frees the registration for the next start.
 */
export async function startRuntime(create: () => Runtime): Promise<Runtime> {
  return create()
}
import { Config, machineOf, resolveWorkspace, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  // `machineOf` validates the configuration and materialises its defaults. The panel may override the three
  // workspace fields, but that saved choice lives in the state database, which cannot be opened until a state
  // directory is known — so the configuration's own directory is used to read it, and the workspace is resolved
  // once more with the stored override before the Runtime mounts. Saving a workspace change restarts the plugin,
  // so the next `apply` reads the new value here.
  const configured = machineOf(config)
  let machine = configured
  try {
    const override = readWorkspaceOverride(configured.stateDir)
    if (override) {
      // An empty string or null in the saved block means "inherit", which `resolveWorkspace` already handles.
      const workspace = resolveWorkspace(config, { stateDir: override.stateDir, sourceRoot: override.sourceRoot,
        workspaceMode: override.workspaceMode ?? undefined, executionMode: override.executionMode ?? undefined })
      machine = { ...configured, ...workspace, ...workspace.sourceRoot ? {} : { sourceRoot: undefined } } as ReturnType<typeof machineOf>
    }
    await mount(ctx, config, machine)
  } catch (error) {
    // The host's own banner does not always reach a log file; a file beside the state makes a failed
    // activation diagnosable after the fact (see docs/007-architecture.md).
    try {
      mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
      const stack = error instanceof Error ? `${error.stack ?? error.message}` : String(error)
      appendFileSync(join(machine.stateDir, 'activation-error.log'), `${new Date().toISOString()} ${stack}\n\n`)
    } catch { /* the failure below is what matters; never mask it with a logging error. */ }
    throw error
  }
}
/**
 * Read the workspace a previous mount saved from the panel, without taking the state lock the Runtime owns.
 * The database may not exist yet on a first start, and a read failure must not stop activation, so any error
 * simply means "no override" and the configuration applies unchanged.
 */
function readWorkspaceOverride(stateDir: string): Settings['workspace'] | undefined {
  const path = join(stateDir, 'orchestrator.sqlite')
  if (!existsSync(path)) return undefined
  let store: Store | undefined
  try {
    store = new Store(path, () => {})
    const saved = store.settings().workspace
    return saved.stateDir || saved.workspaceMode || saved.sourceRoot || saved.executionMode ? saved : undefined
  } catch {
    return undefined
  } finally {
    store?.close()
  }
}
async function mount(ctx: Context, config: DeploymentConfig, machine: ReturnType<typeof machineOf>): Promise<void> {
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = await startRuntime(() => new Runtime(ctx, machine, restart))
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
