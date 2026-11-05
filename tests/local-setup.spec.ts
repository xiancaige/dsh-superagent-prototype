import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { Config, machineOf, resolveDeployment, resolveFeishuBot, workerProbe } from '../src/deployment.ts'
import { Setup, type SetupHost } from '../src/app/setup.ts'
import { agentVariables, applyEnvironment, runAsWorker, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'

vi.mock('../src/deployment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/deployment.ts')>(), workerProbe: vi.fn(),
}))
vi.mock('../src/infra/environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/infra/environment.ts')>(),
  agentVariables: vi.fn(), applyEnvironment: vi.fn(), runAsWorker: vi.fn(), verifyEnvironment: vi.fn(),
  withoutDirectory: vi.fn(), workerBin: vi.fn(), writeEnvironment: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

const localMachine = () => machineOf(Config({ stateDir: 'F:\\trial\\superagent', executionMode: 'local' }))
const bot = { cli: process.execPath, appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Local Bot' }
const botProbe = (mode = 'bot', status = 'ready') => vi.fn(async (argv: string[]) => {
  expect(argv[0]).toBe(process.execPath)
  const command = argv.slice(1).join(' ')
  if (command === 'auth status') return JSON.stringify({ appId: bot.appId, brand: bot.brand, identities: { bot: { status } } })
  if (command === 'config strict-mode') return `strict-mode: ${mode} (source: profile)`
  if (command === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') return JSON.stringify({ bot: { open_id: bot.botId, app_name: bot.name } })
  throw new Error(`Unexpected CLI request: ${command}`)
})
const botSettings = () => SettingsSchema.parse({ sources: { feishu: { config: { cli: process.execPath } }, github: { config: { repository: 'invalid', cli: false } } } })

describe('worker CLI probe', () => {
  it('passes argv and notifier variables through subprocess env without a POSIX env executable', async () => {
    const { workerProbe: actualWorkerProbe } = await vi.importActual<typeof import('../src/deployment.ts')>('../src/deployment.ts')
    vi.mocked(workerBin).mockReturnValue('C:\\state\\worker-bin')
    vi.mocked(withoutDirectory).mockReturnValue('C:\\bin')
    vi.mocked(runAsWorker).mockResolvedValue('identity')
    const subprocess = {} as SetupHost['context']['subprocess']
    const signal = new AbortController().signal
    expect(await actualWorkerProbe(subprocess, 'C:\\state', 'C:\\work', signal)([process.execPath, 'auth', 'status'])).toBe('identity')
    expect(runAsWorker).toHaveBeenCalledWith(subprocess, [process.execPath, 'auth', 'status'], 'C:\\work', expect.any(AbortSignal), {
      PATH: 'C:\\bin', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    })
  })
})

describe('local deployment configuration', () => {
  it('defaults to github and accepts only the two explicit execution modes', () => {
    expect(machineOf(Config({ stateDir: '/state' })).executionMode).toBe('github')
    expect(localMachine().executionMode).toBe('local')
    // @ts-expect-error Invalid user configuration must also be rejected at runtime.
    expect(() => Config({ stateDir: '/state', executionMode: 'offline' })).toThrow()
    expect(() => machineOf(Config({ stateDir: '/state', unexpected: true }))).toThrow('keys it does not use')
  })
  it.each(['/srv/state', 'C:\\state', 'F:/state', '\\\\server\\share', '\\\\server\\share\\state'])('accepts absolute path %s', stateDir => {
    expect(Config({ stateDir }).stateDir).toBe(stateDir)
  })
  it.each(['state', './state', '../state', '~/state', 'C:state', 'C:', '\\state', '\\\\server', '\\\\server\\'])('rejects relative or incomplete path %s', stateDir => {
    expect(() => Config({ stateDir })).toThrow()
  })
  it('keeps source workspace opt-in and requires an existing local source root', () => {
    expect(machineOf(Config({ stateDir: '/state' })).workspaceMode).toBe('isolated')
    expect(machineOf(Config({ stateDir: '/state', executionMode: 'local', workspaceMode: 'source', sourceRoot: tmpdir() }))).toMatchObject({ workspaceMode: 'source', sourceRoot: tmpdir() })
    expect(() => machineOf(Config({ stateDir: '/state', workspaceMode: 'source', sourceRoot: tmpdir() }))).toThrow('executionMode=local')
    expect(() => machineOf(Config({ stateDir: '/state', executionMode: 'local', workspaceMode: 'source' }))).toThrow('sourceRoot')
    expect(() => machineOf(Config({ stateDir: '/state', sourceRoot: tmpdir() }))).toThrow('workspaceMode=source')
  })
  it('resolves without validating or probing CLI accounts and without inventing an identity', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('must not probe'))
    const deployment = await resolveDeployment(localMachine(), { repository: 'invalid', cli: false }, probe)
    expect(deployment).toMatchObject({ executionMode: 'local', repository: '', github: { cli: '', login: '', noreply: '' } })
    expect(deployment).not.toHaveProperty('feishu')
    expect(await resolveFeishuBot(localMachine(), {}, probe)).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })
  it('resolves an explicitly configured local bot without any GitHub requests', async () => {
    const probe = botProbe()
    expect(await resolveFeishuBot(localMachine(), { cli: process.execPath }, probe)).toEqual(bot)
    expect(probe.mock.calls.map(([argv]) => argv.slice(1))).toEqual([
      ['auth', 'status'], ['config', 'strict-mode'], ['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'],
    ])
  })
  it.each(['off', 'user', 'unknown'])('rejects local bot CLI strict-mode %s', async mode => {
    const probe = botProbe(mode)
    await expect(resolveFeishuBot(localMachine(), { cli: process.execPath }, probe)).rejects.toMatchObject({ code: 'feishuUserIdentity', values: { mode } })
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it('rejects an unready local bot before reading strict-mode or bot info', async () => {
    const probe = botProbe('bot', 'missing')
    await expect(resolveFeishuBot(localMachine(), { cli: process.execPath }, probe)).rejects.toMatchObject({ code: 'feishuBotNotReady' })
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('preserves github account and repository resolution in default mode', async () => {
    const machine = machineOf(Config({ stateDir: '/state' }))
    const probe = vi.fn().mockResolvedValueOnce(JSON.stringify({ login: 'Agent-Bot', id: 7 }))
      .mockResolvedValueOnce(JSON.stringify({ name: 'acme/widgets', push: true }))
    const deployment = await resolveDeployment(machine, { repository: 'acme/gadgets', cli: process.execPath }, probe)
    expect(deployment).toMatchObject({ executionMode: 'github', repository: 'acme/widgets',
      github: { cli: process.execPath, login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(probe.mock.calls).toEqual([[ [process.execPath, 'api', 'user'] ],
      [ [process.execPath, 'api', 'repos/acme/gadgets', '--jq', '{name: .full_name, push: .permissions.push}'] ]])
  })
  it('retains github credential requirements when execution mode is absent', async () => {
    const machine = localMachine()
    delete machine.executionMode
    const probe = vi.fn()
    await expect(resolveDeployment(machine, {}, probe)).rejects.toMatchObject({ code: 'repositoryUnset' })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('same-process local Setup', () => {
  it('validates and attaches an optional bot without GitHub, shims, or process environment changes', async () => {
    const before = { ...process.env }
    const probe = botProbe()
    vi.mocked(workerProbe).mockReturnValue(probe)
    const host = { context: { subprocess: {} }, machine: localMachine(), lifetime: new AbortController().signal, restart: vi.fn() } as unknown as SetupHost
    const setup = new Setup(host)
    const settings = botSettings()
    expect(await setup.run(settings)).toBe(true)
    expect(setup.deployment.feishu).toEqual(bot)
    expect(setup.deployment.github).toEqual({ cli: '', login: '', noreply: '' })
    expect(setup.commandEnvironment).toEqual({})
    await setup.checkAccounts('source:feishu', settings)
    expect(probe).toHaveBeenCalledTimes(6)
    await expect(setup.checkAccounts('source:github', settings)).rejects.toMatchObject({ code: 'sourceNotInstalled' })
    expect(probe).toHaveBeenCalledTimes(6)
    await setup.blockCommands(['git', 'gh'])
    setup.restore()
    expect(process.env).toEqual(before)
    for (const operation of [agentVariables, withoutDirectory, writeEnvironment, applyEnvironment, verifyEnvironment]) expect(operation).not.toHaveBeenCalled()
  })
  it('rejects unsafe Feishu account edits but leaves local execution ready when startup bot validation fails', async () => {
    const probe = botProbe('off')
    vi.mocked(workerProbe).mockReturnValue(probe)
    const warn = vi.fn()
    const host = { context: { subprocess: {}, logger: { warn } }, machine: localMachine(), lifetime: new AbortController().signal, restart: vi.fn() } as unknown as SetupHost
    const setup = new Setup(host)
    await expect(setup.checkAccounts('source:feishu', botSettings())).rejects.toMatchObject({ code: 'feishuUserIdentity' })
    expect(await setup.run(botSettings())).toBe(true)
    expect(setup.deployment).not.toHaveProperty('feishu')
    expect(setup.feishuProblem).toBeDefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(writeEnvironment).not.toHaveBeenCalled()
    expect(verifyEnvironment).not.toHaveBeenCalled()
  })
  it('does not construct probes, write shims, apply Git/PATH changes, or verify the worker environment', async () => {
    const before = { ...process.env }
    // Reading subprocess would itself be a bug: local setup needs no CLI service.
    const context = { get subprocess(): never { throw new Error('must not access subprocess') } }
    const host = { context, machine: localMachine(), lifetime: new AbortController().signal, restart: vi.fn() } as unknown as SetupHost
    const setup = new Setup(host)
    const settings = SettingsSchema.parse({})
    expect(await setup.run(settings)).toBe(true)
    expect(setup.configured()).toBe(true)
    expect(setup.deployment.github).toEqual({ cli: '', login: '', noreply: '' })
    expect(setup.commandEnvironment).toEqual({})
    await setup.blockCommands(['git', 'gh'])
    await setup.checkAccounts('source:local', settings)
    await expect(setup.checkAccounts('source:github', settings)).rejects.toMatchObject({ code: 'sourceNotInstalled', values: { source: 'github' } })
    await expect(setup.checkAccounts('source:feishu', settings)).resolves.toBeUndefined()
    setup.restore()
    expect(process.env).toEqual(before)
    for (const operation of [workerProbe, agentVariables, withoutDirectory, workerBin, writeEnvironment, applyEnvironment, verifyEnvironment]) {
      expect(operation).not.toHaveBeenCalled()
    }
  })
})
