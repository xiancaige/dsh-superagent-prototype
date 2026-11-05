import { expect, it, vi } from 'vitest'
import { startRuntime } from '../src/index.ts'
import type { Runtime } from '../src/app/runtime.ts'

it('constructs the runtime exactly once, never retrying a failure', async () => {
  const value = {} as Runtime
  const create = vi.fn().mockReturnValue(value)
  expect(await startRuntime(create)).toBe(value)
  expect(create).toHaveBeenCalledTimes(1)
})

it('propagates a lock failure instead of retrying the constructor', async () => {
  // Retrying was the defect: `super()` already registered the `orchestrator` service, so a second attempt fails
  // with "service orchestrator has been registered" and the plugin never activates. The lock is waited for
  // inside the constructor instead, where no service exists yet to conflict.
  const locked = Object.assign(new Error('locked'), { code: 'ELOCKED' })
  const create = vi.fn(() => { throw locked })
  await expect(startRuntime(create)).rejects.toBe(locked)
  expect(create).toHaveBeenCalledTimes(1)
})

it('does not retry unrelated startup errors', async () => {
  const error = new Error('invalid configuration'), create = vi.fn(() => { throw error })
  await expect(startRuntime(create)).rejects.toBe(error)
  expect(create).toHaveBeenCalledTimes(1)
})
