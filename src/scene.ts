/**
 * dsh-plugin-whiteboard — the board document model and its pure reducer.
 *
 * One board has two surfaces:
 *
 * - a **2D canvas** in a fixed logical space (`0..`{@link BOARD_EXTENT}` on both
 *   axes, origin top-left, y down), fitted into the visible viewport by the
 *   client, so shape coordinates never depend on the panel size;
 * - a **3D scene** (three.js) in world units around the origin.
 *
 * State is event-sourced on the whiteboard Session log: every model tool call
 * appends one event carrying canonical (already id-bearing, already validated)
 * operations, and {@link applyBoardEvent} folds those events into
 * {@link BoardState}. The Host projection unit and the client renderer use the
 * same reducer, so what the model drew and what the user sees cannot drift.
 *
 * This module is dependency-free and environment-free: it is bundled into both
 * the Host face and the browser face.
 */

/** Side length of the logical 2D coordinate space, on both axes. */
export const BOARD_EXTENT = 1000

/** Upper bound on 2D shapes kept on one board. */
export const MAX_SHAPES = 300

/** Upper bound on 3D objects kept on one scene. */
export const MAX_OBJECTS = 120

/** Number of light slots a 3D scene may carry. */
export const MAX_LIGHTS = 4

/**
 * Named paints the model may use instead of a literal `#rrggbb`. The client
 * resolves them against the dsh theme, so a board drawn in light mode still
 * reads in dark mode.
 */
export const PALETTE_TOKENS = [
  'ink',
  'muted',
  'blue',
  'cyan',
  'teal',
  'green',
  'lime',
  'yellow',
  'amber',
  'orange',
  'red',
  'pink',
  'purple',
  'indigo',
  'white',
  'black',
] as const

/** A named paint token. */
export type PaletteToken = (typeof PALETTE_TOKENS)[number]

/** A resolved paint: a palette token or a literal `#rrggbb`/`#rgb` color. */
export type Paint = PaletteToken | string

/** Two-dimensional point in the logical canvas space. */
export type Vec2 = [number, number]

/** Three-dimensional vector in world units. */
export type Vec3 = [number, number, number]

/** Paint and stroke style shared by every 2D shape. */
export interface ShapeStyle {
  /** Interior paint; `null` leaves the shape unfilled. */
  fill?: Paint | null
  /** Outline paint; `null` leaves the shape unstroked. */
  stroke?: Paint | null
  /** Outline width in logical units. */
  strokeWidth?: number
  /** Whole-shape opacity, `0..1`. */
  opacity?: number
  /** Dash pattern in logical units; `null` draws a solid line. */
  dash?: number[] | null
  /** Drop a soft shadow (used for cards and sticky notes). */
  shadow?: boolean
}

/** Rectangle (optionally rounded). */
export interface RectShape extends ShapeStyle {
  id: string
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
  /** Corner radius in logical units. */
  radius?: number
  /** Rotation around the shape centre, in degrees. */
  rotation?: number
}

/** Ellipse (a circle is `rx === ry`). */
export interface EllipseShape extends ShapeStyle {
  id: string
  kind: 'ellipse'
  cx: number
  cy: number
  rx: number
  ry: number
  /** Rotation around the shape centre, in degrees. */
  rotation?: number
}

