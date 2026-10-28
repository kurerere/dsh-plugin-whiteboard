/**
 * The board store: Host-owned durable application state, one JSON document per
 * board.
 *
 * The board deliberately does **not** live on the session log. A plugin-owned
 * event type outside the shipped `SessionEventMap` may only be written with the
 * `ignorable` envelope marker, and the one API that sets it
 * (`appendPluginRecord`) reaches a module-private field of a `Session` instance
 * from *its own* copy of `@deepseek-ai/dsh-session`; an out-of-tree Host face
 * resolves a second copy, so that call is rejected. A projection unit would then
 * also need a committed event for a mutation like "clear", which has none.
 *
 * So the board lives where the framework expects non-session application state:
 * one document per whiteboard, keyed by the whiteboard Session id, beside the
 * session:
 *
 *     <dsh home>/storages/whiteboard/<sessionId>.json
 *
 * Read path: **synchronous and memory-only after the first touch.** The browser
 * polls the state route a few times a second, so a poll must never hit the disk;
 * each board file is read once (lazily) and then served from the map.
 *
 * Write path: every mutation is folded with the same pure reducer the client
 * uses (`applyDraw` / `applyScene3D` / `applyClear` from `./scene.ts`),
 * serialised per board so concurrent tool calls cannot interleave, written with
 * a temp file + rename, and only **after that write succeeded** does the
 * in-memory snapshot advance. A failed write therefore never leaves the browser
 * polling into a state the disk does not have.
 *
 * A missing document is simply an empty board. A corrupt or unreadable one is
 * logged once and treated the same way (rev 0): a browser that cannot render a
 * corrupt board would be worse than losing that board. The next mutation
 * rewrites the file.
 *
 * **Undo history is memory-only, and deliberately so.** Each entry is a whole
 * board document; persisting twelve copies per board would bloat the sidecar
 * document for a convenience feature, and a Host restart is exactly when a user
 * expects to be looking at the durable board rather than a pre-restart step.
 * History therefore lives in-process (bounded, newest last), is cleared when the
 * board is replaced by `newBoard()`, and dies with `dispose()`.
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  applyClear, emptyBoard, isBoardState,
  type BoardState, type ClearEvent,
} from './scene.ts'
import { BOARD_STORAGE_DIR } from './shared.ts'

/** Which surface a clear addresses. */
export type ClearMode = ClearEvent['mode']

/** What one undo step takes back. */
export type UndoKind = 'draw' | 'clear'

/** One immutable read of a board: the whole document and the revision it belongs to. */
export interface BoardSnapshot {
  /** Monotone revision of this board (`0` for a board that was never drawn on). */
  rev: number
  /** The whole board document. */
  board: BoardState
}

/** Result of one successful undo. */
export interface UndoOutcome {
  /** The restored board, published under a NEW revision. */
  snapshot: BoardSnapshot
  /** Which kind of mutation was taken back. */
  reverted: UndoKind
}

/** One retained pre-mutation board and what that mutation was. */
interface HistoryEntry {
  snapshot: BoardSnapshot
  kind: UndoKind
}

/** How many mutations one board can step back (memory only). */
const HISTORY_LIMIT = 12

/**
 * How many times one atomic replace is retried, and the linear backoff step.
 * Six attempts at 15/30/45/60/75 ms ride out a reader that holds the document for
 * about a quarter of a second, which is the window Windows sharing failures live
 * in; anything longer is a stuck file and belongs to the caller as a real error.
 */
const RENAME_ATTEMPTS = 6

/** Milliseconds added per retry attempt (attempt index + 1). */
const RENAME_BACKOFF_MS = 15

