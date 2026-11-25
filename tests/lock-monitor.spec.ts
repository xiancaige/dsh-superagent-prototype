import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { evaluateLockMonitor, LockOwnerMonitor, type LockMonitorReport } from '../src/app/lock-monitor.ts'
import { readResource, type MainResourceHost } from '../src/app/resources.ts'
import { Store } from '../src/app/store.ts'
import type { EnvironmentLeaseRecord } from '../src/app/environment-exclusive.ts'
import type { Ticket } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { packagePath } from '../src/infra/paths.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { jobRegistry } from './fixtures/host.ts'

const execFileAsync = promisify(execFile)
const SCRIPT = packagePath('scripts', 'check-lock-owner.mjs')

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function tempDir(prefix = 'dsh-lock-monitor-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? 'aaaaaaaa111122223333444455556666'
  return {
    id,
    title: 'Fix UMG focus',
    decisionId: 'dec-1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: 'fix' },
    channels: [],
    assignments: [{ id: `assignment:${id}:0`, state: 'running', createdAt: '2026-11-25T00:00:00.000Z', startedAt: '2026-11-25T00:00:01.000Z' }],
    inputs: [],
    undelivered: [],
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:01.000Z',
    origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
    ...overrides,
  }
}

function makeLease(ticketId: string, overrides: Partial<EnvironmentLeaseRecord> = {}): EnvironmentLeaseRecord {
  return {
    token: 'tok-1',
    pid: process.pid,
    host: hostname(),
    holder: { kind: 'ticket', id: ticketId, label: `Fix UMG focus (${ticketId})` },
    resources: [{ name: 'tp-editor', value: 'D:/TP/TP.uproject' }],
    acquiredAt: '2026-11-25T00:00:00.000Z',
    heartbeat: '2026-11-25T00:01:00.000Z',
    ...overrides,
  }
}

function fakeContext(agentsList: Array<{ id: string; status: string; events?: unknown[] }> = [], withJobOwner?: string) {
  const agents = new Map<string, unknown>()
  for (const item of agentsList) {
    agents.set(item.id, {
      id: item.id,
      status: item.status,
      session: { snapshotEvents: () => item.events ?? [] },
    })
  }
  const jobs = jobRegistry()
  if (withJobOwner) jobs.run(withJobOwner, 'run-cqtest.bat')
  const ctx = new Context()
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('jobs', jobs.service)
  return { ctx, jobs }
}

