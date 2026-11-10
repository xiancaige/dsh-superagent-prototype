/**
 * Phase 2 C through the Engine: an accepted ticket takes the shared environment before its workspace is
 * prepared, a second ticket is refused with the holder's name and is not started at all, a worker's
 * `waiting` report and a rework retry keep the hold, a completion the host does not confirm keeps it, a
 * person's stop and work that ends by itself release it, and a handover exports the scene first and only
 * then lets the next ticket in.
 *
 * The environment is the real broker over a temporary state directory, with a real ticket side whose
 * editor is recorded rather than launched; the lifecycle runs through the real `Engine`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runningAssignment } from '../src/core/index.ts'
import { EXCLUSIVITY_FILE } from '../src/app/environment-exclusive.ts'
import { phase2cHarness } from './fixtures/engine-harness.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const dirWith = (): string => { const root = mkdtempSync(path.join(tmpdir(), 'dsh-p2c-engine-')); roots.push(root); return root }

describe('phase 2 C in the Engine', () => {
  it('takes the environment when a ticket is accepted, before its workspace exists', () => {
    const h = phase2cHarness(dirWith())
    const id = h.accept('1')
    // The host's prepareTicket has not run in this harness: the environment was taken before any directory.
    expect(h.tickets.holds(id)).toBe(true)
    const record = JSON.parse(readFileSync(path.join(h.directory, EXCLUSIVITY_FILE), 'utf8')) as { resources: { name: string }[] }
    expect(record.resources.map(resource => resource.name)).toEqual(['tp-editor', 'tpmcp-port', 'tp-project'])
    expect(h.launches).toHaveLength(1)
  })

  it('refuses a second ticket with the holder’s name and starts nothing for it', () => {
    const h = phase2cHarness(dirWith())
    const first = h.accept('1')
    const second = h.accept('2')
    // The ticket exists, blocked by the holder's name, and got no launch: its worker never sees the environment.
    const ticket = h.repo.tickets.get(second)!
    expect(ticket.environmentBlock).toMatch(new RegExp(`TP environment block: TP environment is held by ticket Fix 1 \\(${first}\\)`))
    expect(h.launches).toHaveLength(1)
    expect(h.tickets.holds(second)).toBe(false)
    expect(ticket.ended).toBeUndefined()
    // Queueing for the environment is not a strict-acceptance requirement: it would leave the ticket unable to ever be accepted.
    expect(ticket.validation).toBeUndefined()
  })

  it('keeps holding while the worker waits, fails, and reworks', () => {
    const h = phase2cHarness(dirWith())
    const id = h.accept('1')
    h.settle()
    h.engine.report(id, { state: 'waiting', summary: 'waiting for the person' })
    h.engine.report(id, { state: 'failed', summary: 'the check failed; reworking' })
    expect(h.tickets.holds(id)).toBe(true)
    h.engine.retryTicket(id)
    h.settle()
    expect(h.repo.tickets.get(id)!.assignments).toHaveLength(2)
    expect(runningAssignment(h.repo.tickets.get(id)!)).toBeDefined()
    expect(h.tickets.holds(id)).toBe(true)
  })

  it('keeps the hold when the host cannot confirm the completion’s acceptance, and a stop still releases it', () => {
    const h = phase2cHarness(dirWith())
    const id = h.accept('1')
    h.settle()
    // The host's own check cannot confirm this ticket's acceptance (its evidence is missing).
    h.hosts.acceptance = () => false
    // The worker's ready report is not a completion the host confirmed: the end is refused, and the
    // ticket stays open with the environment.
    expect(() => h.engine.report(id, { state: 'ready', summary: 'done' })).toThrow(/not passed the acceptance/)
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()
    expect(h.tickets.holds(id)).toBe(true)
    // A person's stop of the rejected ticket still gives its environment back.
    h.engine.stopTicket(id)
    return vi.waitFor(() => expect(h.broker.view().lastRelease).toMatchObject({ reason: 'stopped', ticketId: id }))
  })

  it('releases for a person’s stop and for work that ends by itself, and lets the next ticket in', async () => {
    const h = phase2cHarness(dirWith())
    const first = h.accept('1')
    h.settle()
    h.engine.stopTicket(first)
    await vi.waitFor(() => expect(h.tickets.holds(first)).toBe(false))
    expect(h.broker.view().lastRelease).toMatchObject({ reason: 'stopped', ticketId: first })
    // The next ticket enters now.
    const second = h.accept('2')
    expect(h.tickets.holds(second)).toBe(true)
    // Its work ends by itself (a dropped report): the environment comes back.
    h.settle()
    h.engine.report(second, { state: 'dropped', summary: 'nothing to do' })
    await vi.waitFor(() => expect(h.tickets.holds(second)).toBe(false))
    expect(h.broker.view().lastRelease).toMatchObject({ reason: 'stopped', ticketId: second })
  })

  it('hands the environment over only through a person’s request, and then the next ticket enters', async () => {
    // The ticket's execution directory is a git work tree with a scene it has not committed yet.
    const root = dirWith()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    writeFileSync(path.join(root, 'kept.txt'), 'base\n')
    git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('add', '.'); git('commit', '-q', '-m', 'base')
    writeFileSync(path.join(root, 'kept.txt'), 'mine\n')
    const h = phase2cHarness(dirWith())
    const id = h.accept('1')
    h.settle()
    h.hosts.directories.set(id, root)
    // A ticket that holds nothing cannot hand the environment over.
    await expect(h.engine.handOverEnvironment('unknown-ticket')).rejects.toThrow(/Unknown ticket/)
    const result = await h.engine.handOverEnvironment(id)
    expect(result.handedOver).toBe(true)
    expect(result.export).toMatch(/worktree\.bundle$/)
    // The scene is untouched and the next ticket enters.
    expect(readFileSync(path.join(root, 'kept.txt'), 'utf8')).toBe('mine\n')
    expect(h.tickets.holds(id)).toBe(false)
    const next = h.accept('2')
    expect(h.tickets.holds(next)).toBe(true)
  })
})

