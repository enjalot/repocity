import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  buildCityLayout,
  firstAppearanceByPath,
  reconstruct,
  reconstructPair,
  type CityLayoutMode,
  type Replay,
  type ReplayEvent,
} from './city/model'
import type { CameraPreset, ThreeCityScene, ThreeSceneColors } from './city/threeScene'
import { buildFinalLocMarkdown, finalLocMarkdownFilename } from './markdownReport'

type Speed = 'inspect' | 'fast' | 'timelapse' | 'turbo' | 'warp' | 'hyper'

type RepoCityConfig = {
  title: string
  subtitle: string
  dataUrl: string
  city: {
    layout: CityLayoutMode
    neighborhoodDepth: number
    blockLines: number
    alleyWidth: number
    speed: Speed
    camera: CameraPreset
    autoRotate: boolean
  }
  theme: {
    accent: string
    source: string
    test: string
    deleted: string
    add: string
    remove: string
    sky: string
  }
}

type Demo = {
  id: string
  label: string
  repository: string
  repositoryUrl: string
  description: string
  dataUrl: string
}

type DemoCatalog = {
  demos: Demo[]
}

type Hover = {
  pathId: number
  x: number
  y: number
  path: string
  category: 'source' | 'test'
  lines: number
  blocks: number
  peakLoc: number
}

const BASE_COMMIT_DURATION = 2300
const DURATION: Record<Speed, number> = {
  inspect: BASE_COMMIT_DURATION,
  fast: BASE_COMMIT_DURATION / 4,
  timelapse: BASE_COMMIT_DURATION / 16,
  turbo: BASE_COMMIT_DURATION / 32,
  warp: BASE_COMMIT_DURATION / 100,
  hyper: BASE_COMMIT_DURATION / 200,
}

const EFFECT_DURATION = 900

const DETAILED_EFFECTS: Record<Speed, number> = {
  inspect: 7,
  fast: 7,
  timelapse: 7,
  turbo: 7,
  warp: 1,
  hyper: 1,
}

const SPEEDS: [Speed, string][] = [
  ['inspect', '1×'],
  ['fast', '4×'],
  ['timelapse', '16×'],
  ['turbo', '32×'],
  ['warp', '100×'],
  ['hyper', '200×'],
]

const LAYOUTS: { value: CityLayoutMode; label: string; note: string }[] = [
  {
    value: 'files',
    label: 'Equal files',
    note: 'Every historical source or test file gets equal ground area. Height alone encodes current LOC.',
  },
  {
    value: 'peak',
    label: 'Peak area',
    note: 'Stable binary-treemap lots use historical peak LOC for area. Height shows current LOC.',
  },
  {
    value: 'squarify',
    label: 'Squarified LOC',
    note: 'Area uses historical peak LOC with squarified lots to avoid long, thin buildings.',
  },
]

const FALLBACK_CONFIG: RepoCityConfig = {
  title: 'RepoCity',
  subtitle: 'A replayable city built from Git history',
  dataUrl: '/data/replay.json',
  city: {
    layout: 'files',
    neighborhoodDepth: 3,
    blockLines: 50,
    alleyWidth: 1.55,
    speed: 'fast',
    camera: 'isometric',
    autoRotate: false,
  },
  theme: {
    accent: '#4fd1c5',
    source: '#756cc1',
    test: '#d5a248',
    deleted: '#151b27',
    add: '#35d5ff',
    remove: '#ff63c5',
    sky: '#0c111d',
  },
}

function requestedDataset(): string | null {
  const dataset = new URLSearchParams(window.location.search).get('dataset')
  return dataset && /^[A-Za-z0-9._-]+$/.test(dataset) ? dataset : null
}

