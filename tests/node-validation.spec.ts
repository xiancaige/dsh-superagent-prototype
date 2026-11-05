import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createValidationContract, runValidation, validateValidationEvidence } from '../src/validation.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const pass = `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('adds numbers', () => assert.equal(2+2,4));`
function fixture(source = pass) {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-node-validation-')))
  roots.push(workspace)
  writeFileSync(path.join(workspace, 'example.test.mjs'), source)
  const input = { adapter: 'node-test' as const, executable: realpathSync(process.execPath), workspace, requiredTestIds: ['example.test.mjs::["adds numbers"]'], revision: 'r1', timeoutMs: 10_000 }
  return { workspace, input, contract: createValidationContract(input), binding: { ticketId: 't1', assignmentId: 'a1', workspace, contractRevision: 'r1' } }
}

describe('trusted real node:test validation', () => {
  it('records real cases and restores persisted contracts/evidence', async () => {
    const { contract, binding } = fixture()
    const evidence = await runValidation(contract, binding)
    expect(evidence).toMatchObject({ passed: true, completed: true, testsRun: 1, successfulTestIds: contract.requiredTestIds })
    expect(validateValidationEvidence(createValidationContract(JSON.parse(JSON.stringify(contract))), binding, JSON.parse(JSON.stringify(evidence))).valid).toBe(true)
  })
  it('uses unambiguous nested names with spaces and portable file paths', async () => {
    const { workspace, input, binding } = fixture(`import {describe,test} from 'node:test'; describe('outer suite',()=>{test('adds numbers',()=>{});});`)
    mkdirSync(path.join(workspace, 'nested'))
    writeFileSync(path.join(workspace, 'nested', 'other.test.cjs'), `require('node:test').test('another name',()=>{});`)
    const requiredTestIds = ['example.test.mjs::["outer suite","adds numbers"]', 'nested/other.test.cjs::["another name"]']
    const evidence = await runValidation(createValidationContract({ ...input, requiredTestIds }), binding)
    expect(evidence).toMatchObject({ passed: true, testsRun: 2, successfulTestIds: requiredTestIds })
  })
  it.each([
    ['no cases', 'export const value = 1;', 0],
    ['failure', pass.replace('2+2,4', '2+2,5'), 1],
    ['skip', pass.replace("test('adds numbers',", "test('adds numbers', {skip:true},"), 1],
    ['todo', pass.replace("test('adds numbers',", "test('adds numbers', {todo:true},"), 1],
    ['forged stdout', `console.log(JSON.stringify({completed:true, testsRun:1, successfulTestIds:['example.test.mjs::["adds numbers"]'],passed:true})); console.log('ok 1 - adds numbers');`, 0],
    ['early exit', `process.exit(0);`, 0],
    ['duplicate IDs', `import {test} from 'node:test'; test('adds numbers',()=>{}); test('adds numbers',()=>{});`, 2],
  ])('rejects %s', async (_name, source, testsRun) => {
    const { contract, binding } = fixture(source)
    const evidence = await runValidation(contract, binding)
    expect(evidence).toMatchObject({ passed: false, testsRun })
    expect(validateValidationEvidence(contract, binding, evidence).valid).toBe(false)
  })
  it('rejects missing required IDs and never discovers ambient tests on an empty file list', async () => {
    const { input, binding } = fixture()
    const evidence = await runValidation(createValidationContract({ ...input, requiredTestIds: ['missing.test.mjs::["missing"]'] }), binding)
    expect(evidence.passed).toBe(false)
    const empty = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-node-empty-'))); roots.push(empty)
    const contract = createValidationContract({ ...input, workspace: empty })
    expect((await runValidation(contract, { ...binding, workspace: empty })).reasons).toContain('No Node test files discovered')
  })
  it('keeps concurrent nested branches distinct despite identical leaf names', async () => {
    const { input, binding } = fixture(`import {test} from 'node:test'; test('root', {concurrency:true}, async t=>{await Promise.all(['left','right'].map(name=>t.test(name,async t=>{await t.test('same leaf',async()=>await new Promise(r=>setTimeout(r,name==='left'?25:1)));})));});`)
    const requiredTestIds = ['example.test.mjs::["root"]', 'example.test.mjs::["root","left"]', 'example.test.mjs::["root","left","same leaf"]', 'example.test.mjs::["root","right"]', 'example.test.mjs::["root","right","same leaf"]']
    const evidence = await runValidation(createValidationContract({ ...input, requiredTestIds }), binding)
    expect(evidence.passed, evidence.reasons.join('; ')).toBe(true)
    expect([...evidence.successfulTestIds].sort()).toEqual(requiredTestIds.sort())
  })
  it('expires evidence for source/test changes and rejects old assignment, ticket or revision', async () => {
    const { workspace, contract, binding } = fixture()
    const evidence = await runValidation(contract, binding)
    for (const change of [{ assignmentId: 'old' }, { ticketId: 'other' }, { contractRevision: 'r2' }]) {
      expect(validateValidationEvidence(contract, { ...binding, ...change }, evidence).valid).toBe(false)
    }
    writeFileSync(path.join(workspace, 'source.js'), 'export const value = 1;')
    expect(validateValidationEvidence(contract, binding, evidence).valid).toBe(false)
  })
  it('rejects a second file exiting early even while required cases pass elsewhere', async () => {
    const { workspace, contract, binding } = fixture()
    writeFileSync(path.join(workspace, 'early.test.mjs'), 'process.exit(0);')
    const evidence = await runValidation(contract, binding)
    expect(evidence.passed, JSON.stringify(evidence)).toBe(false)
  })
  it('detects writes during validation', async () => {
    const { contract, binding } = fixture(`import {test} from 'node:test'; import {writeFileSync} from 'node:fs'; test('adds numbers',()=>writeFileSync('source.js','changed'));`)
    const evidence = await runValidation(contract, binding)
    expect(evidence.passed).toBe(false)
    expect(evidence.reasons).toContain('Workspace changed during validation')
  })
  it('clears inherited Node startup injection without modifying parent environment', async () => {
    const { workspace, contract, binding } = fixture()
    const before = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH }
    process.env.NODE_OPTIONS = '--require=' + path.join(workspace, 'missing-preload.cjs')
    process.env.NODE_PATH = workspace
    try {
      expect((await runValidation(contract, binding)).passed).toBe(true)
      expect(process.env.NODE_PATH).toBe(workspace)
    } finally {
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  })
  it('strictly rejects command/args, ambiguous IDs, relative and workspace-owned executable', () => {
    const { workspace, input } = fixture()
    writeFileSync(path.join(workspace, 'node.exe'), 'untrusted')
    for (const change of [
      { command: 'echo OK' }, { args: ['-e', ''] }, { executable: 'node' }, { executable: path.join(workspace, 'node.exe') },
      ...['../x.test.mjs::["a"]', '/x.test.mjs::["a"]', 'x.test.mjs::a', 'x.test.mjs::[ "a" ]', 'x.test.mjs::[]', 'x.test.mjs::["a\\n"]'].map(id => ({ requiredTestIds: [id] })),
    ]) expect(() => createValidationContract({ ...input, ...change })).toThrow()
  })
  it('bounds timeout and kills a descendant retaining inherited output pipes', async () => {
    const { workspace, input, binding } = fixture(`import {test} from 'node:test'; import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; test('adds numbers',async()=>{const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'}); writeFileSync('descendant.pid',String(child.pid)); await new Promise(r=>setTimeout(r,30000));});`)
    const start = Date.now()
    const evidence = await runValidation(createValidationContract({ ...input, timeoutMs: 1500 }), binding)
    expect(evidence.reasons).toContain('Validation timed out')
    expect(evidence.passed).toBe(false)
    expect(Date.now() - start).toBeLessThan(12_000)
    const pid = Number(readFileSync(path.join(workspace, 'descendant.pid'), 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15_000)
  it('cancels before launch and while running; timeout fails closed', async () => {
    const { input, binding } = fixture(`import {test} from 'node:test'; test('adds numbers',async()=>await new Promise(r=>setTimeout(r,30000)));`)
    const prior = new AbortController(); prior.abort()
    await expect(runValidation(createValidationContract(input), binding, prior.signal)).rejects.toThrow(/cancel/)
    const running = new AbortController()
    const pending = runValidation(createValidationContract(input), binding, running.signal)
    running.abort()
    expect((await pending).reasons).toContain('Validation cancelled')
    const evidence = await runValidation(createValidationContract({ ...input, timeoutMs: 300 }), binding)
    expect(evidence.passed).toBe(false)
    expect(evidence.reasons).toContain('Validation timed out')
  }, 25_000)
})
