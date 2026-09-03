import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const sourceUrl = new URL('../src/markdownReport.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'markdownReport.ts',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
const {
  buildFinalLocMarkdown,
  finalCityPaths,
  finalLocMarkdownFilename,
} = await import(moduleUrl)

function replay(paths) {
  return {
    repo: 'owner/city | demo',
    tip: 'abc123',
    end: '2026-09-03T12:00:00Z',
    paths,
  }
}

test('finalCityPaths keeps non-empty city files ordered by LOC then path', () => {
  const paths = [
    { id: 0, path: 'src/z.ts', category: 'source', finalLoc: 20 },
    { id: 1, path: 'docs/large.md', category: 'docs', finalLoc: 500 },
    { id: 2, path: 'tests/a.test.ts', category: 'test', finalLoc: 20 },
    { id: 3, path: 'src/empty.ts', category: 'source', finalLoc: 0 },
    { id: 4, path: 'src/big.ts', category: 'source', finalLoc: 80 },
  ]

  assert.deepEqual(
    finalCityPaths(paths).map((path) => path.path),
    ['src/big.ts', 'src/z.ts', 'tests/a.test.ts'],
  )
  assert.deepEqual(paths.map((path) => path.path), [
    'src/z.ts',
    'docs/large.md',
    'tests/a.test.ts',
    'src/empty.ts',
    'src/big.ts',
  ])
})

test('buildFinalLocMarkdown caps rows and describes the final snapshot', () => {
  const markdown = buildFinalLocMarkdown(replay([
    { id: 0, path: 'src/small.ts', category: 'source', finalLoc: 12 },
    { id: 1, path: 'tests/a|b.test.ts', category: 'test', finalLoc: 1_250 },
    { id: 2, path: 'src/medium.ts', category: 'source', finalLoc: 400 },
    { id: 3, path: 'README.md', category: 'docs', finalLoc: 9_000 },
  ]), 2)

  assert.match(markdown, /^# Final LOC report for <code>owner\/city &#124; demo<\/code>/)
  assert.match(markdown, /- Replay tip: <code>abc123<\/code>/)
  assert.match(markdown, /- Files listed: 2 of 3/)
  assert.match(markdown, /- Final city LOC: 1,662/)
  assert.match(markdown, /- LOC represented below: 1,650/)
  assert.match(markdown, /\| 1 \| 1,250 \| test \| <code>tests\/a&#124;b\.test\.ts<\/code> \|/)
  assert.match(markdown, /\| 2 \| 400 \| source \| <code>src\/medium\.ts<\/code> \|/)
  assert.doesNotMatch(markdown, /small\.ts/)
  assert.doesNotMatch(markdown, /README\.md/)
})

test('buildFinalLocMarkdown defaults to at most 1,000 rows', () => {
  const paths = Array.from({ length: 1_005 }, (_, index) => ({
    id: index,
    path: `src/file-${String(index).padStart(4, '0')}.ts`,
    category: 'source',
    finalLoc: 2_000 - index,
  }))
  const markdown = buildFinalLocMarkdown(replay(paths))
  const rows = markdown.split('\n').filter((line) => /^\| \d+ \|/.test(line))

  assert.equal(rows.length, 1_000)
  assert.match(markdown, /- Files listed: 1,000 of 1,005/)
  assert.match(rows.at(-1), /^\| 1000 \| 1,001 \|/)
})

test('finalLocMarkdownFilename creates a portable Markdown filename', () => {
  assert.equal(finalLocMarkdownFilename(' owner/city | demo '), 'owner-city-demo-top-loc.md')
  assert.equal(finalLocMarkdownFilename('...'), 'repository-top-loc.md')
})
