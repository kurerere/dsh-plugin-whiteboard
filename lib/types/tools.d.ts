import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { BoardStore } from './board-store.ts';
import type { AttachedImage, CaptureService, FrameStore, SavedFrame } from './capture.ts';
/**
 * Host services the board tools need beyond the store. They stay optional so a
 * composition without the capture channel (or a schema-only test) still builds
 * the three authoring tools; `whiteboard_look` then explains that it is not wired.
 */
export interface BoardToolServices {
    /** Correlates `whiteboard_look` with the open panel. */
    readonly captures: CaptureService;
    /** Durable PNG storage for captured frames. */
    readonly frames: FrameStore;
    /** Optional frame → durable image attachment (inline image in the result). */
    readonly attachImage: (frame: SavedFrame, name: string) => Promise<AttachedImage | undefined>;
}
/**
 * Build the three board tool definitions, bound to the plugin context so they
 * can read the live projection.
 * @param store - the Host board store the tools mutate.
 * @returns one definition per board tool, in prompt order.
 */
export declare function createBoardTools(store: BoardStore, ready?: Promise<unknown>, services?: BoardToolServices): ToolDefinition[];
