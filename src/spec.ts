/**
 * dsh-plugin-whiteboard — the declarative board contract.
 *
 * This module is the **single source of truth** for what the board accepts: one
 * field spec per wire field, one kind spec per 2D shape / 3D primitive, one spec
 * for the 3D scene view, and one limits table. Two consumers are generated from
 * it:
 *
 * 1. the model-facing tool parameter schemas (`buildDrawParameters`,
 *    `buildSceneParameters`), which stay structurally identical to the shipped
 *    `whiteboard_draw` / `whiteboard_3d` declarations in `tools.ts`;
 * 2. the `whiteboard_api` payload (`buildManifest` in `manifest.ts`), which
 *    tells the model the current build, surface conventions, live camera and
 *    lights, defaults, design scales, per-kind fields, limits, examples and
 *    hints under the **current** theme/viewport.
 *
 * Why a spec at all: the drawing policy in `agent.ts` used to hard-code camera
 * numbers, font sizes, palette advice and count caps, while `tools.ts`
 * hard-coded the same facts a second time as JSON Schema descriptions and a
 * third time as runtime validation. Three copies drift silently. Here the fact
 * is declared once, and both the schema and the prose payload are derived.
 *
 * Everything in this module is pure, dependency-light (only `scene.ts` plus a
 * **type-only** import of the tool-schema DSL) and JSON-serialisable, so it can
 * be bundled into either face and asserted by `scripts/spec.test.mjs` straight
 * from source.
 *
 * Field-spec conventions:
 *
 * - `appliesTo` names the units the field is meaningful for: `draw`/`scene` (an
 *   op object), `shape`/`object` (every kind of that surface), a concrete kind
 *   (`rect`, `box`, …), or a view unit (`view2d`, `view3d`, `camera`, `light`,
 *   `light-shadow`, `view-shadow`, `environment`).
 * - `required: true` means "required for every op/kind the field applies to".
 *   Per-kind requiredness lives in {@link SHAPE_SPECS} / {@link OBJECT_SPECS}.
 * - `client: 'both'` means the browser renderer reads the field;
 *   `client: 'host'` declares it for the Host contract only (the renderer
 *   ignores it until the next build wires it up).
 * - `accepted: false` marks a field that is part of the contract but that the
 *   **current** `whiteboard_draw` / `whiteboard_3d` schema does not accept yet.
 *   The manifest reports the flag and {@link ParameterBuildOptions} can filter
 *   those fields out of a generated schema.
 */

import {
  BOARD_EXTENT,
  DEFAULT_CAMERA,
  DEFAULT_LIGHTS,
  MAX_LIGHTS,
  MAX_OBJECTS,
  MAX_SHAPES,
  PALETTE_TOKENS,
  type Camera3D,
  type Light3D,
  type LightKind,
  type Object3DKind,
  type ShapeKind,
} from './scene.ts'
import type {
  ArrayValueSchemaSpec,
  BooleanValueSchemaSpec,
  IntegerValueSchemaSpec,
  NumberValueSchemaSpec,
  ObjectValueSchemaSpec,
  OneOfValueSchemaSpec,
  ParameterPropertySpec,
  ParameterSchemaSpec,
  StringValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

/** A lossless JSON value, as the tool schema DSL and the manifest allow. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** Version of the `whiteboard_api` payload this module produces. */
export const API_VERSION = '1.0'

/** Shape kinds a `whiteboard_draw` op may add. */
export const SHAPE_KINDS = [
  'rect',
  'ellipse',
  'line',
  'arrow',
  'polyline',
  'path',
  'text',
] as const satisfies readonly ShapeKind[]

/** Object kinds a `whiteboard_3d` op may add. */
export const OBJECT_KINDS = [
  'box',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'plane',
] as const satisfies readonly Object3DKind[]

/** Light kinds a 3D `view.lights` entry may declare. */
export const LIGHT_KINDS = ['ambient', 'directional', 'point'] as const satisfies readonly LightKind[]

/** Op verbs both surfaces share. */
export const OP_VERBS = ['add', 'update', 'remove', 'clear'] as const

/** Every scope token `FieldSpec.appliesTo` may use. */
export const FIELD_SCOPES = [
  'draw',
  'shape',
  ...SHAPE_KINDS,
  'scene',
  'object',
  ...OBJECT_KINDS,
  'view2d',
  'view3d',
  'camera',
  'light',
  'light-shadow',
  'view-shadow',
  'environment',
] as const

/**
 * Capabilities of one build, as declared by the Host.
 *
 * The numbers are duplicated from `tools.ts` on purpose (that module owns the
 * runtime enforcement); `scripts/spec.test.mjs` pins both sides to the same
 * values so a change in one is caught before it silently drifts from the other.
 */
export const LIMITS = {
  /** Shapes kept on one 2D canvas. */
  shapes: MAX_SHAPES,
  /** Objects kept in one 3D scene. */
  objects: MAX_OBJECTS,
  /** Ops accepted per tool call, on both surfaces. */
  opsPerCall: 64,
  /** Lights a 3D scene carries. */
  lights: MAX_LIGHTS,
  /** UTF-16 length of one text label. */
  text: 280,
  /** Length of one SVG `path` `d` string. */
  path: 4_000,
  /** Vertices in one polyline. */
  points: 400,
  /** Hard plausibility bound on any single 2D coordinate (`±20000`). */
  coordLimit: 20_000,
} as const

/** The primitive shape of a wire field. */
export type FieldType = 'number' | 'integer' | 'string' | 'boolean' | 'array' | 'object'

/** Which face consumes a field. */
export type FieldClient = 'both' | 'host'

/** Element shape of an array field, when the DSL can describe it. */
export type FieldItems = 'number' | 'number-pair' | 'light'

/** One wire field the board understands, on any surface. */
export interface FieldSpec {
  /** Wire name, exactly as the tool argument / document key. */
  name: string
  /** Value shape in the tool-schema DSL. */
  type: FieldType
  /** True when the value is required wherever the field applies. */
  required?: boolean
  /** Inclusive lower bound, for numeric fields (documentation + manifest). */
  min?: number
  /** Inclusive upper bound, for numeric fields. */
  max?: number
  /** Marks a number with no range clamp (only `Number.isFinite` is enforced). */
  unbounded?: true
  /** Inclusive upper bound on a string's UTF-16 length. */
  maxLength?: number
  /** Inclusive lower bound on an array's element count. */
  minItems?: number
  /** Inclusive upper bound on an array's element count. */
  maxItems?: number
  /** Element schema an array field generates; omitted accepts any JSON item. */
  items?: FieldItems
  /** Closed string set, when the field accepts one. */
  enum?: readonly string[]
  /** True when `null` is a meaningful value (paint fields: `null` = none). */
  nullable?: true
  /** Value the renderer/Host assumes when the model omits the field. */
  default?: JsonValue
  /** Unit shown in the manifest (`logical units`, `degrees`, `0..1`, …). */
  unit?: string
  /** One line the model reads; must stand alone without the prompt. */
  doc: string
  /** Scopes the field is meaningful in (see {@link FIELD_SCOPES}). */
  appliesTo: readonly string[]
  /** Which face consumes the field. */
  client: FieldClient
  /** False when the current tool schema does not accept the field yet. */
  accepted?: false
  /** Child field-spec ids, for an object field. */
  children?: readonly string[]
  /** A literal example value. */
  example?: JsonValue
}

/** One kind of 2D shape or 3D primitive. */
export interface KindSpec {
  /** The kind discriminator the op carries. */
  kind: ShapeKind | Object3DKind
  /** One line describing what to use it for. */
  doc: string
  /** Shorter "best for" hint; optional. */
  use?: string
  /** Wire fields required when adding this kind. */
  required: readonly string[]
  /**
   * Kind-specific overrides of {@link FIELD_SPECS} defaults. A manifest kind's
   * full default set is every applicable field default plus these overrides.
   */
  defaults?: Readonly<Record<string, JsonValue>>
  /** One compact `add` op for this kind. */
  example: Readonly<Record<string, JsonValue>>
}

/** Shadow settings of the 3D ground. */
export interface ShadowSettings {
  /** Whether objects ground themselves with a shadow. */
  enabled: boolean
  /** `0..1` shadow strength. */
  opacity: number
  /** Blur radius of the shadow edge. */
  softness: number
}

/** Image-based reflection environment of the 3D scene. */
export interface EnvironmentSettings {
  /** `studio` builds a theme-matched studio; `none` disables reflections. */
  kind: 'studio' | 'none'
  /** Reflection strength, `0..2`. */
  intensity: number
}

/** Default ground-shadow settings; reserved until the document carries them. */
export const DEFAULT_SHADOW = {
  enabled: true,
  opacity: 0.32,
  softness: 2.5,
} as const satisfies ShadowSettings

/** Default reflection environment (light theme); see {@link environmentDefaults}. */
export const DEFAULT_ENVIRONMENT = {
  kind: 'studio',
  intensity: 0.75,
} as const satisfies EnvironmentSettings

/** One view block of the 3D `view` argument. */
export interface ViewBlockSpec {
  /** One line the model reads. */
  doc: string
  /** Leaf field-spec id, for a scalar or a pre-built object field. */
  field?: string
  /** Child field-spec ids, for an object block (`camera`). */
  fields?: readonly string[]
  /** Element field-spec ids, for an array block (`lights`). */
  items?: readonly string[]
  /** Maximum element count of an array block. */
  maxItems?: number
  /** Documented default, as JSON. */
  default: JsonValue
}

/** The seven settings a `whiteboard_3d` `view` argument may carry. */
export type ViewBlockName =
  | 'camera'
  | 'background'
  | 'grid'
  | 'autoRotate'
  | 'lights'
  | 'shadow'
  | 'environment'

/** Tool names this plugin owns, as the model sees them. */
export const TOOL_NAMES = {
  draw: 'whiteboard_draw',
  scene3d: 'whiteboard_3d',
  read: 'whiteboard_read',
  look: 'whiteboard_look',
  api: 'whiteboard_api',
} as const

/** One role of a board tool. */
export type ToolRole = keyof typeof TOOL_NAMES

/** A tool's name and one-line purpose, as the manifest reports it. */
export interface ToolInfo {
  /** Wire name. */
  readonly name: string
  /** One line the model can act on. */
  readonly purpose: string
}

/** The board tools and what each is for. */
export const TOOL_SPECS: Readonly<Record<ToolRole, ToolInfo>> = {
  draw: {
    name: TOOL_NAMES.draw,
    purpose: 'Append 1–64 2D ops (add/update/remove/clear) to the conversation canvas; returns the ids it applied.',
  },
  scene3d: {
    name: TOOL_NAMES.scene3d,
    purpose: 'Append 1–64 3D ops plus an optional camera/light view to the conversation scene; returns the ids it applied.',
  },
  read: {
    name: TOOL_NAMES.read,
    purpose: 'Report the board ids, camera and revision before revising work you did not just draw.',
  },
  look: {
    name: TOOL_NAMES.look,
    purpose: 'Capture what the open panel currently shows, so a drawing can be checked by pixels instead of assumption.',
  },
  api: {
    name: TOOL_NAMES.api,
    purpose: 'Read this contract: build, theme, viewport, live board state, field specs, limits, examples and hints.',
  },
}

/** Field-spec ids that make up `view.camera`. */
const CAMERA_FIELD_IDS = ['camera.position', 'camera.target', 'camera.fov'] as const

/** Field-spec ids that make up one `view.lights` entry. */
const LIGHT_FIELD_IDS = [
  'light.kind',
  'light.color',
  'light.intensity',
  'light.position',
  'light.castShadow',
  'light.shadow',
] as const

/** Field-spec ids that make up `light.shadow`. */
const LIGHT_SHADOW_FIELD_IDS = ['light-shadow.radius', 'light-shadow.mapSize'] as const

/** Field-spec ids that make up `view.shadow`. */
const VIEW_SHADOW_FIELD_IDS = ['view-shadow.enabled', 'view-shadow.opacity', 'view-shadow.softness'] as const

/** Field-spec ids that make up `view.environment`. */
const ENVIRONMENT_FIELD_IDS = ['environment.kind', 'environment.intensity'] as const

/** Scopes whose fields belong on a 2D op object. */
const DRAW_SCOPES: ReadonlySet<string> = new Set(['draw', 'shape', ...SHAPE_KINDS])

/** Scopes whose fields belong on a 3D op object. */
const SCENE_SCOPES: ReadonlySet<string> = new Set(['scene', 'object', ...OBJECT_KINDS])

/**
 * Copy a JSON value so callers can never mutate the spec constants.
 * @param value - any lossless JSON value, including one of the spec defaults.
 * @returns a structurally equal value with fresh arrays/objects.
 */
export function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, JsonValue> = {}
    for (const [key, child] of Object.entries(value)) copy[key] = cloneJson(child)
    return copy
  }
  return value
}

