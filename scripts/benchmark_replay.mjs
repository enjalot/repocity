import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import ts from 'typescript'

async function loadModel(source) {
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText.replace("from 'd3'", `from '${import.meta.resolve('d3')}'`)
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}
const current = await loadModel(await readFile(new URL('../src/city/model.ts', import.meta.url), 'utf8'))
const ref = process.argv[2]
const baseline = ref ? await loadModel(execFileSync('git', ['show', `${ref}:src/city/model.ts`], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8',
})) : null
function measure(fn) {
  for (let i = 0; i < 30; i++) fn(i)
  const samples = []
  for (let i = 0; i < 200; i++) {
    const start = performance.now()
    fn(i)
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return { medianMs: +samples[100].toFixed(4), p95Ms: +samples[190].toFixed(4) }
}
for (const dataset of ['latent-scope', 'react']) {
  const replay = JSON.parse(gunzipSync(await readFile(new URL(`../public/data/${dataset}.json.gz`, import.meta.url))))
  const layout = current.buildCityLayout(replay.paths, 'files', 3)
  const index = replay.events.length - 1
  const { before, after } = current.reconstructPair(replay, index)
  const run = model => ({
    seek: measure(i => model.reconstruct(replay, index - i % 100)),
    deltas: measure(() => model.cityDeltas(layout, before, after, replay.events[index])),
  })
  console.log(JSON.stringify({ dataset, paths: replay.paths.length,
    ...(baseline ? { baselineRef: ref, baseline: run(baseline) } : {}), current: run(current) }))
}
