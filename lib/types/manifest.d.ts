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
import { type BoardState, type Camera3D, type Light3D, type Paint } from './scene.ts';
import { EXAMPLES, LIMITS, type DesignSpec, type EnvironmentSettings, type FieldClient, type FieldType, type JsonValue, type ShadowSettings, type ToolInfo, type ToolRole } from './spec.ts';
/** Stage size the panel reported, in CSS pixels. */
export interface ManifestViewport {
    /** Stage width in CSS pixels. */
    width: number;
    /** Stage height in CSS pixels. */
    height: number;
    /** Device pixel ratio the panel renders at. */
    dpr: number;
}
/**
 * Everything the Host knows about the current request. Every field is optional:
 * `buildManifest({})` must produce a complete, useful contract for an empty
 * board.
 */
export interface ManifestContext {
    /** Palette the panel is painting in; defaults to `light`. */
    theme?: 'light' | 'dark';
    /** Stage size in CSS pixels, when the panel has reported one. */
    viewport?: ManifestViewport;
    /** Resolved palette (token → concrete color), when the client can resolve one. */
    palette?: Record<string, string>;
    /** Contrast ratio per token/role, when the caller measured them. */
    contrast?: Record<string, number>;
    /** Current board document; omitted means an empty board. */
    board?: BoardState;
    /** Build identifier (version plus commit, or similar); defaults to `dev`. */
    build?: string;
}
/** The two coordinate spaces of the board. */
export interface ManifestSurfaces {
    /** The 2D canvas: one fixed logical square, fitted into the panel. */
    canvas2d: {
        readonly extent: number;
        readonly origin: 'top-left';
        readonly xAxis: 'right';
        readonly yAxis: 'down';
        readonly unit: string;
        readonly note: string;
    };
    /** The 3D scene: three.js world units around the origin. */
    scene3d: {
        readonly unit: string;
        readonly up: 'y';
        readonly groundY: number;
        readonly note: string;
    };
}
/** Live state of the board, or the documented defaults when there is none. */
export interface ManifestCurrent {
    /** Palette the panel is painting in. */
    theme: 'light' | 'dark';
    /** Stage size in CSS pixels, or null when the panel has not reported one. */
    viewport: ManifestViewport | null;
    /** Revision of the board document; 0 for an empty board. */
    rev: number;
    /** Surface the model last wrote, or `2d` for an empty board. */
    mode: '2d' | '3d';
    /** What exists right now. */
    counts: {
        shapes: number;
        objects: number;
    };
    /** Camera of the 3D scene (default camera for an empty board). */
    camera: Camera3D;
    /** Light rig of the 3D scene (default rig for an empty board). */
    lights: Light3D[];
    /** Ground shadow settings; defaults until the board document carries them. */
    shadow: ShadowSettings;
    /** Reflection environment; defaults until the board document carries it. */
    environment: EnvironmentSettings;
    /** Grid visibility, per surface. */
    grid: {
        canvas: boolean;
        scene: boolean;
    };
    /** Backdrop paint, per surface; null means "follow the theme". */
    background: {
        canvas: Paint | null;
        scene: Paint | null;
    };
    /** Whether the 3D camera slowly orbits. */
    autoRotate: boolean;
}
/** What the renderer/Host assumes when the model omits a field. */
export interface ManifestDefaults {
    /** Default 3D camera. */
    camera: Camera3D;
    /** Default 3D light rig. */
    lights: Light3D[];
    /** 2D page defaults (background, grid). */
    canvas: {
        background: Paint | null;
        grid: boolean;
    };
    /** 3D scene defaults (background, grid, autoRotate, shadow, environment). */
    scene: {
        background: Paint | null;
        grid: boolean;
        autoRotate: boolean;
        shadow: ShadowSettings;
        environment: EnvironmentSettings;
    };
    /** Shared 2D style defaults (fill, stroke, strokeWidth, opacity, dash, shadow). */
    shape: Record<string, JsonValue>;
    /** Text defaults (size, weight, align, baseline). */
    text: Record<string, JsonValue>;
    /** 3D object defaults (position, rotation, scale, color, material, wireframe). */
    object: Record<string, JsonValue>;
    /** Geometry defaults before per-kind overrides (size, radius, height, segments, …). */
    geometry: Record<string, JsonValue>;
    /** Light defaults (color, intensity, position). */
    light: Record<string, JsonValue>;
}
/** The palette block of {@link ManifestDesign}. */
export interface ManifestPalette {
    /** Named paints the client resolves per theme. */
    tokens: readonly string[];
    /** Semantic roles, so a board uses a small consistent accent set. */
    semantics: Readonly<Record<string, string>>;
    /** One line of palette advice. */
    advice: string;
    /** Concrete colors for this theme/viewport, when the client could resolve them. */
    resolved?: Readonly<Record<string, string>>;
}
/** Design scales and palette the board follows. */
export interface ManifestDesign {
    /** Font sizes in 2D canvas units. */
    typeScale: DesignSpec['typeScale'];
    /** Spacing rhythm in 2D canvas units. */
    spacing: DesignSpec['spacing'];
    /** Palette contract. */
    palette: ManifestPalette;
    /** Contrast ratio per token/role, when the caller measured them. */
    contrast?: Readonly<Record<string, number>>;
}
/**
 * One field, as the manifest documents it. This is the JSON form of
 * {@link FieldSpec}: undefined spec members are omitted rather than emitted as
 * `null`, so the payload stays compact and self-consistent.
 */