/** Serialise a camera as plain JSON for the manifest and view defaults. */
function cameraJson(camera: Camera3D): Record<string, JsonValue> {
  return {
    position: [...camera.position],
    target: [...camera.target],
    fov: camera.fov,
  }
}

/** Serialise a light rig as plain JSON for the manifest and view defaults. */
function lightsJson(lights: readonly Light3D[]): JsonValue[] {
  return lights.map((light) => {
    const entry: Record<string, JsonValue> = {
      kind: light.kind,
      color: light.color,
      intensity: light.intensity,
    }
    if (light.position !== undefined) entry['position'] = [...light.position]
    if (typeof light.castShadow === 'boolean') entry['castShadow'] = light.castShadow
    if (light.shadow !== undefined) {
      const shadow: Record<string, JsonValue> = {}
      if (light.shadow.radius !== undefined) shadow['radius'] = light.shadow.radius
      if (light.shadow.mapSize !== undefined) shadow['mapSize'] = light.shadow.mapSize
      if (Object.keys(shadow).length > 0) entry['shadow'] = shadow
    }
    return entry
  })
}

/**
 * Every wire field the board understands, keyed by a stable spec id.
 *
 * The key is namespaced (`rect.w`, `light.shadow`) because the same wire name
 * can mean different things on different surfaces (`shadow` is a boolean on a
 * 2D shape, an object on a light and on the 3D view); the key is never sent to
 * the model, the `name` is.
 */