describe('evaluateLockMonitor', () => {
  it('returns unlocked when no environment or source lock is held', async () => {
    const dir = tempDir()
    const store = new Store(join(dir, 'db.sqlite'))
    try {
      const { ctx } = fakeContext()
      const report = await evaluateLockMonitor({
        envRecord: undefined,
        envLive: false,
        sourceLock: { available: true, locked: false },
        store,
        context: ctx,
        nowMs: Date.parse('2026-11-25T00:05:00.000Z'),
      })
      expect(report).toMatchObject({ status: 'unlocked', locked: false, locks: [], issues: [] })
    } finally { store.close() }
  })

  it('reports alive when lock-holding ticket has a running worker with recent events or active background jobs', async () => {
    const dir = tempDir()
    const store = new Store(join(dir, 'db.sqlite'))
    try {
      const ticket = makeTicket()
      store.tickets.save(ticket)
      const nowMs = Date.parse('2026-11-25T00:05:00.000Z')
      const { ctx } = fakeContext([{
        id: workerSessionId(ticket.id),
        status: 'running',
        events: [{ type: 'tool/call', time: nowMs - 20_000, data: { callId: 'c1', name: 'pwsh', arguments: '{}' } }],
      }])
      const report = await evaluateLockMonitor({
        envRecord: makeLease(ticket.id),
        envLive: true,
        store,
        context: ctx,
        alive: () => true,
        nowMs,
      })
      expect(report.status).toBe('alive')
      expect(report.locked).toBe(true)
      expect(report.issues).toEqual([])
      expect(report.locks[0]).toMatchObject({
        lock: 'tp-environment.lock',
        status: 'alive',
        reasonCode: 'alive',
        ticket: { ticket_id: ticket.id, worker_status: 'running', open_tool_calls: 1 },
      })

      // Idle turn with an active background job is still alive.
      const { ctx: jobCtx } = fakeContext([{ id: workerSessionId(ticket.id), status: 'idle', events: [] }], workerSessionId(ticket.id))
      const jobReport = await evaluateLockMonitor({
        envRecord: makeLease(ticket.id),
        envLive: true,
        store,
        context: jobCtx,
        alive: () => true,
        nowMs,
      })
      expect(jobReport.status).toBe('alive')
      expect(jobReport.locks[0]?.ticket?.running_jobs).toBe(1)
    } finally { store.close() }
  })

  it('detects dead and stalled lock holders across failure modes', async () => {
    const dir = tempDir()
    const store = new Store(join(dir, 'db.sqlite'))
    try {
      const nowMs = Date.parse('2026-11-25T00:25:00.000Z')
      const tWorking = makeTicket({ id: '11111111111111111111111111111111' })
      const tFailed = makeTicket({
        id: '22222222222222222222222222222222',
        assignments: [{ id: 'a-fail', state: 'running', createdAt: '2026-11-25T00:00:00.000Z',
          report: { state: 'failed', summary: 'Build failed', at: '2026-11-25T00:01:00.000Z' } }],
      })
      const tIdle = makeTicket({
        id: '33333333333333333333333333333333',
        assignments: [{ id: 'a-idle', state: 'running', createdAt: '2026-11-25T00:00:00.000Z',
          report: { state: 'waiting', summary: 'Paused', at: '2026-11-25T00:01:00.000Z' } }],
      })
      const tEnded = makeTicket({
        id: '44444444444444444444444444444444',
        ended: { at: '2026-11-25T00:10:00.000Z', by: 'executor', outcome: 'completed' },
      })
      for (const item of [tWorking, tFailed, tIdle, tEnded]) store.tickets.save(item)

      // 1. Missing worker session while assignment is running.
      const { ctx: emptyCtx } = fakeContext([])
      const missingWorker = await evaluateLockMonitor({
        envRecord: makeLease(tWorking.id), envLive: true, store, context: emptyCtx, alive: () => true, nowMs,
      })
      expect(missingWorker).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'worker_session_dead', ticketId: tWorking.id }] })

      // 2. Dead OS PID on lock record.
      const deadPid = await evaluateLockMonitor({
        envRecord: makeLease(tWorking.id), envLive: false, store, context: emptyCtx, alive: () => false, nowMs,
      })
      expect(deadPid).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'lock_pid_dead', ticketId: tWorking.id }] })

      // 3. Ticket reported failed while holding lock.
      const failedReport = await evaluateLockMonitor({
        envRecord: makeLease(tFailed.id), envLive: true, store, context: emptyCtx, alive: () => true, nowMs,
      })
      expect(failedReport).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'worker_failed_holding_lock', ticketId: tFailed.id }] })

      // 4. Ticket sitting idle past grace while holding lock.
      const idleReport = await evaluateLockMonitor({
        envRecord: makeLease(tIdle.id), envLive: true, store, context: emptyCtx, alive: () => true, nowMs,
      })
      expect(idleReport).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'worker_idle_holding_lock', ticketId: tIdle.id, canAdvance: true }] })

      // 5. Ended ticket past grace still holding lock.
      const endedReport = await evaluateLockMonitor({
        envRecord: makeLease(tEnded.id), envLive: true, store, context: emptyCtx, alive: () => true, nowMs,
      })
      expect(endedReport).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'ticket_ended', ticketId: tEnded.id }] })

      // 6. Worker stuck on model budget retry while holding lock.
      const { ctx: runningCtx } = fakeContext([{
        id: workerSessionId(tWorking.id), status: 'running',
        events: [{ type: 'turn/start', time: nowMs - 10_000, data: { turn: 1 } }],
      }])
      const retryReport = await evaluateLockMonitor({
        envRecord: makeLease(tWorking.id), envLive: true, store, context: runningCtx, alive: () => true, nowMs,
        modelRetry: () => ({ model_retry: { sessionId: workerSessionId(tWorking.id), provider: 'openai', attempts: 4, since: '2026-11-25T00:20:00.000Z', lastAt: '2026-11-25T00:24:00.000Z' } }),
      })
      expect(retryReport).toMatchObject({ status: 'stalled', issues: [{ reasonCode: 'worker_model_budget_retry', ticketId: tWorking.id }] })

      // 7. Silent running turn with no open tools/jobs for >= 15m.
      const { ctx: silentCtx } = fakeContext([{
        id: workerSessionId(tWorking.id), status: 'running',
        events: [{ type: 'turn/start', time: nowMs - 20 * 60_000, data: { turn: 1 } }],
      }])
      const silentReport = await evaluateLockMonitor({
        envRecord: makeLease(tWorking.id), envLive: true, store, context: silentCtx, alive: () => true, nowMs,
      })
      expect(silentReport).toMatchObject({ status: 'stalled', issues: [{ reasonCode: 'worker_turn_silent', ticketId: tWorking.id }] })

      // 8. Dead source checkout lock.
      const sourceReport = await evaluateLockMonitor({
        envRecord: undefined, envLive: false,
        sourceLock: { available: true, locked: true, file: 'D:/TP/.git/tp-source-operation.lock', pidAlive: false, stale: true, reapable: true,
          holder: { pid: 999999, op: 'finalize', ticket: tWorking.id, at: '2026-11-25T00:00:00.000Z' } },
        store, context: emptyCtx, nowMs,
      })
      expect(sourceReport).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'source_lock_dead_pid', ticketId: tWorking.id }] })

      // 9. Active finalize on an ended ticket is legitimately alive.
      const activeFinalize = await evaluateLockMonitor({
        envRecord: undefined, envLive: false,
        sourceLock: { available: true, locked: true, file: 'D:/TP/.git/tp-source-operation.lock', pidAlive: true, stale: false, reapable: true,
          holder: { pid: process.pid, op: 'finalize', ticket: tEnded.id, at: new Date(nowMs - 30_000).toISOString() } },
        store, context: emptyCtx, nowMs,
      })
      expect(activeFinalize).toMatchObject({ status: 'alive', issues: [] })
    } finally { store.close() }
  })
})

