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
  applyBoardEvent, BOARD_EXTENT, describeBoard, DRAW_EVENT, lightCastsShadow, MAX_OBJECTS, MAX_SHAPES,
  PALETTE_TOKENS, SCENE_EVENT, shadowCasters, shapeIds,
  type ArrowShape, type BoardMode, type BoardState, type DrawEvent, type DrawOp, type EllipseShape,
  type Geometry3D, type Light3D, type LightKind, type LineShape, type Object3D, type Object3DOp,
  type PaletteToken, type PathShape, type PolylineShape, type RectShape,
  type Scene3DEvent, type Shape2D, type ShapePatch, type ShapeStyle, type TextShape, type Vec2, type Vec3,
  type View3DPatch,
} from './scene.ts'
import {
  DRAW_TOOL, API_TOOL, HISTORY_TOOL, LOOK_TOOL, READ_TOOL, SCENE_TOOL, UNDO_TOOL,
  type CaptureAnswer, type CaptureBaseline, type CaptureDiff, type CaptureOptions,
} from './shared.ts'
import type { BoardSnapshot, BoardStore } from './board-store.ts'
import type { AttachedImage, CaptureService, FrameStore, SavedFrame } from './capture.ts'
import { buildManifest, resolveBuildVersion } from './manifest.ts'

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

/** Output declaration of an inline image attachment, shared by look and dry run. */
const IMAGE_OUTPUT = {
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
} as const

/** Output declaration of one objective board check. */
const CHECK_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    pass: { type: 'boolean', required: true },
    detail: { type: 'string', required: true },
  },
} as const

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
    preview: {
      type: 'object',
      additionalProperties: false,
      description: 'Dry run only: the saved frame of the uncommitted document that would have been committed.',
      properties: {
        path: { type: 'string', required: true },
        hash: { type: 'string', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        mode: { type: 'string', enum: ['2d', '3d'], required: true },
        rev: { type: 'integer', required: true },
      },
    },
    image: {
      ...IMAGE_OUTPUT,
      description: 'Dry run only: the preview as an inline image, when the host can attach one.',
    },
    checks: {
      type: 'array',
      items: CHECK_OUTPUT,
      description: 'Dry run only: the objective checks run against the hypothetical board.',
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Dry run only: failed check details, in check order.',
    },
  },
} as const

/** One dry-run preview of an uncommitted document. */
interface PreviewResult {
  path: string
  hash: string
  width: number
  height: number
  mode: BoardMode
  rev: number
}

/** One batch result; structurally the canonical output value above. */
interface BatchResult {
  tool: string
  added: string[]
  updated: string[]
  removed: string[]
  counts: string
  summary: string
  frame?: string
  preview?: PreviewResult
  image?: AttachedImage
  checks?: BoardCheck[]
  warnings?: string[]
}

