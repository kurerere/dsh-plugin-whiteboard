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
import { type Object3DKind, type ShapeKind } from './scene.ts';
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';
/** A lossless JSON value, as the tool schema DSL and the manifest allow. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
/** Version of the `whiteboard_api` payload this module produces. */
export declare const API_VERSION = "1.0";
/** Shape kinds a `whiteboard_draw` op may add. */
export declare const SHAPE_KINDS: readonly ["rect", "ellipse", "line", "arrow", "polyline", "path", "text"];
/** Object kinds a `whiteboard_3d` op may add. */
export declare const OBJECT_KINDS: readonly ["box", "sphere", "cylinder", "cone", "torus", "plane"];
/** Light kinds a 3D `view.lights` entry may declare. */
export declare const LIGHT_KINDS: readonly ["ambient", "directional", "point"];
/** Op verbs both surfaces share. */
export declare const OP_VERBS: readonly ["add", "update", "remove", "clear"];
/** Every scope token `FieldSpec.appliesTo` may use. */
export declare const FIELD_SCOPES: readonly ["draw", "shape", "rect", "ellipse", "line", "arrow", "polyline", "path", "text", "scene", "object", "box", "sphere", "cylinder", "cone", "torus", "plane", "view2d", "view3d", "camera", "light", "light-shadow", "view-shadow", "environment"];
/**
 * Capabilities of one build, as declared by the Host.
 *
 * The numbers are duplicated from `tools.ts` on purpose (that module owns the
 * runtime enforcement); `scripts/spec.test.mjs` pins both sides to the same
 * values so a change in one is caught before it silently drifts from the other.
 */
