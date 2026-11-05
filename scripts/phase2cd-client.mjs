/** Tiny client for scripts/phase2cd-host.ts: spawns a real OS process and speaks its line protocol. Shared by the demo and the vitest spec. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const HOST = path.join(here, 'phase2cd-host.ts')

export class Host {
  /** @param {string} state absolute state directory */
  static async start(state, extra = [], timeoutMs = 60_000) {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', HOST, '--state', state, ...extra],
      { cwd: path.join(here, '..'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const host = new Host(child)
    host.ready = await host.#await('ready', timeoutMs)
    return host
  }
  #pending = new Map()
  #sequence = 0
  #stderr = ''
  constructor(child) {
    this.child = child
    this.pid = child.pid
    this.exited = new Promise(resolve => child.once('exit', (code, signal) => { this.exitCode = code; this.#fail(new Error(`host ${child.pid} exited (${code ?? signal})\n${this.#stderr}`)); resolve(code) }))
    child.stderr.on('data', chunk => { this.#stderr += chunk })
    createInterface({ input: child.stdout }).on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const key = message.ready ? 'ready' : message.id
      const waiter = this.#pending.get(key)
      if (waiter) { this.#pending.delete(key); waiter.resolve(message) }
    })
  }
  #fail(error) { for (const waiter of this.#pending.values()) waiter.reject(error); this.#pending.clear() }
  #await(key, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(key); reject(new Error(`timeout waiting for ${key}\n${this.#stderr}`)) }, timeoutMs)
      this.#pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    })
  }
  /** Send a command; resolves {ok, result|error} (never throws for a host-side error). */
  async send(cmd, args = {}, timeoutMs = 120_000) {
    const id = ++this.#sequence
    const reply = this.#await(id, timeoutMs)
    this.child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`)
    return reply
  }
  /** Send and require ok. */
  async call(cmd, args = {}, timeoutMs) {
    const reply = await this.send(cmd, args, timeoutMs)
    if (!reply.ok) throw new Error(`${cmd} failed: ${JSON.stringify(reply.error)}`)
    return reply.result
  }
  async shutdown() {
    const reply = await this.send('shutdown', {}, 30_000).catch(() => undefined)
    await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 10_000))])
    return reply
  }
  /** Last resort for a host this client started itself. */
  kill() { try { this.child.kill() } catch { /* gone */ } }
}