export const FIELD_SPECS: Readonly<Record<string, FieldSpec>> = {
  // ---------------------------------------------------------------- op level
  'op.op': {
    name: 'op',
    type: 'string',
    required: true,
    enum: OP_VERBS,
    doc: 'Op verb: add appends, update patches by id, remove deletes by id, clear empties the surface. Ops fold in order.',
    appliesTo: ['draw', 'scene'],
    client: 'both',
    example: 'add',
  },
  'op.id': {
    name: 'id',
    type: 'string',
    maxLength: 64,
    doc: 'Item id: 1–64 chars of A-Z a-z 0-9 . _ : - starting alphanumeric. Required for update/remove; '
      + 'on add it names the new item (auto-minted when omitted). Ids stay stable across turns — patch by id.',
    appliesTo: ['draw', 'scene'],
    client: 'both',
    example: 'rect-a1',
  },

  // ---------------------------------------------------------- 2D op geometry
  'shape.kind': {
    name: 'kind',
    type: 'string',
    required: true,
    enum: SHAPE_KINDS,
    doc: '2D shape kind; required on add and fixed afterwards (an update cannot change it).',
    appliesTo: ['draw'],
    client: 'both',
    example: 'rect',
  },
  'shape.x': {
    name: 'x',
    type: 'number',
    required: true,
    min: 0,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Canvas x on the fixed 0–1000 square (origin top-left, x right): rect left edge, or the text anchor.',
    appliesTo: ['rect', 'text'],
    client: 'both',
    example: 70,
  },
  'shape.y': {
    name: 'y',
    type: 'number',
    required: true,
    min: 0,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Canvas y on the fixed 0–1000 square (y grows DOWN): rect top edge, or the text anchor.',
    appliesTo: ['rect', 'text'],
    client: 'both',
    example: 150,
  },
  'shape.w': {
    name: 'w',
    type: 'number',
    required: true,
    min: 1,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Rectangle width; keep x + w inside 0–1000.',
    appliesTo: ['rect'],
    client: 'both',
    example: 210,
  },
  'shape.h': {
    name: 'h',
    type: 'number',
    required: true,
    min: 1,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Rectangle height; keep y + h inside 0–1000.',
    appliesTo: ['rect'],
    client: 'both',
    example: 95,
  },
  'shape.radius': {
    name: 'radius',
    type: 'number',
    min: 0,
    max: 500,
    unit: 'logical units',
    default: 0,
    doc: 'Rectangle corner radius; 0 draws square corners, 12–20 reads as a card.',
    appliesTo: ['rect'],
    client: 'both',
    example: 16,
  },
  'shape.rotation': {
    name: 'rotation',
    type: 'number',
    unbounded: true,
    unit: 'degrees',
    default: 0,
    doc: 'Rotation around the shape centre in degrees (clockwise on screen); 0 is upright.',
    appliesTo: ['rect', 'ellipse'],
    client: 'both',
    example: 0,
  },
  'shape.cx': {
    name: 'cx',
    type: 'number',
    required: true,
    min: 0,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Ellipse centre x on the 0–1000 canvas.',
    appliesTo: ['ellipse'],
    client: 'both',
    example: 500,
  },
  'shape.cy': {
    name: 'cy',
    type: 'number',
    required: true,
    min: 0,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Ellipse centre y on the 0–1000 canvas (y down).',
    appliesTo: ['ellipse'],
    client: 'both',
    example: 500,
  },
  'shape.rx': {
    name: 'rx',
    type: 'number',
    required: true,
    min: 1,
    max: 500,
    unit: 'logical units',
    doc: 'Horizontal radius; rx === ry draws a circle.',
    appliesTo: ['ellipse'],
    client: 'both',
    example: 120,
  },
  'shape.ry': {
    name: 'ry',
    type: 'number',
    required: true,
    min: 1,
    max: 500,
    unit: 'logical units',
    doc: 'Vertical radius; rx === ry draws a circle.',
    appliesTo: ['ellipse'],
    client: 'both',
    example: 120,
  },
  'shape.x1': {
    name: 'x1',
    type: 'number',
    required: true,
    min: 0,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Start x of a line or arrow.',
    appliesTo: ['line', 'arrow'],
    client: 'both',
    example: 80,
  },
  'shape.y1': {
    name: 'y1',
    type: 'number',
    required: true,
    min: 0,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Start y of a line or arrow (y down).',
    appliesTo: ['line', 'arrow'],
    client: 'both',
    example: 300,
  },
  'shape.x2': {
    name: 'x2',
    type: 'number',
    required: true,
    min: 0,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'End x of a line or arrow.',
    appliesTo: ['line', 'arrow'],
    client: 'both',
    example: 420,
  },
  'shape.y2': {
    name: 'y2',
    type: 'number',
    required: true,
    min: 0,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'End y of a line or arrow (y down).',
    appliesTo: ['line', 'arrow'],
    client: 'both',
    example: 300,
  },
  'shape.head': {
    name: 'head',
    type: 'string',
    enum: ['end', 'both', 'none'],
    default: 'end',
    doc: 'Arrow heads: end (default), both, or none for a plain connector.',
    appliesTo: ['arrow'],
    client: 'both',
    example: 'end',
  },
  'shape.curve': {
    name: 'curve',
    type: 'number',
    unbounded: true,
    unit: 'logical units',
    default: 0,
    doc: 'Perpendicular bend of an arrow; positive bows to the left of the direction, 0 draws straight.',
    appliesTo: ['arrow'],
    client: 'both',
    example: 0,
  },
  'shape.points': {
    name: 'points',
    type: 'array',
    required: true,
    items: 'number-pair',
    minItems: 2,
    maxItems: LIMITS.points,
    unit: 'logical units',
    doc: 'Polyline vertices as [[x, y], …] in canvas units; at most 400 points.',
    appliesTo: ['polyline'],
    client: 'both',
    example: [[80, 700], [200, 640], [320, 700]],
  },
  'shape.smooth': {
    name: 'smooth',
    type: 'boolean',
    default: false,
    doc: 'Round the polyline corners with quadratic segments.',
    appliesTo: ['polyline'],
    client: 'both',
    example: true,
  },
  'shape.closed': {
    name: 'closed',
    type: 'boolean',
    default: false,
    doc: 'Join the last polyline point back to the first.',
    appliesTo: ['polyline'],
    client: 'both',
    example: false,
  },
  'shape.d': {
    name: 'd',
    type: 'string',
    required: true,
    maxLength: LIMITS.path,
    doc: 'SVG path data (Path2D syntax) starting with M/L/C/Q/A/Z; at most 4000 characters.',
    appliesTo: ['path'],
    client: 'both',
    example: 'M 500 200 l 40 40 l -40 40 l -40 -40 Z',
  },
  'shape.text': {
    name: 'text',
    type: 'string',
    required: true,
    maxLength: LIMITS.text,
    doc: 'Label text, ≤280 characters (UTF-16 length); wrap with maxWidth or an explicit \\n. '
      + 'Patch it by id to revise a label instead of redrawing the shape.',
    appliesTo: ['text'],
    client: 'both',
    example: 'Collect',
  },
  'shape.size': {
    name: 'size',
    type: 'number',
    min: 1,
    max: BOARD_EXTENT,
    unit: 'logical units',
    default: 22,
    doc: 'Font size in canvas units; body text ≥14, headings 18–28, a title up to 36.',
    appliesTo: ['text'],
    client: 'both',
    example: 22,
  },
  'shape.weight': {
    name: 'weight',
    type: 'string',
    enum: ['regular', 'medium', 'bold'],
    default: 'regular',
    doc: 'Font weight; bold for titles and labels that carry the eye.',
    appliesTo: ['text'],
    client: 'both',
    example: 'bold',
  },
  'shape.align': {
    name: 'align',
    type: 'string',
    enum: ['left', 'center', 'right'],
    default: 'left',
    doc: 'Horizontal text alignment around the anchor x.',
    appliesTo: ['text'],
    client: 'both',
    example: 'center',
  },
  'shape.baseline': {
    name: 'baseline',
    type: 'string',
    enum: ['top', 'middle', 'bottom'],
    default: 'top',
    doc: 'Vertical text anchor: top (default), middle for label centring in a card, bottom.',
    appliesTo: ['text'],
    client: 'both',
    example: 'middle',
  },
  'shape.maxWidth': {
    name: 'maxWidth',
    type: 'number',
    min: 1,
    max: BOARD_EXTENT,
    unit: 'logical units',
    doc: 'Wrap width; omit it and the label never wraps.',
    appliesTo: ['text'],
    client: 'both',
    example: 180,
  },

  // -------------------------------------------------------------- 2D style
  'style.fill': {
    name: 'fill',
    type: 'string',
    nullable: true,
    default: null,
    doc: 'Interior paint: a palette token or #rrggbb; null/omitted leaves the shape unfilled. '
      + 'Tint containers at 0.12–0.2 opacity with a solid stroke.',
    appliesTo: ['shape'],
    client: 'both',
    example: 'blue',
  },
  'style.stroke': {
    name: 'stroke',
    type: 'string',
    nullable: true,
    default: 'ink',
    doc: 'Outline paint; null removes the outline, omitting it strokes in ink.',
    appliesTo: ['shape'],
    client: 'both',
    example: 'blue',
  },
  'style.strokeWidth': {
    name: 'strokeWidth',
    type: 'number',
    min: 0.4,
    max: 100,
    unit: 'logical units',
    default: 3,
    doc: 'Outline width; 3 is the board default, 1.5–2 reads as a hairline.',
    appliesTo: ['shape'],
    client: 'both',
    example: 3,
  },
  'style.opacity': {
    name: 'opacity',
    type: 'number',
    min: 0,
    max: 1,
    doc: 'Whole-shape or whole-object opacity, 0–1; 1 is opaque.',
    appliesTo: ['shape', 'object'],
    client: 'both',
    default: 1,
    example: 0.14,
  },
  'style.dash': {
    name: 'dash',
    type: 'array',
    items: 'number',
    nullable: true,
    minItems: 1,
    default: null,
    doc: 'Dash pattern in canvas units, e.g. [6, 4]; null/omitted draws a solid line.',
    appliesTo: ['shape'],
    client: 'both',
    example: [6, 4],
  },
  'style.shadow': {
    name: 'shadow',
    type: 'boolean',
    default: false,
    doc: 'Soft drop shadow behind the shape, for cards and sticky notes.',
    appliesTo: ['shape'],
    client: 'both',
    example: true,
  },

  // ------------------------------------------------------------- 2D canvas
  'view2d.background': {
    name: 'background',
    type: 'string',
    nullable: true,
    default: null,
    doc: 'Page paint behind the 2D shapes; null follows the panel theme. The document carries it, '
      + 'but whiteboard_draw has no view argument today.',
    appliesTo: ['view2d'],
    client: 'both',
    accepted: false,
  },
  'view2d.grid': {
    name: 'grid',
    type: 'boolean',
    default: true,
    doc: 'Draw the 2D dot grid. The document carries it, but whiteboard_draw has no view argument today.',
    appliesTo: ['view2d'],
    client: 'both',
    accepted: false,
  },

  // ---------------------------------------------------------- 3D object
  'object.kind': {
    name: 'kind',
    type: 'string',
    required: true,
    enum: OBJECT_KINDS,
    doc: '3D primitive kind; required on add and fixed afterwards.',
    appliesTo: ['scene'],
    client: 'both',
    example: 'box',
  },
  'object.position': {
    name: 'position',
    type: 'array',
    items: 'number',
    minItems: 3,
    maxItems: 3,
    default: [0, 0, 0],
    unit: 'world units',
    doc: 'World position [x, y, z], y UP with the ground at y = 0; stand an object on the ground at '
      + '[x, height / 2, z].',
    appliesTo: ['object'],
    client: 'both',
    example: [0, 0.5, 0],
  },
  'object.rotation': {
    name: 'rotation',
    type: 'array',
    items: 'number',
    minItems: 3,
    maxItems: 3,
    default: [0, 0, 0],
    unit: 'degrees',
    doc: 'Euler rotation [x, y, z] in degrees; a plane lies flat at [-90, 0, 0].',
    appliesTo: ['object'],
    client: 'both',
    example: [0, 45, 0],
  },
  'object.scale': {
    name: 'scale',
    type: 'array',
    items: 'number',
    minItems: 3,
    maxItems: 3,
    default: [1, 1, 1],
    doc: 'Per-axis scale; absolute values, so a negative axis is not a mirror.',
    appliesTo: ['object'],
    client: 'both',
    example: [1, 1, 1],
  },
  'object.color': {
    name: 'color',
    type: 'string',
    default: 'blue',
    doc: 'Base paint: a palette token or #rrggbb.',
    appliesTo: ['object'],
    client: 'both',
    example: 'indigo',
  },
  'object.metalness': {
    name: 'metalness',
    type: 'number',
    min: 0,
    max: 1,
    default: 0.15,
    doc: 'Standard-material metalness, 0–1; above ~0.7 the environment reflections do the work.',
    appliesTo: ['object'],
    client: 'both',
    example: 0.2,
  },
  'object.roughness': {
    name: 'roughness',
    type: 'number',
    min: 0,
    max: 1,
    default: 0.45,
    doc: 'Standard-material roughness, 0–1; low values read as polished, high as matte.',
    appliesTo: ['object'],
    client: 'both',
    example: 0.35,
  },
  'object.wireframe': {
    name: 'wireframe',
    type: 'boolean',
    default: false,
    doc: 'Render the wireframe instead of the solid surface; a wireframe never casts a shadow.',
    appliesTo: ['object'],
    client: 'both',
    example: false,
  },
  'object.emissive': {
    name: 'emissive',
    type: 'string',
    nullable: true,
    default: null,
    doc: 'Glow paint; null/omitted means no emission.',
    appliesTo: ['object'],
    client: 'both',
    example: 'cyan',
  },
  'object.spin': {
    name: 'spin',
    type: 'number',
    unbounded: true,
    unit: 'degrees/second',
    doc: 'Self-rotation about the world Y axis in degrees per second; omitted stays still.',
    appliesTo: ['object'],
    client: 'both',
    example: 12,
  },
  'object.castShadow': {
    name: 'castShadow',
    type: 'boolean',
    doc: 'Cast a shadow onto the ground; omitted lets the material decide (an opaque, non-wireframe object casts, '
      + 'a transparent one does not).',
    appliesTo: ['object'],
    client: 'both',
    example: true,
  },
  'object.receiveShadow': {
    name: 'receiveShadow',
    type: 'boolean',
    default: true,
    doc: 'Receive shadows from other objects; omitted means true.',
    appliesTo: ['object'],
    client: 'both',
    example: true,
  },

  // --------------------------------------------------------- 3D geometry
  'geometry.size': {
    name: 'size',
    type: 'array',
    items: 'number',
    minItems: 3,
    maxItems: 3,
    default: [1, 1, 1],
    unit: 'world units',
    doc: 'Edge lengths as [x, y, z]; a plane uses x and y and ignores z.',
    appliesTo: ['box', 'plane'],
    client: 'both',
    example: [3, 1, 2],
  },
  'geometry.radius': {
    name: 'radius',
    type: 'number',
    min: 0.01,
    max: 100,
    unit: 'world units',
    default: 0.7,
    doc: 'Radius: a sphere radius, a torus ring radius, or the cylinder/cone fallback when '
      + 'radiusTop/radiusBottom are omitted.',
    appliesTo: ['sphere', 'cylinder', 'cone', 'torus'],
    client: 'both',
    example: 0.7,
  },
  'geometry.radiusTop': {
    name: 'radiusTop',
    type: 'number',
    min: 0,
    max: 100,
    unit: 'world units',
    default: 0.5,
    doc: 'Cylinder top radius; 0 builds a cone-like frustum.',
    appliesTo: ['cylinder'],
    client: 'both',
    example: 0.5,
  },
  'geometry.radiusBottom': {
    name: 'radiusBottom',
    type: 'number',
    min: 0,
    max: 100,
    unit: 'world units',
    default: 0.5,
    doc: 'Cylinder/cone bottom radius.',
    appliesTo: ['cylinder', 'cone'],
    client: 'both',
    example: 0.8,
  },
  'geometry.height': {
    name: 'height',
    type: 'number',
    min: 0.05,
    max: 100,
    unit: 'world units',
    default: 1.4,
    doc: 'Cylinder/cone height.',
    appliesTo: ['cylinder', 'cone'],
    client: 'both',
    example: 1.4,
  },
  'geometry.tube': {
    name: 'tube',
    type: 'number',
    min: 0.01,
    max: 100,
    unit: 'world units',
    default: 0.25,
    doc: 'Torus tube radius (the thickness of the ring).',
    appliesTo: ['torus'],
    client: 'both',
    example: 0.25,
  },
  'geometry.segments': {
    name: 'segments',
    type: 'integer',
    min: 3,
    max: 256,
    default: 32,
    doc: 'Radial tessellation, 3–256; 48 is a good default for round primitives, and the renderer draws '
      + 'at most 96.',
    appliesTo: ['sphere', 'cylinder', 'cone', 'torus'],
    client: 'both',
    example: 48,
  },

  // ------------------------------------------------------------- 3D view
  'view3d.background': {
    name: 'background',
    type: 'string',
    nullable: true,
    default: null,
    doc: 'Scene backdrop paint; null/omitted follows the panel theme, so set it only for a requested backdrop.',
    appliesTo: ['view3d'],
    client: 'both',
    example: 'black',
  },
  'view3d.grid': {
    name: 'grid',
    type: 'boolean',
    default: true,
    doc: 'Draw the ground grid at y = 0.',
    appliesTo: ['view3d'],
    client: 'both',
    example: true,
  },
  'view3d.autoRotate': {
    name: 'autoRotate',
    type: 'boolean',
    default: false,
    doc: 'Slowly orbit the camera around the target; use it sparingly, a moving board is hard to read.',
    appliesTo: ['view3d'],
    client: 'both',
    example: false,
  },
  'view3d.lights': {
    name: 'lights',
    type: 'array',
    items: 'light',
    maxItems: LIMITS.lights,
    default: lightsJson(DEFAULT_LIGHTS),
    doc: 'Replace the whole light rig (at most 4); an empty array restores the default rig. '
      + 'Keep one directional light as the shadow caster.',
    appliesTo: ['view3d'],
    client: 'both',
    example: lightsJson(DEFAULT_LIGHTS),
  },
  'view3d.shadow': {
    name: 'shadow',
    type: 'object',
    default: DEFAULT_SHADOW,
    children: VIEW_SHADOW_FIELD_IDS,
    doc: 'Ground shadow settings; reserved — declared for the next build, the current whiteboard_3d schema '
      + 'does not accept it yet.',
    appliesTo: ['view3d'],
    client: 'host',
    accepted: false,
  },
  'view3d.environment': {
    name: 'environment',
    type: 'object',
    default: DEFAULT_ENVIRONMENT,
    children: ENVIRONMENT_FIELD_IDS,
    doc: 'Image-based reflections that make metals read as metal; reserved — declared for the next build.',
    appliesTo: ['view3d'],
    client: 'host',
    accepted: false,
  },
  'view-shadow.enabled': {
    name: 'enabled',
    type: 'boolean',
    default: true,
    doc: 'Turn ground shadows on or off.',
    appliesTo: ['view-shadow'],
    client: 'host',
    accepted: false,
  },
  'view-shadow.opacity': {
    name: 'opacity',
    type: 'number',
    min: 0,
    max: 1,
    default: 0.32,
    doc: 'Shadow strength, 0–1; 0.25–0.45 reads as a soft contact shadow.',
    appliesTo: ['view-shadow'],
    client: 'host',
    accepted: false,
  },
  'view-shadow.softness': {
    name: 'softness',
    type: 'number',
    min: 0,
    max: 10,
    default: 2.5,
    doc: 'Blur radius of the shadow edge; 0 is a hard edge, 3–5 is a soft studio shadow.',
    appliesTo: ['view-shadow'],
    client: 'host',
    accepted: false,
  },
  'environment.kind': {
    name: 'kind',
    type: 'string',
    enum: ['studio', 'none'],
    default: 'studio',
    doc: 'studio builds a theme-matched reflection studio; none disables image-based reflections.',
    appliesTo: ['environment'],
    client: 'host',
    accepted: false,
  },
  'environment.intensity': {
    name: 'intensity',
    type: 'number',
    min: 0,
    max: 2,
    default: 0.75,
    doc: 'Reflection strength, 0–2; dark themes use a little more (0.95) to keep metals from going black.',
    appliesTo: ['environment'],
    client: 'host',
    accepted: false,
  },

  // -------------------------------------------------------------- camera
  'camera.position': {
    name: 'position',
    type: 'array',
    items: 'number',
    minItems: 3,
    maxItems: 3,
    default: cameraJson(DEFAULT_CAMERA)['position'] ?? [6.4, 4.6, 8.2],
    unit: 'world units',
    doc: 'Camera eye [x, y, z] in world units; the default three-quarter view is (6.4, 4.6, 8.2).',
    appliesTo: ['camera'],
    client: 'both',
    example: [6.4, 4.6, 8.2],
  },
  'camera.target': {
    name: 'target',
    type: 'array',
    items: 'number',
    minItems: 3,
    maxItems: 3,
    default: cameraJson(DEFAULT_CAMERA)['target'] ?? [0, 0, 0],
    unit: 'world units',
    doc: 'Look-at point [x, y, z]; keep it around the objects, e.g. [0, 1, 0] for a grounded scene.',
    appliesTo: ['camera'],
    client: 'both',
    example: [0, 1, 0],
  },
  'camera.fov': {
    name: 'fov',
    type: 'number',
    min: 5,
    max: 140,
    unit: 'degrees',
    default: DEFAULT_CAMERA.fov,
    doc: 'Vertical field of view in degrees; the tool accepts 5–140 and the renderer displays 15–100.',
    appliesTo: ['camera'],
    client: 'both',
    example: 45,
  },

  // --------------------------------------------------------------- light
  'light.kind': {
    name: 'kind',
    type: 'string',
    required: true,
    enum: LIGHT_KINDS,
    doc: 'Light kind: ambient fills the scene, directional is the key/sun (and shadow caster), point is a local lamp.',
    appliesTo: ['light'],
    client: 'both',
    example: 'directional',
  },
  'light.color': {
    name: 'color',
    type: 'string',
    default: 'white',
    doc: 'Light paint: a palette token or #rrggbb.',
    appliesTo: ['light'],
    client: 'both',
    example: 'white',
  },
  'light.intensity': {
    name: 'intensity',
    type: 'number',
    min: 0,
    max: 50,
    default: 1,
    doc: 'Light intensity; ambient 0.4–0.7 plus a directional key at 1.4–2 is the usual rig.',
    appliesTo: ['light'],
    client: 'both',
    example: 1.6,
  },
  'light.position': {
    name: 'position',
    type: 'array',
    items: 'number',
    minItems: 3,
    maxItems: 3,
    default: [0, 5, 0],
    unit: 'world units',
    doc: 'Light position [x, y, z]; required for directional/point and ignored for ambient.',
    appliesTo: ['light'],
    client: 'both',
    example: [5, 8, 6],
  },
  'light.castShadow': {
    name: 'castShadow',
    type: 'boolean',
    doc: 'Cast a shadow; only directional lights do in the current renderer, and omitting it makes the first '
      + 'directional light the caster.',
    appliesTo: ['light'],
    client: 'both',
    example: true,
  },
  'light.shadow': {
    name: 'shadow',
    type: 'object',
    children: LIGHT_SHADOW_FIELD_IDS,
    doc: 'Shadow-map tuning of a shadow-casting light.',
    appliesTo: ['light'],
    client: 'both',
  },
  'light-shadow.radius': {
    name: 'radius',
    type: 'number',
    min: 0,
    max: 20,
    default: 2.5,
    doc: 'Softness of the shadow edge (three.js `shadow.radius`); 1–4 reads as a soft studio shadow.',
    appliesTo: ['light-shadow'],
    client: 'both',
  },
  'light-shadow.mapSize': {
    name: 'mapSize',
    type: 'integer',
    min: 256,
    max: 4096,
    default: 2048,
    doc: 'Square shadow-map resolution in pixels; 2048 is the board default, higher is sharper and slower.',
    appliesTo: ['light-shadow'],
    client: 'both',
  },
}

