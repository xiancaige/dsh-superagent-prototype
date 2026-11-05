import { describe, expect, it } from 'vitest'
import { FeishuBotSchema, resolveFeishuBot, workerProbe, type Machine } from '../src/deployment.ts'
import { feishuEnvironment } from '../src/infra/feishu-environment.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { testDeployment } from './fixtures/deployment.ts'

const configDir = 'C:\\isolated\\bot'
const context = { HERMES_HOME: 'hermes', OPENCLAW_HOME: 'claw', LARK_CHANNEL: 'channel', LARKSUITE_CLI_APP_SECRET: 'ambient-test', LARKSUITE_CLI_ACCESS_TOKEN: 'ambient-test', KEEP: 'yes' }
describe('isolated Feishu CLI environment', () => {
  it('validates absolute config directories and inherits the field in the Source schema', () => {
    for (const path of ['/srv/bot', configDir, '\\\\host\\share\\bot']) {
      expect(FeishuBotSchema.parse({ configDir: path }).configDir).toBe(path)
      expect(feishuKind.schema.parse({ configDir: path })).toMatchObject({ configDir: path })
    }
    for (const path of ['', 'bot', 'C:bot', '\\bot', '~/bot', '\\\\host']) expect(FeishuBotSchema.safeParse({ configDir: path }).success).toBe(false)
  })
  it('only removes workspace context when explicitly configured, preserving caller and host environments', () => {
    const before = { ...process.env }
    expect(feishuEnvironment(undefined, context)).toMatchObject(context)
    const env = feishuEnvironment(configDir, context)
    expect(env).toMatchObject({ HERMES_HOME: undefined, OPENCLAW_HOME: undefined, LARK_CHANNEL: undefined, KEEP: 'yes', LARKSUITE_CLI_APP_SECRET: undefined, LARKSUITE_CLI_ACCESS_TOKEN: undefined, LARKSUITE_CLI_CONFIG_DIR: configDir })
    expect(context.HERMES_HOME).toBe('hermes')
    expect(process.env).toEqual(before)
  })
  it('passes isolation on all setup probes and preserves it through worker spawn', async () => {
    const requests: Array<{ argv: readonly string[]; env?: NodeJS.ProcessEnv }> = []
    const subprocess = { spawn: (request: typeof requests[number]) => {
      requests.push(request)
      const command = request.argv.slice(1).join(' ')
      const text = command === 'auth status' ? JSON.stringify({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } })
        : command === 'config strict-mode' ? 'strict-mode: bot'
          : JSON.stringify({ bot: { open_id: 'ou_bot', app_name: 'Bot' } })
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text }) } } }
    } }
    const machine = { executionMode: 'local', stateDir: configDir } as Machine
    const probe = workerProbe(subprocess as never, configDir, configDir, new AbortController().signal)
    expect(await resolveFeishuBot(machine, { cli: process.execPath, configDir }, probe)).toMatchObject({ configDir, botId: 'ou_bot' })
    expect(requests).toHaveLength(3)
    for (const request of requests) expect(request.env).toMatchObject({ LARKSUITE_CLI_CONFIG_DIR: configDir, HERMES_HOME: undefined, OPENCLAW_HOME: undefined, LARK_CHANNEL: undefined })
  })
  it('isolates direct bot commands without affecting other commands or global env', async () => {
    const before = { ...process.env }
    const deployment = testDeployment()
    deployment.feishu = { ...deployment.feishu!, cli: process.execPath, configDir }
    const commands = new Commands(() => deployment, context, new AbortController().signal)
    const output = await commands.run(process.execPath, ['-e', 'console.log(JSON.stringify({config:process.env.LARKSUITE_CLI_CONFIG_DIR,hermes:process.env.HERMES_HOME,claw:process.env.OPENCLAW_HOME,channel:process.env.LARK_CHANNEL,keep:process.env.KEEP}))'])
    expect(JSON.parse(output)).toEqual({ config: configDir, keep: 'yes' })
    expect(process.env).toEqual(before)
    deployment.feishu = undefined
    const unchanged = await commands.run(process.execPath, ['-e', 'console.log(process.env.HERMES_HOME)'])
    expect(unchanged.trim()).toBe('hermes')
  })
})