export declare const LIMITS: {
    /** Shapes kept on one 2D canvas. */
    readonly shapes: 300;
    /** Objects kept in one 3D scene. */
    readonly objects: 120;
    /** Ops accepted per tool call, on both surfaces. */
    readonly opsPerCall: 64;
    /** Lights a 3D scene carries. */
    readonly lights: 4;
    /** UTF-16 length of one text label. */
    readonly text: 280;
    /** Length of one SVG `path` `d` string. */
    readonly path: 4000;
    /** Vertices in one polyline. */
    readonly points: 400;
    /** Hard plausibility bound on any single 2D coordinate (`±20000`). */
    readonly coordLimit: 20000;
    /** Views composed into one `angles: "turntable"` contact sheet (3D only). */
    readonly turntableViews: 4;
    /** Tiles composed into one `debug: "per-light"` contact sheet (at most one per light). */
    readonly perLightTiles: 4;
    /** Largest capture answer the Host accepts, in bytes (8 MB). */
    readonly answerBytes: 8000000;
};
/** The primitive shape of a wire field. */
export type FieldType = 'number' | 'integer' | 'string' | 'boolean' | 'array' | 'object';
/** Which face consumes a field. */
export type FieldClient = 'both' | 'host';
/** Element shape of an array field, when the DSL can describe it. */
export type FieldItems = 'number' | 'number-pair' | 'light';
/** One wire field the board understands, on any surface. */
export interface FieldSpec {
    /** Wire name, exactly as the tool argument / document key. */
    name: string;
    /** Value shape in the tool-schema DSL. */
    type: FieldType;
    /** True when the value is required wherever the field applies. */
    required?: boolean;
    /** Inclusive lower bound, for numeric fields (documentation + manifest). */
    min?: number;
    /** Inclusive upper bound, for numeric fields. */
    max?: number;
    /** Marks a number with no range clamp (only `Number.isFinite` is enforced). */
    unbounded?: true;
    /** Inclusive upper bound on a string's UTF-16 length. */
    maxLength?: number;
    /** Inclusive lower bound on an array's element count. */
    minItems?: number;
    /** Inclusive upper bound on an array's element count. */
    maxItems?: number;
    /** Element schema an array field generates; omitted accepts any JSON item. */
    items?: FieldItems;
    /** Closed string set, when the field accepts one. */
    enum?: readonly string[];
    /** True when `null` is a meaningful value (paint fields: `null` = none). */
    nullable?: true;
    /** Value the renderer/Host assumes when the model omits the field. */
    default?: JsonValue;
    /** Unit shown in the manifest (`logical units`, `degrees`, `0..1`, …). */
    unit?: string;
    /** One line the model reads; must stand alone without the prompt. */
    doc: string;
    /** Scopes the field is meaningful in (see {@link FIELD_SCOPES}). */
    appliesTo: readonly string[];
    /** Which face consumes the field. */
    client: FieldClient;
    /** False when the current tool schema does not accept the field yet. */
    accepted?: false;
    /** Child field-spec ids, for an object field. */
    children?: readonly string[];
    /** A literal example value. */
    example?: JsonValue;
}
/** One kind of 2D shape or 3D primitive. */
export interface KindSpec {
    /** The kind discriminator the op carries. */
    kind: ShapeKind | Object3DKind;
    /** One line describing what to use it for. */
    doc: string;
    /** Shorter "best for" hint; optional. */
    use?: string;
    /** Wire fields required when adding this kind. */
    required: readonly string[];
    /**
     * Kind-specific overrides of {@link FIELD_SPECS} defaults. A manifest kind's
     * full default set is every applicable field default plus these overrides.
     */
    defaults?: Readonly<Record<string, JsonValue>>;
    /** One compact `add` op for this kind. */
    example: Readonly<Record<string, JsonValue>>;
}
/** Shadow settings of the 3D ground. */
export interface ShadowSettings {
    /** Whether objects ground themselves with a shadow. */
    enabled: boolean;
    /** `0..1` shadow strength. */
    opacity: number;
    /** Blur radius of the shadow edge. */
    softness: number;
}
/** Image-based reflection environment of the 3D scene. */
export interface EnvironmentSettings {
    /** `studio` builds a theme-matched studio; `none` disables reflections. */
    kind: 'studio' | 'none';
    /** Reflection strength, `0..2`. */
    intensity: number;
}
/** Default ground-shadow settings; reserved until the document carries them. */
export declare const DEFAULT_SHADOW: {
    readonly enabled: true;
    readonly opacity: 0.32;
    readonly softness: 2.5;
};
/** Default reflection environment (light theme); see {@link environmentDefaults}. */
export declare const DEFAULT_ENVIRONMENT: {
    readonly kind: "studio";
    readonly intensity: 0.75;
};
/** One view block of the 3D `view` argument. */
export interface ViewBlockSpec {
    /** One line the model reads. */
    doc: string;
    /** Leaf field-spec id, for a scalar or a pre-built object field. */
    field?: string;
    /** Child field-spec ids, for an object block (`camera`). */
    fields?: readonly string[];
    /** Element field-spec ids, for an array block (`lights`). */
    items?: readonly string[];
    /** Maximum element count of an array block. */
    maxItems?: number;
    /** Documented default, as JSON. */
    default: JsonValue;
}
/** The seven settings a `whiteboard_3d` `view` argument may carry. */
export type ViewBlockName = 'camera' | 'background' | 'grid' | 'autoRotate' | 'lights' | 'shadow' | 'environment';
/** Tool names this plugin owns, as the model sees them. */
export declare const TOOL_NAMES: {
    readonly draw: "whiteboard_draw";
    readonly scene3d: "whiteboard_3d";
    readonly read: "whiteboard_read";
    readonly look: "whiteboard_look";
    readonly api: "whiteboard_api";
    readonly history: "whiteboard_history";
    readonly undo: "whiteboard_undo";
};
/** One role of a board tool. */
export type ToolRole = keyof typeof TOOL_NAMES;
/** A tool's name and one-line purpose, as the manifest reports it. */
export interface ToolInfo {
    /** Wire name. */
    readonly name: string;
    /** One line the model can act on. */
    readonly purpose: string;
}
/** The board tools and what each is for. */
export declare const TOOL_SPECS: Readonly<Record<ToolRole, ToolInfo>>;
/**
 * Copy a JSON value so callers can never mutate the spec constants.
 * @param value - any lossless JSON value, including one of the spec defaults.
 * @returns a structurally equal value with fresh arrays/objects.
 */
export declare function cloneJson(value: JsonValue): JsonValue;
/**
 * Every wire field the board understands, keyed by a stable spec id.
 *
 * The key is namespaced (`rect.w`, `light.shadow`) because the same wire name
 * can mean different things on different surfaces (`shadow` is a boolean on a
 * 2D shape, an object on a light and on the 3D view); the key is never sent to
 * the model, the `name` is.
 */