/** The seven settings of a `whiteboard_3d` `view` argument. */
export const VIEW_SPEC: Readonly<Record<ViewBlockName, ViewBlockSpec>> = {
  camera: {
    doc: 'Camera framing: position (eye), target (look-at) and vertical fov; a partial patch keeps the '
      + 'axes you omit.',
    fields: CAMERA_FIELD_IDS,
    default: cameraJson(DEFAULT_CAMERA),
  },
  background: {
    doc: 'Scene backdrop paint; null (the default) follows the panel theme.',
    field: 'view3d.background',
    default: null,
  },
  grid: {
    doc: 'Draw the ground grid at y = 0.',
    field: 'view3d.grid',
    default: true,
  },
  autoRotate: {
    doc: 'Slowly orbit the camera around the target.',
    field: 'view3d.autoRotate',
    default: false,
  },
  lights: {
    doc: 'Replace the entire light rig (at most 4); an empty array restores the default rig.',
    items: LIGHT_FIELD_IDS,
    maxItems: LIMITS.lights,
    default: lightsJson(DEFAULT_LIGHTS),
  },
  shadow: {
    doc: 'Ground shadow strength and softness; reserved for the next build.',
    field: 'view3d.shadow',
    default: DEFAULT_SHADOW,
  },
  environment: {
    doc: 'Image-based reflections for metals; reserved for the next build.',
    field: 'view3d.environment',
    default: DEFAULT_ENVIRONMENT,
  },
}

