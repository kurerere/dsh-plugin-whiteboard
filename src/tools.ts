/**
 * Model-facing board tools: `whiteboard_draw`, `whiteboard_3d`, `whiteboard_read`.
 *
 * The three belong to the **main agent of a conversation** and are registered
 * into that agent's own scope (`agent.ctx.tools.register` in `./agent.ts`), so an
 * unrelated agent — a subagent, another conversation — never sees them and never
 * pays for their declarations. Argument shapes stay flat — one op object with
 * optional scalars — because a flat list is what a model gets right, and the
 * schema DSL is easiest to satisfy with one object spec. Each call normalises the
 * flat ops into the canonical `Shape2D` / `Object3D` model in `scene.ts`, allocates
 * ids (`rect-k3f9`), enforces the board limits, and folds the batch through the
 * board store's reducer in one atomic mutation. The returned summary names every
 * applied id so the next call can revise the drawing by id.
 *
 * The declarations are deliberately terse: the drawing policy lives once, in the
 * per-agent `WHITEBOARD` prompt section, and every main-session request pays for
 * both, drawing or not.
 *
 * The board key is the main Session id (`exec.agent.id`); the store is durable,
 * Host-owned document state (`./board-store.ts`), so a batch survives a Host
 * restart and a concurrent `whiteboard.clear` cannot interleave with it.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  applyBoardEvent, BOARD_EXTENT, describeBoard, DRAW_EVENT, MAX_OBJECTS, MAX_SHAPES,
  PALETTE_TOKENS, SCENE_EVENT, shapeIds,
  type ArrowShape, type BoardState, type DrawEvent, type DrawOp, type EllipseShape,
  type Geometry3D, type Light3D, type LightKind, type LineShape, type Object3D, type Object3DOp,
  type PaletteToken, type PathShape, type PolylineShape, type RectShape,
  type Scene3DEvent, type Shape2D, type ShapePatch, type ShapeStyle, type TextShape, type Vec2, type Vec3,
  type View3DPatch,
} from './scene.ts'
import { DRAW_TOOL, API_TOOL, LOOK_TOOL, READ_TOOL, SCENE_TOOL, type CaptureOptions } from './shared.ts'
import type { BoardStore } from './board-store.ts'
import type { AttachedImage, CaptureService, FrameStore, SavedFrame } from './capture.ts'
import { buildManifest } from './manifest.ts'

/** Upper bound on operations one call may carry. */
const MAX_BATCH = 64

/** Upper bound on one text label, in UTF-16 code units. */
const MAX_TEXT = 280

/** Upper bound on one `path` `d` string. */
const MAX_PATH = 4000

/** Upper bound on one polyline's point count. */
const MAX_POINTS = 400

/** Coordinates further than this from the logical square are a mistake, not intent. */
const COORD_LIMIT = 20_000

/** Ids this plugin mints or accepts: short, printable, JSON-key safe. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** Shape kinds `whiteboard_draw` may add. */
const SHAPE_KINDS = ['rect', 'ellipse', 'line', 'arrow', 'polyline', 'path', 'text'] as const

/** Object kinds `whiteboard_3d` may add. */
const OBJECT_KINDS = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane'] as const

/** Light kinds a 3D view may declare. */
const LIGHT_KINDS = ['ambient', 'directional', 'point'] as const

/**
 * Host services the board tools need beyond the store. They stay optional so a
 * composition without the capture channel (or a schema-only test) still builds
 * the three authoring tools; `whiteboard_look` then explains that it is not wired.
 */
export interface BoardToolServices {
  /** Correlates `whiteboard_look` with the open panel. */
  readonly captures: CaptureService
  /** Durable PNG storage for captured frames. */
  readonly frames: FrameStore
  /** Optional frame → durable image attachment (inline image in the result). */
  readonly attachImage: (frame: SavedFrame, name: string) => Promise<AttachedImage | undefined>
}

/** Hex paint: `#rgb`, `#rrggbb`, `#rrggbbaa`. */
const HEX_PAINT = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** The style scalars every shape accepts. */
const STYLE_FIELDS = ['fill', 'stroke', 'strokeWidth', 'opacity', 'dash', 'shadow'] as const

/** Geometry + text fields an `update` op may patch (identity and kind excluded). */
const PATCH_FIELDS = [
  'x', 'y', 'w', 'h', 'radius', 'rotation', 'cx', 'cy', 'rx', 'ry',
  'x1', 'y1', 'x2', 'y2', 'head', 'curve', 'points', 'smooth', 'closed', 'd',
  'text', 'size', 'weight', 'align', 'baseline', 'maxWidth',
  ...STYLE_FIELDS,
] as const

/** Size fields that must stay positive on any patch. */
const POSITIVE_FIELDS = new Set(['w', 'h', 'rx', 'ry', 'size', 'maxWidth', 'strokeWidth'])

/** Per-call id allocator, seeded with every id the board already knows. */
class IdAllocator {
  private readonly taken: Set<string>

  constructor(board: BoardState) {
    this.taken = new Set([...shapeIds(board), ...board.scene.objects.map(object => object.id)])
  }

  /**
   * Take one id: the model's preferred name when it is free and well formed,
   * otherwise a short generated one.
   * @param kind - shape/object kind, used as the readable prefix.
   * @param wanted - optional model-supplied name.
   * @returns a unique id that is now reserved.
   */
  take(kind: string, wanted: string | undefined): string {
    if (wanted !== undefined && ID_PATTERN.test(wanted) && !this.taken.has(wanted)) {
      this.taken.add(wanted)
      return wanted
    }
    let candidate: string
    do {
      candidate = `${kind}-${Math.random().toString(36).slice(2, 6)}`
    } while (this.taken.has(candidate))
    this.taken.add(candidate)
    return candidate
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one optional finite number from a raw op, rejecting wrong types. */
function numberField(raw: Record<string, unknown>, field: string, label: string): number | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}: \`${field}\` must be a finite number (got ${JSON.stringify(value)})`)
  }
  if (Math.abs(value) > COORD_LIMIT) {
    throw new Error(`${label}: \`${field}\` = ${value} is outside the plausible range ±${COORD_LIMIT}`)
  }
  return value
}

/** Read one required finite number from a raw op. */
function requiredNumber(raw: Record<string, unknown>, field: string, label: string): number {
  const value = numberField(raw, field, label)
  if (value === undefined) {
    throw new Error(`${label}: \`${field}\` is required for this kind`)
  }
  return value
}

/** Read one optional paint (palette token, `#rrggbb`, or `null` for none). */
function paintField(raw: Record<string, unknown>, field: string, label: string): string | null | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${label}: \`${field}\` must be a palette token, "#rrggbb", or null`)
  if (!HEX_PAINT.test(value) && !PALETTE_TOKENS.includes(value as PaletteToken)) {
    throw new Error(`${label}: \`${field}\` = ${JSON.stringify(value)} is not a paint; `
      + `use a palette token (${PALETTE_TOKENS.join(', ')}) or "#rrggbb"`)
  }
  return value
}

/** Read one optional vector of exactly three finite numbers. */
function vec3Field(raw: Record<string, unknown>, field: string, label: string): Vec3 | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length !== 3
    || value.some(axis => typeof axis !== 'number' || !Number.isFinite(axis))) {
    throw new Error(`${label}: \`${field}\` must be [x, y, z] with three finite numbers`)
  }
  const [x, y, z] = value as [number, number, number]
  return [x, y, z]
}

