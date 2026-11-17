import { expect, it } from 'vitest'
import { composePrompt, defaultPrompts } from '../src/app/prompts.ts'

it('keeps local delivery authoritative without an unconditional PR requirement', () => {
  const config = defaultPrompts()
  const worker = composePrompt(config, 'worker')
  expect(config.delivery).toContain('不创建 PR')
  expect(config.delivery).toContain('push origin HEAD:main')
  expect(worker).toContain('Create a PR and follow its CI/review only when that workflow requires one')
  expect(worker).not.toContain('A code change without a PR is not ready')
  expect(config.delivery).not.toContain('never push')
})
it('separates diagnostic requests, role routing, evidence and reply responsibilities', () => {
  const config = defaultPrompts()
  expect(config.scope).toContain('Findings do not authorize implementation, migration, deployment or unrelated repairs')
  expect(composePrompt(config, 'orchestrator')).toContain('Do not route a mixed gameplay/tooling takeover wholly as ops')
  expect(config.delivery).toContain('不得跳过已配置的强制门禁')
  expect(config.communication).toContain('worker 通过 orchestrator_report')
  expect(config.communication).toContain('主调度通过 orchestrator_reply')
  expect(composePrompt(config, 'worker', undefined, undefined, 'ops')).toContain('Do not change gameplay')
  expect(composePrompt(config, 'worker')).toContain('AGENTS.md or CLAUDE.md')
})
