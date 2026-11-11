/**
 * Whether a ticket's work reached the remote: the completion gate of a deployment whose tickets each work in their own git
 * worktree (`requirePublication`). A ticket is only done once nothing is left in its worktree and every commit it made is
 * contained in a remote branch, so a worker's `ready` never ends a ticket whose work lives on one machine only.
 *
 * Pure reads (`git status`, `git branch -r --contains`); it never fetches, pushes, stashes or cleans. The remote-tracking
 * refs a worker's own `git push` updates are the evidence, so a push that failed leaves the commit uncontained and the
 * ticket open with the reason. Submodules are checked the same way, each by its own HEAD.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** One git call in `directory`; returns stdout, or throws with git's message. Injectable so tests need no repository. */
export type GitRun = (directory: string, args: readonly string[]) => string

const run: GitRun = (directory, args) => execFileSync('git', ['-C', directory, ...args],
  { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })

/** The paths of the initialized submodules (and theirs) of a work tree; `git submodule status` marks an initialized one with ' ' or '+'. */
function submodules(directory: string, git: GitRun): string[] {
  let text: string
  try { text = git(directory, ['submodule', 'status', '--recursive']) } catch { return [] }
  return text.split(/\r?\n/).flatMap(line => {
    if (!line || line[0] === '-' || line[0] === 'U') return []
    const relative = line.slice(1).trim().split(/\s+/)[1]
    return relative ? [path.join(directory, relative)] : []
  })
}

/** Why one work tree's work is not on the remote, or undefined when it is. */
function unpublishedIn(directory: string, label: string, git: GitRun): string | undefined {
  const dirty = git(directory, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean)
  if (dirty.length) return `${label}: ${dirty.length} uncommitted change(s), such as ${dirty[0]!.trim()}; commit them`
  const detached = git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD'
  const containing = git(directory, ['branch', '-r', '--contains', 'HEAD']).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.includes('->'))
  // A detached submodule HEAD is the pinned commit; it only needs to exist on some remote branch.
  if (!containing.length) return `${label}: HEAD ${git(directory, ['rev-parse', '--short', 'HEAD']).trim()} is in no remote branch${detached ? ' (detached)' : ''}; push it`
  return undefined
}

/**
 * The reason a ticket's work is not published, or undefined when it is. A ticket without a directory, or one that is no git
 * work tree, has nothing to publish. A git failure is itself a reason: an unreadable tree is not proof of publication.
 */
export function unpublishedReason(directory: string | undefined, git: GitRun = run): string | undefined {
  if (!directory || !existsSync(directory)) return undefined
  try {
    if (git(directory, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return undefined
  } catch { return undefined }
  try {
    // Submodules first: their commits are pushed before the parent's pointer to them is committed, so this is the order to act in.
    for (const module of submodules(directory, git)) {
      const reason = unpublishedIn(module, `submodule ${path.relative(directory, module).replaceAll('\\', '/')}`, git)
      if (reason) return reason
    }
    return unpublishedIn(directory, 'worktree', git)
  } catch (error) {
    return `git could not prove the work is published: ${error instanceof Error ? error.message.trim().split(/\r?\n/)[0] : String(error)}`
  }
}
