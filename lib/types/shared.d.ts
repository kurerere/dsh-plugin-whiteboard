/**
 * Wire contract shared by the Host and browser faces of dsh-plugin-whiteboard.
 *
 * The board is a canvas of the **main conversation**, not a separate chat: the
 * three board tools belong to the main agent, the board document is keyed by the
 * main Session id, and the sidebar tab is a view of that one board. This file is
 * the whole surface between the two faces.
 *
 * **Board transport.** The board document is Host-owned application state: the
 * drawing tools mutate it, {@link CLEAR_PATH} clears a surface, {@link UNDO_PATH}
 * steps back, and the browser polls {@link STATE_PATH} for the whole current
 * value. It deliberately is not a session event and not a session projection:
 *
 * - a session event type outside the shipped `SessionEventMap` may only be
 *   written with the `ignorable` envelope marker, and the only API that sets it
 *   (`appendPluginRecord`) checks its receiver against a *module-private*
 *   instance of the Session class; an out-of-tree plugin resolves its own copy,
 *   so that call fails with "Receiver must be an instance of class Session";
 * - a projection unit needs a committed event to drive it, and a clear or an
 *   undo has none.
 *
 * So the board lives where the framework expects non-session application state:
 * beside the session, in a Host store that outlives reloads and restarts, and
 * the browser keeps a live copy by polling the state route.
 *
 * Every route is an exact Connection Fetch route, so it inherits the Connection's
 * trust and authentication fence (owner Peers only).
 */
import type { BoardMode, BoardState, Camera3D } from './scene.ts';
/** `GET ?sessionId=<id>` → {@link WhiteboardSnapshot}: the whole current board. */
export declare const STATE_PATH = "/api/whiteboard.state";
/** `POST { sessionId, mode }` → {@link WhiteboardCleared}: clear a board surface. */
export declare const CLEAR_PATH = "/api/whiteboard.clear";
/** `POST { sessionId }` → {@link WhiteboardUndone}: step back one mutation. */
export declare const UNDO_PATH = "/api/whiteboard.undo";
/**
 * `POST { sessionId, text, requestId? }` → {@link WhiteboardSaid}: send a user
 * message to the Session that owns the board (the main conversation).
 */
export declare const SAY_PATH = "/api/whiteboard.say";
/**
 * Prefix of the retired whiteboard child Sessions. Boards are keyed by the main
 * Session now; this prefix survives only for the one-time migration that moves
 * an old board document onto its parent.
 */
export declare const LEGACY_WHITEBOARD_ID_PREFIX = "session-whiteboard-";
/** Subdirectory of the dsh home that holds one JSON document per board. */
export declare const BOARD_STORAGE_DIR = "storages/whiteboard";
/** Model-facing tool that appends a 2D drawing batch. */
export declare const DRAW_TOOL = "whiteboard_draw";
/** Model-facing tool that appends a 3D scene batch. */
export declare const SCENE_TOOL = "whiteboard_3d";
/** Model-facing tool that reports the current board without changing it. */
export declare const READ_TOOL = "whiteboard_read";
/** Model-facing tool that captures what the open panel currently shows. */
export declare const LOOK_TOOL = "whiteboard_look";
/** Model-facing tool that returns the live, self-describing board contract. */
export declare const API_TOOL = "whiteboard_api";
/** Model-facing tool that reports the undo stack (memory only). */
export declare const HISTORY_TOOL = "whiteboard_history";
/** Model-facing tool that steps the board back when the user asks. */
export declare const UNDO_TOOL = "whiteboard_undo";
/** Tool names owned by this plugin (all seven belong to the main agent). */
export declare const BOARD_TOOLS: readonly string[];
/**
 * `GET ?sessionId=<id>` → {@link CapturePollAnswer} or 204: the open panel asks
 * whether the model wants a frame. The panel long-polls this while it is on
 * screen; a closed panel simply never asks, and a capture request then times out
 * with a readable error instead of rendering somewhere the user cannot see.
 */
export declare const CAPTURE_POLL_PATH = "/api/whiteboard.capture";
/** `POST CaptureAnswer` → {@link CaptureAccepted}: the panel returns the frame. */
export declare const CAPTURE_SUBMIT_PATH = "/api/whiteboard.capture.frame";
/**
 * `POST { theme }` → `{ accepted: true }`: the client plugin reports the app
 * palette once and on every flip, so `whiteboard_api` knows the theme even
 * before the 画板 tab has been opened.
 */
export declare const THEME_PATH = "/api/whiteboard.theme";
/** One frame request the model's `whiteboard_look` is waiting for. */
export interface CaptureRequest {
    /** Correlates the answer; opaque to the model. */
    id: string;
    /** Board the frame belongs to (the main Session id). */
    sessionId: string;
    /** Content revision the frame should show. */
    rev: number;
    /** Surface the board document currently points at. */
    mode: BoardMode;
    /** What the model asked for; the panel may narrow it (it captures what is on screen). */
    options: CaptureOptions;
    /**
     * Earlier document/frame for a `diffAgainst` look. The panel renders the
     * baseline with the same view as the new frame and answers with a before/
     * after/changed sheet instead of the plain picture.
     */
    baseline?: CaptureBaseline;
    /**
     * Uncommitted document a dry run wants rendered. The panel renders it offscreen
     * inside the open tab; nothing is written to the board. `options.mode` is the
     * document's own surface, not the surface currently displayed.
     */
    preview?: BoardState;
}
/** Debug views the panel can render instead of the ordinary lit frame. */
export type CaptureDebug = 'lit' | 'shadow-only' | 'per-light';
/** Multi-view contact sheets the panel can compose. */
export type CaptureAngles = 'default' | 'turntable';
/** What one `whiteboard_look` call asks the panel for. */
export interface CaptureOptions {
    /** Requested surface; `auto` (the default) captures whatever the panel displays. */
    mode?: BoardMode | 'auto';
    /** Draw element ids over the frame so pixels and ids can be matched. */
    overlay?: 'none' | 'ids';
    /** `lit` is the real picture; `shadow-only` hides lit surfaces and keeps shadows. */
    debug?: CaptureDebug;
    /**
     * `turntable` renders four views around the scene target as one contact sheet;
     * `default` (or absent) keeps the live view.
     */
    angles?: CaptureAngles;
    /** Downscale the frame so its longest side is at most this many pixels. */
    maxWidth?: number;
}
/**
 * An earlier board the panel re-renders for a before/after diff.
 *
 * The panel renders this document with the *current* camera, so a document
 * baseline isolates a content change instead of also showing an orbit.
 */
