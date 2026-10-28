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
export declare const BOARD_EXTENT = 1000;
/** Upper bound on 2D shapes kept on one board. */
export declare const MAX_SHAPES = 300;
/** Upper bound on 3D objects kept on one scene. */
export declare const MAX_OBJECTS = 120;
/** Number of light slots a 3D scene may carry. */
export declare const MAX_LIGHTS = 4;
/**
 * Named paints the model may use instead of a literal `#rrggbb`. The client
 * resolves them against the dsh theme, so a board drawn in light mode still
 * reads in dark mode.
 */
export declare const PALETTE_TOKENS: readonly ["ink", "muted", "blue", "cyan", "teal", "green", "lime", "yellow", "amber", "orange", "red", "pink", "purple", "indigo", "white", "black"];
/** A named paint token. */
export type PaletteToken = (typeof PALETTE_TOKENS)[number];
/** A resolved paint: a palette token or a literal `#rrggbb`/`#rgb` color. */
export type Paint = PaletteToken | string;
/** Two-dimensional point in the logical canvas space. */
export type Vec2 = [number, number];
/** Three-dimensional vector in world units. */
export type Vec3 = [number, number, number];
/** Paint and stroke style shared by every 2D shape. */
export interface ShapeStyle {
    /** Interior paint; `null` leaves the shape unfilled. */
    fill?: Paint | null;
    /** Outline paint; `null` leaves the shape unstroked. */
    stroke?: Paint | null;
    /** Outline width in logical units. */
    strokeWidth?: number;
    /** Whole-shape opacity, `0..1`. */
    opacity?: number;
    /** Dash pattern in logical units; `null` draws a solid line. */
    dash?: number[] | null;
    /** Drop a soft shadow (used for cards and sticky notes). */
    shadow?: boolean;
}
/** Rectangle (optionally rounded). */
export interface RectShape extends ShapeStyle {
    id: string;
    kind: 'rect';
    x: number;
    y: number;
    w: number;
    h: number;
    /** Corner radius in logical units. */
    radius?: number;
    /** Rotation around the shape centre, in degrees. */
    rotation?: number;
}
/** Ellipse (a circle is `rx === ry`). */
export interface EllipseShape extends ShapeStyle {
    id: string;
    kind: 'ellipse';
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    /** Rotation around the shape centre, in degrees. */
    rotation?: number;
}
/** Straight segment. */
export interface LineShape extends ShapeStyle {
    id: string;
    kind: 'line';
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}
/** Segment with an arrow head. */
export interface ArrowShape extends ShapeStyle {
    id: string;
    kind: 'arrow';
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** Which ends carry a head. */
    head?: 'end' | 'both' | 'none';
    /** Perpendicular bend, in logical units; positive bows to the left of the direction. */
    curve?: number;
}
/** Connected point list. */
export interface PolylineShape extends ShapeStyle {
    id: string;
    kind: 'polyline';
    points: Vec2[];
    /** Round the corners with quadratic segments. */
    smooth?: boolean;
    /** Join the last point back to the first. */
    closed?: boolean;
}
/** Arbitrary SVG path data (`Path2D` syntax) for free-form drawing and icons. */
export interface PathShape extends ShapeStyle {
    id: string;
    kind: 'path';
    d: string;
}
/** Text label. */
export interface TextShape extends ShapeStyle {
    id: string;
    kind: 'text';
    x: number;
    y: number;
    text: string;
    /** Font size in logical units. */
    size?: number;
    weight?: 'regular' | 'medium' | 'bold';
    align?: 'left' | 'center' | 'right';
    baseline?: 'top' | 'middle' | 'bottom';
    /** Wrap width in logical units (defaults to no wrapping). */
    maxWidth?: number;
}
/** Every 2D shape kind. */
export type Shape2D = RectShape | EllipseShape | LineShape | ArrowShape | PolylineShape | PathShape | TextShape;
/** Shape kinds a `whiteboard_draw` call may add. */
export type ShapeKind = Shape2D['kind'];
/** A partial style/geometry update applied to one existing shape. */
export type ShapePatch = Record<string, unknown>;
/** One 2D operation, already canonical and id-bearing by the time it is logged. */
export type DrawOp = {
    op: 'add';
    shape: Shape2D;
} | {
    op: 'update';
    id: string;
    patch: ShapePatch;
} | {
    op: 'remove';
    id: string;
} | {
    op: 'clear';
};
/** Canvas-wide settings a draw call may carry. */
export interface CanvasView {
    /** Page paint behind the shapes; `null` uses the board surface. */
    background?: Paint | null;
    /** Draw the dot grid. */
    grid?: boolean;
}
/** Payload of one `whiteboard/draw` session event. */
export interface DrawEvent {
    ops: DrawOp[];
    view?: CanvasView;
}
/** Primitives the 3D scene can build. */
export type Object3DKind = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane';
/** Per-kind geometry parameters; omitted values fall back to the kind defaults. */
export interface Geometry3D {
    /** Box/plane edge lengths. */
    size?: Vec3;
    /** Sphere/torus/cylindrical radius. */
    radius?: number;
    /** Cylinder top radius (a cone is `0`). */
    radiusTop?: number;
    /** Cylinder bottom radius. */
    radiusBottom?: number;
    /** Cylinder/cone height. */
    height?: number;
    /** Torus tube radius. */
    tube?: number;
    /** Radial tessellation. */
    segments?: number;
}
/** One 3D object. */
export interface Object3D {
    id: string;
    kind: Object3DKind;
    /** World position. */
    position: Vec3;
    /** Euler rotation in degrees. */
    rotation: Vec3;
    /** Per-axis scale. */
    scale: Vec3;
    /** Base color. */
    color: Paint;
    /** Standard-material metalness, `0..1`. */
    metalness: number;
    /** Standard-material roughness, `0..1`. */
    roughness: number;
    /** Whole-object opacity, `0..1`. */
    opacity: number;
    /** Render the wireframe instead of the solid surface. */
    wireframe: boolean;
    /** Emissive paint, or `null` for none. */
    emissive: Paint | null;
    geometry: Geometry3D;
    /** Rotate about the world Y axis on its own, in degrees per second. */
    spin?: number;
    /**
     * Cast a shadow. Omitted means "decide from the material": opaque,
     * non-wireframe objects cast; transparent objects do not.
     */
    castShadow?: boolean;
    /** Receive shadows; omitted means true. */
    receiveShadow?: boolean;
}
/** 3D light kinds. */
export type LightKind = 'ambient' | 'directional' | 'point';
/** Shadow-map tuning for one casting light. */
export interface LightShadow3D {
    /** Softness of the shadow edge (three.js `shadow.radius`). */
    radius?: number;
    /** Square shadow-map resolution. */
    mapSize?: number;
}
/** One 3D light. */
export interface Light3D {
    kind: LightKind;
    color: Paint;
    intensity: number;
    /** Position (directional/point only). */
    position?: Vec3;
    /**
     * Cast a shadow. Omitted means "the first directional light casts"; the
     * default rig therefore has one visible shadow instead of one per light.
     */
    castShadow?: boolean;
    /** Shadow-map tuning when this light casts. */
    shadow?: LightShadow3D;
}
/** Camera framing of the 3D scene. */
export interface Camera3D {
    position: Vec3;
    target: Vec3;
    /** Vertical field of view in degrees. */
    fov: number;
}
/** Scene-wide settings a 3D call may carry. */
export interface View3DPatch {
    camera?: Partial<Camera3D>;
    /** Scene background paint; `null` uses the panel surface. */
    background?: Paint | null;
    /** Draw the ground grid. */
    grid?: boolean;
    /** Slowly orbit the camera. */
    autoRotate?: boolean;
    /** Replace every light in the scene. */
    lights?: Light3D[];
}
/** One 3D operation, already canonical by the time it is logged. */
export type Object3DOp = {
    op: 'add';
    object: Object3D;
} | {
    op: 'update';
    id: string;
    patch: Partial<Omit<Object3D, 'id' | 'kind'>>;
} | {
    op: 'remove';
    id: string;
} | {
    op: 'clear';
};
/** Payload of one `whiteboard/scene3d` session event. */
export interface Scene3DEvent {
    ops: Object3DOp[];
    view?: View3DPatch;
}
/** Which surface the board is currently about. */
export type BoardMode = '2d' | '3d';
/** Whole 2D surface. */
export interface Canvas2D {
    background: Paint | null;
    grid: boolean;
    shapes: Shape2D[];
}
/** Whole 3D surface. */
export interface Scene3D {
    background: Paint | null;
    grid: boolean;
    autoRotate: boolean;
    camera: Camera3D;
    lights: Light3D[];
    objects: Object3D[];
}
/** The whole board document — the projection value and the client render input. */
export interface BoardState {
    /** Revision counter: one increment per applied event, used for change animations. */
    rev: number;
    /** Surface last written by a tool; the client opens on it. */
    mode: BoardMode;
    canvas: Canvas2D;
    scene: Scene3D;
}
/** Event type appended for a 2D draw call. */
export declare const DRAW_EVENT = "whiteboard/draw";
/** Event type appended for a 3D scene call. */
export declare const SCENE_EVENT = "whiteboard/scene3d";
/** Event type appended when the board is cleared. */
export declare const CLEAR_EVENT = "whiteboard/clear";
/** Payload of one `whiteboard/clear` session event. */
export interface ClearEvent {
    /** Which surface to clear. */
    mode: '2d' | '3d' | 'all';
}
/** Default camera: a three-quarter view of the origin. */
export declare const DEFAULT_CAMERA: Camera3D;
/**
 * Default light rig: one lit key, one unshadowed fill, and one shadow-only
 * directional (zero intensity) placed so its shadow is visible from the default
 * camera. Keeping the shadow on its own light means the fill cannot throw a
 * second, contradictory shadow — the defect the first 3D drawing exposed.
 */