/** Read one optional `[[x, y], …]` point list. */
function pointsField(raw: Record<string, unknown>, label: string): Vec2[] | undefined {
  const value = raw['points']
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${label}: \`points\` must be an array of at least 2 [x, y] pairs`)
  }
  if (value.length > MAX_POINTS) {
    throw new Error(`${label}: \`points\` has ${value.length} points; the limit is ${MAX_POINTS}`)
  }
  return value.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2
      || point.some(axis => typeof axis !== 'number' || !Number.isFinite(axis))) {
      throw new Error(`${label}: points[${index}] must be [x, y] with two finite numbers`)
    }
    const [x, y] = point as [number, number]
    return [x, y] as Vec2
  })
}

/** Read one optional one-of string field. */
function enumField<T extends string>(
  raw: Record<string, unknown>, field: string, label: string, allowed: readonly T[],
): T | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label}: \`${field}\` must be one of ${allowed.join(' | ')}`)
  }
  return value as T
}

/** Build the shared style block from a raw op (absent fields stay absent). */
function styleOf(raw: Record<string, unknown>, label: string): ShapeStyle {
  const style: ShapeStyle = {}
  const fill = paintField(raw, 'fill', label)
  if (fill !== undefined) style.fill = fill
  const stroke = paintField(raw, 'stroke', label)
  if (stroke !== undefined) style.stroke = stroke
  const strokeWidth = numberField(raw, 'strokeWidth', label)
  if (strokeWidth !== undefined) {
    if (strokeWidth <= 0) throw new Error(`${label}: \`strokeWidth\` must be greater than 0`)
    style.strokeWidth = strokeWidth
  }
  const opacity = numberField(raw, 'opacity', label)
  if (opacity !== undefined) {
    if (opacity < 0 || opacity > 1) throw new Error(`${label}: \`opacity\` must be between 0 and 1`)
    style.opacity = opacity
  }
  const dash = raw['dash']
  if (dash === null) {
    style.dash = null
  } else if (dash !== undefined) {
    if (!Array.isArray(dash) || dash.length === 0
      || dash.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${label}: \`dash\` must be an array of non-negative numbers (pass null for solid)`)
    }
    style.dash = dash as number[]
  }
  const shadow = raw['shadow']
  if (shadow !== undefined) {
    if (typeof shadow !== 'boolean') throw new Error(`${label}: \`shadow\` must be true or false`)
    style.shadow = shadow
  }
  return style
}

/** Build one canonical shape from a flat `add` op. */
function buildShape(raw: Record<string, unknown>, index: number, ids: IdAllocator): Shape2D {
  const kind = enumField(raw, 'kind', `op #${index + 1} (add)`, SHAPE_KINDS)
  if (kind === undefined) {
    throw new Error(`op #${index + 1} (add): \`kind\` is required — one of ${SHAPE_KINDS.join(' | ')}`)
  }
  const label = `op #${index + 1} (add ${kind})`
  const wanted = typeof raw['id'] === 'string' ? raw['id'] : undefined
  const id = ids.take(kind, wanted)
  const style = styleOf(raw, label)
  switch (kind) {
    case 'rect': {
      const w = requiredNumber(raw, 'w', label)
      const h = requiredNumber(raw, 'h', label)
      if (w <= 0 || h <= 0) throw new Error(`${label}: \`w\` and \`h\` must be greater than 0`)
      const radius = numberField(raw, 'radius', label)
      if (radius !== undefined && radius < 0) throw new Error(`${label}: \`radius\` must not be negative`)
      const rotation = numberField(raw, 'rotation', label)
      const shape: RectShape = {
        id, kind,
        x: requiredNumber(raw, 'x', label),
        y: requiredNumber(raw, 'y', label),
        w, h,
        ...style,
        ...(radius === undefined ? {} : { radius }),
        ...(rotation === undefined ? {} : { rotation }),
      }
      return shape
    }
    case 'ellipse': {
      const rx = requiredNumber(raw, 'rx', label)
      const ry = requiredNumber(raw, 'ry', label)
      if (rx <= 0 || ry <= 0) throw new Error(`${label}: \`rx\` and \`ry\` must be greater than 0`)
      const rotation = numberField(raw, 'rotation', label)
      const shape: EllipseShape = {
        id, kind,
        cx: requiredNumber(raw, 'cx', label),
        cy: requiredNumber(raw, 'cy', label),
        rx, ry,
        ...style,
        ...(rotation === undefined ? {} : { rotation }),
      }
      return shape
    }
    case 'line': {
      const shape: LineShape = {
        id, kind,
        x1: requiredNumber(raw, 'x1', label),
        y1: requiredNumber(raw, 'y1', label),
        x2: requiredNumber(raw, 'x2', label),
        y2: requiredNumber(raw, 'y2', label),
        ...style,
      }
      return shape
    }
    case 'arrow': {
      const head = enumField(raw, 'head', label, ['end', 'both', 'none'] as const)
      const curve = numberField(raw, 'curve', label)
      const shape: ArrowShape = {
        id, kind,
        x1: requiredNumber(raw, 'x1', label),
        y1: requiredNumber(raw, 'y1', label),
        x2: requiredNumber(raw, 'x2', label),
        y2: requiredNumber(raw, 'y2', label),
        ...style,
        ...(head === undefined ? {} : { head }),
        ...(curve === undefined ? {} : { curve }),
      }
      return shape
    }
    case 'polyline': {
      const points = pointsField(raw, label)
      if (points === undefined) throw new Error(`${label}: \`points\` is required — an array of [x, y] pairs`)
      const smooth = raw['smooth']
      if (smooth !== undefined && typeof smooth !== 'boolean') throw new Error(`${label}: \`smooth\` must be true or false`)
      const closed = raw['closed']
      if (closed !== undefined && typeof closed !== 'boolean') throw new Error(`${label}: \`closed\` must be true or false`)
      const shape: PolylineShape = {
        id, kind, points, ...style,
        ...(smooth === undefined ? {} : { smooth }),
        ...(closed === undefined ? {} : { closed }),
      }
      return shape
    }
    case 'path': {
      const d = raw['d']
      if (typeof d !== 'string' || d.trim() === '') {
        throw new Error(`${label}: \`d\` is required — SVG path data such as "M0 0 L100 100"`)
      }
      if (d.length > MAX_PATH) throw new Error(`${label}: \`d\` is longer than ${MAX_PATH} characters`)
      if (!/^[MmLlHhVvCcSsQqTtAaZz]/.test(d.trim())) {
        throw new Error(`${label}: \`d\` must start with an SVG path command (M, L, C, Q, A, Z, …)`)
      }
      const shape: PathShape = { id, kind, d, ...style }
      return shape
    }
    case 'text': {
      const text = raw['text']
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error(`${label}: \`text\` is required and must not be empty`)
      }
      if (text.length > MAX_TEXT) {
        throw new Error(`${label}: \`text\` is ${text.length} characters; keep labels under ${MAX_TEXT}`)
      }
      const size = numberField(raw, 'size', label)
      if (size !== undefined && size <= 0) throw new Error(`${label}: \`size\` must be greater than 0`)
      const weight = enumField(raw, 'weight', label, ['regular', 'medium', 'bold'] as const)
      const align = enumField(raw, 'align', label, ['left', 'center', 'right'] as const)
      const baseline = enumField(raw, 'baseline', label, ['top', 'middle', 'bottom'] as const)
      const maxWidth = numberField(raw, 'maxWidth', label)
      const shape: TextShape = {
        id, kind,
        x: requiredNumber(raw, 'x', label),
        y: requiredNumber(raw, 'y', label),
        text,
        ...style,
        ...(size === undefined ? {} : { size }),
        ...(weight === undefined ? {} : { weight }),
        ...(align === undefined ? {} : { align }),
        ...(baseline === undefined ? {} : { baseline }),
        ...(maxWidth === undefined ? {} : { maxWidth }),
      }
      return shape
    }
  }
}

