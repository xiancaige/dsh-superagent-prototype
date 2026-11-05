import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Report-validating Unreal CQTest adapter (TODO68 gap 4, option A).
 *
 * The host does NOT launch Unreal. A trusted script (BuildScripts/run-cqtest) runs the tests while the ticket holds the
 * TP environment lock, and writes Unreal's own `index.json`. This module only reads that file and accepts it as evidence
 * when ALL of the following hold, each of which fails closed:
 *
 *  - the report path is a real, link-free file under the ticket workspace's `Saved/Automation/TestReport/`;
 *  - it parses as Unreal's report: a non-empty `tests` array whose per-state counts equal the declared root counts
 *    (same rules as BuildScripts/validate-cqtest-report.py, the single source this mirrors);
 *  - it was created at or after the assignment started (`reportCreatedOn`, and the file mtime), so a report left by an
 *    earlier run or an earlier assignment can never be reused;
 *  - every required test id is present with state `Success` (no warnings-as-pass, no duplicates);
 *  - nothing is Fail / NotRun / InProcess and no test reports errors.
 *
 * Limits, stated plainly: this proves a well-formed Unreal report with the required passes exists and is fresh. It does
 * not prove that the host ran the tests, that the assertions are meaningful, or that the running editor loaded the code
 * under test. A worker that can write the report file can forge it; the freshness window plus the workspace fingerprint
 * only bound accidental reuse, not a malicious same-user writer (same boundary as the other adapters).
 */
export const CQTEST_REPORT_RELATIVE = 'Saved/Automation/TestReport/index.json'
export const CQTEST_ID = /^TP(?:\.[A-Za-z0-9_]+){1,8}$/
const PASS_STATES = new Set(['Success', 'SuccessWithWarnings'])
const KNOWN_STATES = new Set([...PASS_STATES, 'Fail', 'NotRun', 'InProcess'])
const ROOT_FIELDS: Record<string, string> = {
  Success: 'succeeded', SuccessWithWarnings: 'succeededWithWarnings', Fail: 'failed', NotRun: 'notRun', InProcess: 'inProcess',
}
const MAX_REPORT_BYTES = 8 * 1024 * 1024
/** Unreal writes `reportCreatedOn` in UTC (`2026.11.02-07.10.32`; verified against real reports: it equals the file mtime in UTC, not local time). Allow clock granularity only. */
export const CQTEST_CLOCK_SKEW_MS = 2_000

export interface CqtestReport {
  readonly completed: true
  readonly testsRun: number
  readonly failures: number
  readonly errors: number
  readonly skipped: number
  readonly successfulTestIds: readonly string[]
  readonly reportCreatedOn: string
  readonly reportMtimeMs: number
  readonly reportSha256: string
}
export interface CqtestRead { readonly report?: CqtestReport; readonly reasons: readonly string[] }

/** `2026.11.02-07.10.32` -> epoch ms. The stamp is UTC. Undefined when malformed. */
export function parseReportStamp(stamp: unknown): number | undefined {
  if (typeof stamp !== 'string') return undefined
  const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$/.exec(stamp)
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const value = Date.UTC(y, mo - 1, d, h, mi, s)
  const back = new Date(value)
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? value : undefined
}

/** Absolute, link-free path of the report inside the workspace, or throws. */
export function resolveReportPath(workspace: string): string {
  const root = realpathSync(workspace)
  let cursor = path.join(root, ...CQTEST_REPORT_RELATIVE.split('/'))
  const target = cursor
  for (;;) {
    if (cursor === root) break
    let info
    try { info = lstatSync(cursor) } catch { return target }
    if (info.isSymbolicLink()) throw new Error(`CQTest report path crosses a link: ${path.relative(root, cursor)}`)
    cursor = path.dirname(cursor)
  }
  return target
}

/**
 * Read and validate the Unreal report. ``notBeforeMs`` is the assignment start (host clock); a report older than that is
 * rejected as reused. The report stamp is UTC, so no timezone conversion is applied.
 */