/** Every 2D shape kind and what it is for. */
export const SHAPE_SPECS: Readonly<Record<ShapeKind, KindSpec>> = {
  rect: {
    kind: 'rect',
    doc: 'Rectangle, optionally rounded; the workhorse for flow steps, cards, containers and table cells.',
    use: 'flow steps, cards, containers',
    required: ['x', 'y', 'w', 'h'],
    defaults: {},
    example: {
      kind: 'rect',
      x: 70,
      y: 150,
      w: 210,
      h: 95,
      radius: 16,
      fill: 'blue',
      opacity: 0.14,
      stroke: 'blue',
      strokeWidth: 3,
    },
  },
  ellipse: {
    kind: 'ellipse',
    doc: 'Ellipse or circle (rx === ry); use it for start/end nodes, badges and emphasis.',
    use: 'start/end nodes, badges, emphasis',
    required: ['cx', 'cy', 'rx', 'ry'],
    example: {
      kind: 'ellipse',
      cx: 500,
      cy: 500,
      rx: 120,
      ry: 120,
      fill: 'teal',
      opacity: 0.16,
      stroke: 'teal',
      strokeWidth: 3,
    },
  },
  line: {
    kind: 'line',
    doc: 'Straight segment; a divider or a plain relationship with no direction.',
    use: 'dividers, undirected links',
    required: ['x1', 'y1', 'x2', 'y2'],
    example: {
      kind: 'line',
      x1: 80,
      y1: 300,
      x2: 420,
      y2: 300,
      stroke: 'muted',
      strokeWidth: 3,
    },
  },
  arrow: {
    kind: 'arrow',
    doc: 'Segment with one arrow head (default end); the connector between two labels or steps.',
    use: 'directed flow, connectors',
    required: ['x1', 'y1', 'x2', 'y2'],
    defaults: { head: 'end', curve: 0 },
    example: {
      kind: 'arrow',
      x1: 280,
      y1: 200,
      x2: 360,
      y2: 200,
      stroke: 'muted',
      strokeWidth: 3,
      head: 'end',
    },
  },
  polyline: {
    kind: 'polyline',
    doc: 'Connected point list; trends, simple charts and hand-plotted routes.',
    use: 'trend lines, routes',
    required: ['points'],
    defaults: { smooth: false, closed: false },
    example: {
      kind: 'polyline',
      points: [[80, 700], [200, 640], [320, 700]],
      smooth: true,
      stroke: 'purple',
      strokeWidth: 3,
    },
  },
  path: {
    kind: 'path',
    doc: 'Arbitrary SVG path data for free-form shapes and icons; must start with a command letter.',
    use: 'icons, free-form marks',
    required: ['d'],
    example: {
      kind: 'path',
      d: 'M 500 200 l 40 40 l -40 40 l -40 -40 Z',
      fill: 'amber',
      opacity: 0.2,
      stroke: 'amber',
      strokeWidth: 3,
    },
  },
  text: {
    kind: 'text',
    doc: 'Text label, ≤280 characters; the only kind with text, size, weight, align, baseline and maxWidth.',
    use: 'labels, titles, annotations',
    required: ['x', 'y', 'text'],
    defaults: { size: 22, weight: 'regular', align: 'left', baseline: 'top' },
    example: {
      kind: 'text',
      x: 175,
      y: 197,
      text: 'Collect',
      size: 22,
      weight: 'bold',
      align: 'center',
      baseline: 'middle',
      fill: 'ink',
    },
  },
}

