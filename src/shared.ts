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

import type { BoardMode, BoardState, Camera3D } from './scene.ts'

/** `GET ?sessionId=<id>` → {@link WhiteboardSnapshot}: the whole current board. */
export const STATE_PATH = '/api/whiteboard.state'
/** `POST { sessionId, mode }` → {@link WhiteboardCleared}: clear a board surface. */
export const CLEAR_PATH = '/api/whiteboard.clear'
/** `POST { sessionId }` → {@link WhiteboardUndone}: step back one mutation. */
export const UNDO_PATH = '/api/whiteboard.undo'
/**
 * `POST { sessionId, text, requestId? }` → {@link WhiteboardSaid}: send a user
 * message to the Session that owns the board (the main conversation).
 */
export const SAY_PATH = '/api/whiteboard.say'

/**
 * Prefix of the retired whiteboard child Sessions. Boards are keyed by the main
 * Session now; this prefix survives only for the one-time migration that moves
 * an old board document onto its parent.
 */
export const LEGACY_WHITEBOARD_ID_PREFIX = 'session-whiteboard-'

/** Subdirectory of the dsh home that holds one JSON document per board. */
export const BOARD_STORAGE_DIR = 'storages/whiteboard'

/** Model-facing tool that appends a 2D drawing batch. */
export const DRAW_TOOL = 'whiteboard_draw'
/** Model-facing tool that appends a 3D scene batch. */
export const SCENE_TOOL = 'whiteboard_3d'
/** Model-facing tool that reports the current board without changing it. */
export const READ_TOOL = 'whiteboard_read'
/** Model-facing tool that captures what the open panel currently shows. */
export const LOOK_TOOL = 'whiteboard_look'
/** Model-facing tool that returns the live, self-describing board contract. */
export const API_TOOL = 'whiteboard_api'
/** Model-facing tool that reports the undo stack (memory only). */
export const HISTORY_TOOL = 'whiteboard_history'
/** Model-facing tool that steps the board back when the user asks. */
export const UNDO_TOOL = 'whiteboard_undo'

/** Tool names owned by this plugin (all seven belong to the main agent). */
export const BOARD_TOOLS: readonly string[] = [
  DRAW_TOOL, SCENE_TOOL, READ_TOOL, LOOK_TOOL, API_TOOL, HISTORY_TOOL, UNDO_TOOL,
]

/**
 * `GET ?sessionId=<id>` → {@link CapturePollAnswer} or 204: the open panel asks
 * whether the model wants a frame. The panel long-polls this while it is on
 * screen; a closed panel simply never asks, and a capture request then times out
 * with a readable error instead of rendering somewhere the user cannot see.
 */
export const CAPTURE_POLL_PATH = '/api/whiteboard.capture'
/** `POST CaptureAnswer` → {@link CaptureAccepted}: the panel returns the frame. */
export const CAPTURE_SUBMIT_PATH = '/api/whiteboard.capture.frame'
/**
 * `POST { theme }` → `{ accepted: true }`: the client plugin reports the app
 * palette once and on every flip, so `whiteboard_api` knows the theme even
 * before the 画板 tab has been opened.
 */
export const THEME_PATH = '/api/whiteboard.theme'

/** One frame request the model's `whiteboard_look` is waiting for. */
export interface CaptureRequest {
  /** Correlates the answer; opaque to the model. */
  id: string
  /** Board the frame belongs to (the main Session id). */
  sessionId: string
  /** Content revision the frame should show. */
  rev: number
  /** Surface the board document currently points at. */
  mode: BoardMode
  /** What the model asked for; the panel may narrow it (it captures what is on screen). */
  options: CaptureOptions
}

/** What one `whiteboard_look` call asks the panel for. */
export interface CaptureOptions {
  /** Requested surface; `auto` (the default) captures whatever the panel displays. */
  mode?: BoardMode | 'auto'
  /** Draw element ids over the frame so pixels and ids can be matched. */
  overlay?: 'none' | 'ids'
  /** `lit` is the real picture; `shadow-only` hides lit surfaces and keeps shadows. */
  debug?: 'lit' | 'shadow-only'
  /** Downscale the frame so its longest side is at most this many pixels. */
  maxWidth?: number
}

/** Stage size the panel reported with a frame, in CSS pixels. */
export interface CaptureViewport {
  width: number
  height: number
  dpr: number
}

/** One captured frame as the panel submits it. */
export interface CaptureAnswer {
  /** {@link CaptureRequest.id} this answers. */
  requestId: string
  /** Base64 PNG, with or without a `data:image/png;base64,` prefix. */
  png: string
  width: number
  height: number
  /** The surface that was actually captured. */
  mode: BoardMode
  /** Live camera at capture time (3D only). */
  camera?: Camera3D
  /** Stage size in CSS pixels (both surfaces). */
  viewport?: CaptureViewport
  /** A failure the panel could explain; the Host turns it into the tool error. */
  error?: string
}

/** Response body of {@link CAPTURE_POLL_PATH} when a request is waiting. */
export interface CapturePollAnswer {
  request: CaptureRequest
}

/** Response body of {@link CAPTURE_SUBMIT_PATH}. */
export interface CaptureAccepted {
  accepted: boolean
  error?: string
}

/**
 * Whether a Session id is one of the retired whiteboard child Sessions.
 * @param sessionId - candidate Session id.
 * @returns true for ids minted by the old version of this plugin.
 */
export function isLegacyWhiteboardId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(LEGACY_WHITEBOARD_ID_PREFIX)
}

/** Response of {@link STATE_PATH}: the whole board and the revision it belongs to. */
export interface WhiteboardSnapshot {
  /** Monotone revision of this board; unchanged between mutations. */
  rev: number
  /** The whole board document. */
  board: BoardState
  /** True when {@link UNDO_PATH} has a step to go back to. */
  canUndo: boolean
}

export interface WhiteboardCleared {
  accepted: boolean
  /** Revision after the clear, so the browser can drop a stale in-flight poll. */
  rev: number
  /** Whether the clear can be undone. */
  canUndo: boolean
}

/** Response of {@link UNDO_PATH}: the board stepped back one mutation. */
export interface WhiteboardUndone {
  accepted: boolean
  /** Revision the restored document is published under. */
  rev: number
  /** Whether another step is still available. */
  canUndo: boolean
  /** What the undo took back, for the status line ("已撤销上一批"). */
  reverted: 'draw' | 'clear' | 'none'
}

/** Response of {@link SAY_PATH}: the message was appended to the Session. */
export interface WhiteboardSaid {
  accepted: boolean
}

/** Error body of every non-2xx answer. */
export interface WhiteboardError {
  error: string
  code?: string
}
