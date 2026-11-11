/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { DELIVERY_LEVELS, liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  /** Absent by default; do not advertise an unconfigured delivery target to workers. */
  readonly deliveryEnabled?: boolean
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'> & Partial<Pick<EngineForExecutor,
    'runTicketTests' | 'recordVisual' | 'deliverTicket' | 'acquireEditor' | 'releaseEditor'>>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly lifetime?: AbortSignal
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  const runningAssignment = () => {
    const assignment = host.store.tickets.get(ticketId)?.assignments.find(item => item.state === 'running')
    if (!assignment) throw new Error('No running assignment for this ticket')
    return assignment.id
  }
  const combined = (signal: AbortSignal) => host.lifetime ? AbortSignal.any([signal, host.lifetime]) : signal
  return [
    tool({
      name: 'orchestrator_run_tests',
      description: 'Run the current ticket’s trusted strict acceptance tests in a real subprocess. No worker commands or result assertions are accepted. Changing source or tests invalidates evidence.',
      schema: z.object({}).strict(),
      execute: async (_args, signal) => {
        if (!host.engine.runTicketTests) throw new Error('Strict validation runner unavailable')
        return host.engine.runTicketTests(ticketId, runningAssignment(), combined(signal))
      },
    }),
    tool({
      name: 'orchestrator_acquire_editor',
      description: 'Take the exclusive TP editor lock before starting the editor, PIE, CQTest or the TPMcp port; fails naming the holder, so keep working on files and ask later. Not needed to edit, commit or push.',
      schema: z.object({}).strict(),
      execute: async () => {
        if (!host.engine.acquireEditor) throw new Error('Editor lock unavailable')
        return host.engine.acquireEditor(ticketId)
      },
    }),
    tool({
      name: 'orchestrator_release_editor',
      description: 'Give the TP editor lock back when done with the editor, after closing any editor you started yourself; a ticket end releases it too.',
      schema: z.object({}).strict(),
      execute: async () => {
        if (!host.engine.releaseEditor) throw new Error('Editor lock unavailable')
        return host.engine.releaseEditor(ticketId)
      },
    }),
    tool({
      name: 'orchestrator_record_visual',
      description: 'Record the visual acceptance you performed. Capture with the project editor’s own screenshot tool and read the frames yourself; the host does not capture or judge. It stores your verdict and verifies each frame still hashes to what you reported.',
      schema: z.object({
        verdict: z.enum(['passed', 'failed']).describe('Your verdict.'),
        reason: z.string().min(1).max(2000).describe('Why, checkable against the frames.'),
        frames: z.array(z.object({
          path: z.string().min(1).describe('Frame path, workspace-relative or absolute.'),
          sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).describe('sha256 of the file you read.'),
        }).strict()).max(20).describe('Frames judged; a pass needs one.'),
      }).strict(),
      execute: async (args, _signal) => {
        if (!host.engine.recordVisual) throw new Error('Visual recording unavailable')
        return host.engine.recordVisual(ticketId, runningAssignment(), args)
      },
    }),
    ...host.deliveryEnabled ? [tool({
      name: 'orchestrator_request_delivery',
      description: 'Request one independently operator-authorized commit, push or release for this ticket. Defaults are off. '
        + 'The host verifies current assignment, authorized version, strict test/visual evidence and current exclusivity; '
        + 'ready grants nothing. Reuse request_id on transport retries. No commands, targets, grants or result assertions are accepted.',
      schema: z.object({ level: z.enum(DELIVERY_LEVELS), request_id: z.string().min(1).max(200) }).strict(),
      execute: async args => {
        if (!host.engine.deliverTicket) throw new Error('Delivery runner unavailable')
        return host.engine.deliverTicket(ticketId, runningAssignment(), args.level, args.request_id)
      },
    })] : [],
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
