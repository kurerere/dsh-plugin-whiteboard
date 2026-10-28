/**
 * Bring the board into view the first time the model draws, once per conversation.
 *
 * The board lives in the right sidebar, so a drawing produced by an ordinary
 * message is invisible until somebody opens the tab. The transcript says what was
 * drawn; the drawing itself is one gesture away — and a user who has never opened
 * the tab does not know it is there where to look.
 *
 * So: watch the board of the conversation **on screen**, and when its revision
 * grows for the first time in that conversation, open the whiteboard tab. The tab's
 * own route is the same one the tab polls, so this costs one loopback request per
 * tick and nothing at all while the document is hidden.
 *
 * Two deliberate limits:
 *
 * - **Once per conversation.** After the first reveal the user knows where the
 *   board is; yanking the sidebar open on every later drawing would fight whatever
 *   they are reading. The memory is per page lifetime; a reload re-baselines at the
 *   current revision, so an old board never triggers a reveal either.
 * - **Only when the board actually changed.** The first observation of a
 *   conversation records its revision and reveals nothing, which is what keeps
 *   switching to a conversation that already has a drawing from opening a panel.
 */

/** How often the watcher looks at the board of the conversation on screen. */
const REVEAL_INTERVAL_MS = 1500

/** The part of the sidebar controller this watcher drives. */
export interface RevealSidebarFace {
  /** The Session on screen, or `undefined` while no conversation is selected. */
  readonly mounted: { getSnapshot(): string | undefined }
  /** Open a page of this kind and reveal the column. */
  openTab(kind: string): void
  /** The tab the user is looking at on the screen's Surface, if any. */
  active(): { readonly kind?: string } | undefined
}

/** What the watcher needs from the plugin body. */
export interface RevealOptions {
  /** Document-relative URL of a route path. */
  readonly route: (path: string) => string
  /** The sidebar controller (may be absent in a host without the sidebar). */
  readonly sidebar: RevealSidebarFace
  /** Tab kind to open. */
  readonly kind: string
  /** Watch cadence in milliseconds (tests use a shorter one). */
  readonly intervalMs?: number
}

/** Handle on the running watcher. */
export interface BoardReveal {
  /** Stop watching. Safe to call twice. */
  dispose(): void
  /** Run one tick now (tests drive it directly). */
  tick(): Promise<void>
}

/**
 * Start watching the on-screen conversation's board.
 * @param options - route resolver, sidebar controller, tab kind and cadence.
 * @returns the handle; `dispose()` stops the interval.
 */
export function createBoardReveal(options: RevealOptions): BoardReveal {
  const { route, sidebar, kind } = options
  /** First revision seen per conversation; a reveal needs a revision above it. */
  const baseline = new Map<string, number>()
  /** Conversations already revealed (or already showing the board). */
  const done = new Set<string>()
  let busy = false
  let disposed = false

  const readRevision = async (sessionId: string): Promise<number | undefined> => {
    const response = await globalThis.fetch(`${route('/api/whiteboard.state')}?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    const body = await response.json() as { rev?: unknown }
    return typeof body.rev === 'number' ? body.rev : undefined
  }

  const tick = async (): Promise<void> => {
    if (disposed || busy) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const sessionId = sidebar.mounted.getSnapshot()
    if (typeof sessionId !== 'string' || sessionId === '' || done.has(sessionId)) return
    // Already looking at the board: stop watching, so an open tab is not polled twice.
    if (sidebar.active()?.kind === kind) {
      done.add(sessionId)
      return
    }
    busy = true
    try {
      const rev = await readRevision(sessionId)
      if (rev === undefined) return
      const seen = baseline.get(sessionId)
      if (seen === undefined) {
        // The first look only records where this conversation stands: an existing
        // drawing must not pop the panel open when the user switches to it.
        baseline.set(sessionId, rev)
        return
      }
      if (rev <= seen) return
      baseline.set(sessionId, rev)
      if (sidebar.active()?.kind === kind) {
        // The user is already looking at the board; nothing to reveal.
        done.add(sessionId)
        return
      }
      done.add(sessionId)
      sidebar.openTab(kind)
    } catch {
      // A failed poll is routine (Host restarting, route not mounted yet).
    } finally {
      busy = false
    }
  }

  const timer = globalThis.setInterval(() => { void tick() }, options.intervalMs ?? REVEAL_INTERVAL_MS)

  return {
    tick,
    dispose() {
      disposed = true
      globalThis.clearInterval(timer)
    },
  }
}
