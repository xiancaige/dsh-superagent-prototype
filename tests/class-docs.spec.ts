/** Verifies that every class in src has a preceding JSDoc block. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import ts from 'typescript'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

it('gives every class declaration in src a JSDoc block right before it', () => {
  const undocumented = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(path => /\.tsx?$/.test(path)).flatMap(path => {
    const text = readFileSync(join(SRC, path), 'utf8')
    // Parse actual TS declarations: a host-owned Python adapter string can contain
    // Python class declarations, which are not undocumented TypeScript classes.
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const missing: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const before = text.slice(0, node.getStart(source)).trimEnd()
        const start = before.lastIndexOf('/**')
        if (!(start >= 0 && before.indexOf('*/', start) === before.length - 2)) missing.push(`src/${path}: ${node.name?.text ?? '<anonymous>'}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return missing
  })
  expect(undocumented).toEqual([])
})
