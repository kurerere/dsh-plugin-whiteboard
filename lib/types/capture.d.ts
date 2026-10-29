import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock } from '@deepseek-ai/dsh-llm';
import type { BoardStore } from './board-store.ts';
import type { SavedFrame } from './frames.ts';
import type { BoardState } from './scene.ts';
import { type CaptureAnswer, type CaptureBaseline, type CaptureDiff, type CaptureOptions, type CaptureRequest, type CaptureViewport } from './shared.ts';
export { createFrameStore } from './frames.ts';
export type { FrameLogger, FrameMeta, FrameRecord, FrameSource, FrameStore, SavedFrame } from './frames.ts';
/** Error thrown when no panel is polling for the board (or the request expired). */
export declare class CaptureUnavailableError extends Error {
    /** Stable marker for callers that want to fall back to text only. */
    readonly code = "CAPTURE_UNAVAILABLE";
    /**
     * @param message - model-facing explanation.
     */
    constructor(message: string);
}
/**
 * Extra inputs one capture may carry beside the options.
 *
 * Both are optional and independent: `baseline` asks for a before/after sheet,
 * `preview` asks for an uncommitted dry-run document to be rendered instead of
 * the live surface.
 */
export interface CaptureRequestExtra {
    /** Earlier document or stored frame to compare the new frame with. */
    baseline?: CaptureBaseline;
    /** Uncommitted document to render (never written to the board). */
    preview?: BoardState;
}
/**
 * The Host's capture broker.
 *
 * `request` is called from the model-facing tool and resolves when the panel
 * answers or rejects when no panel is on screen. `take` is called by the
 * panel's poll route; `submit` is called by its upload route.
 */
export interface CaptureService {
    /**
     * Ask the open panel for one frame.
     * @param sessionId - board key (the main Session id).
     * @param options - what to capture.
     * @param timeoutMs - how long to wait for the panel.
     * @param extra - optional diff baseline and/or dry-run document.
     * @returns the panel's answer (PNG base64 + metadata).
     * @throws {@link CaptureUnavailableError} when no panel answers in time.
     */
    request(sessionId: string, options: CaptureOptions, timeoutMs?: number, extra?: CaptureRequestExtra): Promise<CaptureAnswer>;
    /**
     * Hand the next waiting request to a polling panel.
     * @param sessionId - board key.
     * @returns a request the panel should capture, or undefined when none waits.
     */
    take(sessionId: string): CaptureRequest | undefined;
    /**
     * Accept one panel answer.
     * @param answer - the uploaded frame or failure.
     * @returns whether the answer matched a live request.
     */
    submit(answer: CaptureAnswer): {
        accepted: boolean;
        error?: string;
    };
    /**
     * Whether a panel polled recently for this board.
     * @param sessionId - board key.
     * @returns true when a capture is likely to be answered.
     */
    hasViewer(sessionId: string): boolean;
    /**
     * Last viewport reported with a frame, for `whiteboard_read` and the API manifest.
     * @param sessionId - board key.
     * @returns the last known stage size, or undefined.
     */
    lastViewport(sessionId: string): CaptureViewport | undefined;
    /**
     * Remember the panel's current palette, reported by its state poll.
     * @param sessionId - board key.
     * @param theme - the theme the panel is painting in.
     */
    noteTheme(sessionId: string, theme: 'light' | 'dark'): void;
    /**
     * Last theme the panel reported, for the API manifest.
     * @param sessionId - board key.
     * @returns the last known theme, or undefined before the first poll.
     */
    lastTheme(sessionId: string): 'light' | 'dark' | undefined;
    /**
     * Remember the app-wide palette reported by the client plugin itself.
     * @param theme - the app theme.
     */
    noteAppTheme(theme: 'light' | 'dark'): void;
    /**
     * App-wide theme reported before any board tab existed.
     * @returns the app theme, or undefined before the client reported one.
     */
    lastAppTheme(): 'light' | 'dark' | undefined;
    /** Reject every waiting request and stop accepting new ones. */
    dispose(): void;
}
/**
 * Validate and copy an optional diff summary from the panel.
 *
 * The summary is explanatory metadata for the model: a malformed one is dropped
 * (with its bounds) rather than failing the frame, which is still a perfectly
 * good PNG.
 * @param value - untrusted `CaptureAnswer.diff`.
 * @returns a fresh, copied summary, or undefined when it is not usable.
 */
export declare function sanitizeCaptureDiff(value: unknown): CaptureDiff | undefined;
/**
 * Validate and copy the optional contact-sheet captions from the panel.
 *
 * Captions are decoration, not data: entries that are not strings are dropped
 * one by one (a stray `null` must not cost the other captions) and the list is
 * cut to the documented maximum, because no sheet is wider than that.
 * @param value - untrusted `CaptureAnswer.tiles`.
 * @returns a copied caption list, or undefined when none survived.
 */
export declare function sanitizeCaptureTiles(value: unknown): string[] | undefined;
/**
 * Build the capture broker for one plugin instance.
 * @param store - the board store used to stamp each request with the current revision.
 * @returns the broker; call `dispose()` with the plugin lifetime.
 */
export declare function createCaptureService(store: BoardStore): CaptureService;
/** The PNG image metadata an `image` content block carries. */
export type AttachedImage = Omit<ImageBlock['attachment'], 'mediaType'> & {
    readonly mediaType: 'image/png';
};
/**
 * Build the optional frame → image-attachment bridge.
 *
 * The attachment store is not a hard dependency: a deployment without it still
 * gets the PNG path, which `read_image` can open. A save failure is logged and
 * degrades to the path rather than failing the model's look.
 * @param ctx - Host plugin context.
 * @returns an attacher that resolves to undefined when the store is absent.
 */
export declare function createImageAttacher(ctx: Context): (frame: SavedFrame, name: string) => Promise<AttachedImage | undefined>;
