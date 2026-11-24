/** Unregister only a missing, ended ticket workspace; never delete directories or session history. */
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'

const canonical = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

/** Re-read ticket ownership after I/O: a resumed ticket or another live owner must keep its registration. */
export async function unregisterMissingWorkspace(registry: {
  list(): readonly Pick<Workspace, 'id' | 'path'>[]; delete(id: WorkspaceId): Promise<boolean>
},
  tickets: Pick<Store['tickets'], 'get' | 'open'>, ticket: Ticket, sourceRoot?: string, stat = lstat): Promise<number> {
  const directory = ticket.execution?.directory
  if (!ticket.ended || !directory || !isAbsolute(directory)) return 0
  const path = canonical(directory)
  if (sourceRoot && path === canonical(sourceRoot)) return 0
  // lstat preserves dangling symlinks, files and inaccessible paths: only ENOENT proves absence.
  try { await stat(directory); return 0 }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const stillEnded = () => {
    const current = tickets.get(ticket.id)
    return current?.ended?.at === ticket.ended!.at && current.execution?.directory === directory
      && !tickets.open().some(other => other.execution?.directory && canonical(other.execution.directory) === path)
  }
  let deleted = 0
  for (const workspace of registry.list()) {
    if (canonical(workspace.path) !== path || !stillEnded()) continue
    if (await registry.delete(workspace.id)) deleted++
  }
  return deleted
}
