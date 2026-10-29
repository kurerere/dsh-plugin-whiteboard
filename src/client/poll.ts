/**
 * The browser's live copy of one board.
 *
 * The board document is Host-owned application state (see `src/shared.ts` for
 * why it is not a session event or a session projection), so the tab keeps it in
 * sync by polling {@link STATE_PATH}. This module is the whole client transport:
 *
 * - {@link useBoard} fetches once, then re-fetches on one of two intervals — a
 *   fast one while the whiteboard agent is running (so tool calls appear while
 *   the answer is still streaming) and a slow one while it is idle. Polling is
 *   suspended while the document is hidden and resumes with an immediate fetch,
 *   so a background tab costs nothing;
 * - responses apply under a **revision floor**: a response whose `rev` is older
 *   than the last applied one is dropped, which is what keeps a late in-flight
 *   poll from resurrecting shapes the user just cleared;
 * - {@link wakeBoard} is the immediate-fetch channel: the composer fires it when
 *   a prompt is accepted (so the first shapes do not wait a full tick) and the
 *   clear route fires it with the new revision (so the floor moves before the
 *   next response lands).
 *
 * A malformed or unreachable response never blanks the board: the last good
 * document stays on screen and the hook reports `stale` for a quiet notice.
 */

import { useEffect, useRef, useState } from 'react'
import { STATE_PATH, type CaptureViewport, type WhiteboardSnapshot } from '../shared.ts'
import { applyClear, emptyBoard, isBoardState, type BoardMode, type BoardState } from '../scene.ts'
import { currentTheme } from './palette.ts'

/** Poll interval while the agent is drawing, in milliseconds. */
const RUNNING_INTERVAL = 350
/** Poll interval while nothing is happening, in milliseconds. */
const IDLE_INTERVAL = 1500

/** Kinds of immediate-fetch wake-up. */
export interface BoardWake {
  /**
   * Newest revision the caller already knows. It only ever *raises the response
   * gate*, so a poll that was already in flight cannot apply an older board on
   * top of the caller's change.
   */
  rev?: number
  /**
   * A surface the caller just cleared on the Host. The board applies it locally
   * right away (same pure reducer as the Host) instead of waiting a round trip;
   * the next poll confirms it under the revision gate.
   */
  cleared?: BoardMode
  /**
   * Undo depth the caller already knows. A clear is confirmed at a revision the
   * board has already applied, so its `canUndo` would otherwise wait for an
   * unrelated mutation.
   */
  canUndo?: boolean
}

/** One immediate-fetch listener. */
type Waiter = (wake: BoardWake) => void

/** Immediate-fetch listeners keyed by whiteboard Session id. */
const waiters = new Map<string, Set<Waiter>>()

/**
 * Ask every mounted board of one Session to refresh right now.
 * @param sessionId - whiteboard Session id.
 * @param wake - revision the caller knows and/or a surface it just cleared.
 */
export function wakeBoard(sessionId: string, wake: BoardWake = {}): void {
  const listeners = waiters.get(sessionId)
  if (listeners === undefined) return
  for (const listener of [...listeners]) listener(wake)
}

function subscribeWake(sessionId: string, listener: Waiter): () => void {
  let listeners = waiters.get(sessionId)
  if (listeners === undefined) {
    listeners = new Set()
    waiters.set(sessionId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) waiters.delete(sessionId)
  }
}

/** Document-relative route URL (the page may be served under a token prefix). */
const route = (path: string): string => path.slice(1)

/**
 * Fill in `mode` on a board document that predates it.
 *
 * `isBoardState` requires the field, and a board migrated from the retired
 * per-board store may not carry one. Its content still says which surface was
 * last touched, so an old document is read as the surface it actually has rather
 * than rejected — otherwise a migrated board would show as 「未同步」 and empty.
 * @param value - candidate board from the Host.
 * @returns the value, or a copy with the implied `mode`.
 */
function withMode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const candidate = value as Record<string, unknown>
  const mode = candidate['mode']
  if (mode === '2d' || mode === '3d') return value
  const scene = candidate['scene']
  const objects = typeof scene === 'object' && scene !== null && Array.isArray((scene as { objects?: unknown }).objects)
    ? ((scene as { objects: unknown[] }).objects.length)
    : 0
  return { ...candidate, mode: objects > 0 ? '3d' : '2d' }
}

/** What a mounted board renders from. */
export interface BoardPoll {
  /** The last good board document. */
  board: BoardState
  /** True while the last response could not be read (the board is the last good one). */
  stale: boolean
  /** True when the Host has a step to undo; false for Hosts that predate undo. */
  canUndo: boolean
}

/** The live stage size the state poll reports; a ref, so resizes do not re-arm the poll. */
export interface BoardViewportSource {
  readonly current: CaptureViewport | undefined
}

/**
 * Poll one board and return its current document.
 * @param sessionId - main Session id that owns the board.
 * @param running - whether the main agent is running right now.
 * @param active - whether this tab is the one on screen; a background or
 *   collapsed tab keeps its state but stops fetching until it is shown again.
 * @param viewport - latest measured stage size, sent with each poll so the API
 *   manifest knows the panel size before the first capture.
 * @returns the current board, a staleness flag, and whether undo is available.
 */
