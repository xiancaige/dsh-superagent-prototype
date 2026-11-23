/** Periodic Feishu intermediate progress synchronization for long-running tickets. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeStretchStartMs, collectProgressSnapshot, formatProgressSyncMessage } from '../src/app/progress-sync.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { IM_WORDS, wordCount } from '../src/infra/text.ts'
import { KV } from '../src/kv.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { sourceContext } from '../src/sources/host.ts'
import { localKind } from '../src/sources/local.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

function setFeishuInterval(host: Host, seconds: number): void {
  const settings = host.runtime.store.settings()
  const feishuSource = settings.sources.feishu!
  host.runtime.store.saveSettings({
    ...settings,
    sources: {
      ...settings.sources,
      feishu: { ...feishuSource, config: { ...feishuSource.config, progressIntervalSeconds: seconds } },
    },
  })
}

function larkMessages(): string[] {
  return vi.mocked(Commands.prototype.lark).mock.calls
    .map(([args]) => args)
    .filter(args => args.includes('+messages-reply') || args.includes('+messages-send'))
    .map(args => {
      const idx = args.indexOf('--markdown')
      return idx >= 0 ? String(args[idx + 1] ?? '') : ''
    })
}

describe('Feishu periodic progress sync', () => {
  it('stays silent before interval, then periodically syncs worker progress, live jobs, and session activity to Feishu within IM_WORDS', async () => {
    h = await startRuntime()
    setFeishuInterval(h, 180)
    const { ticket, sessionId } = await h.acceptedTicket(feishu('101', '@bot 实现长任务进度同步并跑完测试'))
    const startedMs = Date.parse(h.runtime.store.tickets.get(ticket.id)!.assignments[0]!.startedAt!)
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockClear()

    // Before 180s: short tasks receive no periodic progress notice.
    await h.runtime.progressSync.tick(startedMs + 60_000)
    await h.runtime.sendReplies()
    expect(larkMessages()).toEqual([])

    // Worker submits a milestone progress report before a slow step.
    await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: '已完成核心模块改造，准备运行单测验证' })
    await h.runtime.progressSync.tick(startedMs + 185_000)
    await h.runtime.sendReplies()
    const firstBatch = larkMessages()
    expect(firstBatch).toHaveLength(1)
    expect(firstBatch[0]).toContain(ticket.id.slice(0, 8))
    expect(firstBatch[0]).toContain('已完成核心模块改造')
    expect(wordCount(firstBatch[0]!)).toBeLessThanOrEqual(IM_WORDS)
    expect(h.runtime.store.get(KV.feishu.progressSync(ticket.id))).toMatchObject({ syncCount: 1 })

    // Not yet due again at +250s (only 65s since last sync).
    lark.mockClear()
    await h.runtime.progressSync.tick(startedMs + 250_000)
    await h.runtime.sendReplies()
    expect(larkMessages()).toEqual([])

    // Simulate live session events + a running background job for the 2nd interval without another orchestrator_report.
    const agent = h.agents.get(sessionId)!
    const events = [
      { type: 'tool/call', seq: 1, time: startedMs + 200_000, data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'src/app/runtime.ts' }) } },
      { type: 'tool/result', seq: 2, time: startedMs + 201_000, data: { turn: 1, step: 1, message: { role: 'toolResult', toolCallId: 'c1', toolName: 'edit', content: [], isError: false } } },
      { type: 'assistant/message', seq: 3, time: startedMs + 210_000, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '正在执行打包与回归验证' }] }, stream: [] } },
      { type: 'tool/call', seq: 4, time: startedMs + 211_000, data: { turn: 1, step: 2, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ description: 'Run BuildCookRun Win64' }) } },
    ]
    ;(agent.session as unknown as { snapshotEvents(): unknown[] }).snapshotEvents = () => events
    h.jobs.run(sessionId, 'BuildCookRun TP Win64')

    await h.runtime.progressSync.tick(startedMs + 370_000)
    await h.runtime.sendReplies()
    const secondBatch = larkMessages()
    expect(secondBatch).toHaveLength(1)
    expect(secondBatch[0]).toContain('正在执行打包与回归验证')
    expect(secondBatch[0]).toContain('BuildCookRun TP Win64')
    expect(wordCount(secondBatch[0]!)).toBeLessThanOrEqual(IM_WORDS)
    expect(h.runtime.store.get(KV.feishu.progressSync(ticket.id))).toMatchObject({ syncCount: 2 })
  })

  it('does not spam while waiting on human action, blocked, idle, paused, or disabled, and cleans KV when ticket ends', async () => {
    h = await startRuntime()
    setFeishuInterval(h, 60)
    const { ticket, sessionId } = await h.acceptedTicket(feishu('102', '@bot 检查配置'))
    const startedMs = Date.parse(h.runtime.store.tickets.get(ticket.id)!.assignments[0]!.startedAt!)
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockClear()

    // Asking human_action moves ticket to person/answer stage -> progress sync must stay quiet.
    await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: '需要确认分支', human_action: '是否同步推送远端？' })
    await h.runtime.progressSync.tick(startedMs + 120_000)
    await h.runtime.sendReplies()
    expect(larkMessages()).toEqual([])

    // Clear question and go back to working, then test pause and interval=0 disablement.
    await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: '继续处理', human_action: null })
    await h.runtime.settings.pause(true, 'panel')
    await h.runtime.progressSync.tick(startedMs + 120_000)
    await h.runtime.sendReplies()
    expect(larkMessages()).toEqual([])

    await h.runtime.settings.pause(false, 'panel')
    setFeishuInterval(h, 0)
    await h.runtime.progressSync.tick(startedMs + 120_000)
    await h.runtime.sendReplies()
    expect(larkMessages()).toEqual([])

    // Re-enable interval, trigger one sync, then complete ticket and verify KV cleanup.
    setFeishuInterval(h, 60)
    await h.runtime.progressSync.tick(startedMs + 120_000)
    await h.runtime.sendReplies()
    expect(larkMessages()).toHaveLength(1)
    expect(h.runtime.store.get(KV.feishu.progressSync(ticket.id))).toBeDefined()

    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '已完成全部检查' })
    await h.runtime.idle()
    expect(h.runtime.store.get(KV.feishu.progressSync(ticket.id))).toBeUndefined()
  })

  it('skips sending a new sync notice if the previous progress sync receipt is still pending in outbox', async () => {
    h = await startRuntime()
    setFeishuInterval(h, 60)
    const { ticket } = await h.acceptedTicket(feishu('103', '@bot 长任务测试'))
    const startedMs = Date.parse(h.runtime.store.tickets.get(ticket.id)!.assignments[0]!.startedAt!)
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValue(new Error('temporary feishu network timeout'))

    await h.runtime.progressSync.tick(startedMs + 70_000)
    expect(h.runtime.store.get(KV.feishu.progressSync(ticket.id))?.syncCount).toBe(1)
    // Wait without flushing or while receipt stays pending -> 2nd tick must not pile up another message.
    await h.runtime.progressSync.tick(startedMs + 200_000)
    expect(h.runtime.store.get(KV.feishu.progressSync(ticket.id))?.syncCount).toBe(1)
    expect(h.runtime.store.receipts.list().filter(item => item.ticketId === ticket.id && item.kind === 'notice')).toHaveLength(1)
  })

  it('mirrors periodic progress sync to the operator Feishu topic for local-panel tickets', async () => {
    h = await startRuntime()
    setFeishuInterval(h, 60)
    h.runtime.sources.register(localKind(sourceContext(h.runtime, { kind: 'local', health: [] })))
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({
      ...settings,
      policy: { ...settings.policy, sources: { ...settings.policy.sources, local: { allowed: [{ id: 'operator' }], admission: {} } } },
      sources: { ...settings.sources, local: { enabled: true, config: {} } },
    })
    const localTrigger: Trigger = {
      id: 'local:message:m-progress',
      source: 'local',
      threads: [{ source: 'local', id: 'topic-progress' }],
      actor: { source: 'local', id: 'operator' },
      human: true,
      addressed: 'direct',
      at: new Date().toISOString(),
      text: '优化本地长任务同步',
      channel: { source: 'local', thread: 'topic-progress', address: { thread: 'topic-progress' } },
      meta: { messageId: 'm-progress' },
    }
    const { ticket } = await h.acceptedTicket(localTrigger)
    const startedMs = Date.parse(h.runtime.store.tickets.get(ticket.id)!.assignments[0]!.startedAt!)
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockClear()
    lark.mockImplementation(async args => (args.includes('+messages-send') ? { message_id: 'om_mirror_root', chat_id: 'oc_dm' } : {}) as never)

    await h.runtime.progressSync.tick(startedMs + 90_000)
    await h.runtime.sendReplies()
    const calls = lark.mock.calls.map(([args]) => args)
    expect(calls.some(args => args.includes('+messages-send') && args.includes('--user-id'))).toBe(true)
    expect(calls.some(args => args.includes('+messages-reply') && args.includes('om_mirror_root'))).toBe(true)
  })

  it('resets active stretch anchor after idle/resume and summarizes snapshot cleanly in English and Chinese', () => {
    const ticket = {
      id: 'abcdef1234567890',
      title: 'Fix very long build pipeline ' + 'extra '.repeat(30),
      inputs: [],
    } as unknown as Ticket
    const assignment = {
      id: 'a1',
      state: 'running' as const,
      createdAt: '2026-11-23T00:00:00.000Z',
      startedAt: '2026-11-23T00:00:00.000Z',
      idleAt: '2026-11-23T00:01:00.000Z',
      deliveredAt: '2026-11-23T00:20:00.000Z',
    }
    expect(activeStretchStartMs(ticket, assignment)).toBe(Date.parse('2026-11-23T00:20:00.000Z'))

    const snapshot = collectProgressSnapshot({
      ticket,
      assignment,
      events: [
        { type: 'tool/call', seq: 1, time: Date.parse('2026-11-23T00:21:00.000Z'), data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ description: 'Run full test suite' }) } },
      ] as never,
      jobs: [],
      subagentsCount: 0,
      startedMs: Date.parse('2026-11-23T00:00:00.000Z'),
      sinceMs: Date.parse('2026-11-23T00:20:00.000Z'),
      nowMs: Date.parse('2026-11-23T00:25:00.000Z'),
      chinese: false,
    })
    const message = formatProgressSyncMessage(ticket, snapshot, false)
    expect(message).toContain('abcdef12')
    expect(message).toContain('Run full test suite')
    expect(wordCount(message)).toBeLessThanOrEqual(IM_WORDS)
  })
})
