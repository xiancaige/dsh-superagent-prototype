/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, liveTicket, reasonText, assertTicketValidated, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { installTicketAnalysis } from './ticket-analysis.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Mirror } from './mirror.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { FeishuCommands } from './feishu-commands.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { TpEditorRecovery, type RecoverySettings, type TpEditorEnvironment } from './editor-recovery.ts'
import { EnvironmentExclusivity, type EnvironmentExclusivityView } from './environment-exclusive.ts'
import { TicketedEnvironment, environmentPort } from './ticketed-environment.ts'
import { SimulatedDelivery } from './simulated-delivery.ts'
import { exclusivityPort, RECOVERY_HOLDER_PREFIX } from './editor-recovery-lease.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
/** How long a hard-restart's own fresh heartbeat lock is waited for before giving up. */
const LOCK_WAIT_MS = 40_000
/**
 * Takes the state directory lock, waiting out a fresh one a hard host restart left behind (it expires on its
 * own; it is never stolen). Waiting belongs here rather than in a retry of the whole constructor: `super()`
 * has already registered the `orchestrator` service, and cordis refuses a second registration.
 */
function acquireStateLock(stateDir: string, onCompromised: (error: Error) => void): () => void {
  // `lockSync` refuses `retries` ("Cannot use retries with the sync api"), so a short synchronous sleep between
  // attempts is the only waiting this synchronous constructor can do. It is bounded and never steals the lock.
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { return lockSync(stateDir, { stale: 30_000, onCompromised }) }
    catch (error) {
      if ((error as { code?: string })?.code !== 'ELOCKED' || Date.now() >= deadline) throw error
      sleepSync(1_000)
    }
  }
}
/** Sleeps without yielding, for a synchronous startup path that must wait for a lock it may not steal. */
function sleepSync(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) { /* bounded busy wait; startup only, at most LOCK_WAIT_MS in total. */ }
}

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Phase 2 C: the TP environment broker and its ticket side; undefined without a configured TP environment. */
  private readonly environmentHosted?: { broker: EnvironmentExclusivity; tickets: TicketedEnvironment }
  /** The B2 recovery adapter, shared so the host can stop exactly the editor a recovery started. */
  private editorRecovery?: TpEditorRecovery
  /** Phase 2 C: the lease heartbeat of the tickets that hold the environment. */
  private environmentTimer?: ReturnType<typeof setInterval>
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  /**
   * Phase B2 editor recovery. Off unless the rollout configures it (`environment.recoveryEnabled` in
   * the profile patch, or `DSH_SUPERAGENT_EDITOR_RECOVERY=1` on a deployment configured by hand), and
   * then it acts only on the absolute TP project and editor it names, never on another UE project. The
   * capture tool is the one the deployment already expects, so readiness without it is an environment
   * block. The rollout's values win over the process environment, so the repository is the desired state.
   */
  private recoverySettings(): RecoverySettings {
    const configured = this.machine.environment
    if (configured?.recoveryEnabled === true) {
      // setup-superagent.mjs already refused a section whose paths are missing or relative; a hand-edited
      // patch that enables the environment without them is a startup error, never a silent disable.
      const missing = (['projectFile', 'editorExe'] as const).filter(key => !configured[key]?.trim())
      if (missing.length) throw new Error(`dsh-superagent environment.recoveryEnabled is true but ${missing.join(' and ')} is not set; the rollout block must name the absolute TP project and editor`)
      const environment: TpEditorEnvironment = {
        projectFile: configured.projectFile!, editorExe: configured.editorExe!, port: configured.mcpPort,
        captureTool: configured.captureTool, captureToolset: configured.captureToolset,
        ...configured.waitSeconds !== undefined ? { waitSeconds: configured.waitSeconds } : {},
      }
      return { enabled: true, environment }
    }
    // A rollout section that exists but disables recovery means no environment at all: the process
    // environment is not allowed to re-enable what the repository switched off.
    if (configured) return { enabled: false }
    if (process.env.DSH_SUPERAGENT_EDITOR_RECOVERY !== '1') return { enabled: false }
    const projectFile = process.env.DSH_SUPERAGENT_TP_PROJECT
    const editorExe = process.env.DSH_SUPERAGENT_TP_EDITOR_EXE
    if (!projectFile || !editorExe) return { enabled: false }
    const environment: TpEditorEnvironment = {
      projectFile, editorExe,
      port: Number(process.env.DSH_SUPERAGENT_TP_MCP_PORT ?? 55255),
      captureTool: process.env.DSH_SUPERAGENT_TP_CAPTURE_TOOL ?? 'CaptureWidgetBlueprintScreenshot',
      // TPMcp's tools/list shows only its dispatcher; the capture tool lives in this toolset.
      captureToolset: process.env.DSH_SUPERAGENT_TP_CAPTURE_TOOLSET ?? 'TPEditor.TPEditorToolset',
      ...(process.env.DSH_SUPERAGENT_TP_WAIT_SECONDS ? { waitSeconds: Number(process.env.DSH_SUPERAGENT_TP_WAIT_SECONDS) } : {}),
    }
    return { enabled: true, environment }
  }
  /**
   * Phase 2 C: the one TP environment broker, that is: the same `tp-environment.lock` B2 wrote, now a persisted
   * lease for the whole span a ticket changes the TP environment; plus the ticket side that takes it at
   * acceptance, beats it, hands it over and releases it. Absent without a configured TP environment.
   */
  private environmentHost(): { broker: EnvironmentExclusivity; tickets: TicketedEnvironment } | undefined {
    const environment = this.recoverySettings().environment
    if (!environment) return undefined
    const broker = new EnvironmentExclusivity(this.machine.stateDir)
    const tickets = new TicketedEnvironment(broker, { projectFile: environment.projectFile, port: environment.port }, {
      stopEditor: ticketId => this.stopTicketEditor(ticketId, environment),
      ownsEditor: ticketId => !!this.editorRecovery?.owns(ticketId),
      directory: ticketId => this.store.tickets.get(ticketId)?.execution?.directory,
    })
    return { broker, tickets }
  }
  /** The recovery adapter for one ticket, when the operator enabled it; undefined keeps an unreachable editor `unavailable`. */
  private recovery(store: Store): { adapter: TpEditorRecovery; record(ticketId: string): { prior: unknown; save(prior: unknown, outcome: unknown): void } } | undefined {
    if (!this.recoverySettings().enabled) return undefined
    const environment = this.environmentHosted
    const adapter = new TpEditorRecovery(() => this.recoverySettings(), {
      // The recovery borrows the one environment lock; it never writes a second and never takes a held one.
      ...environment ? {
        port: exclusivityPort(environment.broker),
        recordStarted: (ticketId: string, pid: number, startedAt?: string) => environment.tickets.recordStarted(ticketId, pid, startedAt),
        recordedPid: (ticketId: string) => environment.tickets.recordedPid(ticketId),
        recordedStart: (ticketId: string) => environment.tickets.recordedStart(ticketId),
      } : {},
    }, this.machine.stateDir)
    this.editorRecovery = adapter
    return {
      adapter,
      // The ticket's one recovery chance is persisted with the ticket: a restart cannot grant a second.
      record: (ticketId: string) => ({
        prior: store.tickets.get(ticketId)?.editorRecovery,
        save: (_prior: unknown, outcome: unknown) => {
          store.atomic(() => {
            const ticket = store.tickets.get(ticketId)
            if (!ticket) return
            const result = outcome as { kind: string; reason: string; pid?: number; startedPid?: number; sessionId?: string; tools?: readonly string[]; portListened?: boolean; at: string }
            const attempts = (store.tickets.get(ticketId)?.editorRecovery?.attempts ?? 0) + 1
            ticket.editorRecovery = { attempts, outcome: result, ...(result.startedPid ? { startedPid: result.startedPid } : {}) }
            store.tickets.save(ticket)
          })
        },
      }),
    }
  }
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    // A hard host restart can leave a fresh heartbeat lock that expires on its own: wait for it here rather than
    // steal it. Retrying the whole constructor is not an option, because `super()` already registered the
    // `orchestrator` service and cordis would refuse the second registration.
    const release = acquireStateLock(machine.stateDir, compromised)
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      installTicketAnalysis(ctx, store, effects)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      // Tickets that started on the local panel are mirrored into the operator's Feishu direct chat (see `Mirror`).
      const mirror = new Mirror({ store, sources, commands, ready: () => setup.configured() && !!setup.deployment.feishu })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, mirror, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      // Phase 2 C: the environment is composed before any editor recovery, which borrows its one lock.
      this.environmentHosted = this.environmentHost()
      const recovery = this.recovery(store)
      const environments = environmentPort(this.environmentHosted?.tickets)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
        // No real channel is configured implicitly. This explicit host opt-in only writes simulation receipts.
        ...process.env.DSH_SUPERAGENT_DELIVERY_SIMULATION === '1'
          ? { deliveryTarget: new SimulatedDelivery(join(machine.stateDir, 'delivery-simulation')) } : {},
        ...environments ? { environments, acceptance: ticket => this.acceptancePassed(ticket) } : {}, emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          // Phase B2: a TP editor this ticket's recovery started is stopped with the ticket, so no
          // unattended editor is left behind. Only a PID this host started is ever stopped.
          // With an environment, the ticket's own release stops the editor first and keeps the lock on a failure.
          if (event.type === 'ticket.ended' && recovery && !this.environmentHosted) {
            const environment = this.recoverySettings().environment
            if (environment) void recovery.adapter.cleanup(event.data.ticketId, environment)
              .catch(error => ctx.logger.warn('dsh-superagent: TP editor cleanup failed: %s', String(error)))
          }
          // Phase 2 C: a ticket that took the environment notes it, so an operator sees who holds it.
          if (event.type === 'ticket.exclusive' && event.data.action === 'refused') {
            ctx.logger.warn('dsh-superagent: ticket %s did not get the TP environment: %s', event.data.ticketId, String(event.data.reason))
          }
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
          // Persist the direct call in the same transaction as the end. Effects dispatch after commit,
          // survive restart, and never ask a broadcast listener or an LLM to notice the end.
          if (event.type === 'ticket.ended') {
            const { ticketId, by, outcome, reason } = event.data
            effects.enqueue('ticketAnalysis', ticketId, { ticketId, sessionId: workerSessionId(ticketId), by, outcome,
              ...reason ? { reason } : {}, at: event.at })
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      const feishuCommands = new FeishuCommands({ context: ctx, store, settings: this.settings, sessions, outbox, sources,
        masterId, ...(machine.sourceRoot ? { root: machine.sourceRoot } : {}) })
      this.sourceDeps = { store, engine, outbox, commands, sources, command: trigger => feishuCommands.receive(trigger), get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources, lifetime: this.lifetime,
        deliveryEnabled: process.env.DSH_SUPERAGENT_DELIVERY_SIMULATION === '1',
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return (channel, thread) => this.sources.link(channel, links, thread)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    // Phase 2 C: a restarted host keeps the ticket that holds the environment: its persisted lease is
    // re-taken by this process and beaten, so waiting, idling and restarting never free it.
    this.environmentHosted?.broker.wake()
    this.resumeEnvironment()
    // A delivery attempt left running by the stopped host is unknown, not safe to resend.
    this.engine.recoverDeliveries()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /** Re-take the leases the host's tickets already hold (see `TicketedEnvironment.acquire`) and beat them. */
  private resumeEnvironment(): void {
    const environment = this.environmentHosted
    if (!environment) return
    const { broker, tickets } = environment
    // A record whose Session process is gone (a crashed host) no longer holds anything; a live one does.
    const record = broker.held()
    if (record) {
      const ticket = this.store.tickets.get(record.holder.id)
      if (record.holder.kind === 'ticket' && ticket && liveTicket(ticket)) {
        try { tickets.acquire(ticket.id, ticket.title) } catch (error) {
          this.ctx.logger.warn('dsh-superagent: ticket %s could not resume its TP environment lease: %s', ticket.id, String(error))
        }
      } else if (record.holder.kind === 'ticket' && ticket?.ended && record.facts?.purpose === 'delivery') {
        // An operator took the environment again so this completed ticket can deliver: resume it, release it on neither a
        // restart nor a heartbeat, only through the same release facts as any other holder.
        try { tickets.acquire(ticket.id, ticket.title) } catch (error) {
          this.ctx.logger.warn('dsh-superagent: ticket %s could not resume its delivery lease: %s', ticket.id, String(error))
        }
      } else if (record.holder.kind === 'ticket' && ticket?.ended) {
        // The ticket ended but its release did not finish (its editor could not be stopped, or the host stopped meanwhile):
        // take the handle back and finish the release now, which stops the editor first and keeps the lock on a failure.
        const ended = ticket.ended
        void (async () => {
          try {
            tickets.acquire(ticket.id, ticket.title)
            await tickets.end(ticket.id, { by: ended.by, outcome: ended.outcome }, ended.outcome === 'completed')
          } catch (error) {
            this.ctx.logger.warn('dsh-superagent: ticket %s could not finish releasing its TP environment: %s', ticket.id, String(error))
          }
        })()
      } else if (record.holder.kind === 'session' && record.holder.id.startsWith(RECOVERY_HOLDER_PREFIX)) {
        // A recovery that was running when the host stopped left only its borrow; it is not a ticket's lease.
        broker.release(record.token, 'stopped', undefined, 'an interrupted recovery borrow')
      }
    }
    tickets.beat()
    this.environmentTimer = setInterval(() => this.environmentHosted?.tickets.beat(), 30_000)
    this.environmentTimer.unref?.()
  }
  /**
   * The host's own acceptance fact, never a report: the ticket completed with the strict acceptance it
   * required, or, for a ticket that requires none, it recorded its result as ready.
   */
  private acceptancePassed(ticket: Ticket): boolean {
    // Independently required review/design must remain current even without strict tests and with an old ready report.
    try { assertTicketValidated(ticket) } catch { return false }
    if (!ticket.validation?.enabled) {
      // A runner that did not report ready (a dropped report, a closed pull request) accepted nothing.
      return ticket.assignments.some(assignment => assignment.report?.state === 'ready')
    }
    return true
  }
  /** The shared TP environment's holder and latest release, for the panel and the operator. */
  environmentView(): EnvironmentExclusivityView {
    return this.environmentHosted?.broker.view() ?? { held: false }
  }
  /** Stop exactly the TP editor this deployment started for a ticket, before its environment goes elsewhere. */
  private async stopTicketEditor(ticketId: string, environment: TpEditorEnvironment): Promise<void> {
    await this.editorRecovery?.cleanup(ticketId, environment)
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      context: kind => runtime.context(kind),
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog(),
      environment: () => runtime.environmentView() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    // The environment lease outlives the host: the heartbeat stops, the record stays for the next start.
    if (this.environmentTimer) { clearInterval(this.environmentTimer); this.environmentTimer = undefined }
    this.environmentHosted?.broker.halt()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
