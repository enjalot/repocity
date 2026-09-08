import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/city/model.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText.replace("from 'd3'", `from '${import.meta.resolve('d3')}'`)
const { applyEvent, reconstruct, reconstructPair, createReplayReader, buildCityLayout, cityDeltas } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const event = (...changes) => ({ changes })
const replay = {
  paths: ['source', 'test', 'source', 'source', 'fixture'].map((category, id) => ({
    id, path: `src/file${id}.ts`, category, peakLoc: 100, finalLoc: 0,
  })),
  events: [
    event([0, 100, 0, 1, -1]),
    event([1, 20, 0, 1, -1]),
    event([2, 3, 10, 4, 0]), // rename source 0 -> 2
    event([3, 7, 0, 5, 2]), // copy 2 -> 3, leave source intact
    event([2, 0, 93, 3, -1], [1, 4, 4, 2, -1]),
    event([4, 100, 0, 1, -1]),
  ],
  checkpoints: [[1, [[0, 100], [1, 20]]], [3, [[1, 20], [2, 93], [3, 100]]]],
}

test('checkpoint seeks match linear replay on both sides of every snapshot', () => {
  const expected = new Float64Array(replay.paths.length)
  assert.deepEqual(reconstruct(replay, -1), expected)
  for (let index = 0; index < replay.events.length; index++) {
    applyEvent(expected, replay.events[index])
    assert.deepEqual(reconstruct(replay, index), expected)
  }
  assert.deepEqual(reconstruct(replay, 999), expected)
})

test('a late seek never materializes older checkpoints', () => {
  const checkpoints = [[0, { [Symbol.iterator]() { throw Error('old snapshot read') } }], ...replay.checkpoints]
  assert.deepEqual(reconstruct({ ...replay, checkpoints }, 5), reconstruct(replay, 5))
})

test('sequential readers support reverse seeks and preserve earlier snapshots', () => {
  const read = createReplayReader(replay)
  const retained = read(0)
  const original = new Float64Array(retained.after)
  for (const index of [1, 2, 3, 5, 0, 4, 3, 3]) {
    assert.deepEqual(read(index), reconstructPair(replay, index))
  }
  assert.deepEqual(retained.after, original)
  const fourth = read(3)
  assert.equal(read(4).before, fourth.after)
})

test('sparse city deltas include rename origins and exclude unchanged copies and fixtures', () => {
  const layout = buildCityLayout(replay.paths, 'files', 3)
  for (let index = 0; index < replay.events.length; index++) {
    const { before, after } = reconstructPair(replay, index)
    assert.deepEqual(cityDeltas(layout, before, after, replay.events[index]), cityDeltas(layout, before, after))
  }
  const pair = reconstructPair(replay, 2)
  assert.deepEqual(cityDeltas(layout, pair.before, pair.after, replay.events[2]).map(d => d.lot.pathId), [0, 2])
})
