import type { BoardMode, Camera3D } from './scene.ts';
import type { CaptureOptions } from './shared.ts';
/** Where a frame came from, for the index and the model-facing listing. */
export type FrameSource = 'look' | 'auto' | 'preview' | 'diff';
/** What the caller knows about one frame; everything but the bytes. */
export interface FrameMeta {
    /** Output width in pixels. */
    width: number;
    /** Output height in pixels. */
    height: number;
    /** Surface the frame shows. */
    mode: BoardMode;
    /** Board revision the frame shows (the document's own `rev`). */
    rev: number;
    /** Which capture produced it. */
    source: FrameSource;
    /** Live camera at capture time (3D only). */
    camera?: Camera3D;
    /** Capture options the panel actually rendered with. */
    options?: CaptureOptions;
}
/** One indexed frame: its metadata plus where it lives. */
export interface FrameRecord extends FrameMeta {
    /** First 16 hex chars of the PNG's SHA-256; also the file's base name. */
    hash: string;
    /** Absolute PNG path the model can open with `read_image`. */
    path: string;
    /** Byte length of the PNG. */
    bytes: number;
    /** ISO-8601 time the frame was saved. */
    at: string;
}
/** One persisted frame. */
export interface SavedFrame {
    /** Absolute PNG path the model can open with `read_image`. */
    path: string;
    /** Short content hash, stable for identical pixels. */
    hash: string;
    /** Byte length of the PNG. */
    bytes: number;
    /** The decoded bytes, so the attachment path does not read the file again. */
    data: Buffer;
    /** The index entry, which carries the metadata the model was told about. */
    record: FrameRecord;
}
/** Durable PNG storage for captured frames. */
export interface FrameStore {
    /**
     * Persist one base64 PNG and index it.
     *
     * Same pixels reuse the same file and hash; the metadata and timestamp of the
     * newest save win. Indexing is best effort: a failed index write is logged and
     * still resolves with the saved frame.
     * @param sessionId - board key.
     * @param png - base64 PNG, with or without a data-URL prefix.
     * @param meta - size, surface, revision and provenance of the frame.
     * @returns the saved frame, including its index record.
     * @throws when the bytes are not a PNG.
     */
    save(sessionId: string, png: string, meta: FrameMeta): Promise<SavedFrame>;
    /**
     * The retained frames of one board, newest first.
     * @param sessionId - board key.
     * @param limit - at most this many records (`undefined` means all retained).
     * @returns copies are not made; treat the records as read-only.
     */
    list(sessionId: string, limit?: number): Promise<FrameRecord[]>;
    /**
     * Resolve a hash prefix to one frame, newest match first.
     * @param sessionId - board key.
     * @param prefix - hex prefix of at least 6 chars, case-insensitive.
     * @returns the matching record, or `undefined` when nothing matches.
     */
    byHash(sessionId: string, prefix: string): Promise<FrameRecord | undefined>;
    /**
     * Read one retained frame's bytes.
     * @param sessionId - board key.
     * @param hash - full hash or a hex prefix of at least 6 chars.
     * @returns the record and its PNG bytes, or `undefined` when unknown/unreadable.
     */
    read(sessionId: string, hash: string): Promise<{
        record: FrameRecord;
        data: Buffer;
    } | undefined>;
    /**
     * Keep only the newest `keep` frames and delete the rest of the files.
     * @param sessionId - board key.
     * @param keep - how many records to retain (`0` drops every frame).
     * @returns how many records were dropped (files removed alongside them).
     * @throws when the index cannot be rewritten; the frames stay listed then.
     */
    prune(sessionId: string, keep: number): Promise<number>;
}
/** The one logging method the store uses; `ctx.logger` satisfies it. */
export interface FrameLogger {
    warn(message: string): void;
}
/**
 * Create the frame store under the current dsh home.
 * @param logger - optional diagnostics sink (the Host plugin context's logger).
 * @returns the store; directories are created on the first save.
 */
export declare function createFrameStore(logger?: FrameLogger): FrameStore;