/** Build one `update` patch from a flat op, rejecting a patch with no fields. */
function patchOf(raw: Record<string, unknown>, label: string): ShapePatch {
  const patch: ShapePatch = {}
  for (const field of PATCH_FIELDS) {
    if (!Object.hasOwn(raw, field)) continue
    const value = raw[field]
    if (value === undefined) continue
    switch (field) {
      case 'fill':
      case 'stroke':
        patch[field] = paintField(raw, field, label)
        break
      case 'dash':
        // Delegate the whole style block so dash validation stays in one place.
        styleOf(raw, label)
        patch[field] = raw[field]
        break
      case 'shadow':
      case 'smooth':
      case 'closed':
        if (typeof value !== 'boolean') throw new Error(`${label}: \`${field}\` must be true or false`)
        patch[field] = value
        break
      case 'points':
        patch[field] = pointsField(raw, label)
        break
      case 'd':
        if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}: \`d\` must be a non-empty SVG path string`)
        if (value.length > MAX_PATH) throw new Error(`${label}: \`d\` is longer than ${MAX_PATH} characters`)
        patch[field] = value
        break
      case 'text':
        if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}: \`text\` must be a non-empty string`)
        if (value.length > MAX_TEXT) throw new Error(`${label}: \`text\` is longer than ${MAX_TEXT} characters`)
        patch[field] = value
        break
      case 'head':
        patch[field] = enumField(raw, 'head', label, ['end', 'both', 'none'] as const)
        break
      case 'weight':
        patch[field] = enumField(raw, 'weight', label, ['regular', 'medium', 'bold'] as const)
        break
      case 'align':
        patch[field] = enumField(raw, 'align', label, ['left', 'center', 'right'] as const)
        break
      case 'baseline':
        patch[field] = enumField(raw, 'baseline', label, ['top', 'middle', 'bottom'] as const)
        break
      default: {
        const number = numberField(raw, field, label)
        if (number !== undefined && POSITIVE_FIELDS.has(field) && number <= 0) {
          throw new Error(`${label}: \`${field}\` must be greater than 0`)
        }
        patch[field] = number
        break
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(`${label}: nothing to change — pass at least one geometry or style field `
      + '(`fill`, `stroke`, `x`, `y`, `w`, `h`, `text`, …), or use op "remove"')
  }
  return patch
}

/** One-line board census for a tool result. */
function census(board: BoardState): string {
  return `canvas ${board.canvas.shapes.length} shape${board.canvas.shapes.length === 1 ? '' : 's'}, `
    + `scene ${board.scene.objects.length} object${board.scene.objects.length === 1 ? '' : 's'}`
}

/**
 * The board key for one tool call: the whiteboard Session id (`Agent.id` IS the
 * session id, so no session object is touched).
 */
function boardIdFor(tool: string, exec: Readonly<ToolRunContext>): string {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error(`${tool} needs the conversation session that owns this board`)
  }
  return agent.id
}

/** The one-line failure path shared by every id-bearing op. */
function unknownId(tool: string, label: string, id: string, board: BoardState): Error {
  const shapes = shapeIds(board)
  const objects = board.scene.objects.map(object => object.id)
  const where = shapes.includes(id) ? 'it is a 2D shape' : objects.includes(id) ? 'it is a 3D object' : ''
  return new Error(`${tool} ${label}: unknown id ${JSON.stringify(id)}`
    + `${where === '' ? '' : ` (${where})`}; current ids: `
    + `2D [${shapes.join(', ') || 'none'}], 3D [${objects.join(', ') || 'none'}]. `
    + 'The whole batch was rejected — read the board with whiteboard_read and reuse an exact id from there.')
}

/** Shared output declaration: the compact result every batch tool returns. */
const BATCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string', required: true, description: 'The tool that produced this result.' },
    added: { type: 'array', items: { type: 'string' }, required: true, description: 'Ids created by this call.' },
    updated: { type: 'array', items: { type: 'string' }, required: true, description: 'Ids patched by this call.' },
    removed: { type: 'array', items: { type: 'string' }, required: true, description: 'Ids deleted by this call.' },
    counts: { type: 'string', required: true, description: 'Board census after this call.' },
    summary: { type: 'string', required: true, description: 'One line: what changed, with ids.' },
    frame: {
      type: 'string',
      description: 'Absolute PNG path of a frame captured after this call, when the 画板 panel was on screen.',
    },
  },
} as const

/** One batch result; structurally the canonical output value above. */
interface BatchResult {
  tool: string
  added: string[]
  updated: string[]
  removed: string[]
  counts: string
  summary: string
  frame?: string
}

/** Render one batch result as its single model-facing line. */
function batchRender(_args: unknown, value: Readonly<BatchResult>): { type: 'text'; text: string }[] {
  const frame = value.frame === undefined
    ? ''
    : ` Frame captured: ${value.frame} (open it with read_image, or call whiteboard_look for measurements).`
  return [{ type: 'text', text: value.summary + frame }]
}

/** Describe a change list for the result line. */
function changeSummary(tool: string, added: string[], updated: string[], removed: string[], counts: string): string {
  const parts: string[] = []
  if (added.length > 0) parts.push(`added ${added.join(', ')}`)
  if (updated.length > 0) parts.push(`updated ${updated.join(', ')}`)
  if (removed.length > 0) parts.push(`removed ${removed.join(', ')}`)
  const changed = parts.length === 0 ? 'no changes' : parts.join('; ')
  return `${tool}: ${changed} — ${counts}.`
}

/** Axis-aligned 2D bounds, in logical board units. */
interface Bounds2 { x1: number; y1: number; x2: number; y2: number }

/** Axis-aligned 3D bounds, in world units. */
interface Bounds3 { min: Vec3; max: Vec3 }

/**
 * Rough axis-aligned bounds of one 2D shape. Rotation is ignored and an SVG
 * `path` has no cheap box; both are the honest limits of a text summary.
 * @param shape - shape to measure.
 * @returns the box, or undefined when the geometry cannot be cheaply bounded.
 */
function shapeBounds(shape: Shape2D): Bounds2 | undefined {
  switch (shape.kind) {
    case 'rect':
      return { x1: shape.x, y1: shape.y, x2: shape.x + shape.w, y2: shape.y + shape.h }
    case 'ellipse':
      return { x1: shape.cx - shape.rx, y1: shape.cy - shape.ry, x2: shape.cx + shape.rx, y2: shape.cy + shape.ry }
    case 'line':
    case 'arrow':
      return {
        x1: Math.min(shape.x1, shape.x2),
        y1: Math.min(shape.y1, shape.y2),
        x2: Math.max(shape.x1, shape.x2),
        y2: Math.max(shape.y1, shape.y2),
      }
    case 'polyline': {
      let x1 = Infinity
      let y1 = Infinity
      let x2 = -Infinity
      let y2 = -Infinity
      for (const [x, y] of shape.points) {
        x1 = Math.min(x1, x)
        y1 = Math.min(y1, y)
        x2 = Math.max(x2, x)
        y2 = Math.max(y2, y)
      }
      return Number.isFinite(x1) ? { x1, y1, x2, y2 } : undefined
    }
    case 'text':
      return { x1: shape.x, y1: shape.y, x2: shape.x, y2: shape.y }
    case 'path':
      return undefined
    default:
      return undefined
  }
}

