import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  cityDeltas,
  firstAppearanceByPath,
  pointOnRoute,
  type CityLayout,
  type CityLot,
  type ReplayEvent,
  type ReplayPath,
} from './model'

const WORLD_SCALE = 0.055
const BLOCK_HEIGHT = 0.14
const MIN_HEIGHT = 0.035
const MAX_WORKERS = 7
const MAX_TRAIL_EFFECTS = 512
const MAX_BURST_EFFECTS = 512
const TRAIL_RING_OUTER_RADIUS = 0.52
const RING_MIN_RADIUS_FRACTION = 0.225
const RING_MAX_SPAN_MULTIPLIER = 4.4
const RING_FULL_RADIUS_BLOCKS = 20
const LASER_FULL_ENERGY_BLOCKS = 500
const LASER_IMPACT_AT = 2 / 9
const LASER_PAIR_OFFSET = 0.09

export type ThreeSceneColors = {
  source: string
  test: string
  empty: string
  ground: string
  district: string
  road: string
  label: string
  hover: string
  add: string
  remove: string
  person: string
  assisted: string
  factory: string
  automation: string
  sky: string
}

export type ThreeCityHit = {
  lot: CityLot
  lines: number
}

export type CameraPreset = 'aerial' | 'isometric'

type LotBounds = {
  x: number
  z: number
  width: number
  depth: number
}

type BuildingSlot = {
  lot: CityLot
  mesh: THREE.InstancedMesh
  instanceId: number
  bounds: LotBounds
  state: 'future' | 'present' | 'deleted'
}

type LaserDirection = 'add' | 'remove'

type LaserAction = {
  lot: CityLot
  direction: LaserDirection
  amount: number
  before: number
  after: number
  startLines: number
  endLines: number
}

type Worker = {
  bot: THREE.Group
  botMaterials: THREE.MeshStandardMaterial[]
  route: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  action: LaserAction | null
}

type TrailEffect = {
  group: THREE.Group
  route: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  particles: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  action: LaserAction
  slot: BuildingSlot
  startedAt: number
  duration: number
  showRoute: boolean
}

type LaserBurstItem = {
  action: LaserAction
  slot: BuildingSlot
}

type LaserBurstEffect = {
  group: THREE.Group
  beams: THREE.InstancedMesh
  rings: THREE.InstancedMesh
  items: LaserBurstItem[]
  direction: LaserDirection
  startedAt: number
  duration: number
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function mix(start: number, end: number, amount: number) {
  return start + (end - start) * amount
}

function easeCubicInOut(value: number) {
  const amount = clamp01(value)
  return amount < 0.5 ? 4 * amount * amount * amount : 1 - Math.pow(-2 * amount + 2, 3) / 2
}

function easeCubicOut(value: number) {
  return 1 - Math.pow(1 - clamp01(value), 3)
}

function cityX(value: number) {
  return (value - WORLD_WIDTH / 2) * WORLD_SCALE
}

function cityZ(value: number) {
  return (value - WORLD_HEIGHT / 2) * WORLD_SCALE
}

function rayBoxDistance(ray: THREE.Ray, bounds: LotBounds, height: number) {
  let near = -Infinity
  let far = Infinity
  const axes: [origin: number, direction: number, min: number, max: number][] = [
    [ray.origin.x, ray.direction.x, bounds.x - bounds.width / 2, bounds.x + bounds.width / 2],
    [ray.origin.y, ray.direction.y, 0, height],
    [ray.origin.z, ray.direction.z, bounds.z - bounds.depth / 2, bounds.z + bounds.depth / 2],
  ]
  for (const [origin, direction, min, max] of axes) {
    if (Math.abs(direction) < 1e-8) {
      if (origin < min || origin > max) return null
      continue
    }
    let start = (min - origin) / direction
    let end = (max - origin) / direction
    if (start > end) [start, end] = [end, start]
    near = Math.max(near, start)
    far = Math.min(far, end)
    if (near > far) return null
  }
  if (far < 0) return null
  return near >= 0 ? near : far
}

function floorPoint(point: { x: number; y: number }, height = 0.1) {
  return new THREE.Vector3(cityX(point.x), height, cityZ(point.y))
}

function changeMagnitude(amount: number, blockLines: number) {
  const blocksChanged = amount / Math.max(1, blockLines)
  return clamp01(Math.sqrt(blocksChanged / RING_FULL_RADIUS_BLOCKS))
}

function changeEnergy(amount: number, blockLines: number) {
  const blocksChanged = amount / Math.max(1, blockLines)
  return clamp01(Math.sqrt(blocksChanged / LASER_FULL_ENERGY_BLOCKS))
}

function laserOffset(direction: LaserDirection) {
  return direction === 'add' ? -LASER_PAIR_OFFSET : LASER_PAIR_OFFSET
}

function laserMotion(
  startHeight: number,
  endHeight: number,
  amount: number,
  blockLines: number,
  progress: number,
) {
  const magnitude = changeMagnitude(amount, blockLines)
  const energy = changeEnergy(amount, blockLines)
  const impactHeight = Math.max(startHeight, endHeight) + 0.08
  const skyHeight = impactHeight + mix(2.4, 5.4, energy)
  const strike = easeCubicOut(progress / LASER_IMPACT_AT)
  const rebound = clamp01((progress - LASER_IMPACT_AT) / (1 - LASER_IMPACT_AT))
  const reboundArc = Math.sin(rebound * Math.PI)
  const strikeLength = (skyHeight - impactHeight) * strike
  const reboundLength = mix(0.45, 5, energy) * reboundArc
  const beamLength = Math.max(0.015, progress <= LASER_IMPACT_AT ? strikeLength : reboundLength)
  const beamBottom = progress <= LASER_IMPACT_AT ? skyHeight - beamLength : impactHeight
  const beamTop = beamBottom + beamLength
  const flareHeight = progress <= LASER_IMPACT_AT ? beamBottom : beamTop
  const phaseOpacity = progress <= LASER_IMPACT_AT
    ? mix(0.4, 1, strike)
    : Math.pow(reboundArc, 0.55) * mix(1, 0.55, rebound)
  const pulse = 0.78 + Math.sin(progress * Math.PI * 5) * 0.22
  const isRebound = progress > LASER_IMPACT_AT
  return {
    energy,
    isRebound,
    impactHeight,
    beamBottom,
    beamTop,
    flareHeight,
    beamLength,
    beamRadius: isRebound
      ? mix(1.1, 2.5, magnitude)
      : mix(0.28, 0.52, magnitude),
    beamOpacity: (isRebound ? mix(0.55, 1, energy) : mix(0.2, 0.42, energy)) * phaseOpacity * pulse,
    ringProgress: rebound,
    ringOpacity: mix(0.65, 1, energy) * Math.pow(1 - rebound, 0.55),
  }
}

function ringScaleFor(
  amount: number,
  blockLines: number,
  maxRadius: number,
  outerRadius: number,
  progress: number,
) {
  const magnitude = changeMagnitude(amount, blockLines)
  const radiusCap = maxRadius * RING_MAX_SPAN_MULTIPLIER
  const targetRadius = radiusCap * mix(RING_MIN_RADIUS_FRACTION, 1, magnitude)
  return (targetRadius / outerRadius) * mix(0.55, 1, easeCubicOut(progress))
}

function makeStripedMaterial(blockHeight: number) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.08,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBlockHeight = { value: blockHeight }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vCityHeight;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vCityHeight = (instanceMatrix * vec4(transformed, 1.0)).y;
        #else
          vCityHeight = transformed.y;
        #endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uBlockHeight;\nvarying float vCityHeight;',
      )
      .replace(
        '#include <opaque_fragment>',
        `float blockPhase = fract(max(vCityHeight, 0.0) / uBlockHeight);
        float blockEdge = min(blockPhase, 1.0 - blockPhase);
        float seamWidth = max(fwidth(vCityHeight / uBlockHeight) * 1.15, 0.025);
        float blockSeam = 1.0 - smoothstep(0.0, seamWidth, blockEdge);
        outgoingLight = mix(outgoingLight, outgoingLight * 0.48, blockSeam * 0.48);
        #include <opaque_fragment>`,
      )
  }
  material.customProgramCacheKey = () => 'city-block-seams-v1'
  return material
}

