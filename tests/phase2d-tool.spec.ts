/** Phase 2 D worker surface: only a scoped request, never commands, grants or caller-owned evidence.
 * Engine dispatch behavior and real acceptance are covered separately by phase2d-delivery.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import type { Ticket } from '../src/core/index.ts'

function harness(deliveryEnabled?: boolean) {
  const initial: Ticket = {
    id: 'closed-over-ticket', title: 'Delivery tool fixture', decisionId: 'decision',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'chat', id: 'operator' }, scope: 'fixture' },
    channels: [], assignments: [{ id: 'initial-assignment', state: 'running', createdAt: '2026-11-03T00:00:00.000Z' }],
    inputs: [], undelivered: [], createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
    origin: { triggerId: 'request', triggerIds: ['request'] },
  }
  let current: Ticket | undefined = structuredClone(initial)
  const result = { refused: true as const, reasons: ['Host Engine owns authorization'] }
  const deliverTicket = vi.fn(async () => result)
  const configureDelivery = vi.fn()
  const report = vi.fn(), runTicketTests = vi.fn(), captureVisual = vi.fn(), readVisual = vi.fn()
  const get = vi.fn((id: string) => id === initial.id ? current : undefined)
  // Only fields used while constructing tools and requesting delivery are required. The extra grant spy
  // intentionally models a powerful host: its authority must never become a worker tool.
  const host = { ...(deliveryEnabled === undefined ? {} : { deliveryEnabled }),
    engine: { deliverTicket, configureDelivery, report, runTicketTests, captureVisual, readVisual },
    store: { tickets: { get } }, github: { deployment: { github: { login: 'fixture-bot' } } },
  } as unknown as ExecutorToolsHost
  const tools = executorTools(host, initial)
  const delivery = () => {
    const tool = tools.find(item => item.name === 'orchestrator_request_delivery')
    if (!tool) throw new Error('Delivery request tool was not registered')
    return tool
  }
  const execute = (args: unknown) => { const tool = delivery(); return tool.execute(tool.schema.parse(args), new AbortController().signal) }
  return { tools, host, initial, delivery, execute, deliverTicket, configureDelivery, report, runTicketTests, captureVisual, readVisual, get, result,
    replace: (value: Ticket | undefined) => { current = value } }
}

describe('phase 2 D conditional executor delivery tool', () => {
  it.each([undefined, false])('does not register delivery when host deliveryEnabled is %s', enabled => {
    const h = harness(enabled)
    expect(h.tools.map(tool => tool.name)).not.toContain('orchestrator_request_delivery')
    expect(h.deliverTicket).not.toHaveBeenCalled()
  })

  it('registers exactly one delivery request tool only after explicit host opt-in, never a grant tool', () => {
    const h = harness(true)
    expect(h.tools.filter(tool => tool.name === 'orchestrator_request_delivery')).toHaveLength(1)
    expect(h.tools.map(tool => tool.name).filter(name => /delivery|grant|authoriz/i.test(name))).toEqual(['orchestrator_request_delivery'])
    expect(h.configureDelivery).not.toHaveBeenCalled()
  })

  it.each(['commit', 'push', 'release'])('accepts only level and request_id for %s', level => {
    const h = harness(true)
    expect(h.delivery().schema.parse({ level, request_id: 'stable-request' })).toEqual({ level, request_id: 'stable-request' })
  })

  it.each([
    { command: 'git push' }, { evidence: { passed: true } }, { grant: true }, { granted: true },
    { ticket_id: 'another-ticket' }, { ticketId: 'another-ticket' }, { assignment_id: 'another-assignment' },
    { target: 'production' }, { configureDelivery: true },
  ])('rejects caller authority/override fields %j rather than stripping them', extra => {
    const h = harness(true)
    expect(h.delivery().schema.safeParse({ level: 'push', request_id: 'request', ...extra }).success).toBe(false)
    expect(h.deliverTicket).not.toHaveBeenCalled()
    expect(h.configureDelivery).not.toHaveBeenCalled()
  })

  it.each([
    {}, { level: 'push' }, { request_id: 'request' }, { level: 'publish', request_id: 'request' },
    { level: 'push', request_id: '' }, { level: 'push', request_id: 'x'.repeat(201) },
  ])('rejects invalid request shape %j', args => {
    expect(harness(true).delivery().schema.safeParse(args).success).toBe(false)
  })

  it('binds the closed-over ticket and resolves the running assignment at execution time; delegates only to guarded deliverTicket', async () => {
    const h = harness(true)
    const next: Ticket = { ...h.initial, assignments: [
      { ...h.initial.assignments[0]!, state: 'ended' },
      { id: 'current-running-assignment', state: 'running', createdAt: h.initial.createdAt },
      { id: 'pending-not-running', state: 'pending', createdAt: h.initial.createdAt },
    ] }
    h.replace(next)
    expect(await h.execute({ level: 'release', request_id: 'request-1' })).toBe(h.result)
    expect(h.get).toHaveBeenCalledWith('closed-over-ticket')
    expect(h.deliverTicket).toHaveBeenCalledExactlyOnceWith('closed-over-ticket', 'current-running-assignment', 'release', 'request-1')
    for (const forbidden of [h.configureDelivery, h.report, h.runTicketTests, h.captureVisual, h.readVisual]) expect(forbidden).not.toHaveBeenCalled()
  })

  it.each(['missing ticket', 'no running assignment'] as const)('refuses %s before attempting delivery', async kind => {
    const h = harness(true)
    h.replace(kind === 'missing ticket' ? undefined : { ...h.initial, assignments: [{ ...h.initial.assignments[0]!, state: 'ended' }] })
    await expect(h.execute({ level: 'push', request_id: 'request' })).rejects.toThrow(/No running assignment/)
    expect(h.deliverTicket).not.toHaveBeenCalled()
    expect(h.configureDelivery).not.toHaveBeenCalled()
  })

  it('does not bypass Engine guards when an opted-in host lacks its delivery runner', async () => {
    const h = harness(true)
    delete h.host.engine.deliverTicket
    await expect(h.execute({ level: 'push', request_id: 'request' })).rejects.toThrow(/Delivery runner unavailable/)
    expect(h.configureDelivery).not.toHaveBeenCalled()
    expect(h.deliverTicket).not.toHaveBeenCalled()
  })
})