/**
 * Rough axis-aligned bounds of one 3D object. Rotation is ignored; the point is
 * to let the model reason about size and the ground, not to be a collision hull.
 * @param object - object to measure.
 * @returns the box in world units.
 */
function objectBounds(object: Object3D): Bounds3 {
  const geometry = object.geometry
  let half: Vec3
  switch (object.kind) {
    case 'box': {
      const size = geometry.size
      half = [Math.abs(size?.[0] ?? 1) / 2, Math.abs(size?.[1] ?? 1) / 2, Math.abs(size?.[2] ?? 1) / 2]
      break
    }
    case 'sphere': {
      const radius = Math.abs(geometry.radius ?? 1)
      half = [radius, radius, radius]
      break
    }
    case 'cylinder': {
      const radius = Math.max(
        Math.abs(geometry.radiusBottom ?? 1),
        Math.abs(geometry.radiusTop ?? geometry.radiusBottom ?? 1),
      )
      half = [radius, Math.abs(geometry.height ?? 1) / 2, radius]
      break
    }
    case 'cone': {
      const radius = Math.abs(geometry.radiusBottom ?? 1)
      half = [radius, Math.abs(geometry.height ?? 1) / 2, radius]
      break
    }
    case 'torus': {
      const radius = Math.abs(geometry.radius ?? 1) + Math.abs(geometry.tube ?? 0.35)
      half = [radius, Math.abs(geometry.tube ?? 0.35), radius]
      break
    }
    case 'plane': {
      const size = geometry.size
      half = [Math.abs(size?.[0] ?? 2) / 2, Math.abs(size?.[1] ?? 2) / 2, 0]
      break
    }
    default:
      half = [0.5, 0.5, 0.5]
  }
  const scale = object.scale
  const position = object.position
  const sx = Math.abs(scale[0]) || 0.0001
  const sy = Math.abs(scale[1]) || 0.0001
  const sz = Math.abs(scale[2]) || 0.0001
  return {
    min: [position[0] - half[0] * sx, position[1] - half[1] * sy, position[2] - half[2] * sz],
    max: [position[0] + half[0] * sx, position[1] + half[1] * sy, position[2] + half[2] * sz],
  }
}

/** Index of the first directional light, or -1. */
function firstDirectionalIndex(lights: readonly Light3D[]): number {
  return lights.findIndex(light => light.kind === 'directional')
}

/**
 * Whether one light casts, applying the documented default: an explicit
 * `castShadow` wins; otherwise only the first directional light casts.
 * @param light - light to inspect.
 * @param index - its index in the rig.
 * @param lights - the whole rig.
 * @returns whether the renderer arms this light for shadows.
 */
function castsShadow(light: Light3D, index: number, lights: readonly Light3D[]): boolean {
  if (typeof light.castShadow === 'boolean') return light.castShadow
  return light.kind === 'directional' && index === firstDirectionalIndex(lights)
}

/**
 * Model-facing warnings for the current board: the things a picture would make
 * obvious but a bare id list would not.
 * @param board - current board.
 * @returns one line per finding, empty when nothing looks off.
 */
function diagnose(board: BoardState): string[] {
  const warnings: string[] = []
  const outside: string[] = []
  for (const shape of board.canvas.shapes) {
    const bounds = shapeBounds(shape)
    if (bounds === undefined) continue
    if (bounds.x1 < -0.5 || bounds.y1 < -0.5
      || bounds.x2 > BOARD_EXTENT + 0.5 || bounds.y2 > BOARD_EXTENT + 0.5) outside.push(shape.id)
  }
  if (outside.length > 0) {
    warnings.push(`${outside.length} 2D shape(s) extend outside the 0..${BOARD_EXTENT} square: `
      + `${outside.slice(0, 8).join(', ')}${outside.length > 8 ? ', …' : ''}.`)
  }
  const scene = board.scene
  if (scene.objects.length === 0) return warnings
  const casters = scene.lights
    .map((light, index) => ({ light, index }))
    .filter(({ light, index }) => castsShadow(light, index, scene.lights))
  if (casters.length > 1) {
    warnings.push(`${casters.length} lights cast shadows (${casters.map(({ index }) => `light #${index + 1}`).join(', ')}); `
      + 'a single caster gives one readable shadow.')
  }
  if (casters.length === 0) warnings.push('No light casts a shadow; 3D objects may look like they float.')
  const transparentCasters = scene.objects
    .filter(object => object.castShadow === true && (object.opacity ?? 1) < 0.99)
    .map(object => object.id)
  if (transparentCasters.length > 0) {
    warnings.push(`Transparent object(s) explicitly cast a solid shadow: ${transparentCasters.join(', ')}.`)
  }
  const fakeShadows = scene.objects
    .filter(object => /contact|shadow/i.test(object.id) && (object.opacity ?? 1) >= 0.99)
    .map(object => object.id)
  if (fakeShadows.length > 0) {
    warnings.push(`Opaque object(s) look like hand-made shadows (${fakeShadows.join(', ')}); `
      + 'they are geometry, not light, and will not follow the light.')
  }
  const belowGround = scene.objects.filter(object => objectBounds(object).min[1] < -0.05).map(object => object.id)
  if (belowGround.length > 0) warnings.push(`Object(s) below the ground plane: ${belowGround.join(', ')}.`)
  return warnings
}

/**
 * Capture a small automatic frame after a mutation, but only when the panel is
 * on screen. A closed panel must not turn a successful drawing into a timeout.
 * @param services - capture services, when wired.
 * @param sessionId - board key.
 * @param mode - the surface the call just wrote.
 * @returns the saved PNG path, or undefined.
 */
async function autoFrame(
  services: BoardToolServices | undefined, sessionId: string, mode: '2d' | '3d',
): Promise<string | undefined> {
  if (services === undefined || !services.captures.hasViewer(sessionId)) return undefined
  try {
    const answer = await services.captures.request(
      sessionId,
      { mode, overlay: 'none', debug: 'lit', maxWidth: 768 },
      1_500,
    )
    const saved = await services.frames.save(sessionId, answer.png)
    return saved.path
  } catch {
    // A frame is a convenience after a mutation; never fail the mutation for it.
    return undefined
  }
}

/** Output declaration of one look: the frame, the optional inline image, and the notes. */
const LOOK_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string', required: true },
    frame: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        path: { type: 'string', required: true },
        hash: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        mode: { type: 'string', enum: ['2d', '3d'], required: true },
        rev: { type: 'integer', required: true },
      },
    },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', enum: ['image/png'], required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        name: { type: 'string' },
      },
    },
    summary: { type: 'string', required: true },
    warnings: { type: 'array', items: { type: 'string' }, required: true },
    details: { type: 'string', required: true },
  },
} as const

/** One look result; structurally the canonical output value above. */
interface LookResult {
  tool: string
  frame: {
    path: string
    hash: string
    bytes: number
    width: number
    height: number
    mode: '2d' | '3d'
    rev: number
  }
  image?: AttachedImage
  summary: string
  warnings: string[]
  details: string
}