function textPlane(renderer: THREE.WebGLRenderer, text: string, color: string, width: number) {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 192
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create district label texture')
  context.clearRect(0, 0, canvas.width, canvas.height)
  let fontSize = 92
  context.font = `500 ${fontSize}px "Source Sans 3", system-ui, sans-serif`
  while (context.measureText(text).width > 900 && fontSize > 42) {
    fontSize -= 4
    context.font = `500 ${fontSize}px "Source Sans 3", system-ui, sans-serif`
  }
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineWidth = 7
  context.strokeStyle = 'rgba(8, 12, 22, 0.52)'
  context.strokeText(text, canvas.width / 2, canvas.height / 2)
  context.fillStyle = color
  context.fillText(text, canvas.width / 2, canvas.height / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
  texture.needsUpdate = true
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.82,
    alphaTest: 0.04,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  material.toneMapped = false
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, width * (canvas.height / canvas.width)), material)
  plane.rotation.x = -Math.PI / 2
  plane.renderOrder = 9
  return plane
}

function makeBot(): { group: THREE.Group; materials: THREE.MeshStandardMaterial[] } {
  const group = new THREE.Group()
  const materials: THREE.MeshStandardMaterial[] = []
  const material = () => {
    const next = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, metalness: 0.22 })
    materials.push(next)
    return next
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.24, 0.15), material())
  body.position.y = 0.25
  group.add(body)
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.17, 0.18), material())
  head.position.y = 0.47
  group.add(head)
  for (const x of [-0.055, 0.055]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.055), material())
    leg.position.set(x, 0.08, 0)
    group.add(leg)
  }
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.13, 6), material())
  antenna.position.set(0.035, 0.63, 0)
  group.add(antenna)
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xd9fbff })
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.035, 0.012), eyeMaterial)
  eye.position.set(0, 0.49, 0.097)
  group.add(eye)
  group.scale.setScalar(1.75)
  return { group, materials }
}

function makeWorker(scene: THREE.Scene): Worker {
  const { group: bot, materials: botMaterials } = makeBot()
  scene.add(bot)
  const route = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }),
  )
  scene.add(route)
  bot.visible = false
  route.visible = false
  return { bot, botMaterials, route, action: null }
}

