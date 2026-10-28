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

import type { BoardState } from './scene.ts'

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

/** Tool names owned by this plugin (all three belong to the main agent). */
export const BOARD_TOOLS: readonly string[] = [DRAW_TOOL, SCENE_TOOL, READ_TOOL]

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
