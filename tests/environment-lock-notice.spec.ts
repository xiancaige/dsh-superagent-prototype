import { afterEach, describe, expect, it } from 'vitest'
import { environmentLockNotices, isEnvironmentLockSummary } from '../src/app/notices.ts'
import { wordCount, IM_WORDS } from '../src/infra/text.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { githubChannel } from '../src/sources/github-trigger.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

describe('environment lock Feishu notices', () => {
  it('detects environment, editor, and compile-restart lock summaries', () => {
    expect(isEnvironmentLockSummary('EnvironmentHeld: TP environment is held by ticket Foo (1234abcd)')).toBe(true)
    expect(isEnvironmentLockSummary('编译流程被占用。检测到共享引擎被其他工单 (cqtest) 的编辑器进程 (pid=7928) 占用')).toBe(true)
    expect(isEnvironmentLockSummary('Blocked by TPCompileRestart.lock held by pid 1234')).toBe(true)
    expect(isEnvironmentLockSummary('Missing API credentials from operator')).toBe(false)
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
})