function downloadFinalLocReport(replay: Replay) {
  const blob = new Blob([buildFinalLocMarkdown(replay)], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = finalLocMarkdownFilename(replay.repo)
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function publicAssetUrl(value: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(value)) return value
  const base = new URL(import.meta.env.BASE_URL, window.location.href)
  return new URL(value.replace(/^\/+/, ''), base).toString()
}

async function responseJson<T>(response: Response, url: string): Promise<T> {
  const isGzipFile = new URL(url, window.location.href).pathname.endsWith('.gz')
  if (!isGzipFile || response.headers.get('content-encoding')) {
    return await response.json() as T
  }
  if (!response.body || typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the RepoCity demo data')
  }
  const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'))
  return await new Response(decompressed).json() as T
}

function useWidth(ref: React.RefObject<HTMLDivElement>) {
  const [width, setWidth] = useState(1100)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => setWidth(Math.max(300, node.clientWidth))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function cssValue(style: CSSStyleDeclaration, name: string) {
  return style.getPropertyValue(name).trim()
}

function sceneColors(canvas: HTMLCanvasElement): ThreeSceneColors {
  const style = getComputedStyle(canvas)
  return {
    source: cssValue(style, '--city3-source'),
    test: cssValue(style, '--city3-test'),
    empty: cssValue(style, '--city3-empty'),
    ground: cssValue(style, '--city3-ground'),
    district: cssValue(style, '--city3-district'),
    road: cssValue(style, '--city3-road'),
    label: cssValue(style, '--city3-label'),
    hover: cssValue(style, '--city3-hover'),
    add: cssValue(style, '--city3-add'),
    remove: cssValue(style, '--city3-remove'),
    person: cssValue(style, '--city-person'),
    assisted: cssValue(style, '--city-assisted'),
    factory: cssValue(style, '--city-factory'),
    automation: cssValue(style, '--city-automation'),
    sky: cssValue(style, '--city3-sky'),
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(Math.round(value))
}

function eventFileStats(replay: Replay, event: ReplayEvent | undefined) {
  if (!event) return { additions: 0, removals: 0, files: 0 }
  let additions = 0
  let removals = 0
  const files = new Set<number>()
  for (const [pathId, added, removed] of event.changes) {
    const category = replay.paths[pathId]?.category
    if (category !== 'source' && category !== 'test') continue
    additions += added
    removals += removed
    files.add(pathId)
  }
  return { additions, removals, files: files.size }
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function App() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<ThreeCityScene | null>(null)
  const width = useWidth(wrapRef)
  const height = width < 640 ? 560 : Math.min(760, Math.max(620, width * 0.64))
  const [config, setConfig] = useState<RepoCityConfig>(FALLBACK_CONFIG)
  const [demos, setDemos] = useState<Demo[]>([])
  const [activeDemoId, setActiveDemoId] = useState('')
  const [replay, setReplay] = useState<Replay | null>(null)
  const [eventIndex, setEventIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(FALLBACK_CONFIG.city.speed)
  const [layoutMode, setLayoutMode] = useState<CityLayoutMode>(FALLBACK_CONFIG.city.layout)
  const [neighborhoodDepth, setNeighborhoodDepth] = useState(
    FALLBACK_CONFIG.city.neighborhoodDepth,
  )
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>(FALLBACK_CONFIG.city.camera)
  const [blockLines, setBlockLines] = useState(FALLBACK_CONFIG.city.blockLines)
  const [autoTurn, setAutoTurn] = useState(FALLBACK_CONFIG.city.autoRotate)
  const [hover, setHover] = useState<Hover | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sceneVersion, setSceneVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const [configResponse, catalogResponse] = await Promise.all([
          fetch(publicAssetUrl('repocity.config.json'), { signal: controller.signal }),
          fetch(publicAssetUrl('demos.json'), { signal: controller.signal }),
        ])
        const loadedConfig = configResponse.ok
          ? await configResponse.json() as Partial<RepoCityConfig>
          : {}
        const catalog = catalogResponse.ok
          ? await catalogResponse.json() as DemoCatalog
          : { demos: [] }
        const nextConfig: RepoCityConfig = {
          ...FALLBACK_CONFIG,
          ...loadedConfig,
          city: { ...FALLBACK_CONFIG.city, ...loadedConfig.city },
          theme: { ...FALLBACK_CONFIG.theme, ...loadedConfig.theme },
        }
        setConfig(nextConfig)
        setSpeed(nextConfig.city.speed)
        setLayoutMode(nextConfig.city.layout)
        setNeighborhoodDepth(nextConfig.city.neighborhoodDepth)
        setCameraPreset(nextConfig.city.camera)
        setBlockLines(nextConfig.city.blockLines)
        setAutoTurn(nextConfig.city.autoRotate)
        setDemos(catalog.demos)
        const dataset = requestedDataset()
        const selectedDemo = catalog.demos.find((demo) => demo.id === dataset)
        const replayPath = selectedDemo?.dataUrl
          ?? (dataset ? `data/${dataset}.json` : nextConfig.dataUrl)
        const replayUrl = publicAssetUrl(replayPath)
        setActiveDemoId(
          selectedDemo?.id
            ?? catalog.demos.find((demo) => demo.dataUrl === nextConfig.dataUrl)?.id
            ?? '',
        )
        const replayResponse = await fetch(replayUrl, {
          signal: controller.signal,
        })
        if (!replayResponse.ok) throw new Error(`Replay request failed with ${replayResponse.status}`)
        const nextReplay = await responseJson<Replay>(replayResponse, replayUrl)
        if (!nextReplay.events.length) throw new Error('Replay contains no commits')
        setReplay(nextReplay)
        setEventIndex(0)
      } catch (cause) {
        if ((cause as { name?: string }).name !== 'AbortError') {
          setError(cause instanceof Error ? cause.message : 'Could not load RepoCity data')
        }
      }
    }
    load()
    return () => controller.abort()
  }, [])

  const layout = useMemo(
    () => (replay ? buildCityLayout(replay.paths, layoutMode, neighborhoodDepth) : null),
    [layoutMode, neighborhoodDepth, replay],
  )
  const firstAppearance = useMemo(
    () => replay ? firstAppearanceByPath(replay.events, replay.paths.length) : null,
    [replay],
  )
  const replayState = useMemo(
    () => replay ? reconstructPair(replay, eventIndex) : null,
    [eventIndex, replay],
  )
  const event = replay?.events[eventIndex]
  const activeDemo = useMemo(
    () => demos.find((demo) => demo.id === activeDemoId),
    [activeDemoId, demos],
  )
  const fileStats = useMemo(
    () => replay ? eventFileStats(replay, event) : { additions: 0, removals: 0, files: 0 },
    [event, replay],
  )
  const layoutNote = LAYOUTS.find((item) => item.value === layoutMode)?.note ?? ''

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !firstAppearance || !layout || !replay) return
    let cancelled = false
    let created: ThreeCityScene | null = null
    setHover(null)
    import('./city/threeScene').then(({ ThreeCityScene: Scene }) => {
      if (cancelled) return
      created = new Scene(
        canvas,
        layout,
        replay.paths,
        firstAppearance,
        sceneColors(canvas),
        config.city.alleyWidth,
      )
      sceneRef.current = created
      created.setSize(width, height)
      created.setView(cameraPreset)
      created.setState(reconstruct(replay, eventIndex), blockLines, eventIndex)
      setSceneVersion((version) => version + 1)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not start WebGL')
    })
    return () => {
      cancelled = true
      created?.dispose()
      if (sceneRef.current === created) sceneRef.current = null
    }
  }, [config.city.alleyWidth, firstAppearance, layout, replay])

  useEffect(() => sceneRef.current?.setView(cameraPreset), [cameraPreset, sceneVersion])
  useEffect(() => sceneRef.current?.setSize(width, height), [height, sceneVersion, width])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !replay || !event || !replayState) return
    const { before, after } = replayState
    const showWorkers = speed === 'inspect' || speed === 'fast' || speed === 'timelapse'
    const effectDelay = playing && showWorkers ? DURATION[speed] * 0.68 : 0
    scene.beginEvent(
      before,
      after,
      event,
      eventIndex,
      blockLines,
      playing && !reducedMotion() ? EFFECT_DURATION : 0,
      showWorkers,
      DETAILED_EFFECTS[speed],
      effectDelay,
    )
    if (!playing) {
      scene.updateEvent(1)
      setHover((current) => current && scene.isPathVisible(current.pathId) ? {
          ...current,
          lines: scene.linesForPath(current.pathId),
          blocks: scene.linesForPath(current.pathId) / blockLines,
        } : null)
      scene.render()
      return
    }
    const started = performance.now()
    let frame = 0
    let advanced = false
    let lastHoverUpdate = 0
    const draw = (now: number) => {
      const progress = Math.min(1, (now - started) / DURATION[speed])
      scene.updateEvent(progress)
      if (now - lastHoverUpdate > 80) {
        lastHoverUpdate = now
        setHover((current) => current && scene.isPathVisible(current.pathId) ? {
            ...current,
            lines: scene.linesForPath(current.pathId),
            blocks: scene.linesForPath(current.pathId) / blockLines,
          } : null)
      }
      scene.tickEffects(now)
      scene.turntableFrame()
      if (progress < 1) {
        frame = requestAnimationFrame(draw)
      } else if (!advanced) {
        advanced = true
        if (eventIndex < replay.events.length - 1) {
          setEventIndex((current) => current === eventIndex ? current + 1 : current)
        } else {
          setPlaying(false)
        }
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [blockLines, event, eventIndex, playing, replay, replayState, sceneVersion, speed])

  useEffect(() => {
    if (!sceneVersion || playing) return
    let frame = 0
    const tick = (now: number) => {
      const changed = sceneRef.current?.tickEffects(now)
      if (!changed) return
      if (!autoTurn) sceneRef.current?.render()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [autoTurn, playing, sceneVersion])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setAutoRotate(autoTurn)
    if (!autoTurn || playing) {
      scene.render()
      return
    }
    let frame = 0
    const turn = () => {
      scene.turntableFrame()
      frame = requestAnimationFrame(turn)
    }
    frame = requestAnimationFrame(turn)
    return () => cancelAnimationFrame(frame)
  }, [autoTurn, playing, sceneVersion])

  const currentLines = useMemo(() => {
    if (!layout || !replayState) return 0
    return layout.lots.reduce((sum, lot) => sum + (replayState.after[lot.pathId] ?? 0), 0)
  }, [layout, replayState])

  const clearHover = () => {
    sceneRef.current?.clearHover()
    setHover(null)
  }

  const chooseDemo = (id: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('dataset', id)
    window.location.assign(url)
  }

  const handlePointerMove = (pointerEvent: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current
    if (!scene) return
    const rect = pointerEvent.currentTarget.getBoundingClientRect()
    const hit = scene.pick(pointerEvent.clientX, pointerEvent.clientY, rect)
    if (!hit) {
      clearHover()
      return
    }
    setHover({
      pathId: hit.lot.pathId,
      x: Math.min(rect.width - 250, Math.max(8, pointerEvent.clientX - rect.left + 14)),
      y: Math.min(rect.height - 112, Math.max(8, pointerEvent.clientY - rect.top - 54)),
      path: hit.lot.path,
      category: hit.lot.category,
      lines: hit.lines,
      blocks: hit.lines / blockLines,
      peakLoc: hit.lot.peakLoc,
    })
  }

  const play = () => {
    if (!replay) return
    setEventIndex((current) => current >= replay.events.length - 1 ? 0 : current + 1)
    setPlaying(true)
  }

  const cssTheme = {
    '--accent': config.theme.accent,
    '--city3-source': config.theme.source,
    '--city3-test': config.theme.test,
    '--city3-empty': config.theme.deleted,
    '--city3-add': config.theme.add,
    '--city3-remove': config.theme.remove,
    '--city3-sky': config.theme.sky,
  } as CSSProperties

  const author = replay && event ? replay.people[event.author]?.name ?? 'Unknown' : ''
  const excludedLoc = replay?.summary
    ? (replay.summary.locByCategory.fixture ?? 0) + (replay.summary.locByCategory.generated ?? 0)
    : 0

  return (
    <main className="app" style={cssTheme}>
      <header className="page-header">
        <div>
          <span className="eyebrow">Git history, rendered</span>
          <h1>{config.title}</h1>
          <p>{config.subtitle}</p>
          {demos.length ? (
            <label className="demo-picker">
              Demo
              <select value={activeDemoId} onChange={(change) => chooseDemo(change.target.value)}>
                {demos.map((demo) => (
                  <option key={demo.id} value={demo.id}>{demo.label}</option>
                ))}
              </select>
            </label>
          ) : null}
          {activeDemo ? (
            <div className="demo-note">
              {activeDemo.description}{' '}
              <a href={activeDemo.repositoryUrl}>View {activeDemo.repository} on GitHub</a>.
            </div>
          ) : null}
        </div>
        {replay ? (
          <dl className="repo-summary">
            <div><dt>Repository</dt><dd>{replay.repo}</dd></div>
            <div><dt>Commits</dt><dd>{formatNumber(replay.events.length)}</dd></div>
            <div><dt>Source + test LOC</dt><dd>{formatNumber(currentLines)}</dd></div>
            <div><dt>Fixtures/generated outside city</dt><dd>{formatNumber(excludedLoc)} LOC</dd></div>
          </dl>
        ) : null}
      </header>

      <section ref={wrapRef} className="city-shell">
        <div className="controls" aria-label="RepoCity controls">
          <div className="control-group">
            <span>View</span>
            {([['aerial', 'Aerial'], ['isometric', 'Isometric']] as [CameraPreset, string][]).map(([value, label]) => (
              <button key={value} className={cameraPreset === value ? 'active' : ''} onClick={() => setCameraPreset(value)}>{label}</button>
            ))}
            <button aria-label="Zoom out" onClick={() => sceneRef.current?.zoomBy(0.82)}>−</button>
            <button aria-label="Zoom in" onClick={() => sceneRef.current?.zoomBy(1.22)}>+</button>
            <button className={autoTurn ? 'active' : ''} onClick={() => setAutoTurn((current) => !current)}>Turntable</button>
            <button onClick={() => sceneRef.current?.resetView()}>Reset</button>
          </div>
          <div className="control-group">
            <span>Layout</span>
            {LAYOUTS.map(({ value, label }) => (
              <button key={value} className={layoutMode === value ? 'active' : ''} onClick={() => { setPlaying(false); setLayoutMode(value) }}>{label}</button>
            ))}
          </div>
          <label className="select-control">
            Neighborhoods
            <select
              aria-label="Neighborhood folder depth"
              value={neighborhoodDepth}
              onChange={(change) => {
                setPlaying(false)
                setNeighborhoodDepth(Number(change.target.value))
              }}
            >
              <option value={1}>1 folder deep</option>
              <option value={2}>2 folders deep</option>
              <option value={3}>3 folders deep</option>
            </select>
          </label>
          <label className="select-control">
            Lines / block
            <select value={blockLines} onChange={(change) => setBlockLines(Number(change.target.value))}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
          </label>
          {replay ? (
            <div className="control-group">
              <span>Export</span>
              <button
                type="button"
                title="Download the top 1,000 source and test files from the final replay state"
                onClick={() => downloadFinalLocReport(replay)}
              >
                Final LOCs (.md)
              </button>
            </div>
          ) : null}
        </div>
        <p className="layout-note">
          {layoutNote} Neighborhoods group files by their first {neighborhoodDepth}{' '}
          {neighborhoodDepth === 1 ? 'folder' : 'folders'} without changing replay data.
        </p>

        {replay && event ? (
          <>
            <div className="commit-status" aria-live="polite">
              <div>
                <span>{new Date(event.committedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
                <strong>{event.subject}</strong>
              </div>
              <div>
                {author} · {event.authorship} · {fileStats.files} city files ·{' '}
                <span className="addition">+{formatNumber(fileStats.additions)}</span>{' '}
                <span className="removal">−{formatNumber(fileStats.removals)}</span>
              </div>
            </div>
            <div className="stage">
              <canvas
                ref={canvasRef}
                style={{ height }}
                role="img"
                aria-label={`Rotatable three-dimensional code city for ${replay.repo}. ${formatNumber(currentLines)} source and test lines are present.`}
                onPointerMove={handlePointerMove}
                onPointerLeave={clearHover}
              />
              <div className="hint">drag to orbit · wheel/pinch to zoom · hover any building</div>
              {hover ? (
                <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
                  <strong>{hover.path}</strong>
                  {hover.lines > 0 ? (
                    <>
                      <span>{hover.category} · {formatNumber(hover.lines)} lines</span>
                      <span>{hover.blocks.toFixed(2)} blocks at this setting</span>
                    </>
                  ) : (
                    <>
                      <span>deleted</span>
                      <span>{hover.category} · historical peak {formatNumber(hover.peakLoc)} lines</span>
                    </>
                  )}
                </div>
              ) : null}
              <div className="legend" aria-hidden="true">
                <span className="source">source</span>
                <span className="test">tests</span>
                <span className="deleted">deleted</span>
                <span className="add">add</span>
                <span className="remove">remove</span>
              </div>
              {!sceneVersion && !error ? <div className="loading">Starting WebGL city…</div> : null}
              {error ? <div className="loading error">{error}</div> : null}
            </div>
            <div className="scrubber">
              <div className="scrubber-actions">
                <button
                  className="playback-button"
                  aria-pressed={playing}
                  onClick={() => playing ? setPlaying(false) : play()}
                >
                  {playing ? 'Pause' : 'Play'}
                </button>
              </div>
              <input
                aria-label="Replay commit"
                type="range"
                min={0}
                max={replay.events.length - 1}
                value={eventIndex}
                onChange={(change) => { setPlaying(false); setEventIndex(Number(change.target.value)) }}
              />
              <span>{eventIndex + 1} / {replay.events.length}</span>
            </div>
            <div className="speed-controls">
              <div className="control-group">
                <span>Speed</span>
                {SPEEDS.map(([value, label]) => (
                  <button key={value} className={speed === value ? 'active' : ''} onClick={() => setSpeed(value)}>{label}</button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">{error ?? 'Loading replay data…'}</div>
        )}
      </section>
    </main>
  )
}
