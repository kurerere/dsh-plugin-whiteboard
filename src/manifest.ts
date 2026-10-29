/**
 * dsh-plugin-whiteboard — the `whiteboard_api` payload.
 *
 * `whiteboard_api` is the model's **self-describing** way to learn the board:
 * instead of memorising camera numbers, palette tokens, count caps and field
 * lists from the prompt, it asks for the contract of the build it is talking to.
 * {@link buildManifest} assembles that contract from:
 *
 * - the live board document (`BoardState`, via `board`) — revision, mode,
 *   camera, lights, grid, background and counts;
 * - the request context the Host can see but the model cannot — theme, stage
 *   viewport, resolved palette, measured contrast, build id;
 * - the single source of truth in `./spec.ts` — field/kind/view specs, limits,
 *   defaults, design scales, examples and hints.
 *
 * This module depends on `scene.ts` and `spec.ts` only. It deliberately does not
 * import `tools.ts` or `agent.ts`: the tool declarations and the prompt policy
 * will be migrated onto the spec, so the dependency has to run one way
 * (tool/prompt → manifest → spec), never back.
 *
 * The payload is pure and JSON-serialisable: no paths, no environment variables,
 * no credentials. Fresh copies of the mutable defaults (camera, lights, shadow,
 * environment, field defaults) are returned so a caller cannot corrupt the spec
 * constants through the manifest.
 */

import {
  BOARD_EXTENT,
  DEFAULT_CAMERA,
  DEFAULT_LIGHTS,
  type BoardState,
  type Camera3D,
  type Light3D,
  type Paint,
} from './scene.ts'
import {
  API_VERSION,
  DEFAULT_SHADOW,
  DESIGN_SPEC,
  EXAMPLES,
  HINTS,
  LIMITS,
  OBJECT_KINDS,
  OBJECT_SPECS,
  OP_VERBS,
  SHAPE_KINDS,
  SHAPE_SPECS,
  TOOL_SPECS,
  VIEW_SPEC,
  cloneJson,
  defaultsFor,
  environmentDefaults,
  fieldSpecById,
  geometryDefaults,
  kindDefaults,
  opFieldSpecs,
  type DesignSpec,
  type EnvironmentSettings,
  type FieldClient,
  type FieldSpec,
  type FieldType,
  type JsonValue,
  type KindSpec,
  type ShadowSettings,
  type ToolCallExample,
  type ToolInfo,
  type ToolRole,
  type ViewBlockSpec,
} from './spec.ts'

/** Build id used when the caller cannot supply one. */
const DEFAULT_BUILD = 'dev'

/** Stage size the panel reported, in CSS pixels. */
export interface ManifestViewport {
  /** Stage width in CSS pixels. */
  width: number
  /** Stage height in CSS pixels. */
  height: number
  /** Device pixel ratio the panel renders at. */
  dpr: number
}

/**
 * Everything the Host knows about the current request. Every field is optional:
 * `buildManifest({})` must produce a complete, useful contract for an empty
 * board.
 */
export interface ManifestContext {
  /** Palette the panel is painting in; defaults to `light`. */
  theme?: 'light' | 'dark'
  /** Stage size in CSS pixels, when the panel has reported one. */
  viewport?: ManifestViewport
  /** Resolved palette (token → concrete color), when the client can resolve one. */
  palette?: Record<string, string>
  /** Contrast ratio per token/role, when the caller measured them. */
  contrast?: Record<string, number>
  /** Current board document; omitted means an empty board. */
  board?: BoardState
  /** Build identifier (version plus commit, or similar); defaults to `dev`. */
  build?: string
}

/** The two coordinate spaces of the board. */
export interface ManifestSurfaces {
  /** The 2D canvas: one fixed logical square, fitted into the panel. */
  canvas2d: {
    readonly extent: number
    readonly origin: 'top-left'
    readonly xAxis: 'right'
    readonly yAxis: 'down'
    readonly unit: string
    readonly note: string
  }
  /** The 3D scene: three.js world units around the origin. */
  scene3d: {
    readonly unit: string
    readonly up: 'y'
    readonly groundY: number
    readonly note: string
  }
}

