/** Host-owned workflow gate: frozen repository policy + Git deltas + successful Session tool results.
 * This proves delivery of required material to the worker, not comprehension or independent review.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Ticket } from '../core/model.ts'

const relative = z.string().min(1).refine(value => !path.isAbsolute(value) && !value.includes('\\')
  && !value.split('/').includes('..') && !value.includes(':'), 'Use a workspace-relative forward-slash path')
const Rule = z.object({
  id: z.string().min(1),
  paths: z.array(relative).default([]),
  taskIncludes: z.array(z.string().min(1)).default([]),
  reads: z.array(relative).default([]),
  skills: z.array(z.string().min(1)).default([]),
}).strict().refine(rule => rule.paths.length > 0 || rule.taskIncludes.length > 0, 'A rule needs a path or task selector')
export const WorkflowPolicySchema = z.object({
  version: z.literal(1),
  repositories: z.array(relative).default([]),
  rules: z.array(Rule),
}).strict()
export type WorkflowPolicy = z.infer<typeof WorkflowPolicySchema>
export interface WorkflowSnapshot {
  policy: WorkflowPolicy
  repositories: { root: string; head: string }[]
  /** Line coverage from successful read results, never the worker's report. */
  reads: Record<string, Record<string, string>>
  skills: string[]
  calls: Record<string, { name: string; arguments: string }>
}
const POLICY = '.dsh/workflow-validation.json'
export type WorkflowGit = (directory: string, args: string[]) => string
const git: WorkflowGit = (directory, args) => execFileSync('git', ['-C', directory, ...args], {
  encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
})
const slash = (value: string) => value.replaceAll('\\', '/')
const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/** Read policy only from the host-resolved source checkout, never worker-supplied paths. */
export function captureWorkflow(source: string, workspace: string, run: WorkflowGit = git): WorkflowSnapshot | undefined {
  const file = path.join(source, POLICY)
  if (!existsSync(file)) return undefined
  const policy = WorkflowPolicySchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  const repositories: WorkflowSnapshot['repositories'] = []
  const visit = (root: string) => {
    if (repositories.some(repo => repo.root === root)) return
    const directory = path.resolve(workspace, root)
    if (!inside(realpathSync(workspace), realpathSync(directory))) throw new Error(`Workflow repository escapes workspace: ${root}`)
    const head = run(directory, ['rev-parse', '--verify', 'HEAD']).trim()
    repositories.push({ root, head })
    // Gitlinks are authoritative, including nested submodules; use NUL records for paths containing spaces.
    for (const entry of run(directory, ['ls-files', '--stage', '-z']).split('\0')) {
      if (!entry.startsWith('160000 ')) continue
      const child = entry.slice(entry.indexOf('\t') + 1)
      if (existsSync(path.join(directory, child, '.git'))) visit(slash(path.join(root, child)))
    }
  }
  visit('.')
  for (const root of policy.repositories) visit(root)
  return { policy, repositories, reads: {}, skills: [], calls: {} }
}

/** Observe exact call/result pairs from this worker Session. Error, invented report and shell output are not evidence. */
export function observeWorkflow(snapshot: WorkflowSnapshot, workspace: string, event: SessionEvent): void {
  if (event.type === 'tool/call') {
    if (event.data.name === 'read' || event.data.name === 'skill') snapshot.calls[event.data.callId] = {
      name: event.data.name, arguments: event.data.arguments,
    }
    return
  }
  if (event.type !== 'tool/result') return
  const message = event.data.message
  const call = snapshot.calls[message.toolCallId]
  if (!call) return
  delete snapshot.calls[message.toolCallId]
  if (message.isError) return
  let args: { name?: string; file_path?: string }
  try { args = JSON.parse(call.arguments) } catch { return }
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  if (call.name === 'skill') {
    if (args.name && text.includes(`<skill_content name="${args.name}">`) && text.includes('</skill_content>')) {
      if (!snapshot.skills.includes(args.name)) snapshot.skills.push(args.name)
    }
  } else if (args.file_path) {
    const renderedPath = text.match(/^<path>([^\r\n]+)<\/path>/)?.[1]
    if (!renderedPath || !path.isAbsolute(renderedPath)) return
    const absolute = path.resolve(workspace, args.file_path)
    if (!inside(workspace, absolute)) return
    try { if (realpathSync(absolute) !== realpathSync(renderedPath)) return } catch { return }
    const key = slash(path.relative(workspace, absolute))
    const lines = Object.fromEntries([...text.matchAll(/^(\d+): (.*)$/gm)].map(match => [match[1]!, match[2]!]))
    snapshot.reads[key] = { ...snapshot.reads[key], ...lines }
  }
}

/** Refuse with the rule and the exact path/task that triggered it. Git errors fail closed. */
export function workflowReason(ticket: Ticket, run: WorkflowGit = git): string | undefined {
  const snapshot = ticket.execution?.workflow
  if (!snapshot) return undefined // deployments with no repository policy keep their existing contract
  const workspace = ticket.execution!.directory
  try {
    const changed = new Set<string>()
    for (const repo of snapshot.repositories) {
      const directory = path.resolve(workspace, repo.root)
      if (!inside(realpathSync(workspace), realpathSync(directory))) throw new Error(`Repository escapes workspace: ${repo.root}`)
      const files = run(directory, ['diff', '--name-only', '--no-renames', '-z', repo.head, '--'])
        + run(directory, ['ls-files', '--others', '--exclude-standard', '-z'])
      for (const file of files.split('\0').filter(Boolean)) changed.add(slash(path.join(repo.root, file)))
    }
    const task = `${ticket.title}\n${ticket.mandate.scope}\n${ticket.execution!.assignment}`.toLowerCase()
    const missing: string[] = []
    for (const rule of snapshot.policy.rules) {
      const file = [...changed].find(file => rule.paths.some(prefix => file === prefix || file.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)))
      const term = rule.taskIncludes.find(term => task.includes(term.toLowerCase()))
      if (!file && !term) continue
      const why = `${rule.id} (${file ?? `task:${term}`})`
      for (const skill of rule.skills) if (!snapshot.skills.includes(skill)) missing.push(`${why} requires skill ${skill}`)
      for (const read of rule.reads) {
        const absolute = path.resolve(workspace, read)
        if (!inside(realpathSync(workspace), realpathSync(absolute))) throw new Error(`Required read escapes workspace: ${read}`)
        const text = readFileSync(absolute, 'utf8')
        const lines = text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []
        const coverage = snapshot.reads[read]
        if (!coverage || lines.some((line, index) => coverage[String(index + 1)] !== line)) {
          missing.push(`${why} requires full read ${read}`)
        }
      }
    }
    return missing.length ? `Workflow validation: ${missing.join('; ')}` : undefined
  } catch (error) { return `Workflow validation could not verify Git/read evidence: ${String(error)}` }
}
