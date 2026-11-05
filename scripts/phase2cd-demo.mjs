#!/usr/bin/env node
/**
 * Phase 2 C+D local, user-style end-to-end demo with INDEPENDENT OS processes.
 *
 *   node scripts/phase2cd-demo.mjs [--state <absolute dir>]
 *
 * Every host (P1..P5) is a separate `node scripts/phase2cd-host.ts` process holding a real Engine, a real SQLite Store, the real
 * file-backed environment broker and the real SimulatedDelivery. Python tests are real `python -m unittest` runs through the
 * Engine's strict validation. Nothing is pushed, committed upstream, packaged or uploaded. Writes <state>/report.md and
 * <state>/evidence.json; exit code 0 only when every assertion is PASS.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Host } from './phase2cd-client.mjs'

const argIndex = process.argv.indexOf('--state')
const state = path.resolve(argIndex >= 0 ? process.argv[argIndex + 1] : mkdtempSync(path.join(tmpdir(), 'phase2cd-demo-')))
mkdirSync(state, { recursive: true })
const stateReal = realpathSync(state)

// ---------------------------------------------------------------- recording ----------------------------------------------------
const assertions = []
const commandLog = []
const leaseTimeline = []
const hosts = []
const notes = []
let scenario = ''
const text = value => value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value)
function check(name, expected, actual, pass, command = '') {
  assertions.push({ scenario, name, command, expected: text(expected), actual: text(actual).slice(0, 700), status: pass ? 'PASS' : 'FAIL' })
}
const eq = (name, expected, actual, command) => check(name, expected, actual, JSON.stringify(expected) === JSON.stringify(actual), command)
const truthy = (name, actual, command, expected = 'truthy') => check(name, expected, actual, !!actual, command)
const matches = (name, pattern, actual, command) => check(name, `matches ${pattern}`, actual, pattern.test(text(actual)), command)

async function start(name, stateDir = stateReal, extra = []) {
  const host = await Host.start(stateDir, extra)
  host.name = name
  hosts.push({ name, pid: host.pid, state: stateDir, args: extra, startedAt: new Date().toISOString(), resumed: host.ready.resumed })
  return host
}
async function run(host, cmd, args = {}) {
  const reply = await host.send(cmd, args)
  commandLog.push({ scenario, host: host.name, pid: host.pid, cmd, args, ok: reply.ok, outcome: text(reply.ok ? reply.result : reply.error).slice(0, 500) })
  return reply
}
async function must(host, cmd, args = {}) {
  const reply = await run(host, cmd, args)
  if (!reply.ok) throw new Error(`${host.name} ${cmd} failed: ${text(reply.error)}`)
  return reply.result
}
async function snap(label, host) {
  const view = await must(host, 'lease')
  const record = view.record
  leaseTimeline.push({ scenario, label, viaHost: host.name, viaPid: host.pid, holder: record?.holder?.id ?? null, kind: record?.holder?.kind ?? null,
    acquiredAt: record?.acquiredAt ?? null, token: record?.token ?? null, leasePid: record?.pid ?? null, facts: record?.facts ?? null })
  return record
}
const cmdText = (host, cmd, args) => `${host.name}(pid ${host.pid}) ${cmd} ${text(args ?? {})}`
const sameLease = (a, b) => !!a && !!b && a.token === b.token && a.acquiredAt === b.acquiredAt && a.pid === b.pid && a.holder.id === b.holder.id
const mentionsHolder = (reply, id) => !reply.ok && text(reply.error).includes(id)

// ---------------------------------------------------------------- fixtures -----------------------------------------------------
const answerPy = 'def answer():\n    return 42\n'
const testPy = 'import unittest\nfrom answer import answer\n\n\nclass Delivery(unittest.TestCase):\n    def test_answer(self):\n        self.assertEqual(answer(), 42)\n'
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Phase2CD Demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd, encoding: 'utf8' })
function plainWorkspace(name) {
  const directory = path.join(stateReal, 'workspaces', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'answer.py'), answerPy)
  writeFileSync(path.join(directory, 'test_delivery.py'), testPy)
  return realpathSync(directory)
}
const dirty = {
  trackedMark: 'TRACKED-MODIFICATION-MARK-7f3a',
  stagedName: 'staged_feature.txt', stagedBody: 'STAGED-FILE-LINE-a91c\nsecond staged line\n',
  untracked: [
    ['untracked_one.txt', 'UNTRACKED-ONE-LINE-1d2e\nplain text of the first untracked file\n'],
    ['untracked_two.md', '# UNTRACKED-TWO-HEADING-55b0\n\nbody of the second untracked file\n'],
    [path.join('sub', 'untracked_three.txt'), 'UNTRACKED-THREE-LINE-c4c4\n'],
  ],
  binary: 'blob.bin',
}
function gitWorkspace(name) {
  const directory = plainWorkspace(name)
  writeFileSync(path.join(directory, '.gitignore'), '__pycache__/\n*.pyc\n')
  writeFileSync(path.join(directory, 'notes.md'), 'original notes\n')
  git(directory, 'init', '-q'); git(directory, 'add', '.'); git(directory, 'commit', '-q', '-m', 'baseline')
  // A genuinely dirty scene: tracked modification (still passing), staged addition, untracked texts and one binary.
  writeFileSync(path.join(directory, 'answer.py'), `${answerPy}# ${dirty.trackedMark}\n`)
  writeFileSync(path.join(directory, dirty.stagedName), dirty.stagedBody); git(directory, 'add', dirty.stagedName)
  mkdirSync(path.join(directory, 'sub'), { recursive: true })
  for (const [file, body] of dirty.untracked) writeFileSync(path.join(directory, file), body)
  writeFileSync(path.join(directory, dirty.binary), Buffer.from([0, 1, 2, 3, 255, 254, 0, 0, 128, 64, 0, 7]))
  return directory
}
function walk(directory, base = directory, out = []) {
  for (const name of readdirSync(directory).sort()) {
    if (name === '.git' || name === '__pycache__') continue
    const full = path.join(directory, name)
    if (statSync(full).isDirectory()) walk(full, base, out)
    else out.push([path.relative(base, full).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(full)).digest('hex')])
  }
  return out
}
function scene(directory) {
  return { status: git(directory, 'status', '--porcelain=v1', '--untracked-files=all'), stash: git(directory, 'stash', 'list'),
    head: git(directory, 'rev-parse', 'HEAD').trim(), refs: git(directory, 'for-each-ref'), staged: git(directory, 'diff', '--cached', '--binary'),
    files: walk(directory) }
}
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const receiptList = directory => existsSync(directory) ? readdirSync(directory).sort() : []

// ---------------------------------------------------------------- scenarios ----------------------------------------------------
const live = []
const ctx = { receiptsDir: path.join(stateReal, 'delivery-simulation') }
async function main() {
  const pythonExe = execFileSync('python', ['-I', '-S', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
  notes.push(`Python for strict unittest: ${pythonExe}`)
  const wsA = gitWorkspace('A'), wsB = plainWorkspace('B')

  // ===== S1 ==========================================================================================================
  scenario = 'S1 accept + exclusivity refusals'
  const P1 = await start('P1'); live.push(P1)
  truthy('P1 is a separate OS process', P1.pid && P1.pid !== process.pid, 'spawn P1', `pid ${P1.pid} != demo pid ${process.pid}`)
  const acceptA = await must(P1, 'accept', { title: 'Ticket A: dirty scene', dir: wsA })
  const A = acceptA.ticketId
  eq('A accepted and holds the environment', { blocked: null, holds: true, holder: A, kind: 'ticket' },
    { blocked: acceptA.blocked, holds: acceptA.holds, holder: acceptA.lease.record?.holder.id, kind: acceptA.lease.record?.holder.kind }, cmdText(P1, 'accept', { dir: wsA }))
  const L0 = await snap('after A accept', P1)
  eq('lease pid is P1 (the Session that took it)', P1.pid, L0.pid, 'lease')
  const acceptB = await must(P1, 'accept', { title: 'Ticket B: waits for the environment', dir: wsB })
  const B = acceptB.ticketId
  truthy('B accept is blocked, naming holder A', acceptB.blocked && String(acceptB.blocked).includes(A), cmdText(P1, 'accept', { dir: wsB }), `blocked text names ${A}`)
  check('B does not hold', false, acceptB.holds, acceptB.holds === false, cmdText(P1, 'accept B'))
  const tryB = await run(P1, 'attempt-acquire', { ticketId: B, kind: 'ticket' })
  check('ticket B acquire refused and error names holder A', `error containing ${A}`, tryB.ok ? tryB.result : tryB.error, mentionsHolder(tryB, A), cmdText(P1, 'attempt-acquire', { ticketId: B }))
  const trySession = await run(P1, 'attempt-acquire', { ticketId: 'operator-main-session', kind: 'session', label: 'main session' })
  check('session-kind holder acquire refused and error names holder A', `error containing ${A}`, trySession.ok ? trySession.result : trySession.error, mentionsHolder(trySession, A), cmdText(P1, 'attempt-acquire', { kind: 'session' }))
  await must(P1, 'report', { ticketId: A, state: 'waiting' })
  const L1 = await snap('after report waiting', P1)
  check('lease unchanged after waiting report (token/acquiredAt/pid/holder)', text({ token: L0.token, acquiredAt: L0.acquiredAt }), text({ token: L1.token, acquiredAt: L1.acquiredAt }), sameLease(L0, L1), cmdText(P1, 'report waiting'))
  await must(P1, 'report', { ticketId: A, state: 'failed' })
  const L2 = await snap('after report failed', P1)
  check('lease unchanged after failed report', text({ token: L0.token, acquiredAt: L0.acquiredAt }), text({ token: L2.token, acquiredAt: L2.acquiredAt }), sameLease(L0, L2), cmdText(P1, 'report failed'))
  const stateA1 = await must(P1, 'state', { ticketId: A })
  eq('A is still a live ticket that holds the environment after waiting/failed', { ended: null, holds: true }, { ended: stateA1.ended, holds: stateA1.holds }, cmdText(P1, 'state', { ticketId: A }))

  // ===== S2 ==========================================================================================================
  scenario = 'S2 handover'
  const before = scene(wsA)
  const handover = await must(P1, 'handover', { ticketId: A })
  check('handover succeeded with an exported bundle and >= 2 files', 'handedOver && bundle && files>=2', handover, handover.handedOver === true && /worktree\.bundle$/.test(handover.export ?? '') && handover.files >= 2, cmdText(P1, 'handover', { ticketId: A }))
  const exportDir = path.dirname(handover.export)
  const exported = JSON.parse(readFileSync(path.join(exportDir, 'export.json'), 'utf8'))
  for (const file of exported.files) {
    const full = path.join(exportDir, file.path)
    check(`export.json digest of ${file.path} matches the file on disk`, file.sha256, existsSync(full) ? sha(full) : 'missing', existsSync(full) && sha(full) === file.sha256 && statSync(full).size === file.bytes, 'sha256 of export file')
  }
  eq('export.json lists worktree.patch and worktree.bundle', ['worktree.bundle', 'worktree.patch'], exported.files.map(file => file.path).sort(), 'export.json')
  const patch = readFileSync(path.join(exportDir, 'worktree.patch'), 'utf8')
  for (const [file, body] of dirty.untracked) {
    for (const line of body.split('\n').filter(Boolean)) truthy(`worktree.patch contains untracked ${file}: "${line}"`, patch.includes(line), 'read worktree.patch', 'patch includes the line')
  }
  truthy('worktree.patch contains the tracked modification', patch.includes(dirty.trackedMark), 'read worktree.patch')
  truthy('worktree.patch contains the staged file', patch.includes('STAGED-FILE-LINE-a91c'), 'read worktree.patch')
  truthy('worktree.patch carries the binary file as a git binary patch', patch.includes(dirty.binary) && patch.includes('GIT binary patch'), 'read worktree.patch')
  let verify = ''
  try { verify = git(wsA, 'bundle', 'verify', handover.export) + 'exit 0' } catch (error) { verify = `FAILED ${error.message}` }
  check('git bundle verify succeeds', 'exit 0', verify.slice(-120), verify.endsWith('exit 0'), `git bundle verify ${handover.export}`)
  let heads = ''
  try { heads = git(wsA, 'bundle', 'list-heads', handover.export) } catch (error) { heads = String(error) }
  truthy('bundle holds the snapshot commit', exported.snapshot && heads.includes(exported.snapshot), 'git bundle list-heads', `heads contain ${exported.snapshot}`)
  const after = scene(wsA)
  eq('git status (porcelain, all untracked) identical before/after handover', before.status, after.status, 'git status --porcelain')
  eq('no stash created', '', after.stash, 'git stash list')
  eq('HEAD, refs, staged diff and every file digest unchanged (no reset/clean)', { head: before.head, refs: before.refs, staged: before.staged, files: before.files },
    { head: after.head, refs: after.refs, staged: after.staged, files: after.files }, 'rev-parse / for-each-ref / diff --cached / file sha256')
  const L3 = await snap('after handover', P1)
  eq('lock released after handover', null, L3?.holder?.id ?? null, 'lease')
  const stateA2 = await must(P1, 'state', { ticketId: A })
  check('A no longer holds', false, stateA2.holds, stateA2.holds === false, cmdText(P1, 'state'))
  const enterB = await must(P1, 'ensure-env', { ticketId: B })
  eq('B enters after the release', { holds: true, holder: B }, { holds: enterB.holds, holder: enterB.lease.record?.holder.id }, cmdText(P1, 'ensure-env', { ticketId: B }))
  const LB = await snap('B holds', P1)

  // ===== S3 ==========================================================================================================
  scenario = 'S3 retry refused while B holds; B accepts; editor-stop failure'
  await must(P1, 'retry', { ticketId: A })
  const ensureA = await run(P1, 'ensure-env', { ticketId: A })
  check('A retry then ensure-env refused, error names holder B', `error containing ${B}`, ensureA.ok ? ensureA.result : ensureA.error, mentionsHolder(ensureA, B), cmdText(P1, 'ensure-env', { ticketId: A }))
  const LB2 = await snap('after A refused', P1)
  check('A did not steal: lease still B (same token/acquiredAt)', text({ holder: B, token: LB.token }), text({ holder: LB2.holder.id, token: LB2.token }), sameLease(LB, LB2) && LB2.holder.id === B, 'lease')
  await must(P1, 'configure-tests', { ticketId: B })
  const testsB = await must(P1, 'run-tests', { ticketId: B })
  check('B real unittest passed (testsRun 1, no failures)', 'passed, 1 run, 0 failures/errors/skips', testsB, testsB.passed && testsB.exitCode === 0 && testsB.testsRun === 1 && testsB.failures === 0 && testsB.errors === 0 && testsB.skipped === 0, cmdText(P1, 'run-tests', { ticketId: B }))
  await must(P1, 'fail-next-editor-stop')
  await must(P1, 'report', { ticketId: B, state: 'ready' })
  const stateB = await must(P1, 'state', { ticketId: B })
  eq('B completed (ready + passing acceptance)', 'completed', stateB.ended?.outcome, cmdText(P1, 'report ready', { ticketId: B }))
  check('B still holds the lock after the injected editor-stop failure', true, stateB.holds, stateB.holds === true, cmdText(P1, 'state', { ticketId: B }))
  const LB3 = await snap('B after failed editor stop', P1)
  check('lease is still B, unchanged', text({ holder: B, token: LB.token }), text({ holder: LB3?.holder?.id, token: LB3?.token }), !!LB3 && sameLease(LB, LB3), 'lease')
  const stubs1 = await must(P1, 'stubs')
  truthy('stub log records the failed editor stop for B', stubs1.editorStops.some(entry => entry === `FAILED:${B}`), 'stubs', `editorStops contains FAILED:${B}`)
  const ensureA2 = await run(P1, 'ensure-env', { ticketId: A })
  check('A is still refused while B (failed stop) holds', `error containing ${B}`, ensureA2.ok ? ensureA2.result : ensureA2.error, mentionsHolder(ensureA2, B), cmdText(P1, 'ensure-env', { ticketId: A }))
  await must(P1, 'fail-next-editor-stop')
  const releaseFail = await must(P1, 'release-ended', { ticketId: B })
  check('release-ended with a failing editor stop reports released:false and keeps the lock', 'released false + error, lease B', { released: releaseFail.released, error: releaseFail.error, holder: releaseFail.lease.record?.holder.id },
    releaseFail.released === false && !!releaseFail.error && releaseFail.lease.record?.holder.id === B, cmdText(P1, 'release-ended', { ticketId: B }))
  const releaseOk = await must(P1, 'release-ended', { ticketId: B })
  eq('release-ended again releases the environment', { released: true, holder: null }, { released: releaseOk.released, holder: releaseOk.lease.record?.holder.id ?? null }, cmdText(P1, 'release-ended', { ticketId: B }))
  await snap('after B released', P1)

  // ===== S4 ==========================================================================================================
  scenario = 'S4 A continues (C path), completes, D delivery'
  const enterA = await must(P1, 'ensure-env', { ticketId: A })
  eq('A ensure-env succeeds (continue path)', { holds: true, holder: A }, { holds: enterA.holds, holder: enterA.lease.record?.holder.id }, cmdText(P1, 'ensure-env', { ticketId: A }))
  const LA = await snap('A re-entered', P1)
  check('A new lease has a new token/acquiredAt vs. the first one', 'different token', { old: L0.token, new: LA.token }, LA.token !== L0.token && LA.acquiredAt !== L0.acquiredAt, 'lease')
  await must(P1, 'configure-tests', { ticketId: A })
  const testsA = await must(P1, 'run-tests', { ticketId: A })
  check('A real unittest passed over the dirty scene', 'passed, 1 run', testsA, testsA.passed && testsA.testsRun === 1 && testsA.failures === 0 && testsA.errors === 0, cmdText(P1, 'run-tests', { ticketId: A }))
  await must(P1, 'report', { ticketId: A, state: 'ready' })
  const stateA3 = await must(P1, 'state', { ticketId: A })
  eq('A completed and released after the editor stop', { outcome: 'completed', holds: false }, { outcome: stateA3.ended?.outcome, holds: stateA3.holds }, cmdText(P1, 'report ready', { ticketId: A }))
  const stubs2 = await must(P1, 'stubs')
  truthy('stub log records stopped:A editor stop', stubs2.editorStops.includes(`stopped:${A}`), 'stubs', `editorStops contains stopped:${A}`)
  const LA2 = await snap('A completed/released', P1)
  eq('lock released after completion', null, LA2?.holder?.id ?? null, 'lease')
  const noGrant = await must(P1, 'deliver', { ticketId: A, level: 'push', requestId: 'ungranted-1' })
  check('deliver without an operator grant is refused', 'refused with grant reason', noGrant, noGrant.refused === true && /grant/i.test((noGrant.reasons ?? []).join(';')), cmdText(P1, 'deliver', { requestId: 'ungranted-1' }))
  const stateA4 = await must(P1, 'state', { ticketId: A })
  check('refusal is audited in deliveryState().refusals', '>= 1 refusal for ungranted-1', stateA4.delivery.refusals, (stateA4.delivery.refusals ?? []).some(item => item.requestId === 'ungranted-1'), 'state')
  eq('no target execution and no receipt after the refusal', { executions: 0, receipts: 0 }, { executions: noGrant.targetExecutions, receipts: noGrant.receipts.length }, 'deliver')
  const reacquire = await must(P1, 'acquire-env', { ticketId: A })
  check('operator re-acquires the environment for the completed ticket (purpose delivery)', 'holds + facts.purpose=delivery', { holds: reacquire.holds, facts: reacquire.lease.record?.facts }, reacquire.holds === true && reacquire.lease.record?.facts?.purpose === 'delivery', cmdText(P1, 'acquire-env', { ticketId: A }))
  const grant = await must(P1, 'grant', { ticketId: A, level: 'push', by: 'operator-demo' })
  check('operator grant recorded (push, 1h expiry)', 'grant with by=operator-demo', grant, grant?.by === 'operator-demo' && Date.parse(grant.expiresAt) - Date.parse(grant.at) === 3_600_000, cmdText(P1, 'grant', { ticketId: A }))
  const delivered = await must(P1, 'deliver', { ticketId: A, level: 'push', requestId: 'deliver-A-1' })
  if (delivered.refused) notes.push(`S4 deliver was REFUSED: ${text(delivered.reasons)} (recorded as-is, evidence not fabricated)`)
  check('authorized deliver succeeds (state delivered, not repeated)', 'attempt.state=delivered, repeated=false', { state: delivered.attempt?.state, repeated: delivered.repeated, reasons: delivered.reasons }, delivered.attempt?.state === 'delivered' && delivered.repeated === false, cmdText(P1, 'deliver', { requestId: 'deliver-A-1' }))
  eq('receipt directory has exactly 1 receipt', 1, receiptList(ctx.receiptsDir).length, `ls ${ctx.receiptsDir}`)
  const receiptFile = receiptList(ctx.receiptsDir)[0]
  const receipt = receiptFile ? JSON.parse(readFileSync(path.join(ctx.receiptsDir, receiptFile), 'utf8')) : {}
  check('receipt is simulated push+pr only, keyed by the attempt operationKey', 'simulated:true, effects simulated-push/pr', receipt, receipt.simulated === true && receipt.operationKey === delivered.attempt?.operationKey && receipt.effects?.join() === 'simulated-push,simulated-pr', 'read receipt')
  const releaseA = await must(P1, 'release-ended', { ticketId: A })
  eq('release-ended releases the delivery lease', { released: true, holder: null }, { released: releaseA.released, holder: releaseA.lease.record?.holder.id ?? null }, cmdText(P1, 'release-ended', { ticketId: A }))
  await snap('after delivery lease released', P1)

  // ===== S5 ==========================================================================================================
  scenario = 'S5 cross-process recovery'
  await must(P1, 'acquire-env', { ticketId: A })
  const Lp1 = await snap('P1 re-acquired A (delivery)', P1)
  const P3 = await start('P3'); live.push(P3)
  const p3Start = P3.ready.resumed ?? []
  check('P3 startup resume of A is refused while P1 is alive', 'resumed[A].action=refused', p3Start, p3Start.some(item => item.holder === A && item.action === 'refused'), cmdText(P3, 'startup'))
  const p3Try = await run(P3, 'attempt-acquire', { ticketId: A, kind: 'ticket' })
  check('P3 acquire of the same ticket is refused (live foreign PID is never taken over)', `error naming holder ${A}, pid ${P1.pid}`, p3Try.ok ? p3Try.result : p3Try.error, mentionsHolder(p3Try, A), cmdText(P3, 'attempt-acquire', { ticketId: A }))
  const p3Env = await run(P3, 'acquire-env', { ticketId: A })
  check('P3 engine acquire-env of A is refused as well', 'error', p3Env.ok ? p3Env.result : p3Env.error, !p3Env.ok, cmdText(P3, 'acquire-env', { ticketId: A }))
  const LpP3 = await snap('after P3 attempts (read via P3)', P3)
  check('lease still P1\'s (token/pid/acquiredAt unchanged)', text({ token: Lp1.token, pid: P1.pid }), text({ token: LpP3.token, pid: LpP3.pid }), sameLease(Lp1, LpP3) && LpP3.pid === P1.pid, 'lease')
  await P3.shutdown()
  const LpAfterP3 = await snap('after P3 shutdown (read via P1)', P1)
  check('P3 shutdown did not disturb P1\'s lease', Lp1.token, LpAfterP3?.token, !!LpAfterP3 && sameLease(Lp1, LpAfterP3), 'lease')

  const p1Pid = P1.pid
  await P1.shutdown()
  live.splice(live.indexOf(P1), 1)
  check('P1 process exited', 'process gone', `exitCode ${P1.exitCode}`, P1.exitCode !== undefined, 'shutdown P1')
  const P2 = await start('P2'); live.push(P2)
  truthy('P2 is a different OS process on the same state', P2.pid !== p1Pid, 'spawn P2', `pid ${P2.pid} != ${p1Pid}`)
  const p2Start = P2.ready.resumed ?? []
  check('P2 resumed the lock holder A at startup', 'resumed[A].action=resumed', p2Start, p2Start.some(item => item.holder === A && item.action === 'resumed'), cmdText(P2, 'startup'))
  const Lp2 = await snap('P2 after recovery', P2)
  check('recovered lease: token and pid changed', { oldToken: Lp1.token, oldPid: Lp1.pid }, { newToken: Lp2.token, newPid: Lp2.pid }, Lp2.token !== Lp1.token && Lp2.pid === P2.pid && Lp2.pid !== Lp1.pid, 'lease')
  check('recovered lease: acquiredAt and holder unchanged', { acquiredAt: Lp1.acquiredAt, holder: Lp1.holder.id }, { acquiredAt: Lp2.acquiredAt, holder: Lp2.holder.id }, Lp2.acquiredAt === Lp1.acquiredAt && Lp2.holder.id === Lp1.holder.id, 'lease')
  eq('recovered lease keeps the delivery purpose fact', 'delivery', Lp2.facts?.purpose, 'lease')
  const same = await must(P2, 'deliver', { ticketId: A, level: 'push', requestId: 'deliver-A-1' })
  check('P2 same requestId: repeated, same operationKey, no execution', 'repeated=true', { repeated: same.repeated, key: same.attempt?.operationKey?.slice(0, 12), executions: same.targetExecutions }, same.repeated === true && same.attempt?.operationKey === delivered.attempt.operationKey && same.targetExecutions === 0, cmdText(P2, 'deliver', { requestId: 'deliver-A-1' }))
  const fresh = await must(P2, 'deliver', { ticketId: A, level: 'push', requestId: 'deliver-A-new-request-after-restart' })
  if (fresh.refused) notes.push(`S5 new-requestId deliver REFUSED: ${text(fresh.reasons)}`)
  check('P2 new requestId: repeated, same operationKey, no execution', 'repeated=true', { repeated: fresh.repeated, key: fresh.attempt?.operationKey?.slice(0, 12), executions: fresh.targetExecutions, reasons: fresh.reasons }, fresh.repeated === true && fresh.attempt?.operationKey === delivered.attempt.operationKey && fresh.targetExecutions === 0, cmdText(P2, 'deliver', { requestId: 'new' }))
  eq('receipt directory still has exactly 1 receipt', 1, receiptList(ctx.receiptsDir).length, `ls ${ctx.receiptsDir}`)
  const releaseA2 = await must(P2, 'release-ended', { ticketId: A })
  eq('P2 releases the delivery lease', true, releaseA2.released, cmdText(P2, 'release-ended', { ticketId: A }))
  await snap('P2 released', P2)
  await P2.shutdown()
  live.splice(live.indexOf(P2), 1)

  // ===== S6 ==========================================================================================================
  scenario = 'S6 target fails after its effect -> uncertain, never resent'
  const s6State = path.join(stateReal, 's6'); mkdirSync(s6State, { recursive: true })
  const s6Receipts = path.join(s6State, 'delivery-simulation')
  const wsC = path.join(s6State, 'workspaces', 'C'); mkdirSync(wsC, { recursive: true })
  writeFileSync(path.join(wsC, 'answer.py'), answerPy); writeFileSync(path.join(wsC, 'test_delivery.py'), testPy)
  const P4 = await start('P4', s6State, ['--fail-target-after-effect']); live.push(P4)
  const acceptC = await must(P4, 'accept', { title: 'Ticket C: target fails after effect', dir: realpathSync(wsC) })
  const C = acceptC.ticketId
  await must(P4, 'configure-tests', { ticketId: C })
  const testsC = await must(P4, 'run-tests', { ticketId: C })
  check('C real unittest passed', 'passed', testsC, testsC.passed && testsC.testsRun === 1, cmdText(P4, 'run-tests', { ticketId: C }))
  await must(P4, 'grant', { ticketId: C, level: 'push', by: 'operator-demo' })
  const first = await must(P4, 'deliver', { ticketId: C, level: 'push', requestId: 'c-1' })
  check('first deliver: the target wrote its receipt then threw -> uncertain', 'attempt.state=uncertain', { state: first.attempt?.state, detail: first.attempt?.detail, reasons: first.reasons }, first.attempt?.state === 'uncertain', cmdText(P4, 'deliver', { requestId: 'c-1' }))
  eq('exactly 1 receipt exists (the effect did happen)', 1, receiptList(s6Receipts).length, `ls ${s6Receipts}`)
  const stateC = await must(P4, 'state', { ticketId: C })
  eq('state(C) attempts show uncertain', ['uncertain'], stateC.delivery.attempts.map(item => item.state), cmdText(P4, 'state', { ticketId: C }))
  const again = await must(P4, 'deliver', { ticketId: C, level: 'push', requestId: 'c-1' })
  const newRequest = await must(P4, 'deliver', { ticketId: C, level: 'push', requestId: 'c-2' })
  await must(P4, 'grant', { ticketId: C, level: 'push', by: 'operator-demo' })
  const regranted = await must(P4, 'deliver', { ticketId: C, level: 'push', requestId: 'c-3' })
  for (const [label, result] of [['same requestId', again], ['new requestId', newRequest], ['after a new grant + new requestId', regranted]]) {
    check(`re-deliver (${label}) is not re-dispatched and stays uncertain`, 'uncertain, 1 target execution', { state: result.attempt?.state, refused: result.refused, executions: result.targetExecutions, reasons: result.reasons },
      (result.refused === true || result.attempt?.state === 'uncertain') && result.targetExecutions === 1 && result.attempt?.state !== 'delivered', cmdText(P4, 'deliver', { label }))
  }
  eq('receipt directory still exactly 1 receipt', 1, receiptList(s6Receipts).length, `ls ${s6Receipts}`)
  await P4.shutdown(); live.splice(live.indexOf(P4), 1)
  const P5 = await start('P5', s6State); live.push(P5)
  check('P5 (new process) resumed the holder C', 'resumed[C]', P5.ready.resumed, (P5.ready.resumed ?? []).some(item => item.holder === C && item.action === 'resumed'), cmdText(P5, 'startup'))
  const afterRestart = await must(P5, 'deliver', { ticketId: C, level: 'push', requestId: 'c-4-after-restart' })
  check('after restart still uncertain, no new execution (flag-free P5 would have succeeded if it resent)', 'uncertain, 0 executions in P5', { state: afterRestart.attempt?.state, refused: afterRestart.refused, executions: afterRestart.targetExecutions },
    (afterRestart.refused === true || afterRestart.attempt?.state === 'uncertain') && afterRestart.targetExecutions === 0, cmdText(P5, 'deliver', { requestId: 'c-4' }))
  eq('receipt directory still exactly 1 receipt after restart', 1, receiptList(s6Receipts).length, `ls ${s6Receipts}`)
  await P5.shutdown(); live.splice(live.indexOf(P5), 1)
}

// ---------------------------------------------------------------- run + report -------------------------------------------------
let fatal
try { await main() } catch (error) {
  fatal = error
  scenario ||= 'setup'
  check('scenario aborted by an unexpected error', 'no error', String(error?.stack ?? error), false, 'demo')
} finally {
  for (const host of live) host.kill()
}
const failed = assertions.filter(item => item.status === 'FAIL')
const verdict = { passed: assertions.length - failed.length, failed: failed.length, total: assertions.length }
const evidence = { generatedAt: new Date().toISOString(), state: stateReal, node: process.version, demoPid: process.pid, verdict, hosts, assertions, commands: commandLog, leaseTimeline,
  receipts: { main: { directory: path.join(stateReal, 'delivery-simulation'), files: receiptList(path.join(stateReal, 'delivery-simulation')) },
    s6: { directory: path.join(stateReal, 's6', 'delivery-simulation'), files: receiptList(path.join(stateReal, 's6', 'delivery-simulation')) } },
  releases: existsSync(path.join(stateReal, 'tp-environment.releases.json')) ? JSON.parse(readFileSync(path.join(stateReal, 'tp-environment.releases.json'), 'utf8')) : [],
  handovers: existsSync(path.join(stateReal, 'handovers')) ? readdirSync(path.join(stateReal, 'handovers')) : [], notes, fatal: fatal ? String(fatal.stack ?? fatal) : null }
writeFileSync(path.join(stateReal, 'evidence.json'), JSON.stringify(evidence, null, 2))
const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ')
const lines = ['# Phase 2 C+D local end-to-end demo', '', `- generated: ${evidence.generatedAt}`, `- state: \`${stateReal}\``, `- result: **${failed.length ? 'FAIL' : 'PASS'}** (${verdict.passed}/${verdict.total} assertions)`,
  '- scope: local only; SimulatedDelivery writes receipt files; no git push/PR/package/upload; editor and executor are recording stubs.', '', '## Host processes', '',
  '| host | pid | state dir | args | startup recovery |', '|---|---|---|---|---|', ...hosts.map(host => `| ${host.name} | ${host.pid} | ${cell(host.state)} | ${cell(host.args.join(' '))} | ${cell(text(host.resumed))} |`), '']
for (const name of [...new Set(assertions.map(item => item.scenario))]) {
  lines.push(`## ${name}`, '', '| # | assertion | command | expected | actual | status |', '|---|---|---|---|---|---|')
  assertions.filter(item => item.scenario === name).forEach((item, index) => lines.push(`| ${index + 1} | ${cell(item.name)} | ${cell(item.command)} | ${cell(item.expected)} | ${cell(item.actual)} | **${item.status}** |`))
  lines.push('')
}
lines.push('## Lease timeline (holder / acquiredAt / token / pid)', '', '| scenario | step | read via | holder | acquiredAt | token | lease pid | facts |', '|---|---|---|---|---|---|---|---|',
  ...leaseTimeline.map(item => `| ${cell(item.scenario)} | ${cell(item.label)} | ${item.viaHost}(${item.viaPid}) | ${item.holder ?? '-'} | ${item.acquiredAt ?? '-'} | ${item.token ?? '-'} | ${item.leasePid ?? '-'} | ${cell(text(item.facts))} |`), '',
  '## Receipts', '', `- main: \`${evidence.receipts.main.directory}\` -> ${text(evidence.receipts.main.files)}`, `- S6: \`${evidence.receipts.s6.directory}\` -> ${text(evidence.receipts.s6.files)}`, '',
  '## Notes / uncovered', '', ...(notes.length ? notes.map(note => `- ${note}`) : ['- none']), ...(fatal ? ['', '## Fatal', '', '```', String(fatal.stack ?? fatal), '```'] : []), '',
  '## Command log', '', '| # | scenario | host(pid) | command | ok | outcome |', '|---|---|---|---|---|---|',
  ...commandLog.map((item, index) => `| ${index + 1} | ${cell(item.scenario)} | ${item.host}(${item.pid}) | ${cell(`${item.cmd} ${text(item.args)}`)} | ${item.ok} | ${cell(item.outcome)} |`), '')
writeFileSync(path.join(stateReal, 'report.md'), lines.join('\n'))
console.log(`phase2cd demo: ${verdict.passed}/${verdict.total} PASS${failed.length ? `, ${failed.length} FAIL` : ''}`)
for (const item of failed) console.log(`  FAIL [${item.scenario}] ${item.name}\n       expected: ${item.expected}\n       actual:   ${item.actual}`)
console.log(`report:   ${path.join(stateReal, 'report.md')}\nevidence: ${path.join(stateReal, 'evidence.json')}`)
process.exit(failed.length ? 1 : 0)