/** Live state of the board, or the documented defaults when there is none. */
export interface ManifestCurrent {
  /** Palette the panel is painting in. */
  theme: 'light' | 'dark'
  /** Stage size in CSS pixels, or null when the panel has not reported one. */
  viewport: ManifestViewport | null
  /** Revision of the board document; 0 for an empty board. */
  rev: number
  /** Surface the model last wrote, or `2d` for an empty board. */
  mode: '2d' | '3d'
  /** What exists right now. */
  counts: { shapes: number; objects: number }
  /** Camera of the 3D scene (default camera for an empty board). */
  camera: Camera3D
  /** Light rig of the 3D scene (default rig for an empty board). */
  lights: Light3D[]
  /** Ground shadow settings; defaults until the board document carries them. */
  shadow: ShadowSettings
  /** Reflection environment; defaults until the board document carries it. */
  environment: EnvironmentSettings
  /** Grid visibility, per surface. */
  grid: { canvas: boolean; scene: boolean }
  /** Backdrop paint, per surface; null means "follow the theme". */
  background: { canvas: Paint | null; scene: Paint | null }
  /** Whether the 3D camera slowly orbits. */
  autoRotate: boolean
}

/** What the renderer/Host assumes when the model omits a field. */
export interface ManifestDefaults {
  /** Default 3D camera. */
  camera: Camera3D
  /** Default 3D light rig. */
  lights: Light3D[]
  /** 2D page defaults (background, grid). */
  canvas: { background: Paint | null; grid: boolean }
  /** 3D scene defaults (background, grid, autoRotate, shadow, environment). */
  scene: {
    background: Paint | null
    grid: boolean
    autoRotate: boolean
    shadow: ShadowSettings
    environment: EnvironmentSettings
  }
  /** Shared 2D style defaults (fill, stroke, strokeWidth, opacity, dash, shadow). */
  shape: Record<string, JsonValue>
  /** Text defaults (size, weight, align, baseline). */
  text: Record<string, JsonValue>
  /** 3D object defaults (position, rotation, scale, color, material, wireframe). */
  object: Record<string, JsonValue>
  /** Geometry defaults before per-kind overrides (size, radius, height, segments, …). */
  geometry: Record<string, JsonValue>
  /** Light defaults (color, intensity, position). */
  light: Record<string, JsonValue>
}

/** The palette block of {@link ManifestDesign}. */
export interface ManifestPalette {
  /** Named paints the client resolves per theme. */
  tokens: readonly string[]
  /** Semantic roles, so a board uses a small consistent accent set. */
  semantics: Readonly<Record<string, string>>
  /** One line of palette advice. */
  advice: string
  /** Concrete colors for this theme/viewport, when the client could resolve them. */
  resolved?: Readonly<Record<string, string>>
}

/** Design scales and palette the board follows. */
export interface ManifestDesign {
  /** Font sizes in 2D canvas units. */
  typeScale: DesignSpec['typeScale']
  /** Spacing rhythm in 2D canvas units. */
  spacing: DesignSpec['spacing']
  /** Palette contract. */
  palette: ManifestPalette
  /** Contrast ratio per token/role, when the caller measured them. */
  contrast?: Readonly<Record<string, number>>
}

/**
 * One field, as the manifest documents it. This is the JSON form of
 * {@link FieldSpec}: undefined spec members are omitted rather than emitted as
 * `null`, so the payload stays compact and self-consistent.
 */