function workerColor(event: ReplayEvent, colors: ThreeSceneColors) {
  if (event.authorship === 'factory') return colors.factory
  if (event.authorship === 'agent-assisted') return colors.assisted
  if (event.authorship === 'automation') return colors.automation
  return colors.person
}

export function collectLaserActions(
  layout: CityLayout,
  before: Float64Array,
  after: Float64Array,
  event: ReplayEvent,
) {
  const all: LaserAction[] = []
  for (const [pathId, additions, removals] of event.changes) {
    const lot = layout.lotByPath.get(pathId)
    if (!lot) continue
    const beforeLines = before[pathId] ?? 0
    const afterLines = after[pathId] ?? 0
    if (additions > 0) {
      all.push({
        lot,
        direction: 'add',
        amount: additions,
        before: beforeLines,
        after: afterLines,
        startLines: beforeLines,
        endLines: beforeLines + additions,
      })
    }
    if (removals > 0) {
      const startLines = Math.max(beforeLines + additions, afterLines + removals)
      all.push({
        lot,
        direction: 'remove',
        amount: removals,
        before: beforeLines,
        after: afterLines,
        startLines,
        endLines: Math.max(0, startLines - removals),
      })
    }
  }
  all.sort((a, b) => b.amount - a.amount || a.lot.path.localeCompare(b.lot.path))
  return all
}

function selectWorkerLaserActions(all: LaserAction[]) {
  const selected: LaserAction[] = []
  const largestAdd = all.find((action) => action.direction === 'add')
  const largestRemove = all.find((action) => action.direction === 'remove')
  if (largestAdd) selected.push(largestAdd)
  if (largestRemove) selected.push(largestRemove)
  for (const action of all) {
    if (selected.includes(action)) continue
    selected.push(action)
    if (selected.length >= MAX_WORKERS) break
  }
  return selected.slice(0, MAX_WORKERS)
}

export function selectLaserActions(
  layout: CityLayout,
  before: Float64Array,
  after: Float64Array,
  event: ReplayEvent,
) {
  return selectWorkerLaserActions(collectLaserActions(layout, before, after, event))
}

