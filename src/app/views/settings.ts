/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import { policyVersion } from '../../policy.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { Machine } from '../../deployment.ts'
import type { Settings as SettingsValue } from '../../policy.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  const policy = sources.kind(id)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/** True when a saved workspace override is not the one the running plugin mounted, i.e. a restart is still due. */
function mountedDiffers(settings: SettingsValue, machine: Machine): boolean {
  const saved = settings.workspace
  return (saved.stateDir !== '' && saved.stateDir !== machine.stateDir)
    || (saved.workspaceMode !== null && saved.workspaceMode !== (machine.workspaceMode ?? 'isolated'))
    || (saved.sourceRoot !== '' && saved.sourceRoot !== (machine.sourceRoot ?? ''))
    || (saved.executionMode !== null && saved.executionMode !== (machine.executionMode ?? 'github'))
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 * `machine` is the workspace the running plugin actually mounted: it differs from the saved `workspace` block while
 * a save waits for its restart, so the panel shows both instead of letting one masquerade as the other.
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string, machine?: Machine) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor' | 'workspace', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor), workspace: block('workspace', settings.workspace) },
    // The mounted workspace is what new tickets use right now; `pending` marks a saved choice that needs a restart.
    workspace: {
      mounted: { executionMode: machine?.executionMode ?? 'github', stateDir: machine?.stateDir ?? stateDir,
        workspaceMode: machine?.workspaceMode ?? 'isolated', sourceRoot: machine?.sourceRoot ?? '' },
      ...machine && mountedDiffers(settings, machine) ? { pending: true } : {},
    },
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.id] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
