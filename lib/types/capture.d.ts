import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock } from '@deepseek-ai/dsh-llm';
import { type BoardStore } from './board-store.ts';
import { type CaptureAnswer, type CaptureOptions, type CaptureRequest, type CaptureViewport } from './shared.ts';
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
     * @returns the panel's answer (PNG base64 + metadata).
     * @throws {@link CaptureUnavailableError} when no panel answers in time.
     */
    request(sessionId: string, options: CaptureOptions, timeoutMs?: number): Promise<CaptureAnswer>;
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
 * Build the capture broker for one plugin instance.
 * @param store - the board store used to stamp each request with the current revision.
 * @returns the broker; call `dispose()` with the plugin lifetime.
 */
export declare function createCaptureService(store: BoardStore): CaptureService;
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
}
/** Durable PNG storage for captured frames. */
export interface FrameStore {
    /**
     * Persist one base64 PNG.
     * @param sessionId - board key.
     * @param png - base64 PNG, with or without a data-URL prefix.
     * @returns the saved frame.
     */
    save(sessionId: string, png: string): Promise<SavedFrame>;
}
/**
 * Create the frame store under the current dsh home.
 * @returns the store; directories are created on the first save.
 */
export declare function createFrameStore(): FrameStore;
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