/** The Host's board storage. */
export interface BoardStore {
  /**
   * Read one board from memory, loading it from disk on the first call for that
   * id. Never performs I/O once the board is loaded.
   * @param sessionId - whiteboard Session id (the board key).
   * @returns the current document; an empty board when nothing was stored yet.
   */
  read(sessionId: string): BoardSnapshot
  /**
   * Fold one mutation into a board, persist it, and only then advance memory.
   *
   * The reducer runs inside the per-board serialisation, so it always sees the
   * newest board; throwing from it aborts the mutation without writing. A
   * successful mutation pushes the previous board onto that board's undo
   * history.
   * @param sessionId - whiteboard Session id (the board key).
   * @param reduce - pure fold from the current board to the next one.
   * @returns the document after the fold (unchanged when the reducer returns the same reference).
   * @throws when the durable write fails; memory stays at the last durable state.
   */
  mutate(sessionId: string, reduce: (board: BoardState) => BoardState): Promise<BoardSnapshot>
  /**
   * Clear one surface of a board and persist it.
   * @param sessionId - whiteboard Session id (the board key).
   * @param mode - `2d`, `3d`, or `all`.
   * @returns the cleared document.
   * @throws when the durable write fails.
   */
  clear(sessionId: string, mode: ClearMode): Promise<BoardSnapshot>
  /**
   * Step one mutation back, persisting the restored board under a NEW revision.
   *
   * The revision never goes backwards: the client's applied-revision guard and
   * its poll gate both depend on monotonicity, so a restored board is a fresh
   * revision of the same content.
   * @param sessionId - whiteboard Session id (the board key).
   * @returns the restored document and what was taken back, or `undefined` when
   *   the history is empty (nothing is written in that case).
   * @throws when the durable write fails; memory and history stay unchanged.
   */
  undo(sessionId: string): Promise<UndoOutcome | undefined>
  /**
   * Whether {@link undo} has a step to go back to. Memory only and cheap, for the
   * state route.
   * @param sessionId - whiteboard Session id (the board key).
   * @returns whether one undo step is available.
   */
  canUndo(sessionId: string): boolean
  /**
   * Make sure a board document exists, creating an empty one when absent.
   * An existing document is never overwritten. Resets that board's undo history:
   * a replaced board is not the same board.
   * @param sessionId - whiteboard Session id (the board key).
   * @returns the current document.
   */
  newBoard(sessionId: string): Promise<BoardSnapshot>
  /** Drop in-memory state, including undo history (the durable documents stay on disk). */
  dispose(): void
}

/** Document envelope written to disk. */
const DOC_VERSION = 1

/** Board ids this plugin mints or accepts; also a filesystem-safety check. */
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode one stored document. Accepts both the envelope and a bare board
 * document so an older or hand-edited file still loads.
 * @param text - file contents.
 * @returns the snapshot, or `undefined` when the text is not a usable board document.
 */
function decodeDocument(text: string): BoardSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const candidate = isRecord(parsed) && 'board' in parsed ? parsed['board'] : parsed
  if (!isBoardState(candidate)) return undefined
  if (!Number.isInteger(candidate.rev) || candidate.rev < 0) return undefined
  // The board's own `rev` is authoritative: the reducer owns it, and a stored
  // envelope's `rev` is only a copy made at write time.
  return { rev: candidate.rev, board: candidate }
}

/**
 * The directory holding one board document per Session.
 * @returns the absolute directory (`<dsh home>/storages/whiteboard`).
 */
export function boardStorageDirectory(): string {
  const home = process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
  return join(home, BOARD_STORAGE_DIR)
}

/**
 * Build the board store for this plugin instance.
 * @param ctx - Host plugin context (used for diagnostics only).
 * @returns the store, rooted at the current dsh home.
 */