/** Every 3D primitive kind and what it is for. */
export const OBJECT_SPECS: Readonly<Record<Object3DKind, KindSpec>> = {
  box: {
    kind: 'box',
    doc: 'Box (cube); buildings, panels, stages and any blocky mass.',
    use: 'blocks, buildings, panels',
    required: [],
    example: {
      kind: 'box',
      position: [0, 0.5, 0],
      size: [3, 1, 2],
      color: 'indigo',
      metalness: 0.2,
      roughness: 0.35,
    },
  },
  sphere: {
    kind: 'sphere',
    doc: 'Sphere; planets, balls, nodes and any rounded mass.',
    use: 'planets, nodes, rounded mass',
    required: [],
    defaults: { radius: 0.7 },
    example: {
      kind: 'sphere',
      position: [0, 1.2, 0],
      radius: 0.7,
      color: 'amber',
      metalness: 0.6,
      roughness: 0.2,
    },
  },
  cylinder: {
    kind: 'cylinder',
    doc: 'Cylinder (or frustum via radiusTop/radiusBottom); pillars, coins, wheels and stands.',
    use: 'pillars, coins, stands',
    required: [],
    defaults: { radius: 0.5, radiusTop: 0.5, radiusBottom: 0.5, height: 1.4 },
    example: {
      kind: 'cylinder',
      position: [0, 0.7, 0],
      radius: 0.5,
      height: 1.4,
      color: 'teal',
      metalness: 0.3,
      roughness: 0.4,
    },
  },
  cone: {
    kind: 'cone',
    doc: 'Cone; pointers, roofs, funnels and tree-like silhouettes.',
    use: 'pointers, roofs, funnels',
    required: [],
    defaults: { radius: 0.8, radiusBottom: 0.8, height: 1.5 },
    example: {
      kind: 'cone',
      position: [0, 0.75, 0],
      radiusBottom: 0.8,
      height: 1.5,
      color: 'orange',
      roughness: 0.5,
    },
  },
  torus: {
    kind: 'torus',
    doc: 'Torus (ring); loops, orbits, rings and handles.',
    use: 'rings, orbits, loops',
    required: [],
    defaults: { radius: 0.8, tube: 0.25 },
    example: {
      kind: 'torus',
      position: [0, 1, 0],
      radius: 0.8,
      tube: 0.25,
      color: 'purple',
      metalness: 0.5,
      roughness: 0.25,
    },
  },
  plane: {
    kind: 'plane',
    doc: 'Plane; lay it flat with rotation [-90, 0, 0] to make a floor, road or screen.',
    use: 'floors, roads, screens',
    required: [],
    defaults: { size: [2, 2, 1] },
    example: {
      kind: 'plane',
      position: [0, 0, 0],
      size: [4, 4, 1],
      rotation: [-90, 0, 0],
      color: 'white',
      roughness: 0.9,
    },
  },
}

/** Design scales and palette advice the board follows, independent of build. */
export interface DesignSpec {
  /** Font sizes in 2D canvas units, with the readable floor and title ceiling. */
  typeScale: {
    readonly title: number
    readonly heading: number
    readonly subheading: number
    readonly body: number
    readonly label: number
    readonly caption: number
    readonly minBody: number
    readonly maxTitle: number
  }
  /** Spacing rhythm in 2D canvas units. */
  spacing: {
    readonly unit: number
    readonly gaps: readonly number[]
    readonly pageMargin: number
    readonly cardPadding: number
    readonly radii: readonly number[]
  }
  /** The palette contract: the tokens, their roles and when to use which. */
  palette: {
    /** Named paints the client resolves against the current theme. */
    readonly tokens: readonly string[]
    /** Semantic roles, so a board uses a small consistent accent set. */
    readonly semantics: Readonly<Record<string, string>>
    /** One line of palette/colour advice. */
    readonly advice: string
  }
}

