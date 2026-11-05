/** Opt-in host-managed design confirmation; workflow labels are NOT OS authentication. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { latestAssignment, type Ticket } from './model.ts'

const RelativeDocument = z.string().min(1).max(1000).refine(value =>
  !value.includes('\\') && !value.includes(':') && !/[\x00-\x1f\x7f]/.test(value)
  && !path.posix.isAbsolute(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..'),
'Expected a portable workspace-relative document path without traversal')
export const DesignConfigurationRequest = z.discriminatedUnion('required', [
  z.object({ required: z.literal(false) }).strict(),
  z.object({ required: z.literal(true), scope: z.string().trim().min(1).max(10_000), documentPath: RelativeDocument }).strict(),
])
export const DesignApprovalRequest = z.object({
  assignmentId: z.string().min(1), operatorId: z.string().trim().min(1).max(200),
}).strict()
export type DesignConfiguration = z.infer<typeof DesignConfigurationRequest>
export type DesignApprovalInput = z.infer<typeof DesignApprovalRequest>
export interface DesignSignature {
  ticketId: string
  assignmentId: string
  workspace: string
  scope: string
  documentPath: string
  documentDigest: string
  revision: string
  operatorId: string
  at: string
  recordedBy: 'management-operator'
}
export type DesignApproval = DesignConfiguration & { revision: string; approval?: DesignSignature; blocked?: string }

/** Check every component (including workspace ancestors); reject symlinks/junctions and hard-linked documents. */
function linkFree(absolute: string): string {
  for (let cursor = absolute;;) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Design confirmation: links are not permitted')
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const canonical = realpathSync(absolute)
  const same = process.platform === 'win32' ? canonical.toLowerCase() === absolute.toLowerCase() : canonical === absolute
  if (!same) throw new Error('Design confirmation: realpath mismatch')
  return canonical
}
/** Bind only the selected design document, not implementation sources or the entire workspace. */
export function designBinding(ticket: Ticket) {
  const design = ticket.designApproval
  const assignment = latestAssignment(ticket)
  if (!design?.required || !assignment || !ticket.execution?.directory) throw new Error('Design confirmation: missing contract, assignment or workspace')
  DesignConfigurationRequest.parse({ required: true, scope: design.scope, documentPath: design.documentPath })
  if (!path.isAbsolute(ticket.execution.directory)) throw new Error('Design confirmation: workspace must be absolute')
  const workspace = linkFree(path.resolve(ticket.execution.directory))
  if (!lstatSync(workspace).isDirectory()) throw new Error('Design confirmation: workspace must be a directory')
  const document = linkFree(path.join(workspace, ...design.documentPath.split('/')))
  const info = lstatSync(document)
  if (!info.isFile() || info.nlink !== 1) throw new Error('Design confirmation: document must be a link-free regular file')
  return { ticketId: ticket.id, assignmentId: assignment.id, workspace, scope: design.scope,
    documentPath: design.documentPath, documentDigest: createHash('sha256').update(readFileSync(document)).digest('hex') }
}
export function assertTicketDesignApproved(ticket: Ticket, assignmentId?: string): void {
  const design = ticket.designApproval
  if (!design?.required) return
  const signature = design.approval
  if (!signature || signature.recordedBy !== 'management-operator' || !signature.operatorId?.trim()
    || signature.revision !== design.revision) throw new Error('Design confirmation: missing operator approval')
  const binding = designBinding(ticket)
  if (assignmentId !== undefined && assignmentId !== binding.assignmentId) throw new Error('Design confirmation: stale assignment')
  for (const key of Object.keys(binding) as (keyof typeof binding)[]) {
    if (signature[key] !== binding[key]) throw new Error('Design confirmation: stale document, scope, ticket or assignment; operator must re-sign')
  }
}