export function createBoardStore(ctx: Context): BoardStore {
  const directory = boardStorageDirectory()
  /** Live documents, served to every reader without I/O. */
  const cache = new Map<string, BoardSnapshot>()
  /** Board ids whose cached snapshot came from (or was written to) the disk. */
  const durable = new Set<string>()
  /** One write chain per board, so concurrent calls cannot interleave. */
  const chains = new Map<string, Promise<void>>()
  /** Bounded undo history per board, newest last. Memory only (see the module note). */
  const history = new Map<string, HistoryEntry[]>()
  let disposed = false

  /** Remember one pre-mutation board, dropping the oldest step past the limit. */
  const remember = (sessionId: string, snapshot: BoardSnapshot, kind: UndoKind): void => {
    const entries = history.get(sessionId) ?? []
    entries.push({ snapshot, kind })
    while (entries.length > HISTORY_LIMIT) entries.shift()
    history.set(sessionId, entries)
  }

  const fileFor = (sessionId: string): string => {
    if (!BOARD_ID.test(sessionId)) {
      throw new Error(`whiteboard: ${JSON.stringify(sessionId)} is not a board id`)
    }
    return join(directory, `${sessionId}.json`)
  }

  /** Load one board from disk exactly once, then answer from the cache forever. */
  const load = (sessionId: string): BoardSnapshot => {
    const cached = cache.get(sessionId)
    if (cached !== undefined) return cached
    const file = fileFor(sessionId)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code !== 'ENOENT') {
        ctx.logger.warn(`whiteboard: reading ${file} failed (${String(error)}); starting from an empty board`)
      }
      const empty: BoardSnapshot = { rev: 0, board: emptyBoard() }
      cache.set(sessionId, empty)
      return empty
    }
    const decoded = decodeDocument(text)
    if (decoded === undefined) {
      ctx.logger.warn(`whiteboard: ${file} is not a usable board document; starting from an empty board`)
      const empty: BoardSnapshot = { rev: 0, board: emptyBoard() }
      cache.set(sessionId, empty)
      return empty
    }
    cache.set(sessionId, decoded)
    durable.add(sessionId)
    return decoded
  }

  /**
   * Rename a finished temp file over its target, retrying the Windows sharing
   * failures that a concurrent reader or scanner provokes.
   *
   * The write itself is serialised per board, so this is not our own two writes
   * colliding: on Windows `rename` over a file that another handle currently has
   * open (an editor, an antivirus scan, a test reading the document) fails with
   * `EPERM`/`EACCES`/`EBUSY` for a few milliseconds and then succeeds. Those
   * errors are transient by nature, and surfacing one as a failed undo turned a
   * recoverable race into an error the user has to retry by hand.
   * @param temp - the fully written temp file.
   * @param file - the live document to replace.
   */
  const renameWithRetry = async (temp: string, file: string): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, file)
        return
      } catch (error) {
        const code = (error as { code?: unknown }).code
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
        if (!transient || attempt >= RENAME_ATTEMPTS - 1) throw error
        await new Promise<void>((resolve) => {
          setTimeout(resolve, RENAME_BACKOFF_MS * (attempt + 1))
        })
      }
    }
  }

  const save = async (sessionId: string, snapshot: BoardSnapshot): Promise<void> => {
    const file = fileFor(sessionId)
    const temp = `${file}.${Math.random().toString(36).slice(2, 10)}.tmp`
    const text = `${JSON.stringify({ version: DOC_VERSION, rev: snapshot.rev, board: snapshot.board })}\n`
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temp, text, 'utf8')
      await renameWithRetry(temp, file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new Error('whiteboard: could not save the board to '
        + `${file} (${String(error)}). The board was not changed; `
        + 'the workspace must allow writing under the dsh home, then retry.')
    }
  }

  /** Run one operation against a board after every earlier operation settled. */
  const serial = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = chains.get(sessionId)
    const run = previous === undefined ? work() : previous.then(work, work)
    const tail: Promise<void> = run.then(() => undefined, () => undefined)
    chains.set(sessionId, tail)
    void tail.then(() => {
      if (chains.get(sessionId) === tail) chains.delete(sessionId)
    })
    return run
  }

  const assertLive = (): void => {
    if (disposed) throw new Error('whiteboard: the board store is disposed')
  }

  const read = (sessionId: string): BoardSnapshot => {
    assertLive()
    return load(sessionId)
  }

  /** Fold, persist, then advance memory and remember the previous board. */
  const commit = (
    sessionId: string,
    kind: UndoKind,
    reduce: (board: BoardState) => BoardState,
  ): Promise<BoardSnapshot> => {
    assertLive()
    return serial(sessionId, async () => {
      const current = load(sessionId)
      const next = reduce(current.board)
      if (next === current.board) return current
      // The reducer bumps `rev` itself; keep the counter monotone even if a
      // future reducer forgets to.
      const board = next.rev > current.rev ? next : { ...next, rev: current.rev + 1 }
      const snapshot: BoardSnapshot = { rev: board.rev, board }
      await save(sessionId, snapshot)
      // Everything below this line is the success path only: a failed write must
      // leave memory AND the undo history exactly as they were.
      cache.set(sessionId, snapshot)
      durable.add(sessionId)
      remember(sessionId, current, kind)
      return snapshot
    })
  }

  const mutate = (sessionId: string, reduce: (board: BoardState) => BoardState): Promise<BoardSnapshot> =>
    commit(sessionId, 'draw', reduce)

  const clear = (sessionId: string, mode: ClearMode): Promise<BoardSnapshot> =>
    commit(sessionId, 'clear', board => applyClear(board, { mode }))

  const canUndo = (sessionId: string): boolean => {
    assertLive()
    return (history.get(sessionId)?.length ?? 0) > 0
  }

  const undo = (sessionId: string): Promise<UndoOutcome | undefined> => {
    assertLive()
    return serial(sessionId, async () => {
      const entries = history.get(sessionId)
      const entry = entries?.at(-1)
      if (entries === undefined || entry === undefined) return undefined
      const current = load(sessionId)
      // Publish the restored content under a NEW revision so a poll gate or an
      // applied-revision guard never sees the revision go backwards.
      const rev = current.rev + 1
      const board: BoardState = { ...entry.snapshot.board, rev }
      const snapshot: BoardSnapshot = { rev, board }
      await save(sessionId, snapshot)
      cache.set(sessionId, snapshot)
      durable.add(sessionId)
      // Drop the step only after the restored board is durable.
      entries.pop()
      if (entries.length === 0) history.delete(sessionId)
      return { snapshot, reverted: entry.kind }
    })
  }

  const newBoard = (sessionId: string): Promise<BoardSnapshot> => {
    assertLive()
    return serial(sessionId, async () => {
      // A replaced board is not the same board: its steps are meaningless here.
      history.delete(sessionId)
      const current = load(sessionId)
      if (durable.has(sessionId)) return current
      await save(sessionId, current)
      durable.add(sessionId)
      return current
    })
  }

  const dispose = (): void => {
    disposed = true
    cache.clear()
    durable.clear()
    chains.clear()
    history.clear()
  }

  return { read, mutate, clear, undo, canUndo, newBoard, dispose }
}