export interface FieldDoc {
    /** Wire name. */
    name: string;
    /** Value shape. */
    type: FieldType;
    /** Whether the value is required wherever the field applies. */
    required: boolean;
    /** One-line documentation. */
    doc: string;
    /** Scopes the field is meaningful in. */
    appliesTo: readonly string[];
    /** Which face consumes the field. */
    client: FieldClient;
    /** Whether the current tool schema accepts the field. */
    accepted: boolean;
    /** Inclusive lower bound, for numbers. */
    min?: number;
    /** Inclusive upper bound, for numbers. */
    max?: number;
    /** True when the number has no range clamp. */
    unbounded?: true;
    /** Maximum string length, in UTF-16 code units. */
    maxLength?: number;
    /** Minimum array element count. */
    minItems?: number;
    /** Maximum array element count. */
    maxItems?: number;
    /** Child fields of an object value (e.g. `light.shadow`). */
    fields?: readonly FieldDoc[];
    /** Unit label. */
    unit?: string;
    /** Closed string set. */
    enum?: readonly string[];
    /** True when `null` is meaningful (paint fields). */
    nullable?: boolean;
    /** Documented default. */
    default?: JsonValue;
    /** Literal example. */
    example?: JsonValue;
}
/** One shape/object kind, as the manifest documents it. */
export interface KindDoc {
    /** Kind discriminator. */
    kind: string;
    /** One line describing what to use it for. */
    doc: string;
    /** Shorter "best for" hint. */
    use?: string;
    /** Wire fields required on add. */
    required: readonly string[];
    /** Defaults for this kind (applicable field defaults plus kind overrides). */
    defaults: Record<string, JsonValue>;
    /** One compact `add` op. */
    example: JsonValue;
}
/** One `view` block, as the manifest documents it. */
export interface ViewDoc {
    /** One line describing the block. */
    doc: string;
    /** Value shape of the block. */
    type?: FieldType;
    /** Child fields of an object/array block. */
    fields?: readonly FieldDoc[];
    /** Maximum element count of an array block. */
    maxItems?: number;
    /** Documented default. */
    default: JsonValue;
}
/** 2D half of the ops documentation. */
export interface DrawOpsDoc {
    /** Tool the fields belong to. */
    tool: string;
    /** Every field a 2D op may carry. */
    fields: readonly FieldDoc[];
    /** Every 2D kind. */
    kinds: readonly KindDoc[];
    /**
     * The 2D page view. The document carries it, but `whiteboard_draw` has no
     * `view` argument, so it is reported as not accepted.
     */
    view2d: {
        accepted: boolean;
        note: string;
        fields: readonly FieldDoc[];
    };
}
/** 3D half of the ops documentation. */
export interface SceneOpsDoc {
    /** Tool the fields belong to. */
    tool: string;
    /** Every field a 3D op may carry. */
    fields: readonly FieldDoc[];
    /** Every 3D kind. */
    kinds: readonly KindDoc[];
    /** The seven `view` blocks. */
    view: Readonly<Record<string, ViewDoc>>;
}
/** The `ops` block: verbs plus both surfaces' field/kind documentation. */
export interface ManifestOps {
    /** Op verbs both surfaces accept. */
    verbs: readonly string[];
    /** What each `appliesTo` scope token means. */
    legend: Readonly<Record<string, string>>;
    /** 2D ops. */
    draw: DrawOpsDoc;
    /** 3D ops. */
    scene3d: SceneOpsDoc;
}
/** The complete `whiteboard_api` payload. */
export interface WhiteboardManifest {
    /** Version of this payload shape. */
    apiVersion: string;
    /** Build the Host is running (`dev` when the caller cannot supply one). */
    build: string;
    /** The board tools and what each is for. */
    tools: Readonly<Record<ToolRole, ToolInfo>>;
    /** The two coordinate spaces. */
    surfaces: ManifestSurfaces;
    /** Live board state, or the documented defaults. */
    current: ManifestCurrent;
    /** What the renderer assumes when a field is omitted. */
    defaults: ManifestDefaults;
    /** Design scales and palette. */
    design: ManifestDesign;
    /** Field/kind/view documentation both tools' arguments follow. */
    ops: ManifestOps;
    /** Hard caps the Host enforces. */
    limits: typeof LIMITS;
    /** Copyable tool calls for this build. */
    examples: typeof EXAMPLES;
    /** Short rules worth repeating at the point of use. */
    hints: readonly string[];
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
export declare function buildManifest(context?: ManifestContext): WhiteboardManifest;
/** The contract default build id, exported for callers that forward it. */
export declare const MANIFEST_DEFAULT_BUILD = "dev";