/** Render one batch result as text plus the dry-run image. */
function batchRender(_args: unknown, value: Readonly<BatchResult>): ContentBlock[] {
  const head: string[] = [value.summary]
  if (value.preview !== undefined) {
    head.push(` Preview: ${value.preview.path} (${value.preview.width}×${value.preview.height}px, `
      + `${value.preview.mode.toUpperCase()}, board rev ${value.preview.rev}); nothing was committed.`)
  } else if (value.frame !== undefined) {
    head.push(` Frame captured: ${value.frame} (open it with read_image, or call whiteboard_look for measurements).`)
  }
  if (value.checks !== undefined && value.checks.length > 0) {
    const failed = value.checks.filter(check => !check.pass)
    head.push(`\nChecks: ${value.checks.length - failed.length}/${value.checks.length} passed`
      + `${failed.length === 0 ? '.' : `; failing: ${failed.map(check => check.id).join(', ')}.`}`)
  }
  if (value.warnings !== undefined && value.warnings.length > 0) {
    head.push(`\nWarnings:\n- ${value.warnings.join('\n- ')}`)
  }
  const blocks: ContentBlock[] = [{ type: 'text', text: head.join('') }]
  if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
  return blocks
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

/** Describe a hypothetical change list for a dry run, which commits nothing. */
function dryRunSummary(
  tool: string, added: string[], updated: string[], removed: string[], counts: string,
): string {
  const parts: string[] = []
  if (added.length > 0) parts.push(`would add ${added.join(', ')}`)
  if (updated.length > 0) parts.push(`would update ${updated.join(', ')}`)
  if (removed.length > 0) parts.push(`would remove ${removed.join(', ')}`)
  const changed = parts.length === 0 ? 'would change nothing' : parts.join('; ')
  return `${tool} (dry run): ${changed} — ${counts}; nothing was committed.`
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

/**
 * Model-facing warnings for the current board: the things a picture would make
 * obvious but a bare id list would not.
 * @param board - current board.
 * @returns one line per finding, empty when nothing looks off.
 */
/** One declarative board check, mirrored in `whiteboard_look` / `whiteboard_read`. */
interface BoardCheck {
  /** Stable id the model can refer to. */
  id: string
  /** Whether the board satisfies the check. */
  pass: boolean
  /** Human-readable evidence, useful in both states. */
  detail: string
}

/**
 * The objective checks a model (or a test) can rely on without decoding pixels.
 * They are deliberately conservative: a `pass` means the file does not show the
 * problem, not that the picture is beautiful.
 * @param board - current board.
 * @returns one result per check, in a stable order.
 */
function boardChecks(board: BoardState): BoardCheck[] {
  const checks: BoardCheck[] = []
  const outside: string[] = []
  for (const shape of board.canvas.shapes) {
    const bounds = shapeBounds(shape)
    if (bounds === undefined) continue
    if (bounds.x1 < -0.5 || bounds.y1 < -0.5
      || bounds.x2 > BOARD_EXTENT + 0.5 || bounds.y2 > BOARD_EXTENT + 0.5) outside.push(shape.id)
  }
  checks.push({
    id: 'bounds.2d',
    pass: outside.length === 0,
    detail: outside.length === 0
      ? `All 2D shapes are inside the 0..${BOARD_EXTENT} square.`
      : `${outside.length} 2D shape(s) extend outside the 0..${BOARD_EXTENT} square: `
        + `${outside.slice(0, 8).join(', ')}${outside.length > 8 ? ', …' : ''}.`,
  })

  const scene = board.scene
  const casters = shadowCasters(scene.lights)
  const casterNames = casters.map(index => `light #${index + 1}`).join(', ')
  checks.push({
    id: 'shadow.present',
    pass: casters.length > 0,
    detail: casters.length > 0
      ? `${casters.length} light(s) cast shadows.`
      : 'No light casts a shadow; 3D objects may look like they float.',
  })
  checks.push({
    id: 'shadow.single',
    pass: casters.length <= 1,
    detail: casters.length <= 1
      ? 'At most one light casts a shadow.'
      : `${casters.length} lights cast shadows (${casterNames}); a single caster gives one readable shadow.`,
  })

  const transparentCasters = scene.objects
    .filter(object => object.castShadow === true && (object.opacity ?? 1) < 0.99)
    .map(object => object.id)
  checks.push({
    id: 'shadow.opaque',
    pass: transparentCasters.length === 0,
    detail: transparentCasters.length === 0
      ? 'No transparent object is forced to cast a solid shadow.'
      : `Transparent object(s) explicitly cast a solid shadow: ${transparentCasters.join(', ')}.`,
  })

  const belowGround = scene.objects.filter(object => objectBounds(object).min[1] < -0.05).map(object => object.id)
  checks.push({
    id: 'ground.objects',
    pass: belowGround.length === 0,
    detail: belowGround.length === 0
      ? 'All objects are on or above the ground plane.'
      : `Object(s) below the ground plane: ${belowGround.join(', ')}.`,
  })

  const fakeShadows = scene.objects
    .filter(object => /contact|shadow/i.test(object.id) && (object.opacity ?? 1) >= 0.99)
    .map(object => object.id)
  checks.push({
    id: 'shadow.fake',
    pass: fakeShadows.length === 0,
    detail: fakeShadows.length === 0
      ? 'No opaque object looks like a hand-made shadow.'
      : `Opaque object(s) look like hand-made shadows (${fakeShadows.join(', ')}); `
        + 'they are geometry, not light, and will not follow the light.',
  })

  return checks
}

/** Failed check details, in check order, for the warning/diagnostic lists. */
function warningsOf(checks: readonly BoardCheck[]): string[] {
  return checks.filter(check => !check.pass).map(check => check.detail)
}

/**
 * Capture a small automatic frame after a mutation, but only when the panel is
 * on screen. A closed panel must not turn a successful drawing into a timeout.
 * @param services - capture services, when wired.
 * @param sessionId - board key.
 * @param mode - the surface the call just wrote.
 * @param rev - revision the frame shows (the mutation's own revision).
 * @returns the saved PNG path, or undefined.
 */
async function autoFrame(
  services: BoardToolServices | undefined, sessionId: string, mode: BoardMode, rev: number,
): Promise<string | undefined> {
  if (services === undefined || !services.captures.hasViewer(sessionId)) return undefined
  const options: CaptureOptions = { mode, overlay: 'none', debug: 'lit', maxWidth: 768 }
  try {
    const answer = await services.captures.request(sessionId, options, 1_500)
    const saved = await services.frames.save(sessionId, answer.png, {
      width: answer.width,
      height: answer.height,
      mode: answer.mode,
      rev,
      source: 'auto',
      ...(answer.camera === undefined ? {} : { camera: answer.camera }),
      options,
    })
    return saved.path
  } catch {
    // A frame is a convenience after a mutation; never fail the mutation for it.
    return undefined
  }
}

/** One rendered dry-run preview: the saved frame and its inline attachment. */
interface PreviewCapture {
  /** The persisted PNG. */
  saved: SavedFrame
  /** What the panel answered, for size/mode metadata. */
  answer: CaptureAnswer
  /** The inline image block, when the host can attach one. */
  image?: AttachedImage
}

/**
 * Render one uncommitted document inside the open panel and save it.
 *
 * A dry run deliberately does not fall back to "text only": the whole point is
 * to see the batch before it exists, so a missing panel is an error instead of a
 * silent success. Nothing here touches the store.
 * @param services - capture services, when wired.
 * @param tool - tool name for a readable error.
 * @param sessionId - board key.
 * @param mode - the document's own surface.
 * @param board - the hypothetical (uncommitted) document.
 * @param rev - revision the document was derived from.
 * @returns the saved preview and its optional attachment.
 */
async function previewFrame(
  services: BoardToolServices | undefined,
  tool: string,
  sessionId: string,
  mode: BoardMode,
  board: BoardState,
  rev: number,
): Promise<PreviewCapture> {
  if (services === undefined) {
    throw new Error(`${tool} dry run needs the capture channel to render the preview, and this host has it not wired; `
      + 'use the normal call with the 画板 panel open, or whiteboard_read for the current board')
  }
  if (!services.captures.hasViewer(sessionId)) {
    throw new Error(`${tool} dry run renders the preview inside the open 画板 panel, and no panel is on screen; `
      + 'open the 画板 tab in the right sidebar and retry. Nothing was committed.')
  }
  const options: CaptureOptions = { mode, overlay: 'ids', debug: 'lit', maxWidth: 1_024 }
  let answer: CaptureAnswer
  try {
    answer = await services.captures.request(sessionId, options, 4_000, { preview: board })
  } catch (error) {
    throw new Error(`${tool} dry run could not render the preview, so nothing was committed: `
      + `${error instanceof Error ? error.message : String(error)}`)
  }
  const saved = await services.frames.save(sessionId, answer.png, {
    width: answer.width,
    height: answer.height,
    mode: answer.mode,
    rev,
    source: 'preview',
    ...(answer.camera === undefined ? {} : { camera: answer.camera }),
    options,
  })
  const image = await services.attachImage(saved, `whiteboard-preview-${saved.hash}.png`)
  return { saved, answer, ...(image === undefined ? {} : { image }) }
}

/** The three `diffAgainst` forms, spelled for a model-facing error. */
const DIFF_FORMS = '"previous" (the document before the latest mutation), "rev:<n>" (a retained document '
  + 'revision), or a 6–16 character frame-hash prefix'

/** A resolved `diffAgainst` selector: the wire baseline plus the label to report. */
interface ResolvedBaseline {
  /** The baseline the capture request carries. */
  baseline: CaptureBaseline
  /** Label for the result line (`previous`, `rev:12`, `frame:ab12`). */
  label: string
  /** Surface the baseline shows; must equal the current board mode. */
  mode: BoardMode
}

/** Whether a board document has no content on either surface. */
function emptyDocument(board: BoardState): boolean {
  return board.canvas.shapes.length === 0 && board.scene.objects.length === 0
}

/**
 * Point an empty earlier document at the surface being compared.
 *
 * A board that has never been drawn on is surface-agnostic: the first 3D batch
 * on a fresh board has a 2D `previous` document, but "empty before this edit" is
 * exactly what an empty 3D scene also means. Non-empty documents keep their
 * surface, so a real 2D-versus-3D comparison is still refused.
 * @param board - earlier document.
 * @param mode - surface of the current board.
 * @returns the same document, relabelled when it is empty.
 */
function onSurface(board: BoardState, mode: BoardMode): BoardState {
  return board.mode === mode || !emptyDocument(board) ? board : { ...board, mode }
}

/** Retained document revisions, for an error that also says what is available. */
function availableRevisions(store: BoardStore, sessionId: string): string {
  const retained = store.history(sessionId).map(entry => `rev:${entry.rev}`)
  const current = store.read(sessionId).rev
  return `${retained.length === 0 ? 'none' : retained.join(', ')} (current rev ${current})`
}

/**
 * Resolve one `diffAgainst` selector into a wire baseline.
 *
 * `previous` and `rev:<n>` come from the in-memory undo history and are compared
 * as documents; a hash selects a stored frame and is compared as an image.
 * @param store - board store (history access).
 * @param frames - frame store (hash lookup).
 * @param sessionId - board key.
 * @param selector - the model's argument, already trimmed.
 * @param mode - surface of the current board, used to relabel an empty baseline.
 * @returns the baseline and its label.
 * @throws a model-facing error naming the accepted forms and what is available.
 */
async function resolveBaseline(
  store: BoardStore,
  frames: FrameStore,
  sessionId: string,
  selector: string,
  mode: BoardMode,
): Promise<ResolvedBaseline> {
  if (selector === 'previous') {
    const previous = store.previous(sessionId)
    if (previous === undefined) {
      throw new Error(`${LOOK_TOOL}: diffAgainst "previous" needs the document before the latest mutation, but the `
        + `in-memory history is empty (or the Host restarted). Retained revisions: ${availableRevisions(store, sessionId)}. `
        + `Accepted forms: ${DIFF_FORMS}.`)
    }
    const board = onSurface(previous.board, mode)
    return {
      baseline: { kind: 'document', rev: previous.rev, label: 'previous', board },
      label: 'previous',
      mode: board.mode,
    }
  }
  const revisionMatch = /^rev:(\d{1,9})$/.exec(selector)
  if (revisionMatch !== null) {
    const wanted = Number(revisionMatch[1])
    const revision = store.revision(sessionId, wanted)
    if (revision === undefined) {
      throw new Error(`${LOOK_TOOL}: diffAgainst "rev:${wanted}" is not retained; the undo history is memory-only and `
        + `resets when the Host restarts. Retained revisions: ${availableRevisions(store, sessionId)}. `
        + `Accepted forms: ${DIFF_FORMS}.`)
    }
    const board = onSurface(revision.board, mode)
    return {
      baseline: { kind: 'document', rev: revision.rev, label: `rev:${revision.rev}`, board },
      label: `rev:${revision.rev}`,
      mode: board.mode,
    }
  }
  if (/^[0-9a-fA-F]{6,16}$/.test(selector)) {
    const record = await frames.byHash(sessionId, selector)
    if (record === undefined) {
      const saved = await frames.list(sessionId, 8)
      throw new Error(`${LOOK_TOOL}: diffAgainst ${JSON.stringify(selector)} matches no saved frame. Available frames: `
        + `${saved.length === 0 ? 'none' : saved.map(frame => frame.hash.slice(0, 8)).join(', ')}. `
        + `Accepted forms: ${DIFF_FORMS}.`)
    }
    const stored = await frames.read(sessionId, record.hash)
    if (stored === undefined) {
      throw new Error(`${LOOK_TOOL}: diffAgainst ${JSON.stringify(selector)} resolves to frame ${record.hash}, but its `
        + 'PNG is no longer readable (the index and the files disagree). Save a new frame with whiteboard_look and '
        + 'diff against that.')
    }
    return {
      baseline: {
        kind: 'image',
        rev: record.rev,
        label: `frame:${record.hash}`,
        png: stored.data.toString('base64'),
        width: record.width,
        height: record.height,
        mode: record.mode,
        ...(record.camera === undefined ? {} : { camera: record.camera }),
      },
      label: `frame:${record.hash}`,
      mode: record.mode,
    }
  }
  throw new Error(`${LOOK_TOOL}: diffAgainst must be ${DIFF_FORMS}; got ${JSON.stringify(selector)}.`)
}

/** Format a 0..1 changed ratio as the percentage the summary line repeats. */
function formatRatio(ratio: number): string {
  const percent = Math.max(0, Math.min(1, ratio)) * 100
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
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
      ...IMAGE_OUTPUT,
      description: 'The frame as an inline image, when the host can attach one; the PNG path still works.',
    },
    summary: { type: 'string', required: true },
    warnings: { type: 'array', items: { type: 'string' }, required: true },
    checks: {
      type: 'array',
      required: true,
      items: CHECK_OUTPUT,
    },
    tiles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tile captions when the PNG is a contact sheet (per-light or turntable).',
    },
    diff: {
      type: 'object',
      additionalProperties: false,
      description: 'Pixel comparison against the baseline diffAgainst named; absent for a plain look.',
      properties: {
        kind: { type: 'string', enum: ['document', 'image'], required: true },
        label: { type: 'string', required: true },
        rev: { type: 'integer', required: true },
        changedPixels: { type: 'integer', required: true },
        changedRatio: { type: 'number', required: true },
        bounds: {
          type: 'object',
          additionalProperties: false,
          description: 'Bounds of the changed pixels, in new-frame pixels; absent when nothing changed.',
          properties: {
            x: { type: 'number', required: true },
            y: { type: 'number', required: true },
            width: { type: 'number', required: true },
            height: { type: 'number', required: true },
          },
        },
        comparable: { type: 'boolean', required: true },
        note: { type: 'string', required: true },
      },
    },
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
  checks: BoardCheck[]
  tiles?: string[]
  diff?: CaptureDiff
  details: string
}