describe('LockOwnerMonitor', () => {
  it('skips script checks when unlocked, checks when locked, alerts with cooldown, and clears on release', async () => {
    const dir = tempDir()
    const store = new Store(join(dir, 'db.sqlite'))
    try {
      const ticket = makeTicket()
      store.tickets.save(ticket)
      const envFile = join(dir, 'tp-environment.lock')
      const board = new HealthBoard()
      const health = board.claim('lockMonitor', { state: 'ready', detail: 'No lock held' })
      const relays: Array<{ id: string; text: string }> = []
      const runScript = vi.fn<() => Promise<LockMonitorReport>>()
      const { ctx } = fakeContext([])
      let nowMs = Date.parse('2026-11-25T01:00:00.000Z')

      const monitor = new LockOwnerMonitor({
        context: ctx, store,
        sessions: { relay: (id, text) => { relays.push({ id, text }) } },
        health, stateDir: dir,
        envBroker: () => ({ file: envFile, read: () => undefined, liveRecord: () => false }),
        sourceLock: () => ({ available: true, locked: false }),
        runScript,
        configured: () => true, paused: () => false, closing: () => false,
        now: () => nowMs,
        alertCooldownMs: 10 * 60_000,
      })

      // 1. Unlocked -> script is NOT called; health stays ready.
      await monitor.tick()
      expect(runScript).not.toHaveBeenCalled()
      expect(relays).toEqual([])
      expect(health.get()).toMatchObject({ state: 'ready', detail: 'No lock held' })

      // 2. Lock appears and holder is alive -> script IS called, no relay emitted.
      writeFileSync(envFile, JSON.stringify(makeLease(ticket.id)))
      runScript.mockResolvedValueOnce({
        checkedAt: new Date(nowMs).toISOString(), status: 'alive', locked: true,
        locks: [{ lock: 'tp-environment.lock', file: envFile, status: 'alive', reasonCode: 'alive', detail: 'ok',
          holder: { kind: 'ticket', id: ticket.id, label: ticket.title, pid: process.pid, pidAlive: true } }],
        issues: [],
      })
      await monitor.tick()
      expect(runScript).toHaveBeenCalledTimes(1)
      expect(relays).toEqual([])
      expect(health.get()).toMatchObject({ state: 'ready' })

      // 3. Holder dies -> relays lock_owner_alert once, deduplicated inside cooldown.
      const deadReport: LockMonitorReport = {
        checkedAt: new Date(nowMs).toISOString(), status: 'dead', locked: true,
        locks: [{ lock: 'tp-environment.lock', file: envFile, status: 'dead', reasonCode: 'worker_session_dead',
          detail: 'Worker session missing',
          holder: { kind: 'ticket', id: ticket.id, label: ticket.title, pid: process.pid, pidAlive: true } }],
        issues: [{ lock: 'tp-environment.lock', status: 'dead', reasonCode: 'worker_session_dead', detail: 'Worker session missing',
          ticketId: ticket.id, canAdvance: true, stateSignature: 'sig-1' }],
      }
      runScript.mockResolvedValue(deadReport)
      await monitor.tick()
      expect(relays).toHaveLength(1)
      expect(JSON.parse(relays[0]!.text)).toMatchObject({
        kind: 'lock_owner_alert',
        status: 'dead',
        reason_code: 'worker_session_dead',
        can_advance: true,
        read: 'environment',
        script: 'scripts/check-lock-owner.mjs',
        ticket: { ticket_id: ticket.id },
      })
      expect(health.get()?.state).toBe('error')

      // Within cooldown -> no duplicate relay.
      nowMs += 60_000
      await monitor.tick()
      expect(relays).toHaveLength(1)

      // After cooldown -> relays again.
      nowMs += 10 * 60_000
      await monitor.tick()
      expect(relays).toHaveLength(2)

      // 4. Lock released -> clears alert state and stops invoking script.
      rmSync(envFile, { force: true })
      const beforeCalls = runScript.mock.calls.length
      await monitor.tick()
      expect(runScript).toHaveBeenCalledTimes(beforeCalls)
      expect(health.get()).toMatchObject({ state: 'ready', detail: 'No lock held' })
    } finally { store.close() }
  })
})

