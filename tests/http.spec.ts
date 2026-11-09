import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { MemoryRepositories } from '../src/core/index.ts'
import type { Trigger } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('guards local intake, validates input, reports retry conflicts and reads its durable transcript', async () => {
  const repo = new MemoryRepositories(), state = new Map<string, unknown>()
  let received = 0, enabled = true
  const host = {
    triggers: repo.triggers, atomic: <T>(run: () => T) => run(),
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) } },
    receive: (trigger: Trigger) => { received++; if (repo.triggers.get(trigger.id)) return 'duplicate'; repo.triggers.save(trigger); return 'stored' },
  } as unknown as SourceContext
  const call = serve({ sources: { instance: () => ({ enabled }) }, context: () => host })
  const body = { id: 'task', text: 'Real request' }
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil:3082' }, { origin: 'http://evil' }]) {
    expect(await call('POST', 'local/messages', body, headers)).toMatchObject({ status: 403 })
  }
  expect(received).toBe(0)
  expect(await call('POST', 'local/messages', { ...body, actor: 'admin' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'local/messages', body)).toMatchObject({ status: 200, body: { triggerId: 'local:message:task', thread: 'task', result: 'stored' } })
  expect(await call('POST', 'local/messages', body)).toMatchObject({ status: 200, body: { result: 'duplicate' } })
  expect(await call('POST', 'local/messages', { ...body, thread: 'different' })).toMatchObject({ status: 409 })
  expect(await call('GET', 'local/messages?thread=task')).toMatchObject({ status: 200, body: { messages: [{ id: 'task', from: 'operator', text: 'Real request' }] } })
  enabled = false
  expect(await call('POST', 'local/messages', body)).toMatchObject({ status: 404 })
})

it('configures strict acceptance only through explicit management schema and exposes host evidence', async () => {
  const calls: unknown[] = []
  const validation = { enabled: true as const, contract: { revision: 'r1' } }
  const call = serve({ store: { tickets: { get: (id: string) => id === 't1' ? { validation } : undefined } },
    engine: { configureValidation: (id: string, input: unknown) => { calls.push([id, input]); return { validation } } } })
  const contract = { adapter: 'cqtest-report', executable: 'C:/TP/BuildScripts/validate-cqtest-report.py', workspace: 'C:/work/t1', requiredTestIds: ['TP.Editor.UiDsl.ApplyGateRejectsNonPatchable'] }
  expect(await call('PUT', 'tickets/t1/validation', { enabled: true, contract })).toMatchObject({ status: 200, body: { validation } })
  expect(calls).toEqual([['t1', contract]])
  for (const body of [{ enabled: false }, { enabled: true, evidence: { passed: true } },
    { enabled: true, contract: { ...contract, adapter: 'unsupported' } },
    { enabled: true, contract: { ...contract, revision: 'worker-version' } },
    { enabled: true, contract: { ...contract, command: 'echo OK' } }]) {
    expect(await call('PUT', 'tickets/t1/validation', body)).toMatchObject({ status: 400 })
  }
  expect(calls).toHaveLength(1)
  const otherContract = { ...contract, executable: 'C:/TP/BuildScripts/other-validator.py', requiredTestIds: ['TP.GAS.Smoke.Runs'] }
  expect(await call('PUT', 'tickets/t1/validation', { enabled: true, contract: otherContract })).toMatchObject({ status: 200 })
  expect(calls.at(-1)).toEqual(['t1', otherContract])
  expect(await call('PUT', 'tickets/t1/validation', { enabled: true, contract: { ...otherContract, args: ['-e', ''] } })).toMatchObject({ status: 400 })
  expect(await call('GET', 'tickets/t1/validation')).toMatchObject({ status: 200, body: { validation } })
  expect(await call('GET', 'tickets/missing/validation')).toMatchObject({ status: 404 })
  expect(await call('PUT', 'tickets/t1/validation', { enabled: true }, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    mounted: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})


it('keeps delivery grants operator-only and refuses worker commands/evidence through HTTP schemas', async () => {
  const calls: unknown[] = []
  const call = serve({ store: { tickets: { get: (id: string) => id === 'd1' ? { id } : undefined } },
    engine: {
      deliveryState: () => ({}),
      configureDelivery: (...args: unknown[]) => { calls.push(args); return {} },
      deliverTicket: (...args: unknown[]) => { calls.push(args); return { refused: true, reasons: ['No grant'] } },
    } })
  expect(await call('GET', 'tickets/d1/delivery')).toMatchObject({ status: 200, body: {} })
  for (const extra of [{ command: 'publish' }, { evidence: { passed: true } }, { by: 'worker' }, { expiresAt: 'forever' }]) {
    expect(await call('PUT', 'tickets/d1/delivery', { level: 'release', granted: true, ...extra })).toMatchObject({ status: 400 })
  }
  expect(calls).toEqual([])
  expect(await call('PUT', 'tickets/d1/delivery', { level: 'push', granted: true })).toMatchObject({ status: 200 })
  expect(calls).toEqual([['d1', 'push', true, 'management-panel']])
  expect(await call('POST', 'tickets/d1/delivery', { level: 'release', assignmentId: 'a1', requestId: 'r1', command: 'publish' }))
    .toMatchObject({ status: 400 })
  expect(await call('POST', 'tickets/d1/delivery', { level: 'release', assignmentId: 'a1', requestId: 'r1' }))
    .toMatchObject({ status: 200, body: { refused: true, reasons: ['No grant'] } })
  expect(calls.at(-1)).toEqual(['d1', 'a1', 'release', 'r1'])
  expect(await call('PUT', 'tickets/d1/delivery', { level: 'release', granted: true }, { origin: 'http://evil' })).toMatchObject({ status: 403 })
})