export function readCqtestReport(workspace: string, notBeforeMs: number): CqtestRead {
  const reasons: string[] = []
  let file: string
  try { file = resolveReportPath(workspace) } catch (error) { return { reasons: [String((error as Error).message)] } }
  let info
  try { info = statSync(file) } catch { return { reasons: ['CQTest report is missing'] } }
  if (!info.isFile()) return { reasons: ['CQTest report is not a regular file'] }
  if (info.size === 0 || info.size > MAX_REPORT_BYTES) return { reasons: [`CQTest report size ${info.size} is outside the accepted bounds`] }
  let raw: Buffer
  let data: unknown
  try {
    raw = readFileSync(file)
    data = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))
  } catch { return { reasons: ['CQTest report is not valid JSON'] } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { reasons: ['CQTest report root must be an object'] }
  const root = data as Record<string, unknown>
  const tests = root.tests
  if (!Array.isArray(tests) || tests.length === 0) return { reasons: ['CQTest report tests must be a non-empty array'] }

  const counts: Record<string, number> = { Success: 0, SuccessWithWarnings: 0, Fail: 0, NotRun: 0, InProcess: 0 }
  const successful: string[] = []
  let errors = 0
  for (const test of tests) {
    const t = test as Record<string, unknown>
    if (!t || typeof t.fullTestPath !== 'string' || typeof t.state !== 'string' || !t.fullTestPath || !t.state) {
      return { reasons: ['every CQTest entry needs fullTestPath and state'] }
    }
    if (!KNOWN_STATES.has(t.state)) { reasons.push(`unknown CQTest state: ${t.state}`); continue }
    const warnings = typeof t.warnings === 'number' ? t.warnings : 0
    const failed = typeof t.errors === 'number' ? t.errors : 0
    errors += failed
    if (t.state === 'Success' && warnings > 0) counts.SuccessWithWarnings!++
    else counts[t.state]!++
    // Warnings are tolerated by Unreal itself, but any error entry on a passing state contradicts it.
    if (t.state === 'Success' && failed === 0) successful.push(t.fullTestPath)
    else if (t.state === 'SuccessWithWarnings' && failed === 0) successful.push(t.fullTestPath)
    else if (PASS_STATES.has(t.state) && failed > 0) reasons.push(`${t.fullTestPath} reports ${failed} error(s) despite state ${t.state}`)
  }
  for (const [state, field] of Object.entries(ROOT_FIELDS)) {
    const declared = root[field] ?? 0
    if (!Number.isSafeInteger(declared) || declared !== counts[state]) reasons.push(`${field}=${String(declared)} does not match the listed tests (${counts[state]})`)
  }
  if (counts.Fail! > 0 || counts.NotRun! > 0 || counts.InProcess! > 0 || errors > 0) {
    reasons.push(`CQTest not clean: Fail=${counts.Fail} NotRun=${counts.NotRun} InProcess=${counts.InProcess} errors=${errors}`)
  }
  if (new Set(successful).size !== successful.length) reasons.push('duplicate passing CQTest ids')

  const stamp = parseReportStamp(root.reportCreatedOn)
  if (stamp === undefined) reasons.push('CQTest report has no valid reportCreatedOn')
  else {
    if (stamp + CQTEST_CLOCK_SKEW_MS < notBeforeMs) reasons.push('CQTest report predates the current assignment (stale report)')
  }
  if (info.mtimeMs + CQTEST_CLOCK_SKEW_MS < notBeforeMs) reasons.push('CQTest report file predates the current assignment (stale file)')

  const sha = createHash('sha256').update(raw).digest('hex')
  if (reasons.length) return { reasons }
  return {
    reasons,
    report: {
      completed: true, testsRun: tests.length, failures: counts.Fail!, errors, skipped: counts.NotRun!,
      successfulTestIds: Object.freeze([...successful].sort()), reportCreatedOn: String(root.reportCreatedOn),
      reportMtimeMs: info.mtimeMs, reportSha256: sha,
    },
  }
}

export const validCqtestId = (id: unknown): id is string => typeof id === 'string' && CQTEST_ID.test(id)
