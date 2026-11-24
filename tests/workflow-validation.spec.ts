import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Ticket } from '../src/core/model.ts'
import { captureWorkflow, observeWorkflow, workflowReason, WorkflowPolicySchema, type WorkflowSnapshot } from '../src/app/workflow-validation.ts'
import { lifecycleHarness } from './fixtures/lifecycle-harness.ts'
import { startRuntime, feishu } from './fixtures/host.ts'
import { createValidationContract, runValidation } from '../src/validation.ts'

vi.setConfig({ testTimeout: 90_000 })
const roots: string[] = []
const scratch = () => { const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-workflow-'))); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
function repository() {
  const root = scratch()
  git(root, 'init', '-b', 'main')
  mkdirSync(path.join(root, '.dsh')); mkdirSync(path.join(root, 'tools'))
  writeFileSync(path.join(root, 'rules.md'), 'first\nsecond\n')
  writeFileSync(path.join(root, 'tools/a.ts'), 'initial')
  writeFileSync(path.join(root, '.dsh/workflow-validation.json'), JSON.stringify({ version: 1, rules: [
    { id: 'tools', paths: ['tools/'], taskIncludes: ['audit tools'], reads: ['rules.md'], skills: ['verify'] },
  ] }))
  git(root, 'add', '.'); git(root, 'commit', '-m', 'seed')
  const snapshot = captureWorkflow(root, root)!
  const ticket = { title: 'change', mandate: { scope: 'small' }, execution: { directory: root, assignment: '', workflow: snapshot } } as Ticket
  return { root, snapshot, ticket }
}
let callId = 0
function result(snapshot: WorkflowSnapshot, root: string, name: string, args: unknown, text: string, error = false) {
  const id = String(++callId)
  observeWorkflow(snapshot, root, { type: 'tool/call', data: { callId: id, name, arguments: JSON.stringify(args) } } as SessionEvent)
  observeWorkflow(snapshot, root, { type: 'tool/result', data: { message: { toolCallId: id, isError: error, content: [{ type: 'text', text }] } } } as unknown as SessionEvent)
}
function read(snapshot: WorkflowSnapshot, root: string, body: string) {
  result(snapshot, root, 'read', { file_path: 'rules.md' }, `<path>${path.join(root, 'rules.md')}</path>\n${body}`)
}
function skill(snapshot: WorkflowSnapshot, root: string) {
  result(snapshot, root, 'skill', { name: 'verify' }, '<skill_content name="verify">full skill</skill_content>')
}

describe('host workflow evidence', () => {
  it('persists actual Runtime Session events and blocks the registered report tool until loads arrive', async () => {
    const h = await startRuntime()
    try {
      const { root, snapshot } = repository()
      const { ticket, sessionId } = await h.acceptedTicket(feishu('workflow', '@bot audit tools'))
      h.runtime.store.atomic(() => {
        const stored = h.runtime.store.tickets.get(ticket.id)!
        stored.title = 'audit tools'
        stored.execution!.directory = root
        stored.execution!.workflow = snapshot
        h.runtime.store.tickets.save(stored)
      })
      await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done' })).rejects.toThrow('requires skill verify')
      const emit = (name: string, args: unknown, text: string) => {
        const id = String(++callId)
        h.ctx.emit('session/event', { id: sessionId } as never, { type: 'tool/call', data: { callId: id, name, arguments: JSON.stringify(args) } } as never)
        h.ctx.emit('session/event', { id: sessionId } as never, { type: 'tool/result', data: { message: { toolCallId: id, content: [{ type: 'text', text }] } } } as never)
      }
      emit('skill', { name: 'verify' }, '<skill_content name="verify">loaded</skill_content>')
      emit('read', { file_path: 'rules.md' }, `<path>${path.join(root, 'rules.md')}</path>\n1: first\n2: second`)
      expect(h.runtime.store.tickets.get(ticket.id)!.execution!.workflow!.skills).toEqual(['verify'])
      await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done' })
      expect(h.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
    } finally { await h.stop() }
  })
  it('requires related CQTest evidence for committed game code, rejects missing/wrong/stale reports and accepts bound evidence', async () => {
    const { root, ticket, snapshot } = repository()
    snapshot.policy.cqtestPaths = ['Source/', 'Plugins/']
    ticket.assignments = [{ id: 'a1', startedAt: new Date(Date.now() - 60_000).toISOString() }] as Ticket['assignments']
    mkdirSync(path.join(root, 'Source'))
    writeFileSync(path.join(root, 'Source/A.cpp'), 'int a;')
    git(root, 'add', 'Source'); git(root, 'commit', '-m', 'game code')
    expect(workflowReason(ticket)).toContain('related test contract required')
    const trusted = scratch(); const executable = path.join(trusted, 'validator.py'); writeFileSync(executable, '# validator')
    const contract = createValidationContract({ adapter: 'cqtest-report', executable, workspace: root, requiredTestIds: ['TP.Related'], revision: 'r1' })
    ticket.validation = { enabled: true, contract }
    expect(workflowReason(ticket)).toContain('passing regression report evidence required')
    const binding = { ticketId: 't1', assignmentId: 'a1', workspace: root, contractRevision: 'r1', assignmentStartedAt: ticket.assignments[0]!.startedAt! }
    ticket.id = 't1'
    ticket.validation.evidence = await runValidation(contract, binding)
    expect(workflowReason(ticket)).toContain('did not pass')
    const reportDir = path.join(root, 'Saved/Automation/TestReport'); mkdirSync(reportDir, { recursive: true })
    writeFileSync(path.join(root, '.gitignore'), 'Saved/\n')
    writeFileSync(path.join(root, 'TP.uproject'), '{}')
    const save = (id: string) => writeFileSync(path.join(reportDir, 'index.json'), JSON.stringify({
      reportCreatedOn: new Date().toISOString().slice(0, 19).replace(/-/g, '.').replace('T', '-').replace(/:/g, '.'),
      succeeded: 1, tests: [{ fullTestPath: id, state: 'Success', errors: 0 }],
    }))
    save('TP.Unrelated')
    ticket.validation.evidence = await runValidation(contract, binding)
    expect(workflowReason(ticket)).toContain('did not pass')
    save('TP.Related')
    ticket.validation.evidence = await runValidation(contract, binding)
    expect(workflowReason(ticket)).toBeUndefined()
    writeFileSync(path.join(root, 'Source/A.cpp'), 'int changed;')
    expect(workflowReason(ticket)).toContain('stale')
    // A different report cannot replace the one whose digest the host recorded.
    ticket.validation.evidence = await runValidation(contract, binding)
    save('TP.Other')
    expect(workflowReason(ticket)).toContain('report changed')
  })
  it('does not require CQTest for tooling-only code or non-code game files', () => {
    const { root, ticket, snapshot } = repository()
    snapshot.policy.cqtestPaths = ['Source/']
    mkdirSync(path.join(root, 'Source')); writeFileSync(path.join(root, 'Source/readme.md'), 'docs')
    expect(workflowReason(ticket)).toBeUndefined()
    writeFileSync(path.join(root, 'unrelated.ts'), 'tooling')
    expect(workflowReason(ticket)).toBeUndefined()
  })
  it('ignores upstream game-code commits brought in via rebase and push when the ticket itself changed no cqtestPaths', () => {
    const remote = scratch()
    git(remote, 'init', '--bare', '-b', 'main')
    const peer = scratch()
    git(peer, 'clone', remote, '.')
    mkdirSync(path.join(peer, '.dsh'))
    mkdirSync(path.join(peer, 'tools'))
    writeFileSync(path.join(peer, 'tools/a.ts'), 'initial')
    writeFileSync(path.join(peer, '.dsh/workflow-validation.json'), JSON.stringify({
      version: 1,
      cqtestPaths: ['Source/'],
      rules: [],
    }))
    git(peer, 'add', '.'); git(peer, 'commit', '-m', 'seed')
    git(peer, 'push', '-u', 'origin', 'main')

    // Ticket worktree clones/checks out at seed.
    const worktree = scratch()
    git(worktree, 'clone', remote, '.')
    git(worktree, 'checkout', '-b', 'agent/tooling-fix')
    const snapshot = captureWorkflow(worktree, worktree)!
    const ticket = {
      title: 'tooling fix',
      mandate: { scope: 'small' },
      execution: { directory: worktree, assignment: '', workflow: snapshot },
    } as Ticket

    // Meanwhile another teammate pushes a C++ game change to origin/main.
    mkdirSync(path.join(peer, 'Source'))
    writeFileSync(path.join(peer, 'Source/Other.cpp'), 'int other = 1;')
    git(peer, 'add', 'Source'); git(peer, 'commit', '-m', 'unrelated upstream cpp')
    git(peer, 'push', 'origin', 'main')

    // Worker edits only tooling, rebases onto origin/main, and pushes HEAD:main.
    writeFileSync(path.join(worktree, 'tools/a.ts'), 'worker tooling edit')
    git(worktree, 'add', 'tools/a.ts'); git(worktree, 'commit', '-m', 'tooling edit')
    git(worktree, 'fetch', 'origin')
    git(worktree, 'rebase', 'origin/main')
    git(worktree, 'push', 'origin', 'HEAD:main')
    git(worktree, 'fetch', 'origin')

    // Upstream Source/Other.cpp must NOT trigger Workflow CQTest on this tooling ticket.
    expect(workflowReason(ticket)).toBeUndefined()

    // Even when a worker did NOT push to origin/main yet (only rebased onto origin/main), upstream Source/Other.cpp must NOT trigger CQTest.
    const unpushed = scratch()
    git(unpushed, 'clone', remote, '.')
    git(unpushed, 'checkout', '-b', 'agent/unpushed-tooling', 'HEAD~2')
    const snapshotUnpushed = captureWorkflow(unpushed, unpushed)!
    const ticketUnpushed = {
      title: 'unpushed tooling',
      mandate: { scope: 'small' },
      execution: { directory: unpushed, assignment: '', workflow: snapshotUnpushed },
    } as Ticket
    writeFileSync(path.join(unpushed, 'tools/b.ts'), 'worker tooling edit 2')
    git(unpushed, 'add', 'tools/b.ts'); git(unpushed, 'commit', '-m', 'tooling edit 2')
    git(unpushed, 'fetch', 'origin')
    git(unpushed, 'rebase', 'origin/main')
    expect(workflowReason(ticketUnpushed)).toBeUndefined()

    // Still triggers CQTest if the worker itself modifies Source/*.cpp after rebase.
    mkdirSync(path.join(unpushed, 'Source'), { recursive: true })
    writeFileSync(path.join(unpushed, 'Source/Mine.cpp'), 'int mine = 1;')
    git(unpushed, 'add', 'Source/Mine.cpp'); git(unpushed, 'commit', '-m', 'my cpp edit')
    expect(workflowReason(ticketUnpushed)).toContain('Workflow CQTest (Source/Mine.cpp)')
  })
  it('has no extra contract without a policy and rejects malformed/path-escaping policies', () => {
    expect(captureWorkflow(scratch(), scratch())).toBeUndefined()
    expect(WorkflowPolicySchema.safeParse({ version: 1, repositories: ['../other'], rules: [] }).success).toBe(false)
    expect(WorkflowPolicySchema.safeParse({ version: 1, rules: [{ id: 'bad' }] }).success).toBe(false)
  })
  it('detects shell-written, staged, committed and untracked changes against the frozen baseline', () => {
    const { root, snapshot, ticket } = repository()
    expect(workflowReason(ticket)).toBeUndefined()
    writeFileSync(path.join(root, 'tools/a.ts'), 'shell edit')
    expect(workflowReason(ticket)).toContain('tools/a.ts')
    git(root, 'add', '.'); git(root, 'commit', '-m', 'worker change')
    expect(workflowReason(ticket)).toContain('requires skill verify')
    read(snapshot, root, '1: first\n2: second'); skill(snapshot, root)
    expect(workflowReason(ticket)).toBeUndefined()
    writeFileSync(path.join(root, 'tools/new.ts'), 'new')
    snapshot.skills = []
    expect(workflowReason(ticket)).toContain('requires skill verify')
  })
  it('requires complete successful read coverage, rejects errors, stale content and shell claims', () => {
    const { root, snapshot, ticket } = repository()
    ticket.title = 'audit tools without edits'
    result(snapshot, root, 'pwsh', { command: 'read rules.md' }, '1: first\n2: second')
    result(snapshot, root, 'skill', { name: 'verify' }, '<skill_content name="verify"></skill_content>', true)
    expect(workflowReason(ticket)).toContain('task:audit tools')
    expect(snapshot.skills).toEqual([])
    read(snapshot, root, '1: first'); skill(snapshot, root)
    expect(workflowReason(ticket)).toContain('full read rules.md')
    read(snapshot, root, '2: second')
    expect(workflowReason(ticket)).toBeUndefined()
    writeFileSync(path.join(root, 'rules.md'), 'first\nchanged\n')
    expect(workflowReason(ticket)).toContain('full read rules.md')
    read(snapshot, root, '2: changed')
    expect(workflowReason(ticket)).toBeUndefined()
    expect(workflowReason(ticket, () => { throw new Error('git unavailable') })).toContain('could not verify')
  })
  it('scans explicitly declared ignored independent repositories', () => {
    const { root, ticket } = repository()
    const nested = path.join(root, 'ignored'); mkdirSync(nested)
    git(nested, 'init', '-b', 'main'); writeFileSync(path.join(nested, 'a.ts'), 'seed')
    git(nested, 'add', '.'); git(nested, 'commit', '-m', 'seed')
    writeFileSync(path.join(root, '.gitignore'), 'ignored/\n')
    writeFileSync(path.join(root, '.dsh/workflow-validation.json'), JSON.stringify({ version: 1, repositories: ['ignored'], rules: [
      { id: 'nested', paths: ['ignored/'], skills: ['nested-skill'] },
    ] }))
    ticket.execution!.workflow = captureWorkflow(root, root)
    writeFileSync(path.join(nested, 'a.ts'), 'shell change')
    expect(workflowReason(ticket)).toContain('nested (ignored/a.ts) requires skill nested-skill')
  })
  it('finds initialized nested submodule changes even after worker commits', () => {
    const { root, ticket } = repository()
    const child = scratch(); git(child, 'init', '-b', 'main')
    writeFileSync(path.join(child, 'a.ts'), 'seed'); git(child, 'add', '.'); git(child, 'commit', '-m', 'seed')
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'tools/nested')
    git(root, 'commit', '-am', 'submodule')
    ticket.execution!.workflow = captureWorkflow(root, root)
    const nested = path.join(root, 'tools/nested')
    writeFileSync(path.join(nested, 'a.ts'), 'committed shell edit')
    git(nested, 'commit', '-am', 'worker edit')
    expect(workflowReason(ticket)).toContain('requires skill verify')
  })
  it('refuses ready (including implementation) atomically, allows blocked and passes after evidence', () => {
    let reason: string | undefined = 'Workflow validation: tools/a requires skill verify'
    const h = lifecycleHarness(scratch(), { workflow: () => reason })
    const id = h.accept('workflow'); h.settle()
    expect(() => h.ready(id)).toThrow('requires skill verify')
    expect(() => h.engine.report(id, { state: 'ready', completion: 'implementation', summary: 'trust me' })).toThrow('requires skill verify')
    expect(h.repo.tickets.get(id)?.ended).toBeUndefined()
    h.engine.report(id, { state: 'blocked', summary: 'missing skill' })
    reason = undefined
    expect(h.ready(id).ended?.outcome).toBe('completed')
  })
})
