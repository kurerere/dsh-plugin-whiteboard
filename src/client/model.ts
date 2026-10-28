/**
 * React-free state of the whiteboard tab.
 *
 * The board document itself is Host application state keyed by the **main**
 * Session and read by `poll.ts`; this module only owns what the browser must keep
 * across remounts (the composer draft) and the two board mutations the tab can
 * perform (clear and undo), each of which also wakes the poller so the change is
 * drawn without waiting a tick.
 */

import { CLEAR_PATH, UNDO_PATH, type WhiteboardCleared, type WhiteboardUndone } from '../shared.ts'
import type { BoardMode } from '../scene.ts'
import { wakeBoard } from './poll.ts'

/** Document-relative route URL (the page may be served under a token prefix). */
const route = (path: string): string => path.slice(1)

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await globalThis.fetch(route(path), {
    cache: 'no-store',
    ...init,
    ...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) {
    throw Object.assign(new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`), {
      status: response.status,
    })
  }
  return body
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) })

/** One observable text value per key, plus a focus request channel. */
class TextStore {
  private readonly values = new Map<string, string>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly focusCounts = new Map<string, number>()
  private readonly focusListeners = new Map<string, Set<() => void>>()

  /** Current value of one key. */
  readonly get = (key: string): string => this.values.get(key) ?? ''

  /** Write one key, notifying only when it actually changed. */
  readonly set = (key: string, value: string): void => {
    if ((this.values.get(key) ?? '') === value) return
    this.values.set(key, value)
    const listeners = this.listeners.get(key)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener()
  }

  /** Observe one key. */
  readonly subscribe = (key: string, listener: () => void): (() => void) => {
    let listeners = this.listeners.get(key)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** Ask the visible input of one key to take focus. */
  readonly focus = (key: string): void => {
    this.focusCounts.set(key, (this.focusCounts.get(key) ?? 0) + 1)
    const listeners = this.focusListeners.get(key)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener()
  }

  /** Monotonic counter the input reads through `useSyncExternalStore`. */
  readonly focusRevision = (key: string): number => this.focusCounts.get(key) ?? 0

  /** Observe focus requests for one key. */
  readonly subscribeFocus = (key: string, listener: () => void): (() => void) => {
    let listeners = this.focusListeners.get(key)
    if (listeners === undefined) {
      listeners = new Set()
      this.focusListeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

/** Composer draft access, shared by every mount of the tab. */
export interface DraftFace {
  get(key: string): string
  set(key: string, value: string): void
  subscribe(key: string, listener: () => void): () => void
  /** Ask the visible input of one Session to take focus. */
  focus(key: string): void
  /** Monotonic focus request counter, read by `useSyncExternalStore`. */
  focusRevision(key: string): number
  subscribeFocus(key: string, listener: () => void): () => void
}

/** Board mutations and draft storage the tab needs. */
export class WhiteboardModel {
  private readonly texts = new TextStore()

  /** The tab's composer draft, keyed by main Session id. */
  readonly drafts: DraftFace = {
    get: key => this.texts.get(key),
    set: (key, value) => { this.texts.set(key, value) },
    subscribe: (key, listener) => this.texts.subscribe(key, listener),
    focus: key => { this.texts.focus(key) },
    focusRevision: key => this.texts.focusRevision(key),
    subscribeFocus: (key, listener) => this.texts.subscribeFocus(key, listener),
  }

  /**
   * Clear one surface of a board (the model may draw it again).
   * @param sessionId - main Session id that owns the board.
   * @param mode - surface to clear.
   */
  async clear(sessionId: string, mode: BoardMode): Promise<void> {
    const result = await post<WhiteboardCleared>(CLEAR_PATH, { sessionId, mode })
    // Raise the poll gate and fold the cleared surface in locally, so the board
    // empties in this frame and a poll already in flight cannot bring the
    // cleared shapes back. `canUndo` rides along because the confirmation poll
    // lands on the revision we just applied and is therefore a no-op.
    wakeBoard(sessionId, { rev: result.rev, cleared: mode, canUndo: result.canUndo === true })
  }

  /**
   * Step the board back one mutation (a draw batch or a clear).
   *
   * The reverted document is Host-owned, so this only raises the response gate to
   * the revision the Host published the undo under and asks for a fetch: an
   * in-flight poll for the pre-undo board is dropped, and the fetch that follows
   * draws the reverted board. `reverted: 'none'` (nothing left to undo) is not an
   * error — the refresh is enough.
   * @param sessionId - main Session id that owns the board.
   * @returns the Host's answer, including what was taken back.
   */
  async undo(sessionId: string): Promise<WhiteboardUndone> {
    const result = await post<WhiteboardUndone>(UNDO_PATH, { sessionId })
    wakeBoard(sessionId, { rev: result.rev, canUndo: result.canUndo === true })
    return result
  }
}
