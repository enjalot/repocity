import * as d3 from 'd3'

export type CityCategory = 'source' | 'test'
export type CityLayoutMode = 'peak' | 'files' | 'squarify'

export type ReplayPath = {
  id: number
  path: string
  category: string
  peakLoc: number
  finalLoc: number
}

export type ReplayPerson = {
  id: number
  name: string
  kind: string
}

export type ReplayChange = [
  pathId: number,
  additions: number,
  removals: number,
  status: number,
  oldPathId: number,
]

export type ReplayEvent = {
  sha: string
  sourceRepo: string
  authoredAt: string
  committedAt: string
  author: number
  subject: string
  additions: number
  removals: number
  testAdditions: number
  testRemovals: number
  signals: string[]
  authorship: 'factory' | 'agent-assisted' | 'automation' | 'unmarked'
  changes: ReplayChange[]
}

export type Replay = {
  version: number
  repo: string
  ref: string
  tip: string
  start: string
  end: string
  people: ReplayPerson[]
  paths: ReplayPath[]
  events: ReplayEvent[]
  checkpoints: [eventIndex: number, loc: [pathId: number, lines: number][]][]
  summary?: {
    commits: number
    filesByCategory: Record<string, number>
    locByCategory: Record<string, number>
    binaryChanges: number
  }
}

type TreeDatum = {
  name: string
  path: string
  peakLoc: number
  pathId?: number
  category?: CityCategory
  children?: TreeDatum[]
}

export type Point = { x: number; y: number }

export type CityLot = {
  pathId: number
  path: string
  category: CityCategory
  peakLoc: number
  x0: number
  y0: number
  x1: number
  y1: number
  route: Point[]
  routeLength: number
}

export type CityDistrict = {
  name: string
  isDirectory: boolean
  x0: number
  y0: number
  x1: number
  y1: number
}

export type CityLayout = {
  width: number
  height: number
  gate: Point
  gates: Point[]
  mode: CityLayoutMode
  neighborhoodDepth: number
  lots: CityLot[]
  lotByPath: Map<number, CityLot>
  districts: CityDistrict[]
}

export const WORLD_WIDTH = 760
export const WORLD_HEIGHT = 470

function makeTree(paths: ReplayPath[], neighborhoodDepth: number): TreeDatum {
  const root: TreeDatum = { name: 'root', path: '', peakLoc: 0, children: [] }
  const neighborhoods = new Map<string, TreeDatum>()
  for (const item of paths) {
    if ((item.category !== 'source' && item.category !== 'test') || item.peakLoc <= 0) continue
    const parts = item.path.split('/')
    const neighborhoodPath = parts.slice(0, -1).slice(0, neighborhoodDepth).join('/')
    let neighborhood = neighborhoods.get(neighborhoodPath)
    if (!neighborhood) {
      neighborhood = {
        name: neighborhoodPath || '(root)',
        path: neighborhoodPath,
        peakLoc: 0,
        children: [],
      }
      neighborhoods.set(neighborhoodPath, neighborhood)
      root.children?.push(neighborhood)
    }
    neighborhood.children?.push({
      name: parts[parts.length - 1],
      path: item.path,
      peakLoc: Math.max(1, item.peakLoc),
      pathId: item.id,
      category: item.category,
    })
  }
  return root
}

function compactPoints(points: Point[]): Point[] {
  return points.filter((point, index) => {
    const previous = points[index - 1]
    return !previous || Math.abs(previous.x - point.x) > 0.01 || Math.abs(previous.y - point.y) > 0.01
  })
}

function routeLength(points: Point[]) {
  return d3.sum(points.slice(1), (point, index) => {
    const previous = points[index]
    return Math.hypot(point.x - previous.x, point.y - previous.y)
  })
}

function layoutValue(datum: TreeDatum, mode: CityLayoutMode) {
  if (datum.pathId === undefined) return 0
  if (mode === 'files') return 1
  return Math.max(1, datum.peakLoc)
}

function closestGate(gates: Point[], target: Point) {
  return d3.least(gates, (gate) => Math.hypot(target.x - gate.x, target.y - gate.y)) ?? gates[0]
}