/** The board's design system, shared by the manifest and the prompt. */
export const DESIGN_SPEC: DesignSpec = {
  typeScale: {
    title: 32,
    heading: 24,
    subheading: 20,
    body: 18,
    label: 16,
    caption: 14,
    minBody: 14,
    maxTitle: 36,
  },
  spacing: {
    unit: 8,
    gaps: [8, 12, 16, 24, 32],
    pageMargin: 48,
    cardPadding: 20,
    radii: [8, 12, 16],
  },
  palette: {
    tokens: PALETTE_TOKENS,
    semantics: {
      primary: 'blue',
      secondary: 'teal',
      success: 'green',
      warning: 'amber',
      danger: 'red',
      neutral: 'ink',
      quiet: 'muted',
      surface: 'white',
    },
    advice:
      'Use 3–4 accents plus ink and muted; tint containers at 0.12–0.2 opacity with a solid stroke; prefer '
      + 'palette tokens over hex so light and dark both work.',
  },
}

/** One complete tool call the model can copy, adapted to the current context. */
export interface ToolCallExample {
  /** Tool the snippet is for. */
  tool: string
  /** What the snippet demonstrates. */
  note: string
  /** False when the snippet uses fields the current build still rejects. */
  accepted: boolean
  /** The arguments object, ready to send. */
  args: JsonValue
}

/** The three examples every manifest carries. */
export const EXAMPLES: Readonly<Record<'draw' | 'scene3d' | 'fixShadow', ToolCallExample>> = {
  draw: {
    tool: TOOL_NAMES.draw,
    note: 'Layer 1 of a flow: container plus its label and the connector out. Send 2–6 ops per call, one '
      + 'logical layer at a time.',
    accepted: true,
    args: {
      ops: [
        {
          op: 'add',
          kind: 'rect',
          id: 'a',
          x: 70,
          y: 150,
          w: 210,
          h: 95,
          radius: 16,
          fill: 'blue',
          opacity: 0.14,
          stroke: 'blue',
          strokeWidth: 3,
        },
        {
          op: 'add',
          kind: 'text',
          id: 'a-label',
          x: 175,
          y: 197,
          text: 'Collect',
          size: 22,
          weight: 'bold',
          align: 'center',
          baseline: 'middle',
          fill: 'ink',
        },
        {
          op: 'add',
          kind: 'arrow',
          id: 'a-to-b',
          x1: 280,
          y1: 197,
          x2: 344,
          y2: 197,
          stroke: 'muted',
          strokeWidth: 3,
          head: 'end',
        },
      ],
    },
  },
  scene3d: {
    tool: TOOL_NAMES.scene3d,
    note: 'Two grounded primitives with a camera and lights in the same call; every object sits on y = 0 '
      + 'at position [x, height / 2, z].',
    accepted: true,
    args: {
      ops: [
        {
          op: 'add',
          kind: 'box',
          id: 'base',
          position: [0, 0.5, 0],
          size: [3, 1, 2],
          color: 'indigo',
          metalness: 0.2,
          roughness: 0.35,
        },
        {
          op: 'add',
          kind: 'sphere',
          id: 'orb',
          position: [0, 2.1, 0],
          radius: 0.7,
          color: 'amber',
          metalness: 0.6,
          roughness: 0.2,
          spin: 12,
        },
      ],
      view: {
        camera: { position: [6.4, 4.6, 8.2], target: [0, 1, 0], fov: 45 },
        grid: true,
      },
    },
  },
  fixShadow: {
    tool: TOOL_NAMES.scene3d,
    note: 'Fix shadows without redrawing: keep the geometry, replace the light rig and set castShadow on the one '
      + 'light that should cast. Use whiteboard_look({debug: "shadow-only"}) to see the shadow pass before and after.',
    accepted: true,
    args: {
      ops: [
        { op: 'update', id: 'base', color: 'indigo' },
      ],
      view: {
        lights: [
          { kind: 'ambient', color: 'white', intensity: 0.45 },
          { kind: 'directional', color: 'white', intensity: 1.8, position: [5, 8, 6], castShadow: false },
          { kind: 'directional', color: 'white', intensity: 0, position: [-4, 7, 5], castShadow: true, shadow: { radius: 4, mapSize: 2048 } },
        ],
      },
    },
  },
}

/** Short, load-bearing rules the manifest repeats to the model. */
export const HINTS: readonly string[] = [
  'Draw only when the user asks; the board is an answer, not decoration.',
  'Send 2–6 ops per call, one logical layer at a time (containers and titles, then content, then '
    + 'connectors, then labels); a call only reaches the board when the step ends, so one giant batch '
    + 'looks frozen.',
  'Calls append. Reuse the ids from the previous result and patch by id; an unknown id rejects the whole '
    + 'batch and lists the ids that exist.',
  'Call whiteboard_look after drawing to check the actual pixels — text overflow, overlaps and 3D '
    + 'framing — instead of assuming.',
  'Keep a 48-unit margin on the 2D canvas; body text ≥14 keeps the board readable at panel size.',
  'Palette tokens (ink, muted, blue, …) beat hex: the client resolves them per theme, so a light-mode '
    + 'board still reads in dark mode.',
  'Leave view.background unset (null) so the surface follows the panel theme; set it only for a '
    + 'requested backdrop.',
  'In 3D stand an object on the ground with position [x, height / 2, z]; the default camera (6.4, 4.6, '
    + '8.2) looks at the origin.',
  'A batch is atomic: one invalid op rejects every op in it. Fields whose `accepted` is false are '
    + 'reserved for the next build — do not send them yet.',
]

/** Options shared by both parameter builders. */
export interface ParameterBuildOptions {
  /**
   * Include fields marked `accepted: false` (the next-step contract). Default
   * `true`, which is the full contract `whiteboard_api` publishes. Pass `false`
   * when generating a schema for a tool build that does not normalise those
   * fields yet, so the model cannot send an argument that would be dropped.
   */
  includeReserved?: boolean
}

/** Look up one field spec by its stable id. */
export function fieldSpecById(id: string): FieldSpec {
  const spec = FIELD_SPECS[id]
  if (spec === undefined) {
    throw new Error(`whiteboard spec: unknown field spec id ${JSON.stringify(id)}`)
  }
  return spec
}

/**
 * The field specs of one op object, in declaration order.
 *
 * `op`, `id` and `kind` are moved to the front so the generated schema leads
 * with the addressing fields (`opacity` is shared with the 3D object block and
 * would otherwise sit between `id` and `kind`).
 * @param surface - which tool the op belongs to.
 * @returns every field meaningful on that surface, reserved ones included.
 */
export function opFieldSpecs(surface: 'draw' | 'scene'): readonly FieldSpec[] {
  const scopes = surface === 'draw' ? DRAW_SCOPES : SCENE_SCOPES
  const fields = Object.values(FIELD_SPECS).filter(spec => spec.appliesTo.some(scope => scopes.has(scope)))
  const head = ['op', 'id', 'kind'].flatMap(name => fields.filter(spec => spec.name === name))
  return [...head, ...fields.filter(spec => !['op', 'id', 'kind'].includes(spec.name))]
}

/**
 * Documented defaults of every field that applies to a scope.
 * @param scope - a concrete kind or a scope token (`shape`, `object`, `light`).
 * @returns a fresh JSON object of wire-name → default.
 */
export function defaultsFor(scope: string): Record<string, JsonValue> {
  const defaults: Record<string, JsonValue> = {}
  for (const spec of Object.values(FIELD_SPECS)) {
    if (spec.default === undefined) continue
    if (!spec.appliesTo.includes(scope)) continue
    defaults[spec.name] = cloneJson(spec.default)
  }
  return defaults
}

/**
 * Defaults of one kind: every applicable field default plus the kind overrides.
 * @param kind - concrete shape/object kind.
 * @param overrides - kind-specific values from {@link SHAPE_SPECS}/{@link OBJECT_SPECS}.
 * @returns a fresh JSON object of wire-name → default.
 */
