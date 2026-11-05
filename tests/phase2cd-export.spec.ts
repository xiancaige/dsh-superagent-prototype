/** Phase 2 C handover export: every kind of uncommitted change reaches the patch, with a real git repository.
 * Regression for the untracked files: one `git diff --no-index` over several paths compares them with each other,
 * and over a single path it is a usage error, so their content used to be lost or mislabelled in worktree.patch.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvironmentExclusivity } from '../src/app/environment-exclusive.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const dir = (prefix: string) => { const root = realpathSync(mkdtempSync(join(tmpdir(), `dsh-export-${prefix}-`))); roots.push(root); return root }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

/** A repository with one commit and a dirty scene: a tracked edit, a staged file, a binary file and `untracked` text files. */
function scene(untracked: Record<string, string>) {
  const root = dir('repo')
  git(root, 'init', '-q')
  writeFileSync(join(root, 'kept.txt'), 'kept\n')
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'base')
  writeFileSync(join(root, 'kept.txt'), 'kept\nedited-tracked-line\n')
  writeFileSync(join(root, 'staged.txt'), 'staged-line\n'); git(root, 'add', 'staged.txt')
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]))
  for (const [name, text] of Object.entries(untracked)) {
    mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), text)
  }
  return root
}
async function exported(untracked: Record<string, string>) {
  const root = scene(untracked)
  const before = git(root, 'status', '--porcelain', '-uall')
  const broker = new EnvironmentExclusivity(dir('state'))
  const result = await broker.export(root, 'ticket-x')
  const patch = readFileSync(result!.patch!, 'utf8')
  return { root, before, patch, result: result! }
}

describe('handover export of a dirty work tree', () => {
  it.each([
    ['one untracked file', { 'only.txt': 'ONLY-UNTRACKED-LINE\n' }],
    ['several untracked files', { 'one.txt': 'FIRST-UNTRACKED-LINE\n', 'two.md': '# SECOND-UNTRACKED-LINE\n', 'sub/three.txt': 'THIRD-UNTRACKED-LINE\n' }],
  ] as const)('writes the content of every untracked file into the patch: %s', async (_name, untracked) => {
    const { patch, root, before } = await exported(untracked)
    for (const [name, text] of Object.entries(untracked)) {
      expect(patch, `untracked ${name} must appear as a new file`).toContain(`+${text.trimEnd()}`)
      expect(patch).toMatch(new RegExp(`diff --git a/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} b/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\nnew file mode`))
    }
    // No file is compared with another one: a mislabelled patch would name two different untracked paths in one header.
    expect(patch.match(/^diff --git a\/(\S+) b\/(\S+)$/gm)?.every(line => { const [, a, b] = /a\/(\S+) b\/(\S+)/.exec(line)!; return a === b }) ?? true).toBe(true)
    expect(patch).toContain('edited-tracked-line')
    expect(patch).toContain('staged-line')
    expect(patch).toMatch(/GIT binary patch/)
    // Exporting writes files only: the work tree is exactly as it was (nothing stashed, reset, cleaned or staged).
    expect(git(root, 'status', '--porcelain', '-uall')).toBe(before)
    expect(git(root, 'stash', 'list')).toBe('')
  })

  it('keeps a verified bundle that holds the snapshot, and lists each file with its digest', async () => {
    const { result, root } = await exported({ 'one.txt': 'FIRST-UNTRACKED-LINE\n', 'two.md': 'SECOND\n' })
    expect(result.files.map(file => file.path).sort()).toEqual(['worktree.bundle', 'worktree.patch'])
    for (const file of result.files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
    git(root, 'bundle', 'verify', result.bundle!)
    expect(git(root, 'bundle', 'list-heads', result.bundle!)).toContain(result.snapshot!)
  })
})