export interface FieldDoc {
  /** Wire name. */
  name: string
  /** Value shape. */
  type: FieldType
  /** Whether the value is required wherever the field applies. */
  required: boolean
  /** One-line documentation. */
  doc: string
  /** Scopes the field is meaningful in. */
  appliesTo: readonly string[]
  /** Which face consumes the field. */
  client: FieldClient
  /** Whether the current tool schema accepts the field. */
  accepted: boolean
  /** Inclusive lower bound, for numbers. */
  min?: number
  /** Inclusive upper bound, for numbers. */
  max?: number
  /** True when the number has no range clamp. */
  unbounded?: true
  /** Maximum string length, in UTF-16 code units. */
  maxLength?: number
  /** Minimum array element count. */
  minItems?: number
  /** Maximum array element count. */
  maxItems?: number
  /** Child fields of an object value (e.g. `light.shadow`). */
  fields?: readonly FieldDoc[]
  /** Unit label. */
  unit?: string
  /** Closed string set. */
  enum?: readonly string[]
  /** True when `null` is meaningful (paint fields). */
  nullable?: boolean
  /** Documented default. */
  default?: JsonValue
  /** Literal example. */
  example?: JsonValue
}

/** One shape/object kind, as the manifest documents it. */
export interface KindDoc {
  /** Kind discriminator. */
  kind: string
  /** One line describing what to use it for. */
  doc: string
  /** Shorter "best for" hint. */
  use?: string
  /** Wire fields required on add. */
  required: readonly string[]
  /** Defaults for this kind (applicable field defaults plus kind overrides). */
  defaults: Record<string, JsonValue>
  /** One compact `add` op. */
  example: JsonValue
}

/** One `view` block, as the manifest documents it. */
export interface ViewDoc {
  /** One line describing the block. */
  doc: string
  /** Value shape of the block. */
  type?: FieldType
  /** Child fields of an object/array block. */
  fields?: readonly FieldDoc[]
  /** Maximum element count of an array block. */
  maxItems?: number
  /** Documented default. */
  default: JsonValue
}

/** 2D half of the ops documentation. */
export interface DrawOpsDoc {
  /** Tool the fields belong to. */
  tool: string
  /** Every field a 2D op may carry. */
  fields: readonly FieldDoc[]
  /** Every 2D kind. */
  kinds: readonly KindDoc[]
  /**
   * The 2D page view. The document carries it, but `whiteboard_draw` has no
   * `view` argument, so it is reported as not accepted.
   */
  view2d: {
    accepted: boolean
    note: string
    fields: readonly FieldDoc[]
  }
}

/** 3D half of the ops documentation. */
export interface SceneOpsDoc {
  /** Tool the fields belong to. */
  tool: string
  /** Every field a 3D op may carry. */
  fields: readonly FieldDoc[]
  /** Every 3D kind. */
  kinds: readonly KindDoc[]
  /** The seven `view` blocks. */
  view: Readonly<Record<string, ViewDoc>>
}

/** The `ops` block: verbs plus both surfaces' field/kind documentation. */
export interface ManifestOps {
  /** Op verbs both surfaces accept. */
  verbs: readonly string[]
  /** What each `appliesTo` scope token means. */
  legend: Readonly<Record<string, string>>
  /** 2D ops. */
  draw: DrawOpsDoc
  /** 3D ops. */
  scene3d: SceneOpsDoc
}

/** The complete `whiteboard_api` payload. */
export interface WhiteboardManifest {
  /** Version of this payload shape. */
  apiVersion: string
  /** Build the Host is running (`dev` when the caller cannot supply one). */
  build: string
  /** The board tools and what each is for. */
  tools: Readonly<Record<ToolRole, ToolInfo>>
  /** The two coordinate spaces. */
  surfaces: ManifestSurfaces
  /** Live board state, or the documented defaults. */
  current: ManifestCurrent
  /** What the renderer assumes when a field is omitted. */
  defaults: ManifestDefaults
  /** Design scales and palette. */
  design: ManifestDesign
  /** Field/kind/view documentation both tools' arguments follow. */
  ops: ManifestOps
  /** Hard caps the Host enforces. */
  limits: typeof LIMITS
  /** Copyable tool calls for this build. */
  examples: typeof EXAMPLES
  /** Short rules worth repeating at the point of use. */
  hints: readonly string[]
}