export function buildCityLayout(
  paths: ReplayPath[],
  mode: CityLayoutMode = 'peak',
  requestedNeighborhoodDepth = 1,
): CityLayout {
  const neighborhoodDepth = Math.max(1, Math.min(3, Math.round(requestedNeighborhoodDepth)))
  const tree = d3
    .hierarchy<TreeDatum>(makeTree(paths, neighborhoodDepth))
    .sum((datum) => layoutValue(datum, mode))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || d3.ascending(a.data.path, b.data.path))

  const laidOut = d3
    .treemap<TreeDatum>()
    .tile(mode === 'peak' ? d3.treemapBinary : d3.treemapSquarify)
    .size([WORLD_WIDTH, WORLD_HEIGHT])
    .round(false)
    .paddingOuter((node) => (node.depth === 0 ? 5 : 0))
    .paddingInner((node) => (node.depth === 0 ? 6 : 0))
    .paddingTop(0)
    .paddingBottom((node) => (node.depth === 1 ? 9 : 0))(tree)

  const gates = [
    { x: 8, y: 8 },
    { x: WORLD_WIDTH - 8, y: 8 },
    { x: WORLD_WIDTH - 8, y: WORLD_HEIGHT - 8 },
    { x: 8, y: WORLD_HEIGHT - 8 },
  ]
  const gate = gates[3]
  const lots: CityLot[] = laidOut.leaves().flatMap((leaf) => {
    const datum = leaf.data
    if (datum.pathId === undefined || !datum.category) return []
    const ancestors = leaf.ancestors().reverse().slice(1, -1)
    const center = { x: (leaf.x0 + leaf.x1) / 2, y: (leaf.y0 + leaf.y1) / 2 }
    const lotGate = closestGate(gates, center)
    const fromLeft = lotGate.x < WORLD_WIDTH / 2
    const fromTop = lotGate.y < WORLD_HEIGHT / 2
    const route: Point[] = [lotGate]
    for (const ancestor of ancestors) {
      const inset = Math.min(2.5, Math.max(0.4, (ancestor.y1 - ancestor.y0) / 5))
      const horizontalInset = Math.min(2.5, Math.max(0.4, (ancestor.x1 - ancestor.x0) / 5))
      const roadY = fromTop ? ancestor.y0 + inset : ancestor.y1 - inset
      const roadX = fromLeft ? ancestor.x0 + horizontalInset : ancestor.x1 - horizontalInset
      route.push({ x: roadX, y: route[route.length - 1].y })
      route.push({ x: roadX, y: roadY })
    }
    const edgeOffset = Math.min(1.5, Math.max(0.25, (leaf.y1 - leaf.y0) / 4))
    const edge = {
      x: center.x,
      y: fromTop
        ? Math.max(1, leaf.y0 - edgeOffset)
        : Math.min(WORLD_HEIGHT - 1, leaf.y1 + edgeOffset),
    }
    route.push({ x: edge.x, y: route[route.length - 1].y })
    route.push(edge)
    const cleanRoute = compactPoints(route)
    return [
      {
        pathId: datum.pathId,
        path: datum.path,
        category: datum.category,
        peakLoc: datum.peakLoc,
        x0: leaf.x0,
        y0: leaf.y0,
        x1: leaf.x1,
        y1: leaf.y1,
        route: cleanRoute,
        routeLength: routeLength(cleanRoute),
      },
    ]
  })

  lots.sort((a, b) => a.x0 + a.y0 - (b.x0 + b.y0))
  const lotByPath = new Map(lots.map((lot) => [lot.pathId, lot]))
  const districts: CityDistrict[] = (laidOut.children ?? []).map((node) => ({
    name: node.data.name,
    isDirectory: Boolean(node.children),
    x0: node.x0,
    y0: node.y0,
    x1: node.x1,
    y1: node.y1,
  }))
  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    gate,
    gates,
    mode,
    neighborhoodDepth,
    lots,
    lotByPath,
    districts,
  }
}

