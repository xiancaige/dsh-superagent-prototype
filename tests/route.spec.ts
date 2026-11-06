/** Unit tests for the panel's Thread page addresses. */
import { expect, it } from 'vitest'
import { addressRoute, threadPath } from '../src/client/route.ts'

it('names a Thread page by its key and reads the same Thread back from that address', () => {
  const key = 'local:344e468e-2bf1-47a4-adde-0cb065e1c1ce'
  expect(threadPath(key)).toBe('/orchestrator/threads/local%3A344e468e-2bf1-47a4-adde-0cb065e1c1ce')
  expect(addressRoute(threadPath(key))).toEqual({ page: 'trigger', id: key })
  expect(addressRoute('/orchestrator/threads/local%3A344e468e-2bf1-47a4-adde-0cb065e1c1ce/')).toEqual({ page: 'trigger', id: key })
  // A Feishu or GitHub key carries its separators too, and only the separator stays encoded.
  expect(addressRoute(threadPath('feishu:oc_1:om_root'))).toEqual({ page: 'trigger', id: 'feishu:oc_1:om_root' })
})

it('leaves every other address without a route', () => {
  for (const pathname of ['/', '/orchestrator', '/orchestrator/threads', '/orchestrator/threads/', '/orchestrator/api/state',
    '/orchestrator/threads/%E0%A4%A', '/sessions/abc']) expect(addressRoute(pathname)).toBeUndefined()
})