/** Render one look as text plus the image itself when an attachment exists. */
function lookRender(_args: unknown, value: Readonly<LookResult>): ContentBlock[] {
  const failed = value.checks.filter(check => !check.pass)
  const checkText = value.checks.length === 0
    ? ''
    : `\nChecks: ${value.checks.length - failed.length}/${value.checks.length} passed`
      + `${failed.length === 0 ? '.' : `; failing: ${failed.map(check => check.id).join(', ')}.`}`
  const diffText = value.diff === undefined ? '' : `\nDiff: ${value.diff.note}`
  const warningText = value.warnings.length === 0 ? '' : `\nWarnings:\n- ${value.warnings.join('\n- ')}`
  const imageHint = value.image === undefined
    ? `\nPNG: ${value.frame.path} — open it with read_image.`
    : ''
  const blocks: ContentBlock[] = [{
    type: 'text',
    text: `${value.summary}${checkText}${diffText}${warningText}${imageHint}\n${value.details}`,
  }]
  if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
  return blocks
}

/** Output declaration of one model-side undo. */
const UNDO_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reverted: { type: 'array', items: { type: 'string' }, required: true },
    rev: { type: 'integer', required: true },
    canUndo: { type: 'boolean', required: true },
    steps: { type: 'integer', required: true },
  },
} as const