/** Render one look as text plus the image itself when an attachment exists. */
function lookRender(_args: unknown, value: Readonly<LookResult>): ContentBlock[] {
  const warningText = value.warnings.length === 0 ? '' : `\nWarnings:\n- ${value.warnings.join('\n- ')}`
  const imageHint = value.image === undefined
    ? `\nPNG: ${value.frame.path} — open it with read_image.`
    : ''
  const blocks: ContentBlock[] = [{
    type: 'text',
    text: `${value.summary}${warningText}${imageHint}\n${value.details}`,
  }]
  if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
  return blocks
}

/** Build one canonical 3D object from a flat `add` op. */
function buildObject(raw: Record<string, unknown>, index: number, ids: IdAllocator): Object3D {
  const kind = enumField(raw, 'kind', `${SCENE_TOOL} op #${index + 1} (add)`, OBJECT_KINDS)
  if (kind === undefined) {
    throw new Error(`${SCENE_TOOL} op #${index + 1} (add): \`kind\` is required — one of ${OBJECT_KINDS.join(' | ')}`)
  }
  const label = `${SCENE_TOOL} op #${index + 1} (add ${kind})`
  const wanted = typeof raw['id'] === 'string' ? raw['id'] : undefined
  const id = ids.take(kind, wanted)
  const position = vec3Field(raw, 'position', label)
  const rotation = vec3Field(raw, 'rotation', label)
  const scale = vec3Field(raw, 'scale', label)
  const color = paintField(raw, 'color', label)
  const emissive = paintField(raw, 'emissive', label)
  const metalness = numberField(raw, 'metalness', label)
  const roughness = numberField(raw, 'roughness', label)
  const opacity = numberField(raw, 'opacity', label)
  const spin = numberField(raw, 'spin', label)
  const wireframe = raw['wireframe']
  if (wireframe !== undefined && typeof wireframe !== 'boolean') {
    throw new Error(`${label}: \`wireframe\` must be true or false`)
  }
  const castShadow = raw['castShadow']
  if (castShadow !== undefined && typeof castShadow !== 'boolean') {
    throw new Error(`${label}: \`castShadow\` must be true or false`)
  }
  const receiveShadow = raw['receiveShadow']
  if (receiveShadow !== undefined && typeof receiveShadow !== 'boolean') {
    throw new Error(`${label}: \`receiveShadow\` must be true or false`)
  }
  checkUnitInterval(metalness, 'metalness', label)
  checkUnitInterval(roughness, 'roughness', label)
  checkUnitInterval(opacity, 'opacity', label)
  return {
    id,
    kind,
    position: position ?? [0, 0, 0],
    rotation: rotation ?? [0, 0, 0],
    scale: scale ?? [1, 1, 1],
    color: typeof color === 'string' ? color : 'blue',
    metalness: metalness ?? 0.15,
    roughness: roughness ?? 0.45,
    opacity: opacity ?? 1,
    wireframe: wireframe === true,
    emissive: typeof emissive === 'string' ? emissive : null,
    geometry: geometryOf(raw, label),
    ...(spin === undefined ? {} : { spin }),
    ...(castShadow === undefined ? {} : { castShadow }),
    ...(receiveShadow === undefined ? {} : { receiveShadow }),
  }
}

/** Reject a 0..1 field outside its range. */
function checkUnitInterval(value: number | undefined, field: string, label: string): void {
  if (value !== undefined && (value < 0 || value > 1)) {
    throw new Error(`${label}: \`${field}\` must be between 0 and 1 (got ${value})`)
  }
}

/** Read the flat geometry scalars of one 3D op. */
function geometryOf(raw: Record<string, unknown>, label: string): Geometry3D {
  const geometry: Geometry3D = {}
  const size = vec3Field(raw, 'size', label)
  if (size !== undefined) geometry.size = size
  for (const field of ['radius', 'radiusTop', 'radiusBottom', 'height', 'tube'] as const) {
    const value = numberField(raw, field, label)
    if (value !== undefined) {
      if (value < 0) throw new Error(`${label}: \`${field}\` must not be negative`)
      geometry[field] = value
    }
  }
  const segments = numberField(raw, 'segments', label)
  if (segments !== undefined) {
    if (!Number.isInteger(segments) || segments < 3 || segments > 256) {
      throw new Error(`${label}: \`segments\` must be an integer between 3 and 256`)
    }
    geometry.segments = segments
  }
  return geometry
}

/** Build one `update` patch for a 3D object, merging geometry over the current value. */
function objectPatch(
  raw: Record<string, unknown>, current: Object3D, label: string,
): Partial<Omit<Object3D, 'id' | 'kind'>> {
  const patch: Partial<Omit<Object3D, 'id' | 'kind'>> = {}
  const position = vec3Field(raw, 'position', label)
  if (position !== undefined) patch.position = position
  const rotation = vec3Field(raw, 'rotation', label)
  if (rotation !== undefined) patch.rotation = rotation
  const scale = vec3Field(raw, 'scale', label)
  if (scale !== undefined) patch.scale = scale
  const color = paintField(raw, 'color', label)
  if (color !== undefined && color !== null) patch.color = color
  const emissive = paintField(raw, 'emissive', label)
  if (emissive !== undefined) patch.emissive = emissive
  const metalness = numberField(raw, 'metalness', label)
  if (metalness !== undefined) {
    checkUnitInterval(metalness, 'metalness', label)
    patch.metalness = metalness
  }
  const roughness = numberField(raw, 'roughness', label)
  if (roughness !== undefined) {
    checkUnitInterval(roughness, 'roughness', label)
    patch.roughness = roughness
  }
  const opacity = numberField(raw, 'opacity', label)
  if (opacity !== undefined) {
    checkUnitInterval(opacity, 'opacity', label)
    patch.opacity = opacity
  }
  const wireframe = raw['wireframe']
  if (wireframe !== undefined) {
    if (typeof wireframe !== 'boolean') throw new Error(`${label}: \`wireframe\` must be true or false`)
    patch.wireframe = wireframe
  }
  const castShadow = raw['castShadow']
  if (castShadow !== undefined) {
    if (typeof castShadow !== 'boolean') throw new Error(`${label}: \`castShadow\` must be true or false`)
    patch.castShadow = castShadow
  }
  const receiveShadow = raw['receiveShadow']
  if (receiveShadow !== undefined) {
    if (typeof receiveShadow !== 'boolean') throw new Error(`${label}: \`receiveShadow\` must be true or false`)
    patch.receiveShadow = receiveShadow
  }
  const spin = numberField(raw, 'spin', label)
  if (spin !== undefined) patch.spin = spin
  const geometry = geometryOf(raw, label)
  if (Object.keys(geometry).length > 0) patch.geometry = { ...current.geometry, ...geometry }
  if (Object.keys(patch).length === 0) {
    throw new Error(`${label}: nothing to change — pass at least one of position, rotation, scale, color, `
      + 'metalness, roughness, opacity, wireframe, castShadow, receiveShadow, emissive, spin, size, radius, height, tube, segments')
  }
  return patch
}

