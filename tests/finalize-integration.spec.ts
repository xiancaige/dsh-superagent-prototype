/** Real host completion effect -> real finalizer CLI -> local bare remote/source/worktree. No production deletion. */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { feishu, startRuntime } from './fixtures/host.ts'

it('completes published work, fast-forwards source, then reclaims its exact worktree through the host effect', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'finalize-host-e2e-')))
  const source = join(root, 'source'), origin = join(root, 'origin.git'), directory = join(root, 'ticket')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  const h = await startRuntime()
  try {
    mkdirSync(source); git(source, 'init', '-b', 'main'); git(source, 'init', '--bare', origin)
    writeFileSync(join(source, 'seed'), 'seed'); git(source, 'add', 'seed'); git(source, 'commit', '-m', 'seed')
    git(source, 'remote', 'add', 'origin', origin); git(source, 'push', 'origin', 'main')
    git(source, 'worktree', 'add', '-b', 'agent/test', directory, 'main')
    writeFileSync(join(directory, 'result'), 'published'); git(directory, 'add', 'result'); git(directory, 'commit', '-m', 'result')
    git(directory, 'push', 'origin', 'HEAD:main')
    const expected = git(directory, 'rev-parse', 'HEAD')
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, finalize: 'test-real-finalizer' } })
    const one = await h.acceptedTicket(feishu('e2e-finalize', '@bot tooling'))
    const ticket = h.runtime.store.tickets.get(one.ticket.id)!
    ticket.execution!.directory = directory
    h.runtime.store.tickets.save(ticket)
    const original = h.subprocess.spawn.getMockImplementation()!
    let executed = false
    h.subprocess.spawn.mockImplementation(spec => {
      const fake = original(spec)
      if (!spec.argv.includes('test-real-finalizer')) return fake
      executed = true
      const done = new Promise<{ exitCode: number; signal: null }>(resolveDone => {
        execFile(process.execPath, [resolve(import.meta.dirname, '../../finalize-ticket-worktree.mjs'), source, directory], { cwd: root }, error => {
          resolveDone({ exitCode: error ? 1 : 0, signal: null })
        })
      })
      return { ...fake, done }
    })
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Published' })
    const agent = h.agents.get(one.sessionId)!
    agent.status = 'idle'
    h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await h.runtime.idle()
    expect(executed).toBe(true)
    expect(h.runtime.effects.pending('finalize', one.ticket.id)).toBe(false)
    expect(h.runtime.store.tickets.get(one.ticket.id)?.ended?.outcome).toBe('completed')
    expect(git(source, 'rev-parse', 'HEAD')).toBe(expected)
    expect(existsSync(join(source, 'result'))).toBe(true)
    expect(existsSync(directory)).toBe(false)
  } finally {
    await h.stop()
    // Only this test's verified temporary root may be removed.
    if (dirname(root) !== realpathSync(tmpdir()) || !root.includes('finalize-host-e2e-')) throw new Error('unexpected test root')
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