/** Straight segment. */
export interface LineShape extends ShapeStyle {
  id: string
  kind: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Segment with an arrow head. */
export interface ArrowShape extends ShapeStyle {
  id: string
  kind: 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
  /** Which ends carry a head. */
  head?: 'end' | 'both' | 'none'
  /** Perpendicular bend, in logical units; positive bows to the left of the direction. */
  curve?: number
}

/** Connected point list. */
export interface PolylineShape extends ShapeStyle {
  id: string
  kind: 'polyline'
  points: Vec2[]
  /** Round the corners with quadratic segments. */
  smooth?: boolean
  /** Join the last point back to the first. */
  closed?: boolean
}

/** Arbitrary SVG path data (`Path2D` syntax) for free-form drawing and icons. */
export interface PathShape extends ShapeStyle {
  id: string
  kind: 'path'
  d: string
}

/** Text label. */
export interface TextShape extends ShapeStyle {
  id: string
  kind: 'text'
  x: number
  y: number
  text: string
  /** Font size in logical units. */
  size?: number
  weight?: 'regular' | 'medium' | 'bold'
  align?: 'left' | 'center' | 'right'
  baseline?: 'top' | 'middle' | 'bottom'
  /** Wrap width in logical units (defaults to no wrapping). */
  maxWidth?: number
}

/** Every 2D shape kind. */
export type Shape2D =
  | RectShape
  | EllipseShape
  | LineShape
  | ArrowShape
  | PolylineShape
  | PathShape
  | TextShape

/** Shape kinds a `whiteboard_draw` call may add. */
export type ShapeKind = Shape2D['kind']

/** A partial style/geometry update applied to one existing shape. */
export type ShapePatch = Record<string, unknown>

/** One 2D operation, already canonical and id-bearing by the time it is logged. */
export type DrawOp =
  | { op: 'add'; shape: Shape2D }
  | { op: 'update'; id: string; patch: ShapePatch }
  | { op: 'remove'; id: string }
  | { op: 'clear' }

/** Canvas-wide settings a draw call may carry. */
export interface CanvasView {
  /** Page paint behind the shapes; `null` uses the board surface. */
  background?: Paint | null
  /** Draw the dot grid. */
  grid?: boolean
}

/** Payload of one `whiteboard/draw` session event. */
export interface DrawEvent {
  ops: DrawOp[]
  view?: CanvasView
}

/** Primitives the 3D scene can build. */
export type Object3DKind = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane'

/** Per-kind geometry parameters; omitted values fall back to the kind defaults. */
export interface Geometry3D {
  /** Box/plane edge lengths. */
  size?: Vec3
  /** Sphere/torus/cylindrical radius. */
  radius?: number
  /** Cylinder top radius (a cone is `0`). */
  radiusTop?: number
  /** Cylinder bottom radius. */
  radiusBottom?: number
  /** Cylinder/cone height. */
  height?: number
  /** Torus tube radius. */
  tube?: number
  /** Radial tessellation. */
  segments?: number
}

/** One 3D object. */
export interface Object3D {
  id: string
  kind: Object3DKind
  /** World position. */
  position: Vec3
  /** Euler rotation in degrees. */
  rotation: Vec3
  /** Per-axis scale. */
  scale: Vec3
  /** Base color. */
  color: Paint
  /** Standard-material metalness, `0..1`. */
  metalness: number
  /** Standard-material roughness, `0..1`. */
  roughness: number
  /** Whole-object opacity, `0..1`. */
  opacity: number
  /** Render the wireframe instead of the solid surface. */
  wireframe: boolean
  /** Emissive paint, or `null` for none. */
  emissive: Paint | null
  geometry: Geometry3D
  /** Rotate about the world Y axis on its own, in degrees per second. */
  spin?: number
}

/** 3D light kinds. */
export type LightKind = 'ambient' | 'directional' | 'point'

/** One 3D light. */
export interface Light3D {
  kind: LightKind
  color: Paint
  intensity: number
  /** Position (directional/point only). */
  position?: Vec3
}

/** Camera framing of the 3D scene. */
export interface Camera3D {
  position: Vec3
  target: Vec3
  /** Vertical field of view in degrees. */
  fov: number
}

/** Scene-wide settings a 3D call may carry. */
export interface View3DPatch {
  camera?: Partial<Camera3D>
  /** Scene background paint; `null` uses the panel surface. */
  background?: Paint | null
  /** Draw the ground grid. */
  grid?: boolean
  /** Slowly orbit the camera. */
  autoRotate?: boolean
  /** Replace every light in the scene. */
  lights?: Light3D[]
}

/** One 3D operation, already canonical by the time it is logged. */
export type Object3DOp =
  | { op: 'add'; object: Object3D }
  | { op: 'update'; id: string; patch: Partial<Omit<Object3D, 'id' | 'kind'>> }
  | { op: 'remove'; id: string }
  | { op: 'clear' }

/** Payload of one `whiteboard/scene3d` session event. */
export interface Scene3DEvent {
  ops: Object3DOp[]
  view?: View3DPatch
}

/** Which surface the board is currently about. */
export type BoardMode = '2d' | '3d'

/** Whole 2D surface. */
export interface Canvas2D {
  background: Paint | null
  grid: boolean
  shapes: Shape2D[]
}

/** Whole 3D surface. */
export interface Scene3D {
  background: Paint | null
  grid: boolean
  autoRotate: boolean
  camera: Camera3D
  lights: Light3D[]
  objects: Object3D[]
}

/** The whole board document — the projection value and the client render input. */
export interface BoardState {
  /** Revision counter: one increment per applied event, used for change animations. */
  rev: number
  /** Surface last written by a tool; the client opens on it. */
  mode: BoardMode
  canvas: Canvas2D
  scene: Scene3D
}

/** Event type appended for a 2D draw call. */
export const DRAW_EVENT = 'whiteboard/draw'
/** Event type appended for a 3D scene call. */
export const SCENE_EVENT = 'whiteboard/scene3d'
/** Event type appended when the board is cleared. */
export const CLEAR_EVENT = 'whiteboard/clear'

/** Payload of one `whiteboard/clear` session event. */
export interface ClearEvent {
  /** Which surface to clear. */
  mode: '2d' | '3d' | 'all'
}

/** Default camera: a three-quarter view of the origin. */
export const DEFAULT_CAMERA: Camera3D = {
  position: [6.4, 4.6, 8.2],
  target: [0, 0, 0],
  fov: 45,
}

/** Default light rig: soft ambient plus two opposing directionals. */
export const DEFAULT_LIGHTS: Light3D[] = [
  { kind: 'ambient', color: 'white', intensity: 0.55 },
  { kind: 'directional', color: 'white', intensity: 1.6, position: [5, 8, 6] },
  { kind: 'directional', color: 'blue', intensity: 0.5, position: [-6, 3, -5] },
]

/** An empty board document. */
export function emptyBoard(): BoardState {
  return {
    rev: 0,
    mode: '2d',
    canvas: { background: null, grid: true, shapes: [] },
    scene: {
      background: null,
      grid: true,
      autoRotate: false,
      camera: { ...DEFAULT_CAMERA },
      lights: DEFAULT_LIGHTS.map(light => ({ ...light })),
      objects: [],
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asVec3(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const [x, y, z] = value
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined
  return [x, y, z]
}

/**
 * Structural check used by the Host projection (`stateSchema` / `viewSchema`)
 * and by the client before rendering a pushed value: a persisted or replayed
 * board must carry the documented skeleton, while individual shapes stay
 * tolerant so an older or partially-written value cannot crash a renderer.
 * @param value - candidate projection value.
 * @returns true when the value is a board document.
 */
export function isBoardState(value: unknown): value is BoardState {
  if (!isRecord(value)) return false
  if (typeof value.rev !== 'number' || !Number.isFinite(value.rev)) return false
  if (value.mode !== '2d' && value.mode !== '3d') return false
  const canvas = value.canvas
  if (!isRecord(canvas) || !Array.isArray(canvas.shapes)) return false
  const scene = value.scene
  if (!isRecord(scene) || !Array.isArray(scene.objects) || !Array.isArray(scene.lights)) return false
  const camera = scene.camera
  if (!isRecord(camera)) return false
  return asVec3(camera.position) !== undefined && asVec3(camera.target) !== undefined && typeof camera.fov === 'number'
}

/** Whether an op targets a shape/scene object id this board already knows. */
export function hasId(state: BoardState, id: string): boolean {
  return state.canvas.shapes.some(shape => shape.id === id)
    || state.scene.objects.some(object => object.id === id)
}

/** Every shape id on the 2D surface, in draw order. */
export function shapeIds(state: BoardState): string[] {
  return state.canvas.shapes.map(shape => shape.id)
}

/** Append one shape, honouring {@link MAX_SHAPES} by dropping the oldest. */
function addShape(shapes: Shape2D[], shape: Shape2D): Shape2D[] {
  const next = [...shapes, shape]
  return next.length > MAX_SHAPES ? next.slice(next.length - MAX_SHAPES) : next
}

/**
 * Apply one draw event to a board.
 * @param state - board before the event.
 * @param event - decoded `whiteboard/draw` payload.
 * @returns the new board (always a fresh object).
 */
export function applyDraw(state: BoardState, event: DrawEvent): BoardState {
  let shapes = state.canvas.shapes
  for (const op of event.ops ?? []) {
    if (!isRecord(op)) continue
    if (op.op === 'add' && isRecord(op.shape)) {
      const shape = op.shape as unknown as Shape2D
      if (typeof shape.id !== 'string' || typeof shape.kind !== 'string') continue
      shapes = addShape(shapes, shape)
    } else if (op.op === 'update' && typeof op.id === 'string' && isRecord(op.patch)) {
      const id = op.id
      const patch = op.patch as ShapePatch
      shapes = shapes.map(shape => (shape.id === id ? mergeShape(shape, patch) : shape))
    } else if (op.op === 'remove' && typeof op.id === 'string') {
      const id = op.id
      shapes = shapes.filter(shape => shape.id !== id)
    } else if (op.op === 'clear') {
      shapes = []
    }
  }
  const view = event.view
  const canvas: Canvas2D = {
    background: view !== undefined && 'background' in view ? (view.background ?? null) : state.canvas.background,
    grid: view?.grid ?? state.canvas.grid,
    shapes,
  }
  return { ...state, rev: state.rev + 1, mode: '2d', canvas }
}

/**
 * Apply one patch to an existing shape without letting it change identity or
 * kind (both are structural, and a replay must stay type-safe).
 * @param shape - shape before the patch.
 * @param patch - partial style/geometry update.
 * @returns a new shape of the same kind.
 */
function mergeShape<S extends Shape2D>(shape: S, patch: ShapePatch): S {
  const next: Record<string, unknown> = { ...shape }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'kind') continue
    next[key] = value
  }
  return next as unknown as S
}

/** Fill in the fixed fields of one 3D object. */
function normalizeObject(input: Object3D): Object3D {
  const raw = isRecord(input.geometry) ? input.geometry : {}
  const geometry: Geometry3D = {}
  const size = asVec3(raw.size)
  if (size !== undefined) geometry.size = size
  for (const key of ['radius', 'radiusTop', 'radiusBottom', 'height', 'tube', 'segments'] as const) {
    const value = asNumber(raw[key])
    if (value !== undefined) geometry[key] = value
  }
  const spin = asNumber(input.spin)
  return {
    id: input.id,
    kind: input.kind,
    position: asVec3(input.position) ?? [0, 0, 0],
    rotation: asVec3(input.rotation) ?? [0, 0, 0],
    scale: asVec3(input.scale) ?? [1, 1, 1],
    color: asString(input.color) ?? 'blue',
    metalness: asNumber(input.metalness) ?? 0.15,
    roughness: asNumber(input.roughness) ?? 0.45,
    opacity: asNumber(input.opacity) ?? 1,
    wireframe: input.wireframe === true,
    emissive: asString(input.emissive) ?? null,
    geometry,
    ...(spin === undefined ? {} : { spin }),
  }
}

/** Append one object, honouring {@link MAX_OBJECTS} by dropping the oldest. */
function addObject(objects: Object3D[], object: Object3D): Object3D[] {
  const next = [...objects, normalizeObject(object)]
  return next.length > MAX_OBJECTS ? next.slice(next.length - MAX_OBJECTS) : next
}

/**
 * Apply one 3D event to a board.
 * @param state - board before the event.
 * @param event - decoded `whiteboard/scene3d` payload.
 * @returns the new board (always a fresh object).
 */
export function applyScene3D(state: BoardState, event: Scene3DEvent): BoardState {
  let objects = state.scene.objects
  for (const op of event.ops ?? []) {
    if (!isRecord(op)) continue
    if (op.op === 'add' && isRecord(op.object)) {
      const object = op.object as unknown as Object3D
      if (typeof object.id !== 'string' || typeof object.kind !== 'string') continue
      objects = addObject(objects, object)
    } else if (op.op === 'update' && typeof op.id === 'string' && isRecord(op.patch)) {
      const id = op.id
      const patch = op.patch as Partial<Object3D>
      objects = objects.map(object => (object.id === id ? normalizeObject({ ...object, ...patch, id, kind: object.kind }) : object))
    } else if (op.op === 'remove' && typeof op.id === 'string') {
      const id = op.id
      objects = objects.filter(object => object.id !== id)
    } else if (op.op === 'clear') {
      objects = []
    }
  }
  const view = event.view ?? {}
  const cameraPatch = view.camera ?? {}
  const camera: Camera3D = {
    position: asVec3(cameraPatch.position) ?? state.scene.camera.position,
    target: asVec3(cameraPatch.target) ?? state.scene.camera.target,
    fov: asNumber(cameraPatch.fov) ?? state.scene.camera.fov,
  }
  const lights: Light3D[] = Array.isArray(view.lights)
    ? view.lights
        .filter(isRecord)
        .slice(0, MAX_LIGHTS)
        .map((light) => {
          const kind: LightKind = light.kind === 'ambient' || light.kind === 'point' ? light.kind : 'directional'
          const position = asVec3(light.position)
          return {
            kind,
            color: asString(light.color) ?? 'white',
            intensity: asNumber(light.intensity) ?? 1,
            ...(position === undefined ? {} : { position }),
          }
        })
    : state.scene.lights
  const scene: Scene3D = {
    background: 'background' in view ? (view.background ?? null) : state.scene.background,
    grid: view.grid ?? state.scene.grid,
    autoRotate: view.autoRotate ?? state.scene.autoRotate,
    camera,
    lights: lights.length === 0 ? DEFAULT_LIGHTS.map(light => ({ ...light })) : lights,
    objects,
  }
  return { ...state, rev: state.rev + 1, mode: '3d', scene }
}

/**
 * Apply one clear event to a board.
 * @param state - board before the event.
 * @param event - decoded `whiteboard/clear` payload.
 * @returns the cleared board.
 */
export function applyClear(state: BoardState, event: ClearEvent): BoardState {
  const mode = event.mode ?? 'all'
  return {
    ...state,
    rev: state.rev + 1,
    mode: mode === '3d' ? '3d' : mode === '2d' ? '2d' : state.mode,
    canvas: mode === '3d' ? state.canvas : { ...state.canvas, shapes: [] },
    scene: mode === '2d'
      ? state.scene
      : { ...state.scene, objects: [], camera: { ...DEFAULT_CAMERA }, lights: DEFAULT_LIGHTS.map(light => ({ ...light })) },
  }
}

/** The three event kinds a board folds, addressed by their short name. */
export type BoardEventKind = 'draw' | 'scene3d' | 'clear'

/**
 * Map any committed event type onto a board event kind.
 *
 * The log carries plugin records (`plugin:dsh-plugin-whiteboard/draw`), the
 * logical names in this module (`whiteboard/draw`), and short names (`draw`);
 * all three resolve to the same kind so a host can fold without knowing which
 * spelling the persistence layer used.
 * @param type - committed session event type.
 * @returns the board event kind, or undefined for any other event.
 */
export function boardEventKind(type: string): BoardEventKind | undefined {
  const tail = type.slice(type.lastIndexOf('/') + 1)
  if (tail === 'draw' || tail === 'scene3d' || tail === 'clear') return tail
  return undefined
}

/**
 * Fold one committed whiteboard event into a board.
 *
 * Every event type this plugin appends is handled here; events of other types
 * return the same reference so the projection registry can skip publication.
 * @param state - board before the event.
 * @param type - committed session event type, in any of its spellings.
 * @param data - committed event payload.
 * @returns the new board, or `state` when the event is not a whiteboard event.
 */
export function applyBoardEvent(state: BoardState, type: string, data: unknown): BoardState {
  if (!isRecord(data)) return state
  switch (boardEventKind(type)) {
    case 'draw': return applyDraw(state, data as unknown as DrawEvent)
    case 'scene3d': return applyScene3D(state, data as unknown as Scene3DEvent)
    case 'clear': return applyClear(state, data as unknown as ClearEvent)
    default: return state
  }
}

/**
 * A short, model-facing description of a board: what exists and how it is named.
 * @param state - current board.
 * @returns one text block summarising both surfaces.
 */
export function describeBoard(state: BoardState): string {
  const lines: string[] = [`Board mode: ${state.mode} (rev ${state.rev}).`]
  lines.push(state.canvas.shapes.length === 0
    ? 'Canvas (2D): empty.'
    : `Canvas (2D): ${state.canvas.shapes.length} shapes — ${state.canvas.shapes.map(shape => `${shape.id}(${shape.kind})`).join(', ')}.`)
  const camera = state.scene.camera
  lines.push(state.scene.objects.length === 0
    ? 'Scene (3D): empty.'
    : `Scene (3D): ${state.scene.objects.length} objects — ${state.scene.objects.map(object => `${object.id}(${object.kind})`).join(', ')}.`
      + ` Camera ${formatVec(camera.position)} -> ${formatVec(camera.target)}, fov ${camera.fov}.`)
  return lines.join('\n')
}

/** Format a vector as `(x, y, z)` with one decimal. */
function formatVec(value: Vec3): string {
  return `(${value.map(axis => Math.round(axis * 10) / 10).join(', ')})`
}