/** Build the `view` block of a 3D call, if the model supplied one. */
function sceneViewOf(raw: unknown): View3DPatch | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error('view must be an object')
  const view: View3DPatch = {}
  const cameraRaw = raw['camera']
  if (cameraRaw !== undefined) {
    if (!isRecord(cameraRaw)) throw new Error('view.camera must be an object {position, target, fov}')
    const camera: { position?: Vec3; target?: Vec3; fov?: number } = {}
    const position = vec3Field(cameraRaw, 'position', 'view.camera')
    if (position !== undefined) camera.position = position
    const target = vec3Field(cameraRaw, 'target', 'view.camera')
    if (target !== undefined) camera.target = target
    const fov = numberField(cameraRaw, 'fov', 'view.camera')
    if (fov !== undefined) {
      if (fov <= 5 || fov >= 140) throw new Error('view.camera: `fov` must be between 5 and 140 degrees')
      camera.fov = fov
    }
    if (Object.keys(camera).length > 0) view.camera = camera
  }
  const background = paintField(raw, 'background', 'view')
  if (background !== undefined) view.background = background
  const grid = raw['grid']
  if (grid !== undefined) {
    if (typeof grid !== 'boolean') throw new Error('view: `grid` must be true or false')
    view.grid = grid
  }
  const autoRotate = raw['autoRotate']
  if (autoRotate !== undefined) {
    if (typeof autoRotate !== 'boolean') throw new Error('view: `autoRotate` must be true or false')
    view.autoRotate = autoRotate
  }
  const lightsRaw = raw['lights']
  if (lightsRaw !== undefined) {
    if (!Array.isArray(lightsRaw)) throw new Error('view.lights must be an array of {kind, color, intensity, position}')
    view.lights = lightsRaw.map((light, index) => {
      if (!isRecord(light)) throw new Error(`view.lights[${index}] must be an object`)
      const kind: LightKind | undefined = enumField(light, 'kind', `view.lights[${index}]`, LIGHT_KINDS)
      if (kind === undefined) throw new Error(`view.lights[${index}]: \`kind\` is required — ${LIGHT_KINDS.join(' | ')}`)
      const color = paintField(light, 'color', `view.lights[${index}]`)
      const intensity = numberField(light, 'intensity', `view.lights[${index}]`)
      if (intensity !== undefined && intensity < 0) {
        throw new Error(`view.lights[${index}]: \`intensity\` must not be negative`)
      }
      const position = vec3Field(light, 'position', `view.lights[${index}]`)
      const castShadow = light['castShadow']
      if (castShadow !== undefined && typeof castShadow !== 'boolean') {
        throw new Error(`view.lights[${index}]: \`castShadow\` must be true or false`)
      }
      const shadowRaw = light['shadow']
      let shadow: { radius?: number; mapSize?: number } | undefined
      if (shadowRaw !== undefined) {
        if (!isRecord(shadowRaw)) throw new Error(`view.lights[${index}].shadow must be an object`)
        const radius = numberField(shadowRaw, 'radius', `view.lights[${index}].shadow`)
        if (radius !== undefined && radius < 0) {
          throw new Error(`view.lights[${index}].shadow: \`radius\` must not be negative`)
        }
        const mapSize = numberField(shadowRaw, 'mapSize', `view.lights[${index}].shadow`)
        if (mapSize !== undefined && (!Number.isInteger(mapSize) || mapSize < 256 || mapSize > 4096)) {
          throw new Error(`view.lights[${index}].shadow: \`mapSize\` must be an integer between 256 and 4096`)
        }
        shadow = {
          ...(radius === undefined ? {} : { radius }),
          ...(mapSize === undefined ? {} : { mapSize }),
        }
      }
      const value: Light3D = {
        kind,
        color: typeof color === 'string' ? color : 'white',
        intensity: intensity ?? 1,
        ...(position === undefined ? {} : { position }),
        ...(castShadow === undefined ? {} : { castShadow }),
        ...(shadow === undefined || Object.keys(shadow).length === 0 ? {} : { shadow }),
      }
      return value
    })
  }
  return Object.keys(view).length === 0 ? undefined : view
}

/**
 * Build the three board tool definitions, bound to the plugin context so they
 * can read the live projection.
 * @param store - the Host board store the tools mutate.
 * @returns one definition per board tool, in prompt order.
 */