export function kindDefaults(kind: string, overrides: Readonly<Record<string, JsonValue>> = {}): Record<string, JsonValue> {
  const defaults: Record<string, JsonValue> = {}
  for (const spec of Object.values(FIELD_SPECS)) {
    if (spec.default === undefined) continue
    const applies = spec.appliesTo.includes(kind)
      || (kind in SHAPE_SPECS ? spec.appliesTo.includes('shape') : spec.appliesTo.includes('object'))
    if (!applies) continue
    defaults[spec.name] = cloneJson(spec.default)
  }
  for (const [name, value] of Object.entries(overrides)) defaults[name] = cloneJson(value)
  return defaults
}

/** Documented geometry defaults shared by the 3D kinds (before per-kind overrides). */
export function geometryDefaults(): Record<string, JsonValue> {
  const defaults: Record<string, JsonValue> = {}
  for (const spec of Object.values(FIELD_SPECS)) {
    if (spec.default === undefined) continue
    if (!OBJECT_KINDS.some(kind => spec.appliesTo.includes(kind))) continue
    defaults[spec.name] = cloneJson(spec.default)
  }
  return defaults
}

/**
 * The reflection-environment default for one theme.
 * @param theme - palette the board is painting in.
 * @returns a fresh {@link EnvironmentSettings}.
 */
export function environmentDefaults(theme: 'light' | 'dark'): EnvironmentSettings {
  return { kind: 'studio', intensity: theme === 'dark' ? 0.95 : 0.75 }
}

/** Build one parameter property from its field spec. */
function propertyNode(spec: FieldSpec, includeReserved = true): ParameterPropertySpec {
  switch (spec.type) {
    case 'number': {
      const node: NumberValueSchemaSpec & { required?: true } = { type: 'number', description: spec.doc }
      if (spec.required === true) node.required = true
      return node
    }
    case 'integer': {
      const node: IntegerValueSchemaSpec & { required?: true } = { type: 'integer', description: spec.doc }
      if (spec.required === true) node.required = true
      return node
    }
    case 'string': {
      if (spec.nullable === true) {
        const node: OneOfValueSchemaSpec & { required?: true } = {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: spec.doc,
        }
        if (spec.required === true) node.required = true
        return node
      }
      const node: StringValueSchemaSpec & { required?: true } = { type: 'string', description: spec.doc }
      if (spec.enum !== undefined) node.enum = [...spec.enum]
      if (spec.required === true) node.required = true
      return node
    }
    case 'boolean': {
      const node: BooleanValueSchemaSpec & { required?: true } = { type: 'boolean', description: spec.doc }
      if (spec.required === true) node.required = true
      return node
    }
    case 'array': {
      const node: ArrayValueSchemaSpec & { required?: true } = { type: 'array', description: spec.doc }
      if (spec.items === 'number') node.items = { type: 'number' }
      else if (spec.items === 'number-pair') node.items = { type: 'array', items: { type: 'number' } }
      else if (spec.items === 'light') node.items = lightSchema(includeReserved)
      if (spec.nullable === true) {
        // A nullable array means "the value or none": `dash: null` is a solid line.
        const union: OneOfValueSchemaSpec & { required?: true } = {
          oneOf: [node, { type: 'null' }],
          description: spec.doc,
        }
        if (spec.required === true) union.required = true
        return union
      }
      if (spec.required === true) node.required = true
      return node
    }
    case 'object': {
      const node: ObjectValueSchemaSpec & { required?: true } = {
        type: 'object',
        additionalProperties: false,
        description: spec.doc,
        properties: collectionSchema(spec.children ?? [], includeReserved),
      }
      if (spec.required === true) node.required = true
      return node
    }
  }
}

/** Build a property map from a list of field-spec ids. */
function collectionSchema(ids: readonly string[], includeReserved: boolean): ParameterSchemaSpec {
  const properties: ParameterSchemaSpec = {}
  for (const id of ids) {
    const spec = fieldSpecById(id)
    if (!includeReserved && spec.accepted === false) continue
    properties[spec.name] = propertyNode(spec, includeReserved)
  }
  return properties
}

/** The schema of one `view.lights` entry. */
function lightSchema(includeReserved: boolean): ObjectValueSchemaSpec {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'One light: kind, color, intensity and, for directional/point, a position.',
    properties: collectionSchema(LIGHT_FIELD_IDS, includeReserved),
  }
}

/** Build the schema of one 3D `view` block. */
function viewBlockNode(block: ViewBlockSpec, includeReserved: boolean): ParameterPropertySpec {
  if (block.items !== undefined) {
    return {
      type: 'array',
      description: block.doc,
      items: lightSchema(includeReserved),
    }
  }
  if (block.fields !== undefined) {
    return {
      type: 'object',
      additionalProperties: false,
      description: block.doc,
      properties: collectionSchema(block.fields, includeReserved),
    }
  }
  if (block.field !== undefined) return propertyNode(fieldSpecById(block.field), includeReserved)
  throw new Error('whiteboard spec: a view block must declare a field, fields or items')
}

/** Build the full `view` object schema. */
function viewSchema(includeReserved: boolean): ObjectValueSchemaSpec {
  const properties: ParameterSchemaSpec = {}
  for (const [name, block] of Object.entries(VIEW_SPEC)) {
    const reference = block.field === undefined ? undefined : FIELD_SPECS[block.field]
    const reserved = reference?.accepted === false
      || (block.items !== undefined && block.items.every(id => FIELD_SPECS[id]?.accepted === false))
    if (!includeReserved && reserved) continue
    properties[name] = viewBlockNode(block, includeReserved)
  }
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Scene settings; omitted fields keep their current value.',
    properties,
  }
}

/** Build the properties of one op object. */
function opSchema(surface: 'draw' | 'scene', includeReserved: boolean): ParameterSchemaSpec {
  const properties: ParameterSchemaSpec = {}
  for (const spec of opFieldSpecs(surface)) {
    if (!includeReserved && spec.accepted === false) continue
    properties[spec.name] = propertyNode(spec, includeReserved)
  }
  return properties
}

/**
 * The parameter schema of `whiteboard_draw`, in the shipped tool-schema DSL.
 *
 * Structurally it is the same object `tools.ts` declares by hand (plus the
 * documentation and enums kept in {@link FIELD_SPECS}); it is generated so the
 * model's arguments and the manifest cannot describe different fields.
 * @param options - `includeReserved` (default `true`) keeps the next-step fields.
 * @returns a fresh parameter schema.
 */
export function buildDrawParameters(options: ParameterBuildOptions = {}): ParameterSchemaSpec {
  const includeReserved = options.includeReserved !== false
  return {
    ops: {
      type: 'array',
      required: true,
      description: `2D ops, folded in order; 1–${LIMITS.opsPerCall} per call.`,
      items: {
        type: 'object',
        additionalProperties: false,
        description: 'One 2D op: add, update, remove or clear.',
        properties: opSchema('draw', includeReserved),
      },
    },
  }
}

/**
 * The parameter schema of `whiteboard_3d`: `ops` plus the `view` block.
 *
 * More complete than the shipped declaration on purpose — `view.lights`,
 * `view.shadow`, `view.environment` and per-object/light shadow fields are
 * declared here so the next build can open them without a second schema edit.
 * @param options - `includeReserved` (default `true`) keeps the next-step fields.
 * @returns a fresh parameter schema.
 */
export function buildSceneParameters(options: ParameterBuildOptions = {}): ParameterSchemaSpec {
  const includeReserved = options.includeReserved !== false
  return {
    ops: {
      type: 'array',
      required: true,
      description: `3D ops, folded in order; 1–${LIMITS.opsPerCall} per call.`,
      items: {
        type: 'object',
        additionalProperties: false,
        description: 'One 3D op: add, update, remove or clear.',
        properties: opSchema('scene', includeReserved),
      },
    },
    view: viewSchema(includeReserved),
  }
}