export function useBoard(
  sessionId: string,
  running: boolean,
  active = true,
  viewport?: BoardViewportSource,
): BoardPoll {
  const [state, setState] = useState<BoardPoll>(() => ({ board: emptyBoard(), stale: false, canUndo: false }))
  /**
   * Revision of the board currently in state. Equality is tested against this,
   * never against the response gate: a wake can raise the gate ahead of the
   * document it describes, and treating that as "already applied" would strand
   * the board on the previous revision forever.
   */
  const applied = useRef(-1)
  /** Responses older than this are dropped; a wake may raise it out of band. */
  const gate = useRef(-1)
  const runningRef = useRef(running)
  runningRef.current = running
  const activeRef = useRef(active)
  activeRef.current = active
  /** Fetches immediately with the latest effect's closures, when one is mounted. */
  const kick = useRef<(() => void) | undefined>(undefined)
  /** Restarts the interval timer with the current running state. */
  const reschedule = useRef<(() => void) | undefined>(undefined)
  const wasRunning = useRef(running)
  const wasActive = useRef(active)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    let controller: AbortController | undefined

    // A different board (a new Session) starts from nothing, even if this
    // component ever survives a session swap without remounting.
    applied.current = -1
    gate.current = -1

    const markStale = (): void => {
      setState(previous => (previous.stale ? previous : { ...previous, stale: true }))
    }

    const apply = (payload: unknown): void => {
      if (typeof payload !== 'object' || payload === null) {
        markStale()
        return
      }
      const snapshot = payload as Partial<WhiteboardSnapshot>
      const rev = typeof snapshot.rev === 'number' && Number.isFinite(snapshot.rev) ? snapshot.rev : undefined
      if (rev === undefined) {
        markStale()
        return
      }
      // Older Hosts do not answer `canUndo`; `false` just disables the button.
      const canUndo = snapshot.canUndo === true
      // A response older than the gate is a late frame for content we have
      // already moved past: drop it silently.
      if (rev < gate.current) return
      // The same revision as the rendered document is the same document: only
      // clearing `stale` (or an undo-depth change) is news, so an idle poll does
      // not re-render the canvas.
      if (rev === applied.current) {
        setState(previous => (
          previous.stale || previous.canUndo !== canUndo ? { ...previous, stale: false, canUndo } : previous
        ))
        return
      }
      const board = withMode(snapshot.board)
      if (!isBoardState(board)) {
        markStale()
        return
      }
      applied.current = rev
      gate.current = Math.max(gate.current, rev)
      setState({ board, stale: false, canUndo })
    }

    const fetchOnce = (): void => {
      if (disposed) return
      controller?.abort()
      const next = new AbortController()
      controller = next
      const query = new URLSearchParams({ sessionId, theme: currentTheme() })
      const stage = viewport?.current
      if (stage !== undefined) {
        query.set('vw', String(Math.max(1, Math.round(stage.width))))
        query.set('vh', String(Math.max(1, Math.round(stage.height))))
        query.set('dpr', String(stage.dpr))
      }
      globalThis.fetch(`${route(STATE_PATH)}?${query}`, { signal: next.signal, cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return await response.json() as unknown
        })
        .then((payload) => {
          if (disposed || next.signal.aborted) return
          apply(payload)
        })
        .catch(() => {
          if (disposed || next.signal.aborted) return
          markStale()
        })
    }

    const schedule = (): void => {
      if (disposed) return
      if (timer !== undefined) globalThis.clearTimeout(timer)
      const delay = runningRef.current ? RUNNING_INTERVAL : IDLE_INTERVAL
      timer = globalThis.setTimeout(() => {
        if (activeRef.current && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
          fetchOnce()
        }
        schedule()
      }, delay)
    }
    reschedule.current = schedule

    const onVisibility = (): void => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
      if (!activeRef.current) return
      fetchOnce()
    }

    kick.current = fetchOnce
    // A body mounted for a background Session or a collapsed column does not
    // need the current document until it is shown; the effect below fetches then.
    if (activeRef.current) fetchOnce()
    schedule()
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribe = subscribeWake(sessionId, (wake) => {
      if (typeof wake.rev === 'number' && wake.rev > gate.current) gate.current = wake.rev
      const cleared = wake.cleared
      const rev = wake.rev
      if (cleared !== undefined && rev !== undefined) {
        // Draw the cleared surface immediately with the Host's own fold, so the
        // user sees the board empty in this frame instead of one round trip
        // later. The gate above keeps a late poll from bringing the shapes back,
        // and `applied` moves with it so the confirmation poll is a no-op — which
        // is why the caller also hands over `canUndo`: nothing else will.
        applied.current = rev
        setState(previous => ({
          board: applyClear(previous.board, { mode: cleared }),
          stale: false,
          canUndo: wake.canUndo ?? previous.canUndo,
        }))
      } else if (wake.canUndo !== undefined) {
        setState(previous => (previous.canUndo === wake.canUndo ? previous : { ...previous, canUndo: wake.canUndo === true }))
      }
      // After an undo the reverted document is not known locally, so the fetch
      // below is what actually draws it: the gate only drops older frames.
      fetchOnce()
    })

    return () => {
      disposed = true
      kick.current = undefined
      reschedule.current = undefined
      if (timer !== undefined) globalThis.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
      unsubscribe()
    }
  }, [sessionId])

  // A turn starting (or ending) is exactly when the board changes: fetch now
  // and switch the interval immediately instead of finishing the current wait.
  useEffect(() => {
    if (wasRunning.current === running) return
    wasRunning.current = running
    if (!activeRef.current) return
    kick.current?.()
    reschedule.current?.()
  }, [running])

  // Coming back into view: fetch at once instead of waiting out the interval.
  useEffect(() => {
    if (wasActive.current === active) return
    wasActive.current = active
    if (!active) return
    kick.current?.()
    reschedule.current?.()
  }, [active])

  return state
}
