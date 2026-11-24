import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FeishuCommands, type FeishuCommandsHost } from '../src/app/feishu-commands.ts'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { forceUnlockSourceLock, inspectSourceLock, reapStaleSourceLock, resolveSourceRoot, retrySourceLockBlockedTickets,
  sourceLockFile } from '../src/app/source-lock.ts'
import { mainTools, type MainToolsHost } from '../src/app/tools/main.ts'
import { overview } from '../src/app/views/overview.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuTrigger } from '../src/sources/feishu-trigger.ts'
import { UserError, type Ticket } from '../src/core/index.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-superagent-lock-'))
  roots.push(root)
  const source = join(root, 'source')
  mkdirSync(source)
  execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-b', 'main'], { stdio: 'pipe' })
  writeFileSync(join(source, 'seed.txt'), 'seed')
  execFileSync('git', ['-C', source, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed'], { stdio: 'pipe' })
  return { root, source, lock: sourceLockFile(source) }
}

it('resolves sourceRoot from mounted sourceRoot or projectFile parent', () => {
  expect(resolveSourceRoot({ sourceRoot: 'D:/TP', environment: undefined })).toBe('D:/TP')
  expect(resolveSourceRoot({ environment: { recoveryEnabled: true, projectFile: 'D:/TP/TP.uproject', editorExe: 'D:/UE/UnrealEditor.exe',
    mcpPort: 55255, captureTool: 'Cap', captureToolset: 'Set', waitSeconds: 60 } })).toBe('D:/TP')
  expect(resolveSourceRoot({})).toBeUndefined()
})

it('inspects, auto-reaps stale dead-PID locks, and enforces force on live or unknown locks', () => {
  const { source, lock } = gitRepo()
  expect(inspectSourceLock(source)).toEqual({ available: true, sourceRoot: source, file: lock, locked: false })

  // Dead-PID finalize lock is reapable and cleared without force.
  writeFileSync(lock, JSON.stringify({ token: 'tok-1', pid: 999999, host: hostname(), op: 'finalize', reapable: true, ticket: 't1',
    at: '2026-11-24T05:34:41.695Z' }))
  const status = inspectSourceLock(source, { alive: () => false })
  expect(status).toMatchObject({ available: true, locked: true, pidAlive: false, reapable: true, stale: true, holder: { pid: 999999, op: 'finalize' } })
  const warnings: unknown[][] = []
  expect(reapStaleSourceLock(source, { warn: (...args) => warnings.push(args) }, { alive: () => false })).toBe(true)
  expect(warnings).toHaveLength(1)
  expect(existsSync(lock)).toBe(false)

  // Live PID refuses without force, succeeds with force=true.
  writeFileSync(lock, JSON.stringify({ token: 'tok-2', pid: process.pid, host: hostname(), op: 'package', ticket: 't2',
    at: new Date().toISOString() }))
  expect(() => forceUnlockSourceLock(source, { force: false, alive: () => true })).toThrow(UserError)
  expect(existsSync(lock)).toBe(true)
  const unlocked = forceUnlockSourceLock(source, { force: true, alive: () => true })
  expect(unlocked).toMatchObject({ unlocked: true, existed: true, forced: true, stale: false, holder: { pid: process.pid, op: 'package' } })
  expect(existsSync(lock)).toBe(false)

  // Non-reapable package lock is NOT auto-reaped on startup even if PID is dead.
  writeFileSync(lock, JSON.stringify({ token: 'tok-3', pid: 888888, host: hostname(), op: 'package', at: '2026-11-24T05:34:41.695Z' }))
  expect(reapStaleSourceLock(source, undefined, { alive: () => false })).toBe(false)
  expect(existsSync(lock)).toBe(true)
  expect(forceUnlockSourceLock(source, { force: false, alive: () => false })).toMatchObject({ unlocked: true, stale: true, forced: false })
  expect(existsSync(lock)).toBe(false)
})

it('retries only open tickets whose latest failure is source checkout lock contention', () => {
  const tickets: Ticket[] = [
    {
      id: 't-lock', title: 'Locked', decisionId: 'd1', channels: [], inputs: [], undelivered: [],
      mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'u' }, scope: '' },
      origin: { triggerId: 'tr1', triggerIds: ['tr1'] }, createdAt: 'a', updatedAt: 'a',
      assignments: [{ id: 'a1', state: 'ended', createdAt: 'a', endedAt: 'a',
        report: { state: 'failed', summary: 'Error: The prepare command failed: source checkout is busy (D:\\TP\\.git\\tp-source-operation.lock)', at: 'b' } }],
    },
    {
      id: 't-other', title: 'Other', decisionId: 'd2', channels: [], inputs: [], undelivered: [],
      mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'u' }, scope: '' },
      origin: { triggerId: 'tr2', triggerIds: ['tr2'] }, createdAt: 'a', updatedAt: 'a',
      assignments: [{ id: 'a2', state: 'ended', createdAt: 'a', endedAt: 'a',
        report: { state: 'failed', summary: 'LlmError: ECONNRESET', at: 'b' } }],
    },
  ]
  const retryTicket = vi.fn()
  const retried = retrySourceLockBlockedTickets({ retryTicket }, { tickets: { open: () => tickets } as never })
  expect(retried).toEqual(['t-lock'])
  expect(retryTicket).toHaveBeenCalledExactlyOnceWith('t-lock')
})

