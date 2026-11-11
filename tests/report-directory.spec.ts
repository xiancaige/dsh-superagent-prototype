/**
 * A reply too long for the IM is sent as a summary, and its full text is written beside the project. That file must land in the
 * project's git-ignored `.temp`, never in a tracked folder: a loose `AICraft/` once blocked a ticket's completion (its worktree
 * read as having uncommitted changes) and invited a pointless commit.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { REPORT_DIRECTORY } from '../src/app/outbox.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

/** A local-panel reply: Feishu refuses an over-long reply before the file is written, the panel takes it as a summary. */
const panel = { source: 'local', thread: 'local:report-directory', address: {} }

let h: Host
let workspace: string
let saved: string | undefined
beforeEach(async () => {
  saved = process.env.DSH_SUPERAGENT_WORKSPACE
  workspace = mkdtempSync(join(tmpdir(), 'dsh-report-dir-'))
  process.env.DSH_SUPERAGENT_WORKSPACE = workspace
  h = await startRuntime()
})
afterEach(async () => {
  await h.stop()
  if (saved === undefined) delete process.env.DSH_SUPERAGENT_WORKSPACE; else process.env.DSH_SUPERAGENT_WORKSPACE = saved
  rmSync(workspace, { recursive: true, force: true })
})

it('writes the full text of a long reply under .temp, and creates no AICraft folder', async () => {
  const long = Array.from({ length: 300 }, (_, i) => `词${i}`).join(' ')
  h.runtime.outbox.send({ id: 'long', channel: panel, text: long, kind: 'reply', ticketId: 'abcdef0123456789' })
  const file = join(workspace, '.temp', 'superagent-reports', 'ticket-abcdef01-report.md')
  expect(REPORT_DIRECTORY.replaceAll('\\', '/')).toBe('.temp/superagent-reports')
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('词299')
  expect(existsSync(join(workspace, 'AICraft'))).toBe(false)
})

it('writes nothing for a short reply', () => {
  h.runtime.outbox.send({ id: 'short', channel: panel, text: '已合并。', kind: 'reply', ticketId: 'abcdef0123456789' })
  expect(existsSync(join(workspace, '.temp'))).toBe(false)
  expect(existsSync(join(workspace, 'AICraft'))).toBe(false)
})