describe('scripts/check-lock-owner.mjs', () => {
  it('inspects offline state-dir lock and sqlite ticket records with accurate exit codes', async () => {
    const dir = tempDir()
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    const envFile = join(dir, 'tp-environment.lock')
    try {
      // 1. Unlocked -> exit 0.
      const unlocked = await execFileAsync(process.execPath, [SCRIPT, '--state-dir', dir], { encoding: 'utf8' })
      expect(JSON.parse(unlocked.stdout)).toMatchObject({ status: 'unlocked', locked: false })

      // 2. Live working ticket & live PID -> exit 0.
      const live = makeTicket({ id: 'aaaa1111aaaa1111aaaa1111aaaa1111', updatedAt: new Date().toISOString(),
        assignments: [{ id: 'a1', state: 'running', createdAt: new Date().toISOString(), startedAt: new Date().toISOString() }] })
      store.tickets.save(live)
      writeFileSync(envFile, JSON.stringify(makeLease(live.id)))
      const aliveRes = await execFileAsync(process.execPath, [SCRIPT, '--state-dir', dir], { encoding: 'utf8' })
      expect(JSON.parse(aliveRes.stdout)).toMatchObject({ status: 'alive', locked: true })

      // 3. Dead PID -> exit 2.
      writeFileSync(envFile, JSON.stringify(makeLease(live.id, { pid: 99999999 })))
      let exitCode = 0
      let stdout = ''
      try {
        await execFileAsync(process.execPath, [SCRIPT, '--state-dir', dir], { encoding: 'utf8' })
      } catch (error) {
        const failed = error as { code: number; stdout: string }
        exitCode = failed.code
        stdout = failed.stdout
      }
      expect(exitCode).toBe(2)
      expect(JSON.parse(stdout)).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'lock_pid_dead' }] })

      // 4. Ended ticket with live host PID -> exit 2.
      const ended = makeTicket({
        id: 'bbbb2222bbbb2222bbbb2222bbbb2222',
        ended: { at: '2026-11-25T00:00:00.000Z', by: 'executor', outcome: 'completed' },
      })
      store.tickets.save(ended)
      writeFileSync(envFile, JSON.stringify(makeLease(ended.id)))
      exitCode = 0; stdout = ''
      try {
        await execFileAsync(process.execPath, [SCRIPT, '--state-dir', dir], { encoding: 'utf8' })
      } catch (error) {
        const failed = error as { code: number; stdout: string }
        exitCode = failed.code
        stdout = failed.stdout
      }
      expect(exitCode).toBe(2)
      expect(JSON.parse(stdout)).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'ticket_ended', ticketId: ended.id }] })
    } finally { store.close() }
  })

  it('queries GET /orchestrator/api/lock-monitor over HTTP and serves orchestrator_read environment resource', async () => {
    const dir = tempDir()
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      const report: LockMonitorReport = {
        checkedAt: '2026-11-25T01:00:00.000Z',
        status: 'dead',
        locked: true,
        locks: [{
          lock: 'tp-environment.lock',
          file: join(dir, 'tp-environment.lock'),
          status: 'dead',
          reasonCode: 'worker_idle_holding_lock',
          detail: 'Ticket ended its turn idle',
          holder: { kind: 'ticket', id: 't1', label: 'Ticket 1', pid: process.pid, pidAlive: true, host: hostname() },
        }],
        issues: [{
          lock: 'tp-environment.lock',
          status: 'dead',
          reasonCode: 'worker_idle_holding_lock',
          detail: 'Ticket ended its turn idle',
          ticketId: 't1',
          canAdvance: true,
          stateSignature: 'sig',
        }],
      }

      const envResult = await readResource({
        store, pages: {} as never, prompts: {} as never, commands: {} as never,
        masterId: 'master-1', context: new Context(), promptVersion: () => ({}) as never,
        mayRead: () => true, feishuPageSize: () => 20, sourceLink: async () => ({}),
        sessions: {} as never, settings: {} as never,
        lockMonitor: async () => report,
      } as MainResourceHost, 'environment', 0, undefined)
      expect(envResult).toEqual(report)

      let handler!: (req: unknown, res: unknown) => Promise<void>
      const server = createServer((req, res) => { void handler(req, res) })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address() as { port: number }
        registerHttp({ webServer: { host: '127.0.0.1', port: address.port, register: (r: { handler: typeof handler }) => { handler = r.handler; return () => {} } } } as never,
          { ready: Promise.resolve(), lockMonitor: async () => report } as unknown as HttpHost)
        let exitCode = 0
        let stdout = ''
        try {
          await execFileAsync(process.execPath, [SCRIPT, '--url', `http://127.0.0.1:${address.port}`], { encoding: 'utf8' })
        } catch (error) {
          const failed = error as { code: number; stdout: string }
          exitCode = failed.code
          stdout = failed.stdout
        }
        expect(exitCode).toBe(2)
        expect(JSON.parse(stdout)).toMatchObject({ status: 'dead', issues: [{ reasonCode: 'worker_idle_holding_lock' }] })
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    } finally { store.close() }
  })
})
