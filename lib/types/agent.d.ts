/**
 * The board's model-facing face on a **main** agent.
 *
 * The whiteboard is a canvas of one conversation, so the three board tools and
 * the drawing policy belong to the main agent itself — not to a hidden child
 * session and not to the plugin's global scope. Registering them globally would
 * tax every agent in the process (including subagents, whose requests never need
 * them), so the wiring happens per agent through the documented extension point:
 *
 * - `agent/created` is a **serial** creation event, awaited before queued input
 *   is released, and the agent README says a listener should "return only after
 *   required asynchronous tool and prompt installation completes" — so what we
 *   register here is present for the agent's first request, and again on every
 *   resume (`source: 'resume'`).
 * - `agent.ctx` is documented as the agent-scoped context "whose contributions
 *   are agent-local [and] unwind on disposal". Registering through it puts the
 *   tool definitions in the agent's own toolbar layer and the section in the
 *   agent's own prompt layer (`ToolRuntime.register` runs
 *   `this.layers.effect(this.ctx, …)` and cordis rebinds `this.ctx` to the
 *   accessing context), so sibling agents never see either.
 * - Subagent sessions (`header.origin === 'subagent'`) are skipped: a child agent
 *   answers a delegated task, it does not own the conversation's board.
 *
 * On plugin activation we also wire every already-live agent (`agents.list()`), so
 * an HMR reload or a late mount does not leave existing conversations without the
 * board until their next resume.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BoardStore } from './board-store.ts';
/**
 * Register the board face for every main agent of this plugin's lifetime, and for
 * the live ones that already exist.
 * @param ctx - Host plugin context.
 * @param store - the Host board store.
 * @param ready - resolves once the one-time legacy board migration has settled.
 */
export declare function registerBoardFace(ctx: Context, store: BoardStore, ready: Promise<unknown>): void;
/** The policy text, exported for tests that assert its size and hard rules. */
export declare const BOARD_POLICY_TEXT: string;
