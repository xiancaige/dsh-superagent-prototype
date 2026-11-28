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

it('notifies Feishu when finalize skips source sync due to editor lock or dirty source', async () => {
  for (const mode of ['locked', 'dirty'] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `finalize-host-skip-${mode}-`)))
    const source = join(root, 'source'), origin = join(root, 'origin.git'), directory = join(root, 'ticket')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
    const h = await startRuntime()
    try {
      mkdirSync(source); git(source, 'init', '-b', 'main'); git(source, 'init', '--bare', origin)
      writeFileSync(join(source, 'seed'), 'seed'); git(source, 'add', 'seed'); git(source, 'commit', '-m', 'seed')
      git(source, 'remote', 'add', 'origin', origin); git(source, 'push', 'origin', 'main')
      const sourceHead = git(source, 'rev-parse', 'HEAD')
      git(source, 'worktree', 'add', '-b', 'agent/test', directory, 'main')
      writeFileSync(join(directory, 'result'), 'published'); git(directory, 'add', 'result'); git(directory, 'commit', '-m', 'result')
      git(directory, 'push', 'origin', 'HEAD:main')
      if (mode === 'locked') {
        const stateDir = join(source, '.dsh', 'home', 'state', 'superagent')
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(join(stateDir, 'tp-environment.lock'), JSON.stringify({ token: 'lease-1', holder: { kind: 'ticket', id: 'other' } }))
      } else {
        writeFileSync(join(source, 'untracked'), 'dirty')
      }
      const settings = h.runtime.store.settings()
      h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, finalize: 'test-real-finalizer' } })
      const one = await h.acceptedTicket(feishu(`e2e-finalize-${mode}`, '@bot 修复工单'))
      const ticket = h.runtime.store.tickets.get(one.ticket.id)!
      ticket.execution!.directory = directory
      h.runtime.store.tickets.save(ticket)
      const original = h.subprocess.spawn.getMockImplementation()!
      h.subprocess.spawn.mockImplementation(spec => {
        const fake = original(spec)
        if (!spec.argv.includes('test-real-finalizer')) return fake
        let capturedStdout = ''
        const done = new Promise<{ exitCode: number; signal: null }>(resolveDone => {
          execFile(process.execPath, [resolve(import.meta.dirname, '../../finalize-ticket-worktree.mjs'), source, directory], { cwd: root }, (error, stdout) => {
            capturedStdout = String(stdout ?? '')
            resolveDone({ exitCode: error ? 1 : 0, signal: null })
          })
        })
        return {
          ...fake,
          collected: {
            stdout: { readFrom: () => ({ text: capturedStdout, nextOffset: capturedStdout.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done,
        }
      })
      await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Published' })
      const agent = h.agents.get(one.sessionId)!
      agent.status = 'idle'
      h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await h.runtime.idle()
      expect(existsSync(directory)).toBe(false)
      expect(git(source, 'rev-parse', 'HEAD')).toBe(sourceHead)
      const notices = h.runtime.store.receipts.list().filter(item => item.ticketId === one.ticket.id && item.kind === 'notice' && item.channel.source === 'feishu' && item.text.includes('跳过源工程自动同步'))
      expect(notices).toHaveLength(1)
      if (mode === 'locked') {
        expect(notices[0]!.text).toContain('tp-environment.lock')
      } else {
        expect(notices[0]!.text).toContain('未提交改动')
        expect(existsSync(join(source, 'untracked'))).toBe(true)
      }
    } finally {
      await h.stop()
      if (dirname(root) !== realpathSync(tmpdir()) || !root.includes(`finalize-host-skip-${mode}-`)) throw new Error('unexpected test root')
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 90_000)
