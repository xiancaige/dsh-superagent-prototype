/**
 * TODO 32: a ticket is only completed once its work reached the remote. Real git over a local bare repository stands in for
 * the remote: success, a commit that was never pushed, uncommitted changes, a rejected non-fast-forward push, an
 * unreadable remote, and a submodule whose own commit is unpushed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Real git on Windows is slow; every case here shells out several times.
vi.setConfig({ testTimeout: 90_000 })
import { unpublishedReason } from '../src/app/publication.ts'
import { lifecycleHarness } from './fixtures/lifecycle-harness.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const scratch = (): string => { const root = mkdtempSync(path.join(tmpdir(), 'dsh-pub-')); roots.push(root); return root }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8', stdio: 'pipe' })

/** A bare `origin` with one commit, and a clone of it standing for a ticket's worktree. */
function repository(): { origin: string; work: string } {
  const root = scratch()
  const origin = path.join(root, 'origin.git'), seed = path.join(root, 'seed'), work = path.join(root, 'work')
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' })
  mkdirSync(seed)
  git(seed, 'init', '-b', 'main'); writeFileSync(path.join(seed, 'a.txt'), 'a'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'seed')
  git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', 'origin', 'main')
  execFileSync('git', ['clone', origin, work], { stdio: 'pipe' })
  return { origin, work }
}

describe('unpublishedReason', () => {
  it('is satisfied by a clean worktree whose HEAD is in a remote branch', () => {
    expect(unpublishedReason(repository().work)).toBeUndefined()
  })

  it('has nothing to publish for no directory, a missing one, or a directory that is no work tree', () => {
    expect(unpublishedReason(undefined)).toBeUndefined()
    expect(unpublishedReason(path.join(scratch(), 'gone'))).toBeUndefined()
    expect(unpublishedReason(scratch())).toBeUndefined()
  })

  it('refuses uncommitted changes, tracked or untracked, naming one', () => {
    const { work } = repository()
    writeFileSync(path.join(work, 'new.txt'), 'x')
    expect(unpublishedReason(work)).toMatch(/1 uncommitted change\(s\), such as \?\? new\.txt/)
    git(work, 'add', '.'); git(work, 'commit', '-m', 'c')
    writeFileSync(path.join(work, 'a.txt'), 'changed')
    expect(unpublishedReason(work)).toMatch(/uncommitted change\(s\), such as M a\.txt/)
  })

  it('refuses a commit that was never pushed, and accepts it once pushed', () => {
    const { work } = repository()
    writeFileSync(path.join(work, 'b.txt'), 'b'); git(work, 'add', '.'); git(work, 'commit', '-m', 'local only')
    expect(unpublishedReason(work)).toMatch(/is in no remote branch; push it/)
    git(work, 'push', 'origin', 'HEAD:main')
    expect(unpublishedReason(work)).toBeUndefined()
  })

  it('refuses a work whose push the remote rejected as non-fast-forward (the tracking ref never moved)', () => {
    const { origin, work } = repository()
    const other = path.join(scratch(), 'other')
    execFileSync('git', ['clone', origin, other], { stdio: 'pipe' })
    writeFileSync(path.join(other, 'o.txt'), 'o'); git(other, 'add', '.'); git(other, 'commit', '-m', 'other'); git(other, 'push', 'origin', 'HEAD:main')
    writeFileSync(path.join(work, 'b.txt'), 'b'); git(work, 'add', '.'); git(work, 'commit', '-m', 'mine')
    expect(() => git(work, 'push', 'origin', 'HEAD:main')).toThrow()
    expect(unpublishedReason(work)).toMatch(/no remote branch/)
  })

  it('refuses stale tracking refs after the remote branch was deleted', () => {
    const { origin, work } = repository()
    git(origin, 'update-ref', '-d', 'refs/heads/main')
    expect(git(work, 'branch', '-r', '--contains', 'HEAD')).toContain('origin/main')
    expect(unpublishedReason(work)).toMatch(/no remote branch/)
  })

  it('refuses an unreachable origin despite a containing tracking ref', () => {
    const { work } = repository()
    git(work, 'remote', 'set-url', 'origin', path.join(scratch(), 'missing.git'))
    expect(unpublishedReason(work)).toMatch(/could not prove/)
  })

  it('treats a git failure as a reason, never as proof of publication', () => {
    const { work } = repository()
    const failing = (_directory: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n'
      throw new Error('fatal: unable to read the index')
    }
    expect(unpublishedReason(work, failing)).toMatch(/could not prove the work is published: fatal: unable to read the index/)
  })

  it('refuses a submodule whose own HEAD is in no remote branch, though the parent is clean and pushed', () => {
    const { work } = repository()
    const modOrigin = path.join(scratch(), 'mod.git'), modSeed = path.join(scratch(), 'modseed')
    execFileSync('git', ['init', '--bare', '-b', 'main', modOrigin], { stdio: 'pipe' })
    mkdirSync(modSeed); git(modSeed, 'init', '-b', 'main'); writeFileSync(path.join(modSeed, 'm.txt'), 'm'); git(modSeed, 'add', '.'); git(modSeed, 'commit', '-m', 'm')
    git(modSeed, 'remote', 'add', 'origin', modOrigin); git(modSeed, 'push', 'origin', 'main')
    git(work, 'submodule', 'add', modOrigin, 'sub'); git(work, 'commit', '-m', 'add sub'); git(work, 'push', 'origin', 'HEAD:main')
    expect(unpublishedReason(work)).toBeUndefined()
    const sub = path.join(work, 'sub')
    writeFileSync(path.join(sub, 'n.txt'), 'n'); git(sub, 'add', '.'); git(sub, 'commit', '-m', 'sub local')
    expect(unpublishedReason(work)).toMatch(/submodule sub: HEAD .* is in no remote branch/)
    git(sub, 'push', 'origin', 'HEAD:main')
    // The submodule is pushed, but the parent's pointer to its new commit is still an uncommitted change.
    expect(unpublishedReason(work)).toMatch(/worktree: 1 uncommitted change\(s\), such as M sub/)
    git(work, 'add', 'sub'); git(work, 'commit', '-m', 'bump sub'); git(work, 'push', 'origin', 'HEAD:main')
    expect(unpublishedReason(work)).toBeUndefined()
  }, 60_000)
})

describe('completion gate', () => {
  it('refuses a completion while the work is unpublished, naming why, and completes once it is', () => {
    let reason: string | undefined = 'worktree: 2 uncommitted change(s), such as M a.txt; commit them'
    const h = lifecycleHarness(scratch(), { publication: () => reason })
    const id = h.accept('1')
    h.settle()
    expect(() => h.ready(id)).toThrow(/Completion refused: the ticket's work is not published to the remote\. worktree: 2 uncommitted/)
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()
    reason = undefined
    h.ready(id)
    expect(h.repo.tickets.get(id)!.ended?.outcome).toBe('completed')
  })

  it('does not gate a non-completion end such as a drop or a stop', () => {
    const h = lifecycleHarness(scratch(), { publication: () => 'unpublished' })
    const id = h.accept('1')
    h.settle()
    h.engine.report(id, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.tickets.get(id)!.ended?.outcome).toBe('dropped')
  })
})