export interface DocumentBaseline {
    /** Discriminator. */
    kind: 'document';
    /** Revision of the earlier document (its own `board.rev`). */
    rev: number;
    /** What the model asked for, for the result line (`previous`, `rev:12`). */
    label: string;
    /** The whole earlier document. */
    board: BoardState;
}
/** A stored frame the panel compares pixel-for-pixel. */
export interface ImageBaseline {
    /** Discriminator. */
    kind: 'image';
    /** Revision the frame was captured at. */
    rev: number;
    /** What the model asked for, for the result line (`frame:ab12cd34`). */
    label: string;
    /** Bare base64 PNG (no data-URL prefix). */
    png: string;
    /** Width the frame was captured at, in pixels. */
    width: number;
    /** Height the frame was captured at, in pixels. */
    height: number;
    /** Surface the frame shows. */
    mode: BoardMode;
    /** Live camera when the frame was captured (3D only). */
    camera?: Camera3D;
}
/** What a `diffAgainst` look compares the new frame with. */
export type CaptureBaseline = DocumentBaseline | ImageBaseline;
/** Pixel comparison of a new frame with {@link CaptureBaseline}. */
export interface CaptureDiff {
    /** Whether the baseline was a document (re-rendered) or a stored image. */
    kind: 'document' | 'image';
    /** Label the model used (`previous`, `rev:12`, `frame:ab12cd34`). */
    label: string;
    /** Revision the baseline document/frame belongs to. */
    rev: number;
    /** Pixels whose color changed beyond the noise threshold. */
    changedPixels: number;
    /** `changedPixels / (width * height)`, 0..1. */
    changedRatio: number;
    /** Bounds of changed pixels in **new-frame** pixels; absent when nothing changed. */
    bounds?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    /** False when the comparison is approximate (different camera/size/surface). */
    comparable: boolean;
    /** One sentence the model can repeat: what changed and whether to trust it. */
    note: string;
}
/** Stage size the panel reported with a frame, in CSS pixels. */
export interface CaptureViewport {
    width: number;
    height: number;
    dpr: number;
}
/** One captured frame as the panel submits it. */
export interface CaptureAnswer {
    /** {@link CaptureRequest.id} this answers. */
    requestId: string;
    /** Base64 PNG, with or without a `data:image/png;base64,` prefix. */
    png: string;
    width: number;
    height: number;
    /** The surface that was actually captured. */
    mode: BoardMode;
    /** Live camera at capture time (3D only). */
    camera?: Camera3D;
    /** Stage size in CSS pixels (both surfaces). */
    viewport?: CaptureViewport;
    /** Present when the request carried a baseline; `png` is then the diff sheet. */
    diff?: CaptureDiff;
    /** Tile captions when `png` is a contact sheet (`per-light`, `turntable`). */
    tiles?: string[];
    /** True when `png` renders an uncommitted dry-run document. */
    preview?: boolean;
    /** A failure the panel could explain; the Host turns it into the tool error. */
    error?: string;
}
/** Response body of {@link CAPTURE_POLL_PATH} when a request is waiting. */
export interface CapturePollAnswer {
    request: CaptureRequest;
}
/** Response body of {@link CAPTURE_SUBMIT_PATH}. */
export interface CaptureAccepted {
    accepted: boolean;
    error?: string;
}
/**
 * Whether a Session id is one of the retired whiteboard child Sessions.
 * @param sessionId - candidate Session id.
 * @returns true for ids minted by the old version of this plugin.
 */
export declare function isLegacyWhiteboardId(sessionId: string | undefined | null): boolean;
/** Response of {@link STATE_PATH}: the whole board and the revision it belongs to. */
export interface WhiteboardSnapshot {
    /** Monotone revision of this board; unchanged between mutations. */
    rev: number;
    /** The whole board document. */
    board: BoardState;
    /** True when {@link UNDO_PATH} has a step to go back to. */
    canUndo: boolean;
}
export interface WhiteboardCleared {
    accepted: boolean;
    /** Revision after the clear, so the browser can drop a stale in-flight poll. */
    rev: number;
    /** Whether the clear can be undone. */
    canUndo: boolean;
}
/** Response of {@link UNDO_PATH}: the board stepped back one mutation. */
export interface WhiteboardUndone {
    accepted: boolean;
    /** Revision the restored document is published under. */
    rev: number;
    /** Whether another step is still available. */
    canUndo: boolean;
    /** What the undo took back, for the status line ("已撤销上一批"). */
    reverted: 'draw' | 'clear' | 'none';
}
/** Response of {@link SAY_PATH}: the message was appended to the Session. */
export interface WhiteboardSaid {
    accepted: boolean;
}
/** Error body of every non-2xx answer. */
export interface WhiteboardError {
    error: string;
    code?: string;
}
