import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Executable index of plans/todo/superagent-phase2-acceptance.md "A 测试门禁（必测）" and of the four items the
 * first Phase-2-A review returned. It runs nothing itself: each row names the real spec file and the exact title
 * of the test that covers the scenario, and fails if that test is renamed away or deleted. A passing row here means
 * "a named test exists"; whether the scenario passes is that test's own result, run in the same suite.
 */
const here = dirname(fileURLToPath(import.meta.url))
const cache = new Map<string, string>()
const source = (file: string) => {
  if (!cache.has(file)) cache.set(file, readFileSync(join(here, file), 'utf8'))
  return cache.get(file)!
}

interface Row { scenario: string; file: string; title: string }
const MATRIX: Row[] = [
  { scenario: '01 未开启 strict 的历史工单保持旧行为', file: 'strict-validation.spec.ts', title: 'keeps legacy tickets without validation backward compatible, including after SQLite restore' },
  { scenario: '02 strict 已启用但无契约/无证据 ready 拒绝', file: 'strict-validation.spec.ts', title: 'rejects ready with %s, without saving a ready report' },
  { scenario: '03 过滤器零用例', file: 'node-validation.spec.ts', title: 'rejects missing required IDs and never discovers ambient tests on an empty file list' },
  { scenario: '04 用例失败/错误/跳过', file: 'strict-validation.spec.ts', title: 'does not accept a worker success summary when the actual Python case fails' },
  { scenario: '05 必需测试未包含', file: 'node-validation.spec.ts', title: 'rejects missing required IDs and never discovers ambient tests on an empty file list' },
  { scenario: '06 worker 伪造通过数/exit0/伪报告不作为证据', file: 'strict-validation.spec.ts', title: 'ignores forged worker report counts and evidence instead of treating them as a host run' },
  { scenario: '07 证据归属其他工单/旧 assignment 拒绝', file: 'strict-validation.spec.ts', title: 'rejects repository-tampered evidence bound to the wrong %s' },
  { scenario: '08 改源码/测试/增删文件使指纹变化', file: 'validation.spec.ts', title: 'fingerprints all source extensions and file names but excludes fixed generated caches/reports' },
  { scenario: '09 取消/超时不能通过', file: 'node-validation.spec.ts', title: 'cancels before launch and while running; timeout fails closed' },
  { scenario: '10 测试期间修改（前后内容一致性）', file: 'node-validation.spec.ts', title: 'detects writes during validation' },
  // Parameterised: it.each([... ['forged stdout', ...] ...])('rejects %s'). Require both the template and the forged-stdout case row.
  { scenario: '11 输出含伪造 Passed/OK 不被采信 (模板)', file: 'node-validation.spec.ts', title: "])('rejects %s', async (_name, source, testsRun)" },
  { scenario: '11 输出含伪造 Passed/OK 不被采信 (伪造 stdout 用例行)', file: 'node-validation.spec.ts', title: "['forged stdout', `console.log(JSON.stringify({completed:true" },
  { scenario: '12 目录越界/符号链接拒绝', file: 'validation.spec.ts', title: 'rejects workspace links, ancestor links, executable links and links escaping a tree' },
  { scenario: '13 PR threadClosed 等其他成功终态与 ready 同守卫', file: 'strict-validation.spec.ts', title: 'rejects threadClosed(%s) as a validation bypass' },
  { scenario: '14a stopped/dropped 保持非成功语义（dropped 清理但不发布结果）', file: 'strict-validation.spec.ts', title: 'allows ordinary strict dropped cleanup but refuses an unvalidated result publication' },
  { scenario: '14b 人工 stop 不发布结果', file: 'strict-validation.spec.ts', title: 'allows a person to stop strict work without tests but does not publish a result' },
  { scenario: '15 重启恢复后契约与证据持久并重新核验', file: 'strict-validation.spec.ts', title: 'restores contract and green evidence from actual SQLite and still checks current files' },
  { scenario: '16 当前版本必需测试通过放行并留下证据', file: 'strict-validation.spec.ts', title: 'runs current real Python tests, persists host evidence, and permits ready and result' },
]
const RETURNED: Row[] = [
  { scenario: 'A-退回1 旧 assignment 的运行请求', file: 'strict-validation.spec.ts', title: 'invalidates green evidence on retry and rejects a run requested by the old assignment' },
  { scenario: 'A-退回2 取消向运行中进程传递', file: 'validation.spec.ts', title: 'rejects cancellation before launch and during a running real process' },
  { scenario: 'A-退回2 取消后不保留成功证据', file: 'strict-validation.spec.ts', title: 'does not retain successful evidence when a host run is cancelled' },
  { scenario: 'A-退回3 子孙进程持有 stdio 时超时收敛 (Python)', file: 'validation.spec.ts', title: 'bounds timeout when a real descendant inherits Python output pipes' },
  { scenario: 'A-退回3 子孙进程持有 stdio 时超时收敛 (Node)', file: 'node-validation.spec.ts', title: 'bounds timeout and kills a descendant retaining inherited output pipes' },
  { scenario: 'A-退回4 htmlcov/报告目录内的源码仍计入指纹', file: 'validation.spec.ts', title: 'fingerprints imported source within %s' },
]
const has = (row: Row) => source(row.file).includes(row.title)

describe('Phase 2 A acceptance matrix is backed by named tests', () => {
  it.each(MATRIX)('$scenario', row => { expect(has(row), `${row.file} lacks "${row.title}"`).toBe(true) })
  it('covers all 16 scenarios of the matrix (14 has two parts)', () => {
    const numbers = new Set(MATRIX.map(row => row.scenario.slice(0, 2)))
    expect([...numbers].sort()).toEqual(Array.from({ length: 16 }, (_, index) => String(index + 1).padStart(2, '0')))
  })
})
describe('the four returned Phase 2 A items are backed by named tests', () => {
  it.each(RETURNED)('$scenario', row => { expect(has(row), `${row.file} lacks "${row.title}"`).toBe(true) })
  it('covers all four returned items', () => {
    expect(new Set(RETURNED.map(row => row.scenario.slice(0, 5)))).toEqual(new Set(['A-退回1', 'A-退回2', 'A-退回3', 'A-退回4']))
  })
})