/** The coordinate spaces, described once. */
const SURFACES: ManifestSurfaces = {
  canvas2d: {
    extent: BOARD_EXTENT,
    origin: 'top-left',
    xAxis: 'right',
    yAxis: 'down',
    unit: 'logical units',
    note: `Fixed 0..${BOARD_EXTENT} square on both axes, letterboxed into the panel; a 48-unit margin reads as a page.`,
  },
  scene3d: {
    unit: 'world units',
    up: 'y',
    groundY: 0,
    note: 'three.js world units; ground at y = 0; stand an object at [x, height / 2, z]; '
      + 'the default camera (6.4, 4.6, 8.2) looks at the origin.',
  },
}

/** What each `appliesTo` token means, for the manifest's field lists. */
const SCOPE_LEGEND: Readonly<Record<string, string>> = {
  draw: 'the 2D op object (whiteboard_draw.ops[])',
  shape: 'every 2D kind',
  scene: 'the 3D op object (whiteboard_3d.ops[])',
  object: 'every 3D kind',
  view2d: 'the 2D page view (document only today)',
  view3d: 'the 3D view block',
  camera: 'view.camera',
  light: 'one view.lights[] entry',
  'light-shadow': 'light.shadow',
  'view-shadow': 'view.shadow',
  environment: 'view.environment',
  ...Object.fromEntries(SHAPE_KINDS.map(kind => [kind, `the ${kind} shape`])),
  ...Object.fromEntries(OBJECT_KINDS.map(kind => [kind, `the ${kind} object`])),
}

/** Copy a camera so the caller cannot mutate the scene constants. */
function cloneCamera(camera: Camera3D): Camera3D {
  return { position: [...camera.position], target: [...camera.target], fov: camera.fov }
}

/** Copy a light rig so the caller cannot mutate the scene constants. */
function cloneLights(lights: readonly Light3D[]): Light3D[] {
  return lights.map((light) => {
    const copy: Light3D = { kind: light.kind, color: light.color, intensity: light.intensity }
    if (light.position !== undefined) copy.position = [...light.position]
    if (light.castShadow !== undefined) copy.castShadow = light.castShadow
    if (light.shadow !== undefined) {
      copy.shadow = {
        ...(light.shadow.radius === undefined ? {} : { radius: light.shadow.radius }),
        ...(light.shadow.mapSize === undefined ? {} : { mapSize: light.shadow.mapSize }),
      }
    }
    return copy
  })
}

/** Copy shadow settings. */
function cloneShadow(settings: ShadowSettings): ShadowSettings {
  return { enabled: settings.enabled, opacity: settings.opacity, softness: settings.softness }
}

/**
 * Turn one field spec into its manifest form.
 * @param spec - the field spec.
 * @returns a fresh JSON-friendly field document.
 */
function describeField(spec: FieldSpec): FieldDoc {
  const doc: FieldDoc = {
    name: spec.name,
    type: spec.type,
    required: spec.required === true,
    doc: spec.doc,
    appliesTo: [...spec.appliesTo],
    client: spec.client,
    accepted: spec.accepted !== false,
  }
  if (spec.min !== undefined) doc.min = spec.min
  if (spec.max !== undefined) doc.max = spec.max
  if (spec.unbounded === true) doc.unbounded = true
  if (spec.maxLength !== undefined) doc.maxLength = spec.maxLength
  if (spec.minItems !== undefined) doc.minItems = spec.minItems
  if (spec.maxItems !== undefined) doc.maxItems = spec.maxItems
  if (spec.children !== undefined) doc.fields = spec.children.map(id => describeField(fieldSpecById(id)))
  if (spec.unit !== undefined) doc.unit = spec.unit
  if (spec.enum !== undefined) doc.enum = [...spec.enum]
  if (spec.nullable === true) doc.nullable = true
  if (spec.default !== undefined) doc.default = cloneJson(spec.default)
  if (spec.example !== undefined) doc.example = cloneJson(spec.example)
  return doc
}