it('surfaces stale source-lock problems in overview and serves GET/POST source-lock endpoints, main tool, and Feishu /unlock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-superagent-lock-http-'))
  roots.push(dir)
  const store = new Store(join(dir, 'db.sqlite'))
  try {
    const sources = new SourceRegistry(() => store.settings())
    const lockState = { available: true, sourceRoot: 'D:/TP', file: 'D:/TP/.git/tp-source-operation.lock', locked: true, pidAlive: false,
      reapable: true, stale: true, holder: { pid: 9116, op: 'finalize', ticket: 'd01b579d340ed0090e3f56eef5806f85', at: '2026-11-24T05:34:41.695Z' } }
    const problems = overview({ store, sources, links: () => ({ url: '', label: { zh: '', en: '' } }) }, {}, 'v1',
      { running: 0, queued: 0 }, undefined, lockState).problems
    expect(problems).toContainEqual({ kind: 'source-lock', sourceLock: lockState })

    let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
    const unlockSourceLock = vi.fn(() => ({ unlocked: true, existed: true, forced: true, stale: false, file: lockState.file, sourceRoot: 'D:/TP', retriedTickets: ['t1'] }))
    const requestPass = vi.fn()
    registerHttp({ webServer: { host: '127.0.0.1', port: 3082, register: (r: { handler: typeof handler }) => { handler = r.handler; return () => {} } } } as never,
      { ready: Promise.resolve(), sourceLock: () => lockState, unlockSourceLock, requestPass } as unknown as HttpHost)
    const call = async (method: string, path: string, body?: unknown) => {
      let status = 0, text = ''
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      await handler({ method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
        async *[Symbol.asyncIterator]() { yield* chunks } }, { writeHead: (c: number) => { status = c }, end: (d: string) => { text = d } })
      return { status, body: JSON.parse(text) }
    }
    expect(await call('GET', 'source-lock')).toEqual({ status: 200, body: lockState })
    expect(await call('POST', 'source-lock/unlock', { force: true, retryBlocked: true })).toEqual({ status: 200,
      body: { unlocked: true, existed: true, forced: true, stale: false, file: lockState.file, sourceRoot: 'D:/TP', retriedTickets: ['t1'] } })
    expect(unlockSourceLock).toHaveBeenCalledWith({ force: true, retryBlocked: true })
    expect(requestPass).toHaveBeenCalled()

    const tools = mainTools({ context: {}, engine: {}, store, prompts: {}, sessions: {}, settings: {}, assessor: {}, resources: {},
      requestPass, sendReplies: async () => {}, quietly: (run: () => unknown) => run(),
      sourceLock: () => lockState, unlockSourceLock } as unknown as MainToolsHost, { id: 'master' } as never)
    const lockTool = tools.find(tool => tool.name === 'orchestrator_source_lock')!
    expect(lockTool).toBeDefined()
    expect(await lockTool.execute({ action: 'status' } as never, new AbortController().signal)).toEqual(lockState)
    expect(await lockTool.execute({ action: 'unlock', force: true, retry_blocked: true } as never, new AbortController().signal))
      .toMatchObject({ unlocked: true, retriedTickets: ['t1'] })

    const settings = SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_op' }] } } } })
    store.saveSettings(settings)
    const replies: { text: string }[] = []
    const commands = new FeishuCommands({
      context: {} as never, store, settings: {} as never, sessions: {} as never,
      outbox: { send: (msg: { text: string }) => replies.push(msg) } as never,
      sources: { scope: () => ({ listened: true }) } as never,
      masterId: 'master',
      sourceLock: () => lockState,
      unlockSourceLock,
    } as unknown as FeishuCommandsHost)
    const trig = feishuTrigger({ message_id: 'om_unlock', chat_id: 'oc_chat', chat_type: 'p2p', sender_id: 'ou_op',
      sender_type: 'user', content: '/unlock force', create_time: '1794140000000' }, 'ou_bot', 'cli_bot')!
    expect(await commands.receive(trig)).toBe(true)
    expect(replies.at(-1)?.text).toContain('强制解除源工程锁')
  } finally {
    store.close()
  }
})
