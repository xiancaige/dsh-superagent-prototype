import { afterEach, describe, expect, it } from 'vitest'
import { environmentLockNotices, isEnvironmentLockSummary } from '../src/app/notices.ts'
import { wordCount, IM_WORDS } from '../src/infra/text.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { githubChannel } from '../src/sources/github-trigger.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

describe('environment lock Feishu notices', () => {
  it('detects environment, editor, compile-restart, and source-checkout lock summaries', () => {
    expect(isEnvironmentLockSummary('EnvironmentHeld: TP environment is held by ticket Foo (1234abcd)')).toBe(true)
    expect(isEnvironmentLockSummary('编译流程被占用。检测到共享引擎被其他工单 (cqtest) 的编辑器进程 (pid=7928) 占用')).toBe(true)
    expect(isEnvironmentLockSummary('Blocked by TPCompileRestart.lock held by pid 1234')).toBe(true)
    expect(isEnvironmentLockSummary('Error: The prepare command failed: source checkout is busy (D:\\TP\\.git\\tp-source-operation.lock): {"token":"t","pid":9116,"ticket":"d01b579d340ed009","at":"2026-11-24T05:34:41.695Z"}')).toBe(true)
    expect(isEnvironmentLockSummary('Missing API credentials from operator')).toBe(false)
  })

  it('formats source-checkout lock notices concisely within the word limit', () => {
    const ticket = {
      id: '8144c9525e92dd5006358103be6f8b69',
      title: '将肉鸽三选一超时自动选择改为按阶段时长动态预留 1 秒触发',
      channels: [feishuChannel('oc_team', 'om_1', true)],
    } as never
    const reason = 'Error: The prepare command failed: source checkout is busy (D:\\TP\\.git\\tp-source-operation.lock): {"token":"t","pid":9116,"ticket":"d01b579d340ed0090e3f56eef5806f85","at":"2026-11-24T05:34:41.695Z"}'
    const messages = environmentLockNotices(ticket, '进度', reason, { assignmentId: 'a1' })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('8144c952')
    expect(messages[0]!.text).toContain('d01b579d')
    expect(messages[0]!.text).toContain('9116')
    expect(wordCount(messages[0]!.text)).toBeLessThanOrEqual(IM_WORDS)
  })

  it('formats concise IM notices within the word limit and skips GitHub channels', () => {
    const ticket = {
      id: 'cadb21d165fdb0509197ef9eb4e1e713',
      title: '源工程同步最新代码、编译并重启 DSH',
      channels: [feishuChannel('oc_team', 'om_1', true), githubChannel(42)],
    } as never
    const reason = 'TP environment block: TP environment is held by ticket 处理 TODO 6 (18ba2b1608ab28b096a8badca00c2d95) (Session pid 10120) since 2026-11-16T14:39:30.445Z; waiting, idle time and a restart do not release it'
    const messages = environmentLockNotices(ticket, '同步最新代码并重启', reason, { assignmentId: 'a1' })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.channel.source).toBe('feishu')
    expect(messages[0]!.kind).toBe('notice')
    expect(messages[0]!.text).toContain('cadb21d1')
    expect(messages[0]!.text).toContain('18ba2b1608ab28b096a8badca00c2d95')
    expect(messages[0]!.text).toContain('10120')
    expect(wordCount(messages[0]!.text)).toBeLessThanOrEqual(IM_WORDS)
  })

  it('notifies Feishu once per assignment/holder when orchestrator_acquire_editor is refused', async () => {
    h = await startRuntime(undefined, {
      environmentMode: 'editor',
      environment: {
        recoveryEnabled: true,
        projectFile: 'D:/TP/TP.uproject',
        editorExe: 'D:/UnrealEngine/Engine/Binaries/Win64/UnrealEditor.exe',
        mcpPort: 55255,
        captureTool: 'CaptureWidgetBlueprintScreenshot',
        captureToolset: 'TPEditor.TPEditorToolset',
        waitSeconds: 300,
      },
    })
    const first = await h.acceptedTicket(feishu('1', '@bot run PIE check'))
    const second = await h.acceptedTicket(feishu('2', '@bot 同步重启编辑器'))
    expect(await h.runTool(first.sessionId, 'orchestrator_acquire_editor', {})).toEqual({ held: true })
    await expect(h.runTool(second.sessionId, 'orchestrator_acquire_editor', {})).rejects.toThrow(/held by ticket/)
    await expect(h.runTool(second.sessionId, 'orchestrator_acquire_editor', {})).rejects.toThrow(/held by ticket/)
    await h.runtime.idle()
    const notices = h.runtime.store.receipts.list().filter(item => item.ticketId === second.ticket.id && item.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.channel.source).toBe('feishu')
    expect(notices[0]!.text).toContain(first.ticket.id)
  })

  it('notifies Feishu when a worker reports blocked on a shared-engine lock without human_action, and warns for non-lock blocked reports', async () => {
    h = await startRuntime()
    const lockTicket = await h.acceptedTicket(feishu('1', '@bot 编译并重启 DSH'))
    const reported = await h.runTool(lockTicket.sessionId, 'orchestrator_report', {
      state: 'blocked',
      summary: '编译流程被占用。检测到共享引擎被其他工单 (cqtest-full-regression-3c0b84cf) 的编辑器进程 (pid=7928) 占用，无法执行清理与重启。',
    })
    expect(reported).toMatchObject({ reported: true, lock_notification: 'queued' })
    // Repeating the same blocked summary for the same assignment deduplicates the Feishu notice.
    await h.runTool(lockTicket.sessionId, 'orchestrator_report', {
      state: 'blocked',
      summary: '编译流程被占用。检测到共享引擎被其他工单 (cqtest-full-regression-3c0b84cf) 的编辑器进程 (pid=7928) 占用，无法执行清理与重启。',
    })
    await h.runtime.idle()
    const lockNotices = h.runtime.store.receipts.list().filter(item => item.ticketId === lockTicket.ticket.id && item.kind === 'notice')
    expect(lockNotices).toHaveLength(1)
    expect(lockNotices[0]!.channel.source).toBe('feishu')
    expect(lockNotices[0]!.text).toContain('环境锁阻塞')

    const nonLockTicket = await h.acceptedTicket(feishu('2', '@bot 查询配置'))
    const nonLockReport = await h.runTool(nonLockTicket.sessionId, 'orchestrator_report', {
      state: 'blocked',
      summary: 'Waiting for credentials configuration.',
    })
    expect(nonLockReport).toMatchObject({ reported: true, warning: expect.stringContaining('human_action') })
    expect(nonLockReport).not.toHaveProperty('lock_notification')
    const nonLockNotices = h.runtime.store.receipts.list().filter(item => item.ticketId === nonLockTicket.ticket.id && item.kind === 'notice')
    expect(nonLockNotices).toHaveLength(0)
  })

  it('notifies Feishu, surfaces unanswered_triggers, and permits orchestrator_reply purpose=answer on terminal model/prepare failures', async () => {
    h = await startRuntime()
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修复知识库加载'))
    const agent = h.agents.get(sessionId)!
    const followup = feishu('2', '进度', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(followup)
    await h.runtime.idle()

    h.ctx.emit('agent/error', { agent, error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) } as never)
    await h.runtime.idle()

    const notices = h.runtime.store.receipts.list().filter(item => item.ticketId === ticket.id && item.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toContain(ticket.id.slice(0, 8))
    expect(notices[0]!.text).toContain('ECONNRESET')

    const relay = h.relays(h.runtime.masterId).findLast(item => item.kind === 'worker_report') as { unanswered_triggers?: { trigger_id: string }[] }
    expect(relay.unanswered_triggers).toEqual([expect.objectContaining({ trigger_id: followup.id })])

    await expect(h.runTool(h.runtime.masterId, 'orchestrator_reply', {
      ticket_id: ticket.id,
      trigger_id: followup.id,
      purpose: 'answer',
      text: '知识库工单因模型连接 ECONNRESET 暂停，已保留已有修改，等待重试。',
    })).resolves.toEqual({ status: 'sent' })
  })
})
