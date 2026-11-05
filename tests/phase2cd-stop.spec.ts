/** The real PID-exact stop, on a process this test starts itself (never an editor, never another project's process).
 * The stop used by TpEditorRecovery when no `stopProcess` is injected is `Stop-Process -Id <pid>` and a wait for the exit.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { TpEditorRecovery } from '../src/app/editor-recovery.ts'

const children: ChildProcess[] = []
afterEach(() => { for (const child of children.splice(0)) { try { child.kill('SIGKILL') } catch { /* gone */ } } })
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleeper = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}
const environment = { projectFile: 'C:\\TP\\TP.uproject', editorExe: 'C:\\UE\\UnrealEditor.exe', port: 55255, captureTool: 'Capture' }
const editorAt = (pid: number, startedAt: string) => ({ pid, name: 'UnrealEditor.exe', executablePath: 'C:\\UE\\UnrealEditor.exe',
  commandLine: '"C:\\UE\\UnrealEditor.exe" "C:\\TP\\TP.uproject"', startedAt })

describe.runIf(process.platform === 'win32')('the real PID-exact stop (a process this test started)', () => {
  it('stops exactly the recorded process, with the real Stop-Process, and leaves another one running', async () => {
    const target = sleeper(), bystander = sleeper()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(alive(target.pid!)).toBe(true); expect(alive(bystander.pid!)).toBe(true)
    const startedAt = new Date().toISOString()
    // The listing says the target pid is the TP editor started at `startedAt`; nothing is injected for the stop itself.
    const recovery = new TpEditorRecovery(() => ({ enabled: true, environment }), {
      processList: async () => [editorAt(target.pid!, startedAt)],
      recordedPid: () => target.pid!, recordedStart: () => startedAt,
    }, process.cwd())
    await recovery.cleanup('ticket-1', environment)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(alive(target.pid!)).toBe(false)
    expect(alive(bystander.pid!)).toBe(true)
  })

  it('does not stop a live process whose start time differs from the recorded one (a reused pid)', async () => {
    const target = sleeper()
    await new Promise(resolve => setTimeout(resolve, 400))
    const recovery = new TpEditorRecovery(() => ({ enabled: true, environment }), {
      processList: async () => [editorAt(target.pid!, '2026-11-03T00:00:00.000Z')],
      recordedPid: () => target.pid!, recordedStart: () => '2026-11-03T10:00:00.000Z',
    }, process.cwd())
    await recovery.cleanup('ticket-1', environment)
    expect(alive(target.pid!)).toBe(true)
  })

  it('treats a pid that is already gone as stopped, without error', async () => {
    const target = sleeper()
    await new Promise(resolve => setTimeout(resolve, 300))
    const pid = target.pid!
    target.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(alive(pid)).toBe(false)
    const startedAt = new Date().toISOString()
    const recovery = new TpEditorRecovery(() => ({ enabled: true, environment }), {
      processList: async () => [editorAt(pid, startedAt)],
      recordedPid: () => pid, recordedStart: () => startedAt,
    }, process.cwd())
    await expect(recovery.cleanup('ticket-1', environment)).resolves.toBeUndefined()
  })
})
