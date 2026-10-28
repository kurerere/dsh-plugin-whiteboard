import type { Context } from '@deepseek-ai/cordis';
import { type BoardState, type ClearEvent } from './scene.ts';
/** Which surface a clear addresses. */
export type ClearMode = ClearEvent['mode'];
/** What one undo step takes back. */
export type UndoKind = 'draw' | 'clear';
/** One immutable read of a board: the whole document and the revision it belongs to. */
export interface BoardSnapshot {
    /** Monotone revision of this board (`0` for a board that was never drawn on). */
    rev: number;
    /** The whole board document. */
    board: BoardState;
}
/** Result of one successful undo. */
export interface UndoOutcome {
    /** The restored board, published under a NEW revision. */
    snapshot: BoardSnapshot;
    /** Which kind of mutation was taken back. */
    reverted: UndoKind;
}
/** The Host's board storage. */
export interface BoardStore {
    /**
     * Read one board from memory, loading it from disk on the first call for that
     * id. Never performs I/O once the board is loaded.
     * @param sessionId - whiteboard Session id (the board key).
     * @returns the current document; an empty board when nothing was stored yet.
     */
    read(sessionId: string): BoardSnapshot;
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
    mutate(sessionId: string, reduce: (board: BoardState) => BoardState): Promise<BoardSnapshot>;
    /**
     * Clear one surface of a board and persist it.
     * @param sessionId - whiteboard Session id (the board key).
     * @param mode - `2d`, `3d`, or `all`.
     * @returns the cleared document.
     * @throws when the durable write fails.
     */
    clear(sessionId: string, mode: ClearMode): Promise<BoardSnapshot>;
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
    undo(sessionId: string): Promise<UndoOutcome | undefined>;
    /**
     * Whether {@link undo} has a step to go back to. Memory only and cheap, for the
     * state route.
     * @param sessionId - whiteboard Session id (the board key).
     * @returns whether one undo step is available.
     */
    canUndo(sessionId: string): boolean;
    /**
     * Make sure a board document exists, creating an empty one when absent.
     * An existing document is never overwritten. Resets that board's undo history:
     * a replaced board is not the same board.
     * @param sessionId - whiteboard Session id (the board key).
     * @returns the current document.
     */
    newBoard(sessionId: string): Promise<BoardSnapshot>;
    /** Drop in-memory state, including undo history (the durable documents stay on disk). */
    dispose(): void;
}
/**
 * The directory holding one board document per Session.
 * @returns the absolute directory (`<dsh home>/storages/whiteboard`).
 */
export declare function boardStorageDirectory(): string;
/**
 * Build the board store for this plugin instance.
 * @param ctx - Host plugin context (used for diagnostics only).
 * @returns the store, rooted at the current dsh home.
 */
export declare function createBoardStore(ctx: Context): BoardStore;
