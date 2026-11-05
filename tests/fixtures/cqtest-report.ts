/**
 * Shared CQTest acceptance fixture.
 *
 * The project's own `BuildScripts/run-cqtest` launches Unreal and writes
 * `Saved/Automation/TestReport/index.json`; the host only validates that file. These helpers write a
 * report with Unreal's exact shape so tests exercise the real validator instead of a stand-in.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CQTEST_PASSING_ID = 'TP.Editor.UiDsl.ApplyGateRejectsNonPatchable'

/** `2026.11.05-05.00.13` (UTC, Unreal's format) for a Date. */
export function reportStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}.${pad(date.getUTCMinutes())}.${pad(date.getUTCSeconds())}`
}

export interface ReportOptions {
  /** Passing test ids; defaults to one known-good CQTest id. */
  passing?: readonly string[]
  /** Test ids written with state Fail. */
  failing?: readonly string[]
  /** Stamp written into the report; defaults to now. */
  at?: Date
}

/** Write an Unreal-shaped report under `<workspace>/Saved/Automation/TestReport/index.json`. */
export function writeCqtestReport(workspace: string, options: ReportOptions = {}): { path: string; sha256: string; ids: string[] } {
  const passing = [...(options.passing ?? [CQTEST_PASSING_ID])]
  const failing = [...(options.failing ?? [])]
  const at = options.at ?? new Date()
  const tests = [
    ...passing.map(id => ({ testDisplayName: id.split('.').pop(), fullTestPath: id, tags: [], state: 'Success',
      deviceInstance: ['DEVICE'], duration: 0.001, dateTime: reportStamp(at), entries: [], warnings: 0, errors: 0, artifacts: [] })),
    ...failing.map(id => ({ testDisplayName: id.split('.').pop(), fullTestPath: id, tags: [], state: 'Fail',
      deviceInstance: ['DEVICE'], duration: 0.001, dateTime: reportStamp(at), entries: [], warnings: 0, errors: 1, artifacts: [] })),
  ]
  const report = { devices: [{ instance: 'DEVICE', platform: 'WindowsEditor', osVersion: '10' }], reportCreatedOn: reportStamp(at),
    succeeded: passing.length, succeededWithWarnings: 0, failed: failing.length, notRun: 0, inProcess: 0,
    totalDuration: 0.001, comparisonExported: false, comparisonExportDirectory: '', tests }
  const text = JSON.stringify(report, null, 2)
  const directory = join(workspace, 'Saved', 'Automation', 'TestReport')
  mkdirSync(directory, { recursive: true })
  const path_ = join(directory, 'index.json')
  writeFileSync(path_, text)
  return { path: path_, sha256: createHash('sha256').update(text).digest('hex'), ids: [...passing, ...failing] }
}
