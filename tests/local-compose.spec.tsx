// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalCompose } from '../src/client/local-compose.tsx'

const { call, navigate } = vi.hoisted(() => ({ call: vi.fn(), navigate: vi.fn() }))
vi.mock('../src/client/provider.tsx', () => ({ usePanel: () => ({ t: () => 'en', call, navigate }) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
beforeEach(() => {
  call.mockReset(); navigate.mockReset()
  call.mockImplementation(async route => route === 'GET sources' ? [{ id: 'local', installed: true }]
    : { triggerId: 'trigger-1', thread: 'local:thread-1' })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
const mount = () => act(async () => { root.render(<LocalCompose />) })
const posts = () => call.mock.calls.filter(([route]) => route === 'POST local/messages')
async function fill(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const send = () => act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

it('reuses the request id and payload after errors, then uses a new id for a follow-up', async () => {
  const uuid = vi.spyOn(crypto, 'randomUUID')
  let fail = true
  call.mockImplementation(async route => {
    if (route === 'GET sources') return [{ id: 'local', installed: true }]
    if (fail) throw new Error('Local source unavailable')
    return { triggerId: 'trigger-1', thread: 'local:thread-1' }
  })
  await mount()
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  await fill('textarea', '  Fix the local task  ')
  await send()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Local source unavailable')
  expect(container.querySelector('textarea')!.value).toBe('  Fix the local task  ')
  fail = false
  await send()
  expect(posts()).toHaveLength(2)
  expect(posts()[0]![1]).toEqual(posts()[1]![1])
  expect(posts()[0]![1]).toEqual({ body: { id: expect.any(String), text: 'Fix the local task' } })
  expect(uuid).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('trigger-1')
  expect(container.querySelector('input')!.value).toBe('local:thread-1')
  await act(async () => { container.querySelector<HTMLButtonElement>('.dt-textlink')!.click() })
  expect(navigate).toHaveBeenCalledWith({ page: 'trigger', id: 'local:thread-1' })
  await fill('textarea', 'Follow up')
  await send()
  expect(posts()[2]![1]).toEqual({ body: { id: expect.any(String), text: 'Follow up', thread: 'local:thread-1' } })
  expect(posts()[2]![1].body.id).not.toBe(posts()[0]![1].body.id)
  expect(uuid).toHaveBeenCalledTimes(2)
})

it('starts a new attempt when the user edits a failed request', async () => {
  call.mockImplementation(async route => {
    if (route === 'GET sources') return [{ id: 'local', installed: true }]
    throw new Error('Offline')
  })
  await mount()
  await fill('textarea', 'First request')
  await send()
  await fill('input', 'local:existing')
  await send()
  expect(posts()[1]![1].body).toMatchObject({ text: 'First request', thread: 'local:existing' })
  expect(posts()[1]![1].body.id).not.toBe(posts()[0]![1].body.id)
})

it('prevents duplicate submits while a send is pending and ignores blank requests', async () => {
  let resolve!: (value: unknown) => void
  call.mockImplementation(route => route === 'GET sources' ? Promise.resolve([{ id: 'local', installed: true }])
    : new Promise(done => { resolve = done }))
  await mount()
  await fill('textarea', '   ')
  await send()
  expect(posts()).toHaveLength(0)
  await fill('textarea', 'Do local work')
  await send()
  expect(container.querySelector('form')!.getAttribute('aria-busy')).toBe('true')
  expect(container.querySelector('textarea')!.disabled).toBe(true)
  await send()
  expect(posts()).toHaveLength(1)
  await act(async () => { resolve({ triggerId: 'trigger-1', thread: 'local:thread-1' }) })
  expect(container.querySelector('form')!.getAttribute('aria-busy')).toBe('false')
})

it('does not offer local submission when the local source is not installed', async () => {
  call.mockResolvedValue([{ id: 'local', installed: false }, { id: 'github', installed: true }])
  await mount()
  expect(container.querySelector('form')).toBeNull()
  expect(posts()).toHaveLength(0)
})
