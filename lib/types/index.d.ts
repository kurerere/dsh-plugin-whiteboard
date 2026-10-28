/**
 * dsh-plugin-whiteboard — Host face.
 *
 * An AI whiteboard in the right sidebar **of a conversation**: the user chats,
 * the model draws on a 2D canvas or a three.js scene, and the board updates while
 * the answer streams.
 *
 * The Host owns three things:
 *
 * 1. **The board store** (`./board-store.ts`). A board is Host-owned durable
 *    application state, one JSON document per **main Session** under
 *    `<dsh home>/storages/whiteboard/`, *not* a session event and not a session
 *    projection — see that module for why the event channel cannot work out of
 *    tree. The browser keeps a live copy by polling {@link STATE_PATH}; the
 *    drawing tools (which run on the conversation's own agent) and the clear /
 *    undo routes mutate the same document.
 * 2. **The board's model-facing face** (`./agent.ts`): the three board tools and
 *    the drawing-policy prompt section, registered into each **main** agent's own
 *    scope from `agent/created`, so unrelated agents never see them.
 * 3. **The routes** below, which let the sidebar tab read and drive that board
 *    without a private client path.
 */
import type { Context } from '@deepseek-ai/cordis';
export type * from './shared.ts';
export type { BoardState } from './scene.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "whiteboard";
/** Hard dependencies: routes, per-agent wiring and the legacy scan. */
export declare const inject: string[];
/**
 * Plugin body. The board takes no configuration: one board per main Session,
 * keyed by the Session itself, needs no knobs.
 * @param ctx - Host plugin context.
 */
export declare function apply(ctx: Context): void;
