import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

// Use a local Playwright installation without adding a runtime dependency to RepoCity.
const { chromium } = await import(process.env.REPOCITY_PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.REPOCITY_URL || 'http://127.0.0.1:5186'
const artifacts = process.env.REPOCITY_ARTIFACTS || '/tmp/repocity-validation'
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
const reports = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })

try {
  for (const dataset of ['latent-scope', 'react']) {
    await page.goto(`${base}/?dataset=${dataset}`)
    await page.locator('canvas').waitFor()
    await page.locator('.loading').waitFor({ state: 'detached' })
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(entry => /\/src\/city\/threeScene/.test(entry.name)).name
      const { ThreeCityScene } = await import(url)
      const setState = ThreeCityScene.prototype.setState
      ThreeCityScene.prototype.setState = function (...args) {
        window.testScene = this
        return setState.apply(this, args)
      }
      const beginEvent = ThreeCityScene.prototype.beginEvent
      window.emitted = []
      window.emittedFrames = []
      ThreeCityScene.prototype.beginEvent = function (...args) {
        if (args[5] > 0) {
          window.emitted.push(args[3])
          window.emittedFrames.push(this.renderer.info.render.frame)
        }
        return beginEvent.apply(this, args)
      }
    })
    await page.getByRole('button', { name: 'Final commit', exact: true }).click()
    await page.waitForFunction(() => Boolean(window.testScene))
    const report = await page.evaluate(async (dataset) => {
      const response = await fetch(`/data/${dataset}.json.gz`)
      const replay = response.headers.get('content-encoding') ? await response.json()
        : await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json()
      window.testReplay = replay
      const scene = window.testScene
      const model = await import('/src/city/model.ts')
      window.testModel = model
      const mismatches = replay.paths.filter(path => ['source', 'test'].includes(path.category)
        && path.peakLoc > 0 && scene.linesForPath(path.id) !== path.finalLoc)
      const { memory, render } = scene.renderer.info
      const final = { calls: render.calls, geometries: memory.geometries, textures: memory.textures }
      const rect = document.querySelector('canvas').getBoundingClientRect()
      const sizes = { width: rect.width, bufferWidth: scene.renderer.domElement.width,
        pixelRatio: scene.renderer.getPixelRatio() }
      // Check full-box picking by projecting the center of the tallest building.
      const lot = [...scene.slots.values()].filter(slot => slot.state === 'present')
        .sort((a, b) => scene.linesForPath(b.lot.pathId) - scene.linesForPath(a.lot.pathId))[0]
      scene.fitView()
      const vector = scene.camera.position.clone().set(lot.bounds.x,
        scene.heightFor(scene.linesForPath(lot.lot.pathId)) * 0.8, lot.bounds.z).project(scene.camera)
      const hit = scene.pick(rect.left + (vector.x + 1) / 2 * rect.width,
        rect.top + (1 - vector.y) / 2 * rect.height, rect)
      const picked = hit?.lot.pathId === lot.lot.pathId
      scene.clearHover()
      scene.resetView()
      return { dataset, mismatches: mismatches.length, final, sizes, picked }
    }, dataset)
    assert.equal(report.mismatches, 0, 'final city agrees with validated replay LOC')
    assert.equal(report.picked, true, 'full building box can be picked')
    assert.ok(report.final.calls < 20, 'districts use bounded batches')
    assert.ok(report.final.textures < 10, 'labels use shared atlases')
    assert.ok(Math.abs(report.sizes.bufferWidth - report.sizes.width * report.sizes.pixelRatio) <= 1)
    await page.locator('.city-shell').screenshot({ path: `${artifacts}/${dataset}-final.png` })
    await page.getByRole('button', { name: 'Fit skyline', exact: true }).click()
    const fit = await page.evaluate(() => {
      const scene = window.testScene
      let outside = 0
      for (const slot of scene.slots.values()) {
        if (slot.state !== 'present') continue
        const point = scene.camera.position.clone().set(slot.bounds.x,
          scene.heightFor(scene.linesForPath(slot.lot.pathId)), slot.bounds.z).project(scene.camera)
        if (Math.abs(point.x) > 1 || Math.abs(point.y) > 1 || Math.abs(point.z) > 1) outside++
      }
      return outside
    })
    assert.equal(fit, 0, 'fit skyline includes tall roofs without clipping')
    await page.locator('.stage').screenshot({ path: `${artifacts}/${dataset}-fit.png` })
    await page.getByRole('button', { name: 'Reset', exact: true }).click()

    // Exercise actual mixed and monumental commits at controlled points in the choreography.
    const effects = await page.evaluate(() => {
      const scene = window.testScene
      const replay = window.testReplay
      const { reconstructPair } = window.testModel
      const candidates = replay.events.map((event, index) => ({ event, index }))
      const largestAdd = candidates.reduce((a, b) => a.event.additions > b.event.additions ? a : b)
      const largestRemove = candidates.reduce((a, b) => a.event.removals > b.event.removals ? a : b)
      const mixed = candidates.find(({ event }) => event.changes.some(([id, a, r]) =>
        a > 0 && r > 0 && scene.layout.lotByPath.has(id)))
      const gl = scene.renderer.getContext()
      const created = new Set()
      const createBuffer = gl.createBuffer.bind(gl)
      const deleteBuffer = gl.deleteBuffer.bind(gl)
      gl.createBuffer = () => { const buffer = createBuffer(); created.add(buffer); return buffer }
      gl.deleteBuffer = buffer => { created.delete(buffer); return deleteBuffer(buffer) }
      const results = []
      for (const candidate of [mixed, largestAdd, largestRemove]) {
        const { index, event } = candidate
        const { before, after } = reconstructPair(replay, index)
        scene.setState(before, 50, index - 1)
        scene.beginEvent(before, after, event, index, 50, 900, true, 7, 1564)
        scene.updateEvent(0.68)
        const workers = scene.workers.filter(worker => worker.action)
        const roofErrors = workers.filter(worker => Math.abs(worker.bot.position.y
          - scene.heightFor(worker.action.before) - 0.11) > 1e-6).length
        const firstEffect = scene.trailEffects[0] ?? scene.burstEffects[0]
        const startedAt = firstEffect?.startedAt ?? performance.now()
        scene.tickEffects(startedAt - 1)
        const earlyBeams = scene.trailEffects.filter(effect => effect.beam.visible).length
        scene.tickEffects(startedAt + 100)
        scene.render()
        scene.updateEvent(1)
        scene.tickEffects(startedAt + 400)
        scene.render()
        scene.tickEffects(startedAt + 901)
        scene.render()
        results.push({ index, roofErrors, earlyBeams,
          remaining: scene.trailEffects.length + scene.burstEffects.length })
      }
      // Worker routes persist; temporary instanced beam/ring buffers must all be released.
      const retained = created.size
      const candidate = largestAdd
      const pair = reconstructPair(replay, candidate.index)
      scene.lastSpawnedSha = null
      scene.beginEvent(pair.before, pair.after, candidate.event, candidate.index, 50, 900, false, 0)
      scene.tickEffects(performance.now() + 400)
      scene.render()
      scene.tickEffects(performance.now() + 901)
      scene.render()
      const leaked = created.size - retained
      gl.createBuffer = createBuffer
      gl.deleteBuffer = deleteBuffer
      return { results, leaked }
    })
    assert.ok(effects.results.every(result => result.roofErrors === 0 && result.earlyBeams === 0 && result.remaining === 0), JSON.stringify(effects))
    assert.equal(effects.leaked, 0, 'expired instanced effects release their GPU buffers')
    report.effects = effects

    const upload = await page.evaluate(() => {
      const scene = window.testScene
      const replay = window.testReplay
      const index = replay.events.findIndex(event => event.changes.length < 6
        && event.changes.some(([id, add, remove]) => scene.layout.lotByPath.has(id) && add !== remove))
      const { before, after } = window.testModel.reconstructPair(replay, index)
      scene.clearEffects()
      scene.setState(before, 50, index - 1)
      const gl = scene.renderer.getContext()
      const update = gl.bufferSubData.bind(gl)
      let bytes = 0
      gl.bufferSubData = (...args) => {
        bytes += (args[4] ?? args[2].length) * args[2].BYTES_PER_ELEMENT
        return update(...args)
      }
      scene.beginEvent(before, after, replay.events[index], index, 50, 0, false)
      scene.updateEvent(0.5)
      scene.render()
      const approachBytes = bytes
      scene.updateEvent(1)
      scene.render()
      gl.bufferSubData = update
      const touched = scene.activeDeltas.length
      return { approachBytes, bytes, touched }
    })
    assert.equal(upload.approachBytes, 0, 'worker travel does not upload unchanged buildings')
    assert.ok(upload.bytes > 0 && upload.bytes <= upload.touched * (16 + 3) * 4,
      'GPU uploads are bounded by touched matrices and colors')
    report.upload = upload

    if (dataset === 'latent-scope') {
      for (const { index } of effects.results) {
        await page.evaluate((index) => {
          const scene = window.testScene
          const replay = window.testReplay
          const { before, after } = window.testModel.reconstructPair(replay, index)
          scene.clearEffects()
          scene.setState(before, 50, index - 1)
          scene.beginEvent(before, after, replay.events[index], index, 50, 900, true, 7, 1564)
          scene.fitView()
          window.previewStartedAt = (scene.trailEffects[0] ?? scene.burstEffects[0]).startedAt
        }, index)
        for (const [phase, progress, time] of [['approach', 0.5, -100], ['strike', 0.72, 100], ['rebound', 0.9, 400]]) {
          await page.evaluate(({ progress, time }) => {
            window.testScene.updateEvent(progress)
            window.testScene.tickEffects(window.previewStartedAt + time)
            window.testScene.render()
          }, { progress, time })
          await page.locator('.stage').screenshot({ path: `${artifacts}/event-${index}-${phase}.png` })
        }
      }
      await page.getByRole('button', { name: 'Reset', exact: true }).click()
    }

    await page.getByRole('button', { name: 'First commit', exact: true }).click()
    await page.getByRole('button', { name: '200×', exact: true }).click()
    await page.evaluate(() => { window.emitted = []; window.emittedFrames = [] })
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.waitForTimeout(500)
    // Simulate one stalled frame: catch-up must process all commits before the next draw.
    await page.evaluate(() => {
      const until = performance.now() + 50
      while (performance.now() < until) { /* controlled main-thread stall */ }
    })
    await page.waitForTimeout(60)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    const emitted = await page.evaluate(() => window.emitted)
    assert.ok(emitted.length >= 10, 'high speed advances multiple commits')
    assert.ok(emitted.every((value, i) => i === 0 || value === emitted[i - 1] + 1), 'every crossed commit emits effects')
    const frames = await page.evaluate(() => window.emittedFrames)
    assert.ok(frames.some((frame, i) => i > 0 && frame === frames[i - 1]), 'catch-up is not limited to one commit per rendered frame')
    report.highSpeedEvents = emitted.length
    await page.waitForTimeout(1100)
    const frame = await page.evaluate(() => window.testScene.renderer.info.render.frame)
    await page.waitForTimeout(120)
    assert.equal(await page.evaluate(() => window.testScene.renderer.info.render.frame), frame, 'idle scene stops rendering')
    reports.push(report)
  }

  for (const layout of ['Peak area', 'Squarified LOC', 'Equal files']) {
    await page.getByRole('button', { name: layout, exact: true }).click()
    await page.waitForTimeout(200)
    await page.getByRole('button', { name: 'Final commit', exact: true }).click()
  }
  await page.getByLabel('Neighborhood folder depth').selectOption('1')
  await page.waitForTimeout(200)
  await page.locator('.stage').screenshot({ path: `${artifacts}/react-districts.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.locator('.city-shell').screenshot({ path: `${artifacts}/mobile.png` })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'First commit', exact: true }).click()
  await page.getByRole('button', { name: '1×', exact: true }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForTimeout(120)
  assert.equal(await page.evaluate(() => window.testScene.workers.some(worker => worker.bot.visible)), false)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  assert.deepEqual(errors, [], 'no browser or WebGL shader errors')
  await writeFile(`${artifacts}/report.json`, JSON.stringify({ reports, errors }, null, 2))
  console.log(JSON.stringify({ reports, errors, artifacts }, null, 2))
} finally {
  await browser.close()
}
