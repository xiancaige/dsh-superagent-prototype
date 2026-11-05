/** Phase 2 C+D across independent OS processes: each Host is `node scripts/phase2cd-host.ts` with its own Engine, SQLite and broker.
 *  Python tests are real unittest runs; delivery is the local SimulatedDelivery only. Nothing is pushed or published. */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM client shared with the demo script
import { Host } from '../scripts/phase2cd-client.mjs'

interface HostLike {
  pid: number; ready: { resumed: { holder: string; action: string }[] }; exitCode?: number | null
  send(cmd: string, args?: unknown): Promise<{ ok: boolean; result?: any; error?: any }>
  call(cmd: string, args?: unknown): Promise<any>
  shutdown(): Promise<unknown>; kill(): void; exited: Promise<unknown>
}
const hosts: HostLike[] = []
const roots: string[] = []
afterEach(async () => {
  const running = hosts.splice(0)
  for (const host of running) host.kill()
  // The SQLite files stay locked until the child is really gone (Windows).
  await Promise.all(running.map(host => Promise.race([host.exited, new Promise(resolve => setTimeout(resolve, 10_000))])))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})
async function start(state: string, extra: string[] = []): Promise<HostLike> { const host = await Host.start(state, extra) as HostLike; hosts.push(host); return host }
function scene() {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'p2cd-spec-')))
  roots.push(state)
  const dir = join(state, 'workspace'); mkdirSync(dir)
  writeFileSync(join(dir, 'answer.py'), 'def answer():\n    return 42\n')
  writeFileSync(join(dir, 'test_delivery.py'), 'import unittest\nfrom answer import answer\n\n\nclass Delivery(unittest.TestCase):\n    def test_answer(self):\n        self.assertEqual(answer(), 42)\n')
  return { state, dir, receipts: join(state, 'delivery-simulation') }
}
const receiptCount = (directory: string) => { try { return readdirSync(directory).length } catch { return 0 } }
async function acceptedAndTested(host: HostLike, dir: string) {
  const { ticketId } = await host.call('accept', { title: 'Process ticket', dir })
  await host.call('configure-tests', { ticketId })
  expect(await host.call('run-tests', { ticketId })).toMatchObject({ passed: true, testsRun: 1, failures: 0, errors: 0, skipped: 0 })
  return ticketId as string
}

describe('phase 2 C+D with independent OS processes', () => {
  it('a different process recovers the lease: token and pid change, acquiredAt and holder do not', async () => {
    const { state, dir } = scene()
    const p1 = await start(state)
    const id = await acceptedAndTested(p1, dir)
    const before = (await p1.call('lease')).record
    expect(before).toMatchObject({ pid: p1.pid, holder: { kind: 'ticket', id } })
    await p1.shutdown()
    const p2 = await start(state)
    expect(p2.pid).not.toBe(p1.pid)
    expect(p2.ready.resumed).toContainEqual({ holder: id, action: 'resumed' })
    const after = (await p2.call('lease')).record
    expect(after.pid).toBe(p2.pid)
    expect(after.token).not.toBe(before.token)
    expect(after.acquiredAt).toBe(before.acquiredAt)
    expect(after.holder).toEqual(before.holder)
    expect((await p2.call('state', { ticketId: id })).holds).toBe(true)
  })

  it('a second live process never takes the lease of a live holder, for the same ticket or any other holder', async () => {
    const { state, dir } = scene()
    const p1 = await start(state)
    const id = await acceptedAndTested(p1, dir)
    const before = (await p1.call('lease')).record
    const p3 = await start(state)
    expect(p3.ready.resumed).toContainEqual(expect.objectContaining({ holder: id, action: 'refused' }))
    for (const args of [{ ticketId: id, kind: 'ticket' }, { ticketId: 'other-ticket' }, { ticketId: 'a-session', kind: 'session' }]) {
      const reply = await p3.send('attempt-acquire', args)
      expect(reply.ok).toBe(false)
      expect(reply.error).toMatchObject({ name: 'EnvironmentHeld', holder: { id }, holderPid: p1.pid })
    }
    expect((await p3.send('acquire-env', { ticketId: id })).ok).toBe(false)
    expect((await p1.call('lease')).record).toEqual(expect.objectContaining({ token: before.token, pid: p1.pid, acquiredAt: before.acquiredAt }))
  })

  it('delivery leaves exactly one receipt across a restart, same or new request ids', async () => {
    const { state, dir, receipts } = scene()
    const p1 = await start(state)
    const id = await acceptedAndTested(p1, dir)
    expect(await p1.call('deliver', { ticketId: id, level: 'push', requestId: 'r0' })).toMatchObject({ refused: true })
    expect((await p1.call('state', { ticketId: id })).delivery.refusals).toHaveLength(1)
    expect(receiptCount(receipts)).toBe(0)
    await p1.call('grant', { ticketId: id, level: 'push' })
    const first = await p1.call('deliver', { ticketId: id, level: 'push', requestId: 'r1' })
    expect(first).toMatchObject({ repeated: false, attempt: { state: 'delivered' }, targetExecutions: 1 })
    expect(receiptCount(receipts)).toBe(1)
    await p1.shutdown()
    const p2 = await start(state)
    for (const requestId of ['r1', 'brand-new-request']) {
      const again = await p2.call('deliver', { ticketId: id, level: 'push', requestId })
      expect(again).toMatchObject({ repeated: true, targetExecutions: 0 })
      expect(again.attempt.operationKey).toBe(first.attempt.operationKey)
    }
    expect(receiptCount(receipts)).toBe(1)
  })

  it('an uncertain delivery (target failed after its effect) is never resent, even after a new grant and a restart', async () => {
    const { state, dir, receipts } = scene()
    const p1 = await start(state, ['--fail-target-after-effect'])
    const id = await acceptedAndTested(p1, dir)
    await p1.call('grant', { ticketId: id, level: 'push' })
    expect(await p1.call('deliver', { ticketId: id, level: 'push', requestId: 'u1' })).toMatchObject({ attempt: { state: 'uncertain' }, targetExecutions: 1 })
    expect(receiptCount(receipts)).toBe(1)
    await p1.call('grant', { ticketId: id, level: 'push' })
    for (const requestId of ['u1', 'u2', 'u3']) {
      const reply = await p1.call('deliver', { ticketId: id, level: 'push', requestId })
      expect(reply.attempt?.state ?? 'refused').not.toBe('delivered')
      expect(reply.targetExecutions).toBe(1)
    }
    await p1.shutdown()
    const p2 = await start(state)
    const reply = await p2.call('deliver', { ticketId: id, level: 'push', requestId: 'u4' })
    expect(reply.attempt?.state ?? 'refused').not.toBe('delivered')
    expect(reply.targetExecutions).toBe(0)
    expect(receiptCount(receipts)).toBe(1)
  })
})