/** One model-side undo result. */
interface UndoResult {
  reverted: string[]
  rev: number
  canUndo: boolean
  steps: number
}

/** Render one model-side undo as a single line. */
function undoRender(_args: unknown, value: Readonly<UndoResult>): { type: 'text'; text: string }[] {
  const text = value.steps === 0
    ? `${UNDO_TOOL}: nothing to undo (rev ${value.rev}${value.canUndo ? '' : ', history empty'}).`
    : `${UNDO_TOOL}: stepped back ${value.steps} (${value.reverted.join(', ')}); `
      + `rev ${value.rev}; canUndo ${value.canUndo}.`
  return [{ type: 'text', text }]
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
      + 'field spec, defaults, palette and batch limit. Pass dryRun: true to render the batch as a preview without '
      + 'committing anything.',
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
      dryRun: {
        type: 'boolean',
        description: 'Preview without committing (default false): renders the hypothetical board in the open 画板 '
          + 'panel and returns the frame, checks and hypothetical counts; the store, undo history and revision are '
          + 'left untouched.',
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
      // Build the batch as a pure fold so a dry run can reuse it: the batch is
      // validated against one board and applies atomically (or not at all).
      const fold = (board: BoardState): BoardState => {
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
      }
      const dryRun = args.dryRun === true
      const before = dryRun ? store.read(sessionId) : undefined
      let snapshot: BoardSnapshot
      if (before === undefined) {
        snapshot = await store.mutate(sessionId, fold)
      } else {
        // A dry run renders the hypothetical document; the store is untouched.
        snapshot = { rev: before.rev, board: fold(before.board) }
      }
      const counts = census(snapshot.board)
      if (dryRun) {
        const preview = await previewFrame(services, DRAW_TOOL, sessionId, '2d', snapshot.board, snapshot.rev)
        const checks = boardChecks(snapshot.board)
        const previewResult: BatchResult = {
          tool: DRAW_TOOL,
          added,
          updated,
          removed,
          counts,
          summary: dryRunSummary(DRAW_TOOL, added, updated, removed, counts),
          preview: {
            path: preview.saved.path,
            hash: preview.saved.hash,
            width: preview.answer.width,
            height: preview.answer.height,
            mode: preview.answer.mode,
            rev: snapshot.rev,
          },
          checks,
          warnings: warningsOf(checks),
          ...(preview.image === undefined ? {} : { image: preview.image }),
        }
        return previewResult
      }
      const frame = await autoFrame(services, sessionId, '2d', snapshot.rev)
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
      + 'spec, camera/lights and batch limit. Pass dryRun: true to render the batch as a preview without committing '
      + 'anything.',
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
      dryRun: {
        type: 'boolean',
        description: 'Preview without committing (default false): renders the hypothetical scene in the open 画板 '
          + 'panel and returns the frame, checks and hypothetical counts; the store, undo history and revision are '
          + 'left untouched.',
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
      // A pure fold, so the normal path commits it and a dry run only renders it.
      const fold = (board: BoardState): BoardState => {
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
      }
      const dryRun = args.dryRun === true
      const before = dryRun ? store.read(sessionId) : undefined
      let snapshot: BoardSnapshot
      if (before === undefined) {
        snapshot = await store.mutate(sessionId, fold)
      } else {
        // A dry run renders the hypothetical document; the store is untouched.
        snapshot = { rev: before.rev, board: fold(before.board) }
      }
      const counts = census(snapshot.board)
      if (dryRun) {
        const preview = await previewFrame(services, SCENE_TOOL, sessionId, '3d', snapshot.board, snapshot.rev)
        const checks = boardChecks(snapshot.board)
        const previewResult: BatchResult = {
          tool: SCENE_TOOL,
          added,
          updated,
          removed,
          counts,
          summary: dryRunSummary(SCENE_TOOL, added, updated, removed, counts),
          preview: {
            path: preview.saved.path,
            hash: preview.saved.hash,
            width: preview.answer.width,
            height: preview.answer.height,
            mode: preview.answer.mode,
            rev: snapshot.rev,
          },
          checks,
          warnings: warningsOf(checks),
          ...(preview.image === undefined ? {} : { image: preview.image }),
        }
        return previewResult
      }
      const frame = await autoFrame(services, sessionId, '3d', snapshot.rev)
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
      const checks = boardChecks(board)
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
            casts: lightCastsShadow(board.scene.lights, index),
          })),
          objects: board.scene.objects.map(object => ({ ...object, bounds: objectBounds(object) })),
        },
        checks,
        diagnostics: warningsOf(checks),
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
      + 'surfaces and keeps the shadows, which is how a wrong shadow is identified; debug "per-light" and angles '
      + '"turntable" return 3D contact sheets, and diffAgainst compares with an earlier revision or saved frame.',
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
        enum: ['lit', 'shadow-only', 'per-light'],
        description: 'lit is the real picture; shadow-only shows the shadow pass; per-light renders one tile per '
          + 'shadow-casting light as a 3D contact sheet.',
      },
      angles: {
        type: 'string',
        enum: ['default', 'turntable'],
        description: 'turntable renders four yaw views around the 3D camera target as one contact sheet; default keeps '
          + 'the live view.',
      },
      diffAgainst: {
        type: 'string',
        description: 'Compare with an earlier board instead of just capturing: "previous" (the document before the '
          + 'latest mutation), "rev:<n>" (a retained revision) or a saved frame hash prefix. Returns a '
          + 'before/after/changed sheet.',
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
      const board = snapshot.board
      const debug = args.debug ?? 'lit'
      const perLight = debug === 'per-light'
      const turntable = args.angles === 'turntable'
      const requestedDiff = typeof args.diffAgainst === 'string' ? args.diffAgainst.trim() : undefined
      if (requestedDiff === '') {
        throw new Error(`${LOOK_TOOL}: diffAgainst must be ${DIFF_FORMS}; got an empty string.`)
      }
      const selector = requestedDiff

      // Validate before requesting anything: a wrong mode should not cost a frame.
      if (perLight && turntable) {
        throw new Error(`${LOOK_TOOL}: debug "per-light" and angles "turntable" cannot be combined — each already `
          + 'returns a multi-tile sheet. Ask for one: per-light isolates one shadow-casting light per tile, turntable '
          + 'orbits the camera.')
      }
      if ((perLight || turntable) && board.mode !== '3d') {
        const rendered = perLight
          ? 'debug "per-light" renders one frame per shadow-casting light'
          : 'angles "turntable" renders four views around the camera target'
        throw new Error(`${LOOK_TOOL}: ${rendered}, which only exists in the 3D scene; the board is on the 2D canvas `
          + `(rev ${snapshot.rev}). Both contact sheets are 3D-only: draw to the 3D scene with whiteboard_3d, or drop `
          + 'the option and capture the plain frame.')
      }
      let casterCount = 0
      if (perLight) {
        casterCount = shadowCasters(board.scene.lights).length
        if (casterCount === 0) {
          throw new Error(`${LOOK_TOOL}: debug "per-light" needs at least one light that casts a shadow, and no light in `
            + 'this scene does. Arm one with whiteboard_3d view.lights: [{kind:"directional", intensity:0, '
            + 'castShadow:true, position:[…]}] — only directional lights cast shadows, and castShadow:false never does.')
        }
      }
      if (selector !== undefined && (perLight || turntable)) {
        throw new Error(`${LOOK_TOOL}: diffAgainst cannot be combined with debug "per-light" or angles "turntable" — `
          + 'a contact sheet is many views and a diff is one before/after pair. Ask for one, not both.')
      }
      const resolved = selector === undefined
        ? undefined
        : await resolveBaseline(store, services.frames, sessionId, selector, board.mode)
      if (resolved !== undefined && resolved.mode !== board.mode) {
        throw new Error(`${LOOK_TOOL}: diffAgainst ${resolved.label} is a ${resolved.mode.toUpperCase()} frame, but the `
          + `board is now ${board.mode.toUpperCase()}; a diff only compares the same surface. Use a baseline from the `
          + `${board.mode === '2d' ? '2D canvas' : '3D scene'} history, or skip diffAgainst.`)
      }

      const options: CaptureOptions = {
        // A sheet or a diff renders one known document, so it cannot follow the panel.
        mode: resolved !== undefined || perLight || turntable ? board.mode : (args.mode ?? 'auto'),
        overlay: args.overlay ?? 'ids',
        debug,
        maxWidth: args.maxWidth ?? 1_280,
        ...(turntable ? { angles: 'turntable' as const } : {}),
      }
      const extra: { baseline?: CaptureBaseline } = resolved === undefined ? {} : { baseline: resolved.baseline }
      const answer = await services.captures.request(sessionId, options, 4_000, extra)
      // The panel captures what it shows, so a pinned 2D surface (or an older
      // panel that ignores the new options) can answer a 3D request with a plain
      // frame. Refuse that instead of saving a picture whose summary lies about
      // what it is.
      if ((perLight || turntable) && (answer.mode !== '3d' || answer.tiles === undefined || answer.tiles.length === 0)) {
        const reason = answer.mode !== '3d'
          ? `the 画板 panel is showing the ${answer.mode.toUpperCase()} surface`
          : 'the panel returned a plain frame without contact-sheet captions'
        throw new Error(`${LOOK_TOOL}: ${perLight ? 'debug "per-light"' : 'angles "turntable"'} needs a 3D contact `
          + `sheet, but ${reason}. Switch the 画板 panel to 3D (or drop the option) and retry; nothing was saved.`)
      }
      if (resolved !== undefined && (answer.mode !== resolved.mode || answer.diff === undefined)) {
        const reason = answer.mode !== resolved.mode
          ? `the 画板 panel is showing the ${answer.mode.toUpperCase()} surface`
          : 'the panel returned a plain frame without diff statistics'
        throw new Error(`${LOOK_TOOL}: diffAgainst ${resolved.label} needs a ${resolved.mode.toUpperCase()} comparison, `
          + `but ${reason}. Switch the 画板 panel to ${resolved.mode.toUpperCase()} (or drop diffAgainst) and retry; `
          + 'nothing was saved.')
      }
      // A contact sheet is still a look; only a diff sheet is a comparison.
      const source = resolved === undefined ? 'look' : 'diff'
      const saved = await services.frames.save(sessionId, answer.png, {
        width: answer.width,
        height: answer.height,
        mode: answer.mode,
        rev: snapshot.rev,
        source,
        ...(answer.camera === undefined ? {} : { camera: answer.camera }),
        options,
      })
      const image = await services.attachImage(saved, `whiteboard-${saved.hash}.png`)
      const checks = boardChecks(board)
      const warnings = warningsOf(checks)
      const diff = answer.diff
      const view = resolved !== undefined
        ? `diff against ${resolved.label}${diff === undefined ? '' : `: ${formatRatio(diff.changedRatio)} changed`}`
        : turntable
          ? 'turntable sheet (4 views)'
          : perLight
            ? `per-light sheet (${casterCount} caster${casterCount === 1 ? '' : 's'})`
            : 'panel'
      const details = JSON.stringify({
        rev: snapshot.rev,
        mode: answer.mode,
        width: answer.width,
        height: answer.height,
        camera: answer.camera ?? null,
        viewport: answer.viewport ?? null,
        source,
        ...(resolved === undefined
          ? {}
          : { baseline: { kind: resolved.baseline.kind, label: resolved.label, rev: resolved.baseline.rev } }),
        tiles: answer.tiles ?? null,
        diff: diff ?? null,
        checks,
      }, null, 2)
      const summary = `${LOOK_TOOL}: captured the ${answer.mode.toUpperCase()} ${view} at `
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
        checks,
        details,
        ...(image === undefined ? {} : { image }),
        ...(answer.tiles === undefined ? {} : { tiles: answer.tiles }),
        ...(diff === undefined ? {} : { diff }),
      }
      return result
    },
  })

  const api = defineTool({
    name: API_TOOL,
    description:
      'Read the live board contract for this conversation: tool list, op/field spec, defaults, palette, '
      + 'current camera and lights, viewport, limits, examples and hints. Call it before authoring; every '
      + 'value can change between builds, themes and conversations, so do not assume values from another one. '
      + 'Pass `section` to fetch one part when the whole contract would be too much.',
    parameters: {
      section: {
        type: 'string',
        enum: ['all', 'tools', 'surfaces', 'current', 'defaults', 'design', 'ops', 'limits', 'examples', 'hints'],
        description: 'One part of the contract; all (default) returns everything.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => {
      await ready
      const sessionId = boardIdFor(API_TOOL, exec)
      const snapshot = store.read(sessionId)
      const theme = services?.captures.lastAppTheme() ?? services?.captures.lastTheme(sessionId)
      const viewport = services?.captures.lastViewport(sessionId)
      const manifest = buildManifest({
        ...(theme === undefined ? {} : { theme }),
        ...(viewport === undefined ? {} : { viewport }),
        board: snapshot.board,
        // The installed package version, so a model can tell two builds apart.
        // Cached after the first call; falls back to `dev` when it cannot be read.
        build: resolveBuildVersion(),
      })
      const section = args.section ?? 'all'
      if (section === 'all') return JSON.stringify(manifest)
      const pieces = {
        tools: manifest.tools,
        surfaces: manifest.surfaces,
        current: manifest.current,
        defaults: manifest.defaults,
        design: manifest.design,
        ops: manifest.ops,
        limits: manifest.limits,
        examples: manifest.examples,
        hints: manifest.hints,
      } as const
      return JSON.stringify({
        apiVersion: manifest.apiVersion,
        build: manifest.build,
        [section]: pieces[section],
      })
    },
  })

  const history = defineTool({
    name: HISTORY_TOOL,
    description:
      'Report the memory-only undo stack for this board: current revision, whether an undo exists, and the '
      + 'revisions an undo would restore. It resets when the Host restarts.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (_args, exec) => {
      await ready
      const sessionId = boardIdFor(HISTORY_TOOL, exec)
      const snapshot = store.read(sessionId)
      return JSON.stringify({
        rev: snapshot.rev,
        canUndo: store.canUndo(sessionId),
        history: store.history(sessionId),
      }, null, 2)
    },
  })

  const undo = defineTool({
    name: UNDO_TOOL,
    description:
      'Step the board back one or more mutations (draw or clear). Use it only when the user asks to undo; '
      + 'Ctrl+Z is theirs, and clearing is the only destructive action otherwise.',
    parameters: {
      steps: { type: 'integer', description: 'How many mutations to step back, 1..8 (default 1).' },
    },
    output: { schema: UNDO_OUTPUT, render: undoRender },
    execute: async (args, exec) => {
      await ready
      const sessionId = boardIdFor(UNDO_TOOL, exec)
      const steps = Math.max(1, Math.min(8, args.steps ?? 1))
      const reverted: string[] = []
      for (let i = 0; i < steps; i += 1) {
        const outcome = await store.undo(sessionId)
        if (outcome === undefined) break
        reverted.push(outcome.reverted)
      }
      const snapshot = store.read(sessionId)
      const result: UndoResult = {
        reverted,
        rev: snapshot.rev,
        canUndo: store.canUndo(sessionId),
        steps: reverted.length,
      }
      return result
    },
  })

  return [draw, scene, read, look, api, history, undo]
}