export class ThreeCityScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.OrthographicCamera
  readonly controls: OrbitControls

  private readonly layout: CityLayout
  private readonly colors: ThreeSceneColors
  private readonly alleyWidth: number
  private readonly sourceMesh: THREE.InstancedMesh
  private readonly testMesh: THREE.InstancedMesh
  private readonly sourceLots: CityLot[]
  private readonly testLots: CityLot[]
  private readonly slots = new Map<number, BuildingSlot>()
  private readonly firstAppearance: Int32Array
  private readonly workers: Worker[]
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly dummy = new THREE.Object3D()
  private readonly hoverOutline: THREE.LineSegments
  private readonly strikeLaserColor: THREE.Color
  private readonly addLaserColor: THREE.Color
  private readonly removeLaserColor: THREE.Color
  private averageBuildingSpan = 0.25
  private lines: Float64Array
  private blockLines = 100
  private stateEventIndex = -1
  private targetEventIndex = -1
  private activeDeltas: ReturnType<typeof cityDeltas> = []
  private readonly trailEffects: TrailEffect[] = []
  private readonly burstEffects: LaserBurstEffect[] = []
  private lastSpawnedSha: string | null = null
  private hoveredPathId: number | null = null
  private viewPreset: CameraPreset = 'aerial'

  constructor(
    canvas: HTMLCanvasElement,
    layout: CityLayout,
    paths: ReplayPath[],
    events: ReplayEvent[],
    colors: ThreeSceneColors,
    alleyWidth: number,
  ) {
    this.layout = layout
    this.colors = colors
    this.alleyWidth = alleyWidth
    this.strikeLaserColor = new THREE.Color(colors.label).lerp(new THREE.Color(colors.sky), 0.45)
    this.addLaserColor = new THREE.Color(colors.add)
    this.removeLaserColor = new THREE.Color(colors.remove)
    this.lines = new Float64Array(paths.length)
    this.firstAppearance = firstAppearanceByPath(events, paths.length)
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    this.renderer.setClearColor(colors.sky)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(colors.sky)
    this.scene.fog = new THREE.Fog(colors.sky, 52, 86)
    this.camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 140)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.set(0, 2.2, 0)
    this.controls.enablePan = false
    this.controls.enableZoom = true
    this.controls.minZoom = 0.62
    this.controls.maxZoom = 3.2
    this.controls.enableDamping = false
    this.controls.minPolarAngle = Math.PI * 0.14
    this.controls.maxPolarAngle = Math.PI * 0.48
    this.controls.autoRotateSpeed = 0.78
    this.controls.addEventListener('change', this.render)

    this.scene.add(new THREE.HemisphereLight(0xcad8ff, 0x191527, 2.25))
    const sun = new THREE.DirectionalLight(0xfff0ce, 2.35)
    sun.position.set(24, 42, 18)
    this.scene.add(sun)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_WIDTH * WORLD_SCALE + 4, WORLD_HEIGHT * WORLD_SCALE + 4),
      new THREE.MeshStandardMaterial({ color: colors.ground, roughness: 0.95, metalness: 0.02 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.045
    this.scene.add(ground)

    const districtMaterial = new THREE.MeshStandardMaterial({ color: colors.district, roughness: 0.9 })
    for (const district of layout.districts) {
      const width = Math.max(0.03, (district.x1 - district.x0) * WORLD_SCALE)
      const depth = Math.max(0.03, (district.y1 - district.y0) * WORLD_SCALE)
      const pad = new THREE.Mesh(new THREE.BoxGeometry(width, 0.04, depth), districtMaterial)
      pad.position.set(cityX((district.x0 + district.x1) / 2), -0.005, cityZ((district.y0 + district.y1) / 2))
      this.scene.add(pad)
    }

    const geometry = new THREE.BoxGeometry(1, 1, 1)
    this.sourceLots = layout.lots.filter((lot) => lot.category === 'source')
    this.testLots = layout.lots.filter((lot) => lot.category === 'test')
    this.sourceMesh = new THREE.InstancedMesh(geometry, makeStripedMaterial(BLOCK_HEIGHT), this.sourceLots.length)
    this.testMesh = new THREE.InstancedMesh(geometry.clone(), makeStripedMaterial(BLOCK_HEIGHT), this.testLots.length)
    this.sourceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.testMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.sourceMesh.frustumCulled = false
    this.testMesh.frustumCulled = false
    this.sourceMesh.name = 'source-buildings'
    this.testMesh.name = 'test-buildings'
    this.scene.add(this.sourceMesh, this.testMesh)
    this.indexLots(this.sourceMesh, this.sourceLots)
    this.indexLots(this.testMesh, this.testLots)
    for (const lot of this.layout.lots) this.setBuilding(lot.pathId, 0)
    this.flushInstances(true)
    const buildingDimensions = [...this.slots.values()].flatMap(({ bounds }) => [bounds.width, bounds.depth])
    if (buildingDimensions.length) {
      this.averageBuildingSpan = buildingDimensions.reduce((sum, value) => sum + value, 0) / buildingDimensions.length
    }

    const edgeGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1), 24)
    this.hoverOutline = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({ color: colors.hover, transparent: true, opacity: 0.95 }),
    )
    this.hoverOutline.visible = false
    this.hoverOutline.renderOrder = 5
    this.scene.add(this.hoverOutline)

    for (const district of layout.districts.filter((item) => item.isDirectory)) {
      const districtWidth = (district.x1 - district.x0) * WORLD_SCALE
      const width = Math.min(7.4, Math.max(0.72, districtWidth * 0.64))
      const frontInset = Math.min(4.5, Math.max(0.8, (district.y1 - district.y0) * 0.22))
      const label = textPlane(this.renderer, district.name, colors.label, width)
      label.name = `district-label:${district.name}`
      label.position.set(
        cityX((district.x0 + district.x1) / 2),
        0.13,
        cityZ(district.y1 - frontInset),
      )
      this.scene.add(label)
    }

    this.workers = Array.from({ length: MAX_WORKERS }, () => makeWorker(this.scene))
    this.setSize(900, 700)
    this.resetView()
  }

  private bounds(lot: CityLot): LotBounds {
    const lotWidth = lot.x1 - lot.x0
    const lotDepth = lot.y1 - lot.y0
    const inset = Math.min(
      this.alleyWidth,
      Math.max(0.18, Math.min(lotWidth, lotDepth) * 0.19),
    )
    return {
      x: cityX((lot.x0 + lot.x1) / 2),
      z: cityZ((lot.y0 + lot.y1) / 2),
      width: Math.max(0.025, (lotWidth - inset * 2) * WORLD_SCALE),
      depth: Math.max(0.025, (lotDepth - inset * 2) * WORLD_SCALE),
    }
  }

  private indexLots(mesh: THREE.InstancedMesh, lots: CityLot[]) {
    lots.forEach((lot, instanceId) => {
      this.slots.set(lot.pathId, {
        lot,
        mesh,
        instanceId,
        bounds: this.bounds(lot),
        state: 'future',
      })
    })
  }

  private heightFor(lines: number) {
    return Math.max(MIN_HEIGHT, (Math.max(0, lines) / this.blockLines) * BLOCK_HEIGHT)
  }

  private setBuilding(pathId: number, lines: number) {
    const slot = this.slots.get(pathId)
    if (!slot) return
    const future = lines <= 0 && this.stateEventIndex < this.firstAppearance[pathId]
    slot.state = future ? 'future' : lines > 0 ? 'present' : 'deleted'
    if (future) {
      this.dummy.position.set(slot.bounds.x, 0, slot.bounds.z)
      this.dummy.scale.set(0, 0, 0)
      this.dummy.rotation.set(0, 0, 0)
      this.dummy.updateMatrix()
      slot.mesh.setMatrixAt(slot.instanceId, this.dummy.matrix)
      return
    }
    const height = this.heightFor(lines)
    this.dummy.position.set(slot.bounds.x, height / 2, slot.bounds.z)
    this.dummy.scale.set(slot.bounds.width, height, slot.bounds.depth)
    this.dummy.rotation.set(0, 0, 0)
    this.dummy.updateMatrix()
    slot.mesh.setMatrixAt(slot.instanceId, this.dummy.matrix)
    slot.mesh.setColorAt(
      slot.instanceId,
      new THREE.Color(lines > 0 ? (slot.lot.category === 'test' ? this.colors.test : this.colors.source) : this.colors.empty),
    )
  }

  private flushInstances(colors = false) {
    this.sourceMesh.instanceMatrix.needsUpdate = true
    this.testMesh.instanceMatrix.needsUpdate = true
    if (colors) {
      if (this.sourceMesh.instanceColor) this.sourceMesh.instanceColor.needsUpdate = true
      if (this.testMesh.instanceColor) this.testMesh.instanceColor.needsUpdate = true
    }
  }

  setState(lines: Float64Array, blockLines: number, eventIndex: number) {
    this.lines = new Float64Array(lines)
    this.blockLines = blockLines
    this.stateEventIndex = eventIndex
    this.targetEventIndex = eventIndex
    for (const lot of this.layout.lots) this.setBuilding(lot.pathId, this.lines[lot.pathId] ?? 0)
    this.flushInstances(true)
    this.refreshHover()
    this.render()
  }

  private disposeTrailEffect(effect: TrailEffect) {
    this.scene.remove(effect.group)
    effect.group.traverse((object) => {
      if (!(object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Mesh)) return
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) material.dispose()
    })
  }

  private makeTrailEffect(
    action: LaserAction,
    authorColor: THREE.Color,
    duration: number,
    startedAt: number,
    showRoute: boolean,
  ): TrailEffect | null {
    const slot = this.slots.get(action.lot.pathId)
    if (!slot) return null
    const group = new THREE.Group()
    const trailColor = authorColor.clone().lerp(new THREE.Color(this.colors.label), 0.34)
    const route = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        action.lot.route.map((point) => floorPoint(point, 0.12)),
      ),
      new THREE.LineBasicMaterial({
        color: trailColor,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    route.renderOrder = 6
    group.add(route)

    const particlePoints = Array.from({ length: 30 }, (_, index) => {
      const point = pointOnRoute(action.lot.route, index / 29)
      const vector = floorPoint(point, 0.14 + (index % 4) * 0.026)
      vector.x += Math.sin(index * 12.9898 + action.lot.pathId) * 0.035
      vector.z += Math.cos(index * 7.233 + action.lot.pathId) * 0.035
      return vector
    })
    const particleGeometry = new THREE.BufferGeometry().setFromPoints(particlePoints)
    particleGeometry.setDrawRange(0, 0)
    const particles = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({
        color: trailColor,
        size: 0.21,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    particles.renderOrder = 7
    group.add(particles)

    const actionColor = action.direction === 'add' ? this.addLaserColor : this.removeLaserColor
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 1, 9, 1, true),
      new THREE.MeshBasicMaterial({
        color: this.strikeLaserColor,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    beam.visible = false
    beam.renderOrder = 8
    group.add(beam)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.28, TRAIL_RING_OUTER_RADIUS, 28),
      new THREE.MeshBasicMaterial({
        color: actionColor,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    ring.rotation.x = Math.PI / 2
    ring.visible = false
    ring.renderOrder = 10
    ring.material.toneMapped = false
    group.add(ring)
    this.scene.add(group)
    return { group, route, particles, beam, ring, action, slot, startedAt, duration, showRoute }
  }

  private spawnTrailEffects(
    actions: LaserAction[],
    authorColor: THREE.Color,
    duration: number,
    delay: number,
    showRoute: boolean,
  ) {
    const startedAt = performance.now() + delay
    for (const action of actions) {
      const effect = this.makeTrailEffect(
        action,
        authorColor,
        Math.max(500, duration),
        startedAt,
        showRoute,
      )
      if (effect) this.trailEffects.push(effect)
    }
    while (this.trailEffects.length > MAX_TRAIL_EFFECTS) {
      const oldest = this.trailEffects.shift()
      if (oldest) this.disposeTrailEffect(oldest)
    }
  }

  private makeLaserBurstEffect(
    actions: LaserAction[],
    direction: LaserDirection,
    duration: number,
    startedAt: number,
  ): LaserBurstEffect | null {
    const items = actions.flatMap((action) => {
      const slot = this.slots.get(action.lot.pathId)
      return slot ? [{ action, slot }] : []
    })
    if (!items.length) return null

    const color = direction === 'add' ? this.addLaserColor : this.removeLaserColor
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: this.strikeLaserColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const ringMaterial = beamMaterial.clone()
    ringMaterial.color.copy(color)
    ringMaterial.depthTest = false
    ringMaterial.side = THREE.DoubleSide
    ringMaterial.toneMapped = false
    const beams = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.075, 0.075, 1, 9, 1, true),
      beamMaterial,
      items.length,
    )
    const rings = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.28, TRAIL_RING_OUTER_RADIUS, 28),
      ringMaterial,
      items.length,
    )
    items.forEach(({ action }, index) => {
      const energy = changeEnergy(action.amount, this.blockLines)
      const beamBrightness = mix(0.48, 1, energy)
      const ringBrightness = mix(0.65, 1, energy)
      beams.setColorAt(index, new THREE.Color(beamBrightness, beamBrightness, beamBrightness))
      rings.setColorAt(index, new THREE.Color(ringBrightness, ringBrightness, ringBrightness))
    })
    if (beams.instanceColor) beams.instanceColor.needsUpdate = true
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true
    beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    beams.frustumCulled = false
    rings.frustumCulled = false
    beams.renderOrder = 8
    rings.renderOrder = 10
    const group = new THREE.Group()
    group.add(beams, rings)
    this.scene.add(group)
    return { group, beams, rings, items, direction, startedAt, duration }
  }

  private spawnLaserBursts(actions: LaserAction[], duration: number, delay: number) {
    const startedAt = performance.now() + delay
    const burstDuration = Math.max(500, duration)
    for (const direction of ['add', 'remove'] as const) {
      const directional = actions.filter((action) => action.direction === direction)
      const effect = this.makeLaserBurstEffect(
        directional,
        direction,
        burstDuration,
        startedAt,
      )
      if (effect) this.burstEffects.push(effect)
    }
    while (this.burstEffects.length > MAX_BURST_EFFECTS) {
      const oldest = this.burstEffects.shift()
      if (oldest) this.disposeLaserBurstEffect(oldest)
    }
  }

  private disposeLaserBurstEffect(effect: LaserBurstEffect) {
    this.scene.remove(effect.group)
    effect.beams.geometry.dispose()
    effect.rings.geometry.dispose()
    const materials = [effect.beams.material, effect.rings.material].flat()
    for (const material of materials) material.dispose()
  }

  private tickLaserBurst(effect: LaserBurstEffect, now: number) {
    const elapsed = now - effect.startedAt
    if (elapsed < 0) {
      const beamMaterial = effect.beams.material as THREE.MeshBasicMaterial
      const ringMaterial = effect.rings.material as THREE.MeshBasicMaterial
      beamMaterial.opacity = 0
      ringMaterial.opacity = 0
      return true
    }
    const life = clamp01(elapsed / effect.duration)
    const fade = Math.pow(1 - life, 1.18)
    const laser = life
    const ringProgress = clamp01((laser - LASER_IMPACT_AT) / (1 - LASER_IMPACT_AT))

    effect.items.forEach(({ action, slot }, index) => {
      const oldHeight = this.heightFor(action.before)
      const newHeight = this.heightFor(action.after)
      const motion = laserMotion(oldHeight, newHeight, action.amount, this.blockLines, laser)
      const lateral = laserOffset(action.direction)
      const beamX = slot.bounds.x + lateral
      const beamZ = slot.bounds.z

      this.dummy.position.set(
        beamX,
        motion.beamBottom + motion.beamLength / 2,
        beamZ,
      )
      this.dummy.rotation.set(0, 0, 0)
      this.dummy.scale.set(motion.beamRadius, motion.beamLength, motion.beamRadius)
      this.dummy.updateMatrix()
      effect.beams.setMatrixAt(index, this.dummy.matrix)

      this.dummy.position.set(beamX, motion.impactHeight + 0.025, beamZ)
      this.dummy.rotation.set(Math.PI / 2, 0, 0)
      this.dummy.scale.setScalar(ringScaleFor(
        action.amount,
        this.blockLines,
        this.averageBuildingSpan,
        TRAIL_RING_OUTER_RADIUS,
        motion.ringProgress,
      ))
      this.dummy.updateMatrix()
      effect.rings.setMatrixAt(index, this.dummy.matrix)
    })
    effect.beams.instanceMatrix.needsUpdate = true
    effect.rings.instanceMatrix.needsUpdate = true
    const beamMaterial = effect.beams.material as THREE.MeshBasicMaterial
    const ringMaterial = effect.rings.material as THREE.MeshBasicMaterial
    const actionColor = effect.direction === 'add' ? this.addLaserColor : this.removeLaserColor
    beamMaterial.color.copy(laser <= LASER_IMPACT_AT ? this.strikeLaserColor : actionColor)
    const strike = easeCubicOut(laser / LASER_IMPACT_AT)
    const reboundArc = Math.sin(ringProgress * Math.PI)
    const beamPhase = laser <= LASER_IMPACT_AT
      ? mix(0.4, 1, strike)
      : Math.pow(reboundArc, 0.55) * mix(1, 0.55, ringProgress)
    const beamStrength = laser <= LASER_IMPACT_AT ? 0.38 : 0.88
    beamMaterial.opacity = laser > 0 ? (beamStrength + Math.sin(laser * Math.PI * 5) * 0.1) * beamPhase * fade : 0
    ringMaterial.opacity = ringProgress > 0 ? Math.pow(1 - ringProgress, 0.55) * fade : 0
    return life < 1
  }

  tickEffects(now: number) {
    let changed = false
    for (let index = this.burstEffects.length - 1; index >= 0; index -= 1) {
      const effect = this.burstEffects[index]
      if (!this.tickLaserBurst(effect, now)) {
        this.disposeLaserBurstEffect(effect)
        this.burstEffects.splice(index, 1)
      }
      changed = true
    }
    for (let index = this.trailEffects.length - 1; index >= 0; index -= 1) {
      const effect = this.trailEffects[index]
      const elapsed = now - effect.startedAt
      if (elapsed < 0) {
        effect.route.material.opacity = 0
        effect.particles.material.opacity = 0
        effect.particles.geometry.setDrawRange(0, 0)
        effect.beam.visible = false
        effect.ring.visible = false
        changed = true
        continue
      }
      const life = clamp01(elapsed / effect.duration)
      if (life >= 1) {
        this.disposeTrailEffect(effect)
        this.trailEffects.splice(index, 1)
        changed = true
        continue
      }
      changed = true
      const fade = Math.pow(1 - life, 1.25)
      const travel = clamp01(life / 0.24)
      const visibleParticles = effect.showRoute ? Math.max(1, Math.floor(travel * 30)) : 0
      const particleStart = Math.max(0, visibleParticles - 20)
      effect.particles.geometry.setDrawRange(particleStart, visibleParticles - particleStart)
      effect.route.material.opacity = effect.showRoute ? (0.1 + travel * 0.31) * fade : 0
      effect.particles.material.opacity = effect.showRoute
        ? (0.46 + Math.sin(now * 0.014) * 0.16) * fade
        : 0

      const laser = life
      const oldHeight = this.heightFor(effect.action.before)
      const newHeight = this.heightFor(effect.action.after)
      const motion = laserMotion(oldHeight, newHeight, effect.action.amount, this.blockLines, laser)
      const lateral = laserOffset(effect.action.direction)
      const beamX = effect.slot.bounds.x + lateral
      const beamZ = effect.slot.bounds.z
      effect.beam.visible = laser > 0 && motion.beamOpacity > 0.001
      effect.beam.position.set(
        beamX,
        motion.beamBottom + motion.beamLength / 2,
        beamZ,
      )
      const actionColor = effect.action.direction === 'add' ? this.addLaserColor : this.removeLaserColor
      effect.beam.material.color.copy(motion.isRebound ? actionColor : this.strikeLaserColor)
      effect.beam.scale.set(motion.beamRadius, motion.beamLength, motion.beamRadius)
      effect.beam.material.opacity = motion.beamOpacity * fade
      effect.ring.visible = motion.ringProgress > 0 && motion.ringProgress < 1
      effect.ring.position.set(beamX, motion.impactHeight + 0.025, beamZ)
      effect.ring.scale.setScalar(ringScaleFor(
        effect.action.amount,
        this.blockLines,
        this.averageBuildingSpan,
        TRAIL_RING_OUTER_RADIUS,
        motion.ringProgress,
      ))
      effect.ring.material.opacity = motion.ringOpacity * fade
    }
    return changed
  }

  beginEvent(
    before: Float64Array,
    after: Float64Array,
    event: ReplayEvent,
    eventIndex: number,
    blockLines: number,
    effectDuration: number,
    showWorkers: boolean,
    detailedEffectLimit = MAX_WORKERS,
    effectDelay = 0,
  ) {
    this.blockLines = blockLines
    this.activeDeltas = cityDeltas(this.layout, before, after)
    const allActions = collectLaserActions(this.layout, before, after, event)
    const actions = selectWorkerLaserActions(allActions)
    this.setState(before, blockLines, eventIndex - 1)
    this.targetEventIndex = eventIndex
    const authorColor = new THREE.Color(workerColor(event, this.colors))
    if (effectDuration > 0 && this.lastSpawnedSha !== event.sha) {
      const detailedActions = actions.slice(0, detailedEffectLimit)
      this.spawnTrailEffects(detailedActions, authorColor, effectDuration, effectDelay, !showWorkers)
      const detailed = new Set(detailedActions)
      this.spawnLaserBursts(
        allActions.filter((action) => !detailed.has(action)),
        effectDuration,
        effectDelay,
      )
      this.lastSpawnedSha = event.sha
    }
    this.workers.forEach((worker, index) => {
      worker.action = showWorkers ? actions[index] ?? null : null
      const active = worker.action !== null
      worker.bot.visible = active
      worker.route.visible = active
      if (!worker.action) return
      for (const material of worker.botMaterials) material.color.copy(authorColor)
      worker.route.material.color.copy(authorColor)
      worker.route.geometry.dispose()
      worker.route.geometry = new THREE.BufferGeometry().setFromPoints(
        worker.action.lot.route.map((point) => floorPoint(point, 0.105)),
      )
    })
  }

  updateEvent(progress: number) {
    const globalBuild = easeCubicInOut((progress - 0.68) / 0.32)
    this.activeDeltas.forEach((delta, index) => {
      const stagger = index < MAX_WORKERS ? index * 0.022 : 0
      const local = clamp01((progress - stagger) / (1 - stagger))
      const build = index < MAX_WORKERS ? easeCubicInOut((local - 0.68) / 0.32) : globalBuild
      const lines = mix(delta.before, delta.after, build)
      this.lines[delta.lot.pathId] = lines
      this.setBuilding(delta.lot.pathId, lines)
    })
    if (this.activeDeltas.length) this.flushInstances(true)

    if (progress >= 1 && this.stateEventIndex !== this.targetEventIndex) {
      this.stateEventIndex = this.targetEventIndex
      for (const lot of this.layout.lots) {
        if ((this.lines[lot.pathId] ?? 0) <= 0) this.setBuilding(lot.pathId, 0)
      }
      this.flushInstances(true)
    }

    this.workers.forEach((worker, index) => {
      const action = worker.action
      if (!action) return
      const stagger = index * 0.022
      const local = clamp01((progress - stagger) / (1 - stagger))
      const walkEnd = 0.55
      const climbEnd = 0.68
      const center = {
        x: (action.lot.x0 + action.lot.x1) / 2,
        y: (action.lot.y0 + action.lot.y1) / 2,
      }
      const edge = action.lot.route[action.lot.route.length - 1]
      let world = edge
      let vertical = 0.11
      if (local <= walkEnd) {
        world = pointOnRoute(action.lot.route, local / walkEnd)
        vertical += Math.abs(Math.sin(local * Math.PI * 14)) * 0.055
      } else if (local < climbEnd) {
        const climb = easeCubicOut((local - walkEnd) / (climbEnd - walkEnd))
        world = { x: mix(edge.x, center.x, climb), y: mix(edge.y, center.y, climb) }
        vertical = mix(0.11, this.heightFor(action.startLines) + 0.11, climb)
      } else {
        world = center
        const build = easeCubicInOut((local - climbEnd) / (1 - climbEnd))
        vertical = this.heightFor(mix(action.startLines, action.endLines, build)) + 0.11
      }
      worker.bot.position.copy(floorPoint(world, vertical))
      const lateral = laserOffset(action.direction)
      worker.bot.position.x += lateral
      worker.bot.rotation.y = Math.sin(local * Math.PI * 8) * 0.12
      worker.route.material.opacity = 0.18 + (1 - local) * 0.42
    })
    this.refreshHover()
  }

  private refreshHover() {
    if (this.hoveredPathId === null) return
    const slot = this.slots.get(this.hoveredPathId)
    if (!slot) return
    if (slot.state === 'future') {
      this.hoverOutline.visible = false
      return
    }
    const height = this.heightFor(this.lines[this.hoveredPathId] ?? 0)
    this.hoverOutline.position.set(slot.bounds.x, height / 2, slot.bounds.z)
    this.hoverOutline.scale.set(slot.bounds.width + 0.045, height + 0.045, slot.bounds.depth + 0.045)
  }

  pick(clientX: number, clientY: number, rect: DOMRect): ThreeCityHit | null {
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
    let closest: BuildingSlot | null = null
    let closestDistance = Infinity
    for (const slot of this.slots.values()) {
      if (slot.state === 'future') continue
      const lines = this.lines[slot.lot.pathId] ?? 0
      const distance = rayBoxDistance(this.raycaster.ray, slot.bounds, this.heightFor(lines))
      if (distance !== null && distance < closestDistance) {
        closest = slot
        closestDistance = distance
      }
    }
    if (closest) {
      this.hoveredPathId = closest.lot.pathId
      this.hoverOutline.visible = true
      this.refreshHover()
      this.render()
      return { lot: closest.lot, lines: this.lines[closest.lot.pathId] ?? 0 }
    }
    return null
  }

  linesForPath(pathId: number) {
    return this.lines[pathId] ?? 0
  }

  isPathVisible(pathId: number) {
    const slot = this.slots.get(pathId)
    return Boolean(slot && slot.state !== 'future')
  }

  clearHover() {
    if (this.hoveredPathId === null && !this.hoverOutline.visible) return
    this.hoveredPathId = null
    this.hoverOutline.visible = false
    this.render()
  }

  setAutoRotate(enabled: boolean) {
    this.controls.autoRotate = enabled
  }

  setView(preset: CameraPreset) {
    this.viewPreset = preset
    this.resetView()
  }

  zoomBy(factor: number) {
    this.camera.zoom = THREE.MathUtils.clamp(
      this.camera.zoom * factor,
      this.controls.minZoom,
      this.controls.maxZoom,
    )
    this.camera.updateProjectionMatrix()
    this.render()
  }

  setSize(width: number, height: number) {
    this.renderer.setSize(width, height, false)
    const aspect = width / height
    const viewHeight = Math.max(48, 54 / Math.max(0.35, aspect))
    this.camera.left = (-viewHeight * aspect) / 2
    this.camera.right = (viewHeight * aspect) / 2
    this.camera.top = viewHeight / 2
    this.camera.bottom = -viewHeight / 2
    this.camera.updateProjectionMatrix()
    this.render()
  }

  resetView = () => {
    if (this.viewPreset === 'aerial') {
      this.camera.position.set(27, 48, 34)
      this.camera.zoom = 0.9
    } else {
      this.camera.position.set(34, 31, 40)
      this.camera.zoom = 1
    }
    this.controls.target.set(0, 2.2, 0)
    this.camera.lookAt(this.controls.target)
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.render()
  }

  render = () => {
    this.renderer.render(this.scene, this.camera)
  }

  turntableFrame() {
    this.controls.update()
    this.render()
  }

  dispose() {
    this.controls.removeEventListener('change', this.render)
    this.controls.dispose()
    while (this.trailEffects.length) {
      const effect = this.trailEffects.pop()
      if (effect) this.disposeTrailEffect(effect)
    }
    while (this.burstEffects.length) {
      const effect = this.burstEffects.pop()
      if (effect) this.disposeLaserBurstEffect(effect)
    }
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments)) return
      geometries.add(object.geometry)
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of objectMaterials) {
        materials.add(material)
        const map = (material as THREE.MeshBasicMaterial).map
        if (map) textures.add(map)
      }
    })
    for (const texture of textures) texture.dispose()
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    this.renderer.dispose()
  }
}