export declare const FIELD_SPECS: Readonly<Record<string, FieldSpec>>;
/** The seven settings of a `whiteboard_3d` `view` argument. */
export declare const VIEW_SPEC: Readonly<Record<ViewBlockName, ViewBlockSpec>>;
/** Every 2D shape kind and what it is for. */
export declare const SHAPE_SPECS: Readonly<Record<ShapeKind, KindSpec>>;
/** Every 3D primitive kind and what it is for. */
export declare const OBJECT_SPECS: Readonly<Record<Object3DKind, KindSpec>>;
/** Design scales and palette advice the board follows, independent of build. */
export interface DesignSpec {
    /** Font sizes in 2D canvas units, with the readable floor and title ceiling. */
    typeScale: {
        readonly title: number;
        readonly heading: number;
        readonly subheading: number;
        readonly body: number;
        readonly label: number;
        readonly caption: number;
        readonly minBody: number;
        readonly maxTitle: number;
    };
    /** Spacing rhythm in 2D canvas units. */
    spacing: {
        readonly unit: number;
        readonly gaps: readonly number[];
        readonly pageMargin: number;
        readonly cardPadding: number;
        readonly radii: readonly number[];
    };
    /** The palette contract: the tokens, their roles and when to use which. */
    palette: {
        /** Named paints the client resolves against the current theme. */
        readonly tokens: readonly string[];
        /** Semantic roles, so a board uses a small consistent accent set. */
        readonly semantics: Readonly<Record<string, string>>;
        /** One line of palette/colour advice. */
        readonly advice: string;
    };
}
/** The board's design system, shared by the manifest and the prompt. */
export declare const DESIGN_SPEC: DesignSpec;
/** One complete tool call the model can copy, adapted to the current context. */
export interface ToolCallExample {
    /** Tool the snippet is for. */
    tool: string;
    /** What the snippet demonstrates. */
    note: string;
    /** False when the snippet uses fields the current build still rejects. */
    accepted: boolean;
    /** The arguments object, ready to send. */
    args: JsonValue;
}
/** Roles of the copyable examples every manifest carries. */
export type ExampleRole = 'draw' | 'scene3d' | 'fixShadow' | 'diffLook' | 'dryRun';
/** The copyable tool calls every manifest carries. */
export declare const EXAMPLES: Readonly<Record<ExampleRole, ToolCallExample>>;
/** Short, load-bearing rules the manifest repeats to the model. */
export declare const HINTS: readonly string[];
/** Options shared by both parameter builders. */
export interface ParameterBuildOptions {
    /**
     * Include fields marked `accepted: false` (the next-step contract). Default
     * `true`, which is the full contract `whiteboard_api` publishes. Pass `false`
     * when generating a schema for a tool build that does not normalise those
     * fields yet, so the model cannot send an argument that would be dropped.
     */
    includeReserved?: boolean;
}
/** Look up one field spec by its stable id. */
export declare function fieldSpecById(id: string): FieldSpec;
/**
 * The field specs of one op object, in declaration order.
 *
 * `op`, `id` and `kind` are moved to the front so the generated schema leads
 * with the addressing fields (`opacity` is shared with the 3D object block and
 * would otherwise sit between `id` and `kind`).
 * @param surface - which tool the op belongs to.
 * @returns every field meaningful on that surface, reserved ones included.
 */
export declare function opFieldSpecs(surface: 'draw' | 'scene'): readonly FieldSpec[];
/**
 * Documented defaults of every field that applies to a scope.
 * @param scope - a concrete kind or a scope token (`shape`, `object`, `light`).
 * @returns a fresh JSON object of wire-name → default.
 */
export declare function defaultsFor(scope: string): Record<string, JsonValue>;
/**
 * Defaults of one kind: every applicable field default plus the kind overrides.
 * @param kind - concrete shape/object kind.
 * @param overrides - kind-specific values from {@link SHAPE_SPECS}/{@link OBJECT_SPECS}.
 * @returns a fresh JSON object of wire-name → default.
 */
export declare function kindDefaults(kind: string, overrides?: Readonly<Record<string, JsonValue>>): Record<string, JsonValue>;
/** Documented geometry defaults shared by the 3D kinds (before per-kind overrides). */
export declare function geometryDefaults(): Record<string, JsonValue>;
/**
 * The reflection-environment default for one theme.
 * @param theme - palette the board is painting in.
 * @returns a fresh {@link EnvironmentSettings}.
 */
export declare function environmentDefaults(theme: 'light' | 'dark'): EnvironmentSettings;
/**
 * The parameter schema of `whiteboard_draw`, in the shipped tool-schema DSL.
 *
 * Structurally it is the same object `tools.ts` declares by hand (plus the
 * documentation and enums kept in {@link FIELD_SPECS}); it is generated so the
 * model's arguments and the manifest cannot describe different fields.
 * @param options - `includeReserved` (default `true`) keeps the next-step fields.
 * @returns a fresh parameter schema.
 */
export declare function buildDrawParameters(options?: ParameterBuildOptions): ParameterSchemaSpec;
/**
 * The parameter schema of `whiteboard_3d`: `ops` plus the `view` block.
 *
 * More complete than the shipped declaration on purpose — `view.lights`,
 * `view.shadow`, `view.environment` and per-object/light shadow fields are
 * declared here so the next build can open them without a second schema edit.
 * @param options - `includeReserved` (default `true`) keeps the next-step fields.
 * @returns a fresh parameter schema.
 */
export declare function buildSceneParameters(options?: ParameterBuildOptions): ParameterSchemaSpec;