export function firstAppearanceByPath(events: ReplayEvent[], pathCount: number): Int32Array {
  const unseen = 2_147_483_647
  const firstAppearance = new Int32Array(pathCount)
  firstAppearance.fill(unseen)
  events.forEach((event, eventIndex) => {
    for (const [pathId, , , status, oldPathId] of event.changes) {
      const pathAppearance = status === 3 ? Math.max(0, eventIndex - 1) : eventIndex
      firstAppearance[pathId] = Math.min(firstAppearance[pathId], pathAppearance)
      if (oldPathId >= 0) {
        firstAppearance[oldPathId] = Math.min(
          firstAppearance[oldPathId],
          Math.max(0, eventIndex - 1),
        )
      }
    }
  })
  for (let pathId = 0; pathId < pathCount; pathId += 1) {
    if (firstAppearance[pathId] === unseen) firstAppearance[pathId] = 0
  }
  return firstAppearance
}

export function applyEvent(loc: Float64Array, event: ReplayEvent) {
  for (const [pathId, additions, removals, status, oldPathId] of event.changes) {
    if ((status === 4 || status === 5) && oldPathId >= 0) {
      const oldLines = loc[oldPathId] ?? 0
      if (status === 4) loc[oldPathId] = 0
      loc[pathId] = Math.max(0, oldLines + additions - removals)
    } else if (status === 3) {
      loc[pathId] = 0
    } else {
      loc[pathId] = Math.max(0, (loc[pathId] ?? 0) + additions - removals)
    }
  }
}

export function reconstruct(replay: Replay, eventIndex: number) {
  const loc = new Float64Array(replay.paths.length)
  if (eventIndex < 0) return loc
  eventIndex = Math.min(eventIndex, replay.events.length - 1)
  let start = 0
  // Find the last usable snapshot without materializing every earlier one.
  let low = 0
  let high = replay.checkpoints.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (replay.checkpoints[middle][0] <= eventIndex) low = middle + 1
    else high = middle
  }
  if (low > 0) {
    const [checkpointIndex, values] = replay.checkpoints[low - 1]
    for (const [pathId, lines] of values) loc[pathId] = lines
    start = checkpointIndex + 1
  }
  for (let index = start; index <= eventIndex; index += 1) {
    applyEvent(loc, replay.events[index])
  }
  return loc
}

export function reconstructPair(replay: Replay, eventIndex: number) {
  const before = reconstruct(replay, eventIndex - 1)
  const after = new Float64Array(before)
  const event = replay.events[eventIndex]
  if (event) applyEvent(after, event)
  return { before, after }
}

/** Sequential reads reuse the previous result; returned snapshots stay immutable. */
export function createReplayReader(replay: Replay) {
  let previousIndex = -2
  let previous: ReturnType<typeof reconstructPair> | null = null
  return (eventIndex: number) => {
    if (previous && previousIndex === eventIndex) return previous
    const before = previous && previousIndex === eventIndex - 1
      ? previous.after
      : reconstruct(replay, eventIndex - 1)
    const after = new Float64Array(before)
    const event = replay.events[eventIndex]
    if (event) applyEvent(after, event)
    previousIndex = eventIndex
    previous = { before, after }
    return previous
  }
}

export function pointOnRoute(route: Point[], distanceFraction: number): Point {
  if (route.length === 0) return { x: 0, y: 0 }
  if (route.length === 1) return route[0]
  const total = routeLength(route)
  let remaining = Math.max(0, Math.min(1, distanceFraction)) * total
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1]
    const end = route[index]
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    if (remaining <= length || index === route.length - 1) {
      const amount = length ? Math.min(1, remaining / length) : 1
      return {
        x: d3.interpolateNumber(start.x, end.x)(amount),
        y: d3.interpolateNumber(start.y, end.y)(amount),
      }
    }
    remaining -= length
  }
  return route[route.length - 1]
}

export function cityDeltas(
  layout: CityLayout,
  before: Float64Array,
  after: Float64Array,
  event?: ReplayEvent,
) {
  const touched = new Set<number>()
  for (const [pathId, , , status, oldPathId] of event?.changes ?? []) {
    touched.add(pathId)
    if (status === 4 && oldPathId >= 0) touched.add(oldPathId)
  }
  const lots = event
    ? [...touched].flatMap((id) => { const lot = layout.lotByPath.get(id); return lot ? [lot] : [] })
    : layout.lots
  return lots
    .map((lot) => ({ lot, before: before[lot.pathId] ?? 0, after: after[lot.pathId] ?? 0 }))
    .filter((change) => change.before !== change.after)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
}