/**
 * Turn one kind spec into its manifest form.
 * @param spec - the kind spec.
 * @returns a fresh JSON-friendly kind document with merged defaults.
 */
function describeKind(spec: KindSpec): KindDoc {
  const doc: KindDoc = {
    kind: spec.kind,
    doc: spec.doc,
    required: [...spec.required],
    defaults: kindDefaults(spec.kind, spec.defaults),
    example: cloneJson(spec.example as JsonValue),
  }
  if (spec.use !== undefined) doc.use = spec.use
  return doc
}

/**
 * Turn one view block into its manifest form.
 * @param block - the view block spec.
 * @returns a fresh JSON-friendly view document.
 */
function describeViewBlock(block: ViewBlockSpec): ViewDoc {
  const doc: ViewDoc = { doc: block.doc, default: cloneJson(block.default) }
  if (block.items !== undefined) {
    doc.type = 'array'
    doc.fields = block.items.map(id => describeField(fieldSpecById(id)))
  } else if (block.fields !== undefined) {
    doc.type = 'object'
    doc.fields = block.fields.map(id => describeField(fieldSpecById(id)))
  } else if (block.field !== undefined) {
    const spec = fieldSpecById(block.field)
    doc.type = spec.type
    if (spec.children !== undefined) doc.fields = spec.children.map(id => describeField(fieldSpecById(id)))
  }
  if (block.maxItems !== undefined) doc.maxItems = block.maxItems
  return doc
}

/** Build the `ops` documentation block for both surfaces. */
function buildOpsDocs(): ManifestOps {
  const view: Record<string, ViewDoc> = {}
  for (const [name, block] of Object.entries(VIEW_SPEC)) view[name] = describeViewBlock(block)
  return {
    verbs: [...OP_VERBS],
    legend: SCOPE_LEGEND,
    draw: {
      tool: TOOL_SPECS.draw.name,
      fields: opFieldSpecs('draw').map(describeField),
      kinds: SHAPE_KINDS.map(kind => describeKind(SHAPE_SPECS[kind])),
      view2d: {
        accepted: false,
        note: 'The 2D page background and dot grid live in the document and follow the panel theme; '
          + 'whiteboard_draw has no view argument today.',
        fields: ['view2d.background', 'view2d.grid'].map(id => describeField(fieldSpecById(id))),
      },
    },
    scene3d: {
      tool: TOOL_SPECS.scene3d.name,
      fields: opFieldSpecs('scene').map(describeField),
      kinds: OBJECT_KINDS.map(kind => describeKind(OBJECT_SPECS[kind])),
      view,
    },
  }
}

/** Build the `design` block, including context-supplied palette/contrast. */
function buildDesign(context: ManifestContext): ManifestDesign {
  const palette: ManifestPalette = {
    tokens: [...DESIGN_SPEC.palette.tokens],
    semantics: { ...DESIGN_SPEC.palette.semantics },
    advice: DESIGN_SPEC.palette.advice,
  }
  if (context.palette !== undefined) palette.resolved = { ...context.palette }
  const design: ManifestDesign = {
    typeScale: { ...DESIGN_SPEC.typeScale },
    spacing: { ...DESIGN_SPEC.spacing, gaps: [...DESIGN_SPEC.spacing.gaps], radii: [...DESIGN_SPEC.spacing.radii] },
    palette,
  }
  if (context.contrast !== undefined) design.contrast = { ...context.contrast }
  return design
}

