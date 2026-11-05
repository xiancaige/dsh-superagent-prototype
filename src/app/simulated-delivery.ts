/** Explicit local rehearsal target for phase 2 D. Never runs git/gh, a packager or uploader.
 * Receipts live outside the worker workspace. Exclusive creation also makes target retries idempotent.
 * This is not a production adapter; production Git targets must bind HEAD/tree/index and immutable payloads.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DeliveryTarget, DeliveryAttempt } from '../core/delivery.ts'
import { fingerprintWorkspace } from '../validation.ts'

/** Only the host chooses this directory and opt-in. No worker tool or authorization body may choose it. */
export class SimulatedDelivery implements DeliveryTarget {
  readonly id: string
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Simulation receipt directory must be absolute')
    this.id = `simulation:${directory}`
  }
  version(workspace: string): string { return `simulated-content:${fingerprintWorkspace(workspace)}` }
  async execute(attempt: Readonly<DeliveryAttempt>): Promise<{ receipt: string; detail: string }> {
    if (!/^[a-f0-9]{64}$/.test(attempt.operationKey) || attempt.target !== this.id) throw new Error('Wrong simulation target/key')
    if (this.version(attempt.workspace) !== attempt.version || fingerprintWorkspace(attempt.workspace) !== attempt.fingerprint) {
      throw new Error('Simulation payload changed before dispatch')
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const receipt = path.join(this.directory, `${attempt.operationKey}.json`)
    const value = { simulated: true, operationKey: attempt.operationKey, level: attempt.level, version: attempt.version,
      effects: attempt.level === 'push' ? ['simulated-push', 'simulated-pr'] : [`simulated-${attempt.level}`] }
    try { writeFileSync(receipt, JSON.stringify(value), { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (readFileSync(receipt, 'utf8') !== JSON.stringify(value)) throw new Error('Simulation receipt conflict')
    }
    return { receipt, detail: 'SIMULATED ONLY: no commit, push, PR, package, upload or publication performed' }
  }
}