export declare const DEFAULT_LIGHTS: Light3D[];
/** An empty board document. */
export declare function emptyBoard(): BoardState;
/**
 * Structural check used by the Host projection (`stateSchema` / `viewSchema`)
 * and by the client before rendering a pushed value: a persisted or replayed
 * board must carry the documented skeleton, while individual shapes stay
 * tolerant so an older or partially-written value cannot crash a renderer.
 * @param value - candidate projection value.
 * @returns true when the value is a board document.
 */
export declare function isBoardState(value: unknown): value is BoardState;
/** Whether an op targets a shape/scene object id this board already knows. */
export declare function hasId(state: BoardState, id: string): boolean;
/** Every shape id on the 2D surface, in draw order. */
export declare function shapeIds(state: BoardState): string[];
/**
 * Apply one draw event to a board.
 * @param state - board before the event.
 * @param event - decoded `whiteboard/draw` payload.
 * @returns the new board (always a fresh object).
 */
export declare function applyDraw(state: BoardState, event: DrawEvent): BoardState;
/**
 * Apply one 3D event to a board.
 * @param state - board before the event.
 * @param event - decoded `whiteboard/scene3d` payload.
 * @returns the new board (always a fresh object).
 */
export declare function applyScene3D(state: BoardState, event: Scene3DEvent): BoardState;
/**
 * Apply one clear event to a board.
 * @param state - board before the event.
 * @param event - decoded `whiteboard/clear` payload.
 * @returns the cleared board.
 */
export declare function applyClear(state: BoardState, event: ClearEvent): BoardState;
/** The three event kinds a board folds, addressed by their short name. */
export type BoardEventKind = 'draw' | 'scene3d' | 'clear';
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
export declare function boardEventKind(type: string): BoardEventKind | undefined;
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
export declare function applyBoardEvent(state: BoardState, type: string, data: unknown): BoardState;
/**
 * A short, model-facing description of a board: what exists and how it is named.
 * @param state - current board.
 * @returns one text block summarising both surfaces.
 */
export declare function describeBoard(state: BoardState): string;