/** Copy the tool list so a caller cannot mutate the module constants. */
function cloneTools(): Record<ToolRole, ToolInfo> {
  return {
    draw: { ...TOOL_SPECS.draw },
    scene3d: { ...TOOL_SPECS.scene3d },
    read: { ...TOOL_SPECS.read },
    look: { ...TOOL_SPECS.look },
    api: { ...TOOL_SPECS.api },
    history: { ...TOOL_SPECS.history },
    undo: { ...TOOL_SPECS.undo },
  }
}

/** Copy the coordinate spaces so a caller cannot mutate the module constants. */
function cloneSurfaces(): ManifestSurfaces {
  return { canvas2d: { ...SURFACES.canvas2d }, scene3d: { ...SURFACES.scene3d } }
}

/** Copy one tool-call example, including its JSON arguments. */
function cloneExample(example: ToolCallExample): ToolCallExample {
  return {
    tool: example.tool,
    note: example.note,
    accepted: example.accepted,
    args: cloneJson(example.args),
  }
}

/** Copy the three examples so a caller cannot mutate the module constants. */
function cloneExamples(): Readonly<Record<'draw' | 'scene3d' | 'fixShadow', ToolCallExample>> {
  return {
    draw: cloneExample(EXAMPLES.draw),
    scene3d: cloneExample(EXAMPLES.scene3d),
    fixShadow: cloneExample(EXAMPLES.fixShadow),
  }
}

/**
 * Build the `whiteboard_api` payload for the current build and board.
 *
 * Pure: it reads the context, never the filesystem, the environment or the
 * clock, and every mutable part it returns (defaults, examples, hints, tools,
 * surfaces, limits) is a fresh copy.
 * @param context - request context (theme, viewport, palette, board, build).
 * @returns the complete, JSON-serialisable contract.
 */
export function buildManifest(context: ManifestContext = {}): WhiteboardManifest {
  const theme = context.theme ?? 'light'
  const board = context.board
  const scene = board?.scene
  return {
    apiVersion: API_VERSION,
    build: context.build ?? DEFAULT_BUILD,
    tools: cloneTools(),
    surfaces: cloneSurfaces(),
    current: {
      theme,
      viewport: context.viewport === undefined ? null : { ...context.viewport },
      rev: board?.rev ?? 0,
      mode: board?.mode ?? '2d',
      counts: {
        shapes: board?.canvas.shapes.length ?? 0,
        objects: scene?.objects.length ?? 0,
      },
      camera: cloneCamera(scene?.camera ?? DEFAULT_CAMERA),
      lights: cloneLights(scene?.lights ?? DEFAULT_LIGHTS),
      // The board document does not carry these yet; report the contract default
      // so the model still sees the current effective value.
      shadow: cloneShadow(DEFAULT_SHADOW),
      environment: environmentDefaults(theme),
      grid: {
        canvas: board?.canvas.grid ?? true,
        scene: scene?.grid ?? true,
      },
      background: {
        canvas: board?.canvas.background ?? null,
        scene: scene?.background ?? null,
      },
      autoRotate: scene?.autoRotate ?? false,
    },
    defaults: {
      camera: cloneCamera(DEFAULT_CAMERA),
      lights: cloneLights(DEFAULT_LIGHTS),
      canvas: { background: null, grid: true },
      scene: {
        background: null,
        grid: true,
        autoRotate: false,
        shadow: cloneShadow(DEFAULT_SHADOW),
        environment: environmentDefaults(theme),
      },
      shape: defaultsFor('shape'),
      text: defaultsFor('text'),
      object: defaultsFor('object'),
      geometry: geometryDefaults(),
      light: defaultsFor('light'),
    },
    design: buildDesign(context),
    ops: buildOpsDocs(),
    limits: { ...LIMITS },
    examples: cloneExamples(),
    hints: [...HINTS],
  }
}

/** The contract default build id, exported for callers that forward it. */
export const MANIFEST_DEFAULT_BUILD = DEFAULT_BUILD