export function createBoardTools(
  store: BoardStore,
  ready: Promise<unknown> = Promise.resolve(),
  services?: BoardToolServices,
): ToolDefinition[] {
  const draw = defineTool({
    name: DRAW_TOOL,
    description:
      'Draw a batch of ops on the conversation board (2D); returns the ids it applied. Call whiteboard_api for the live '
      + 'field spec, defaults, palette and batch limit.',
    parameters: {
      ops: {
        type: 'array',
        required: true,
        description: 'Ops, folded in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          description: 'One 2D op.',
          properties: {
            op: { type: 'string', enum: ['add', 'update', 'remove', 'clear'], required: true },
            id: { type: 'string', description: 'update/remove id, or add name.' },
            kind: { type: 'string', enum: SHAPE_KINDS, description: 'required for add.' },
            x: { type: 'number', description: 'rect left; text anchor x.' },
            y: { type: 'number', description: 'rect top; text anchor y.' },
            w: { type: 'number', description: 'Width (rect).' },
            h: { type: 'number', description: 'Height (rect).' },
            cx: { type: 'number', description: 'Centre x (ellipse).' },
            cy: { type: 'number', description: 'Centre y (ellipse).' },
            rx: { type: 'number', description: 'x radius (ellipse).' },
            ry: { type: 'number', description: 'y radius (ellipse).' },
            x1: { type: 'number', description: 'From x (line/arrow).' },
            y1: { type: 'number', description: 'From y (line/arrow).' },
            x2: { type: 'number', description: 'To x (line/arrow).' },
            y2: { type: 'number', description: 'To y (line/arrow).' },
            points: {
              type: 'array',
              description: '[[x,y],…] (polyline).',
              items: { type: 'array', items: { type: 'number' } },
            },
            d: { type: 'string', description: 'SVG path d (path).' },
            text: { type: 'string', description: 'Text, ≤280 chars (text).' },
            radius: { type: 'number', description: 'Corner radius (rect).' },
            rotation: { type: 'number', description: 'Degrees.' },
            head: { type: 'string', enum: ['end', 'both', 'none'], description: 'Arrow heads.' },
            curve: { type: 'number', description: 'Bow; + bows left.' },
            smooth: { type: 'boolean', description: 'Round corners (polyline).' },
            closed: { type: 'boolean', description: 'Close the path (polyline).' },
            size: { type: 'number', description: 'Font size.' },
            weight: { type: 'string', enum: ['regular', 'medium', 'bold'], description: 'Font weight (text).' },
            align: { type: 'string', enum: ['left', 'center', 'right'], description: 'Anchor x.' },
            baseline: { type: 'string', enum: ['top', 'middle', 'bottom'], description: 'Anchor y.' },
            maxWidth: { type: 'number', description: 'Wrap width.' },
            fill: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Fill paint; null = none.' },
            stroke: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Stroke paint; null = none.' },
            strokeWidth: { type: 'number', description: 'Stroke width.' },
            opacity: { type: 'number', description: '0..1.' },
            dash: {
              type: 'array',
              items: { type: 'number' },
              description: 'Pattern [6,4].',
            },
            shadow: { type: 'boolean', description: 'Soft shadow.' },
          },
        },
      },
    },
    output: { schema: BATCH_OUTPUT, render: batchRender },
    execute: async (args, exec) => {
      // The one-time legacy-board migration must settle before any board is read.
      await ready
      const sessionId = boardIdFor(DRAW_TOOL, exec)
      const rawOps = args.ops
      if (rawOps.length === 0) {
        throw new Error(`${DRAW_TOOL} needs at least one op; nothing was drawn.`)
      }
      if (rawOps.length > MAX_BATCH) {
        throw new Error(`${DRAW_TOOL}: ${rawOps.length} ops in one call; the limit is ${MAX_BATCH}. Split into batches.`)
      }
      const added: string[] = []
      const updated: string[] = []
      const removed: string[] = []
      // Build inside the store's reducer: the batch is validated against the
      // newest board and applies atomically (or not at all).
      const snapshot = await store.mutate(sessionId, (board) => {
        const ops: DrawOp[] = []
        const ids = new IdAllocator(board)
        /** Ids this board knows once the batch so far is folded. */
        const liveIds = new Set(shapeIds(board))
        /** Shape count the fold will reach, so the cap fails instead of dropping art. */
        let projected = board.canvas.shapes.length
        for (const [index, op] of rawOps.entries()) {
          const raw = op as unknown as Record<string, unknown>
          const label = `op #${index + 1}`
          switch (op.op) {
            case 'add': {
              const shape = buildShape(raw, index, ids)
              ops.push({ op: 'add', shape })
              added.push(shape.id)
              liveIds.add(shape.id)
              projected += 1
              break
            }
            case 'update': {
              const id = typeof op.id === 'string' ? op.id : ''
              if (id === '') throw new Error(`${DRAW_TOOL} ${label} (update): \`id\` is required`)
              if (!liveIds.has(id)) throw unknownId(DRAW_TOOL, `${label} (update)`, id, board)
              ops.push({ op: 'update', id, patch: patchOf(raw, `${DRAW_TOOL} ${label} (update ${id})`) })
              updated.push(id)
              break
            }
            case 'remove': {
              const id = typeof op.id === 'string' ? op.id : ''
              if (id === '') throw new Error(`${DRAW_TOOL} ${label} (remove): \`id\` is required`)
              if (!liveIds.has(id)) throw unknownId(DRAW_TOOL, `${label} (remove)`, id, board)
              ops.push({ op: 'remove', id })
              removed.push(id)
              liveIds.delete(id)
              projected -= 1
              break
            }
            case 'clear':
              ops.push({ op: 'clear' })
              projected = 0
              break
            default:
              throw new Error(`${DRAW_TOOL} ${label}: \`op\` must be add | update | remove | clear`)
          }
        }
        if (projected > MAX_SHAPES) {
          throw new Error(`${DRAW_TOOL}: this batch would leave ${projected} shapes; the canvas limit is ${MAX_SHAPES}. `
            + 'Remove shapes first (whiteboard_read lists their ids) or clear the canvas and redraw a simpler board.')
        }
        const payload: DrawEvent = { ops }
        return applyBoardEvent(board, DRAW_EVENT, payload)
      })
      const counts = census(snapshot.board)
      const frame = await autoFrame(services, sessionId, '2d')
      const result: BatchResult = {
        tool: DRAW_TOOL,
        added,
        updated,
        removed,
        counts,
        summary: changeSummary(DRAW_TOOL, added, updated, removed, counts),
        ...(frame === undefined ? {} : { frame }),
      }
      return result
    },
  })

  const scene = defineTool({
    name: SCENE_TOOL,
    description:
      'Add or edit objects in the board 3D scene; returns the ids it applied. Call whiteboard_api for the live field '
      + 'spec, camera/lights and batch limit.',
    parameters: {
      ops: {
        type: 'array',
        required: true,
        description: 'Ops, folded in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          description: 'One 3D op.',
          properties: {
            op: { type: 'string', enum: ['add', 'update', 'remove', 'clear'], required: true },
            id: { type: 'string', description: 'update/remove id, or add name.' },
            kind: { type: 'string', enum: OBJECT_KINDS, description: 'required for add.' },
            position: { type: 'array', items: { type: 'number' }, description: 'World [x,y,z].' },
            rotation: { type: 'array', items: { type: 'number' }, description: 'Degrees [x,y,z].' },
            scale: { type: 'array', items: { type: 'number' }, description: 'Per-axis scale.' },
            size: { type: 'array', items: { type: 'number' }, description: 'Edge lengths (box/plane).' },
            radius: { type: 'number', description: 'Radius (sphere/torus/cyl).' },
            radiusTop: { type: 'number', description: 'Top radius; 0 = cone.' },
            radiusBottom: { type: 'number', description: 'Bottom radius.' },
            height: { type: 'number', description: 'Height.' },
            tube: { type: 'number', description: 'Tube radius.' },
            segments: { type: 'integer', description: 'Tessellation, e.g. 48.' },
            color: { type: 'string', description: 'Palette token or #rrggbb.' },
            metalness: { type: 'number', description: '0..1.' },
            roughness: { type: 'number', description: '0..1.' },
            opacity: { type: 'number', description: '0..1.' },
            wireframe: { type: 'boolean', description: 'Wireframe.' },
            emissive: { type: 'string', description: 'Glow paint.' },
            spin: { type: 'number', description: 'Deg/sec about Y.' },
            castShadow: { type: 'boolean', description: 'Cast a shadow (default: opaque, non-wireframe).' },
            receiveShadow: { type: 'boolean', description: 'Receive shadows (default true).' },
          },
        },
      },
      view: {
        type: 'object',
        additionalProperties: false,
        description: 'Scene settings.',
        properties: {
          camera: {
            type: 'object',
            additionalProperties: false,
            description: 'Camera.',
            properties: {
              position: { type: 'array', items: { type: 'number' }, description: 'Eye [x,y,z].' },
              target: { type: 'array', items: { type: 'number' }, description: 'Look-at [x,y,z].' },
              fov: { type: 'number', description: 'FOV degrees.' },
            },
          },
          background: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Paint; null = theme.' },
          grid: { type: 'boolean', description: 'Ground grid.' },
          autoRotate: { type: 'boolean', description: 'Slow orbit.' },
          lights: {
            type: 'array',
            description: 'Replace every light in the scene; omitted keeps the current rig.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: LIGHT_KINDS, required: true, description: 'ambient | directional | point.' },
                color: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Palette token or #rrggbb.' },
                intensity: { type: 'number', description: 'Non-negative; 0 is legal (shadow-only light).' },
                position: { type: 'array', items: { type: 'number' }, description: 'World [x,y,z].' },
                castShadow: {
                  type: 'boolean',
                  description: 'Cast a shadow. Omitted: only the first directional light casts.',
                },
                shadow: {
                  type: 'object',
                  additionalProperties: false,
                  description: 'Shadow-map tuning when this light casts.',
                  properties: {
                    radius: { type: 'number', description: 'Edge softness.' },
                    mapSize: { type: 'integer', description: '256..4096.' },
                  },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: BATCH_OUTPUT, render: batchRender },
    execute: async (args, exec) => {
      await ready
      const sessionId = boardIdFor(SCENE_TOOL, exec)
      const rawOps = args.ops
      if (rawOps.length === 0) throw new Error(`${SCENE_TOOL} needs at least one op; nothing was added.`)
      if (rawOps.length > MAX_BATCH) {
        throw new Error(`${SCENE_TOOL}: ${rawOps.length} ops in one call; the limit is ${MAX_BATCH}. Split into batches.`)
      }
      const view = sceneViewOf(args.view)
      const added: string[] = []
      const updated: string[] = []
      const removed: string[] = []
      const snapshot = await store.mutate(sessionId, (board) => {
        const ops: Object3DOp[] = []
        const ids = new IdAllocator(board)
        const byId = new Map(board.scene.objects.map(object => [object.id, object]))
        /** Object count the fold will reach, so the cap fails instead of dropping art. */
        let projected = board.scene.objects.length
        for (const [index, op] of rawOps.entries()) {
          const raw = op as unknown as Record<string, unknown>
          const label = `${SCENE_TOOL} op #${index + 1}`
          switch (op.op) {
            case 'add': {
              const object = buildObject(raw, index, ids)
              ops.push({ op: 'add', object })
              added.push(object.id)
              byId.set(object.id, object)
              projected += 1
              break
            }
            case 'update': {
              const id = typeof op.id === 'string' ? op.id : ''
              if (id === '') throw new Error(`${label} (update): \`id\` is required`)
              const current = byId.get(id)
              if (current === undefined) throw unknownId(SCENE_TOOL, `${label} (update)`, id, board)
              ops.push({ op: 'update', id, patch: objectPatch(raw, current, `${label} (update ${id})`) })
              updated.push(id)
              break
            }
            case 'remove': {
              const id = typeof op.id === 'string' ? op.id : ''
              if (id === '') throw new Error(`${label} (remove): \`id\` is required`)
              if (!byId.has(id)) throw unknownId(SCENE_TOOL, `${label} (remove)`, id, board)
              ops.push({ op: 'remove', id })
              removed.push(id)
              byId.delete(id)
              projected -= 1
              break
            }
            case 'clear':
              ops.push({ op: 'clear' })
              projected = 0
              break
            default:
              throw new Error(`${label}: \`op\` must be add | update | remove | clear`)
          }
        }
        if (projected > MAX_OBJECTS) {
          throw new Error(`${SCENE_TOOL}: this batch would leave ${projected} objects; the scene limit is ${MAX_OBJECTS}. `
            + 'Remove objects first (whiteboard_read lists their ids) or clear the scene.')
        }
        const payload: Scene3DEvent = view === undefined ? { ops } : { ops, view }
        return applyBoardEvent(board, SCENE_EVENT, payload)
      })
      const counts = census(snapshot.board)
      const frame = await autoFrame(services, sessionId, '3d')
      const result: BatchResult = {
        tool: SCENE_TOOL,
        added,
        updated,
        removed,
        counts,
        summary: changeSummary(SCENE_TOOL, added, updated, removed, counts),
        ...(frame === undefined ? {} : { frame }),
      }
      return result
    },
  })

  const read = defineTool({
    name: READ_TOOL,
    description:
      'Read the whole board state before revising work you did not just draw: every shape/object with its geometry and style, '
      + 'the view (camera, lights, shadows), the stage viewport and diagnostics. Use whiteboard_look when you need the picture.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (_args, exec) => {
      await ready
      const sessionId = boardIdFor(READ_TOOL, exec)
      const snapshot = store.read(sessionId)
      const board = snapshot.board
      const viewport = services?.captures.lastViewport(sessionId) ?? null
      const report = {
        mode: board.mode,
        rev: board.rev,
        canUndo: store.canUndo(sessionId),
        viewport,
        canvas: {
          background: board.canvas.background,
          grid: board.canvas.grid,
          shapes: board.canvas.shapes.map(shape => ({ ...shape, bounds: shapeBounds(shape) ?? null })),
        },
        scene: {
          background: board.scene.background,
          grid: board.scene.grid,
          autoRotate: board.scene.autoRotate,
          camera: board.scene.camera,
          lights: board.scene.lights.map((light, index) => ({
            ...light,
            casts: castsShadow(light, index, board.scene.lights),
          })),
          objects: board.scene.objects.map(object => ({ ...object, bounds: objectBounds(object) })),
        },
        diagnostics: diagnose(board),
      }
      return [
        describeBoard(board),
        `Canvas is a ${BOARD_EXTENT}×${BOARD_EXTENT} square (origin top-left, y down); 3D is world units with y up. `
          + 'Bounds are axis-aligned and ignore rotation.',
        JSON.stringify(report, null, 2),
        'Use whiteboard_look when you need the picture; use whiteboard_draw / whiteboard_3d to revise by id.',
      ].join('\n')
    },
  })

  const look = defineTool({
    name: LOOK_TOOL,
    description:
      'Capture what the open 画板 panel shows, as an image plus measurements and warnings. The panel must be on screen; '
      + 'without it use whiteboard_read. overlay "ids" labels every element with its id; debug "shadow-only" hides the lit '
      + 'surfaces and keeps the shadows, which is how a wrong shadow is identified.',
    parameters: {
      mode: {
        type: 'string',
        enum: ['auto', '2d', '3d'],
        description: 'Surface to capture; auto follows the panel (default).',
      },
      overlay: {
        type: 'string',
        enum: ['none', 'ids'],
        description: 'Draw element ids over the frame (default ids).',
      },
      debug: {
        type: 'string',
        enum: ['lit', 'shadow-only'],
        description: 'lit is the real picture; shadow-only shows the shadow pass (3D).',
      },
      maxWidth: {
        type: 'integer',
        description: 'Longest side of the returned image, in pixels (default 1280).',
      },
    },
    output: { schema: LOOK_OUTPUT, render: lookRender },
    execute: async (args, exec) => {
      await ready
      const sessionId = boardIdFor(LOOK_TOOL, exec)
      if (services === undefined) {
        throw new Error(`${LOOK_TOOL}: the capture channel is not wired in this host; use whiteboard_read instead`)
      }
      const snapshot = store.read(sessionId)
      const options: CaptureOptions = {
        mode: args.mode ?? 'auto',
        overlay: args.overlay ?? 'ids',
        debug: args.debug ?? 'lit',
        maxWidth: args.maxWidth ?? 1_280,
      }
      const answer = await services.captures.request(sessionId, options, 4_000)
      const saved = await services.frames.save(sessionId, answer.png)
      const image = await services.attachImage(saved, `whiteboard-${saved.hash}.png`)
      const warnings = diagnose(snapshot.board)
      const details = JSON.stringify({
        rev: snapshot.rev,
        mode: answer.mode,
        width: answer.width,
        height: answer.height,
        camera: answer.camera ?? null,
        viewport: answer.viewport ?? null,
      }, null, 2)
      const summary = `${LOOK_TOOL}: captured the ${answer.mode.toUpperCase()} panel at `
        + `${answer.width}×${answer.height}px (board rev ${snapshot.rev}); `
        + (image === undefined ? 'the PNG is on disk.' : 'the image is attached.')
      const result: LookResult = {
        tool: LOOK_TOOL,
        frame: {
          path: saved.path,
          hash: saved.hash,
          bytes: saved.bytes,
          width: answer.width,
          height: answer.height,
          mode: answer.mode,
          rev: snapshot.rev,
        },
        summary,
        warnings,
        details,
        ...(image === undefined ? {} : { image }),
      }
      return result
    },
  })

  const api = defineTool({
    name: API_TOOL,
    description:
      'Read the live board contract for this conversation: tool list, op/field spec, defaults, palette, '
      + 'current camera and lights, viewport, limits, examples and hints. Call it before authoring; every '
      + 'value can change between builds, themes and conversations, so do not assume values from another one.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (_args, exec) => {
      await ready
      const sessionId = boardIdFor(API_TOOL, exec)
      const snapshot = store.read(sessionId)
      const theme = services?.captures.lastAppTheme() ?? services?.captures.lastTheme(sessionId)
      const viewport = services?.captures.lastViewport(sessionId)
      const manifest = buildManifest({
        ...(theme === undefined ? {} : { theme }),
        ...(viewport === undefined ? {} : { viewport }),
        board: snapshot.board,
      })
      // Compact, not pretty: the manifest is already structured JSON and the
      // pretty form costs roughly twice the context for the same facts.
      return JSON.stringify(manifest)
    },
  })

  return [draw, scene, read, look, api]
}
