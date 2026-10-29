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
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { BoardStore } from './board-store.ts'
import { createBoardTools, type BoardToolServices } from './tools.ts'

/**
 * The runtime prompt face we depend on. `dsh-system-prompt` is not a plugin
 * dependency, so this is the whole contract used from it.
 */
interface PromptFace {
  section(section: { name: string; order: number; text: string }): () => void
  getSectionOrder(name: 'PLAN_POLICY'): number
}

/**
 * Where the drawing policy lands when the composition has no allocation table for
 * `PLAN_POLICY`: after first-party guidance, before the persona suffix.
 */
const BOARD_SECTION_ORDER_FALLBACK = 10050

/**
 * The board bootstrap for one main agent.
 *
 * It carries intent and the two hard safety rules only: draw when asked, and
 * never use a browser as the board's view. The technical contract (coordinate
 * spaces, palette, defaults, lights, limits, examples) lives in the generated
 * `whiteboard_api` manifest, so it is inspectable and cannot go stale in a
 * prompt. That also keeps the resident section small.
 */
const BOARD_POLICY = [
  'WHITEBOARD',
  'This conversation owns a whiteboard in the sidebar: a 2D canvas and a 3D scene.',
  '',
  'DRAW ONLY WHEN ASKED',
  'Draw only when the user asks for a visual. The board tools are yours alone.',
  '',
  'DISCOVER, DO NOT ASSUME',
  'Before authoring, call whiteboard_api. It returns the live contract: op/field spec, defaults, palette',
  'for the current theme, viewport, current camera and lights, limits, examples and hints. Every value can',
  'change between builds, themes and conversations; do not carry assumptions from another one.',
  '',
  'AUTHOR BY ID',
  'Use whiteboard_draw / whiteboard_3d. Calls append; results name the ids added, updated and removed.',
  'Revise by id, never repaint. An unknown id rejects the batch and lists the ids that exist.',
  '',
  'VERIFY WITH THE PANEL',
  'whiteboard_look captures what the open 画板 panel shows: pixels, measurements and warnings (ids can be',
  'overlaid and shadows isolated). It only works while the panel is open. Never open the GUI in a browser:',
  'it is token-fenced and is not your view. whiteboard_read returns the full state without the picture.',
  'per-light / turntable contact sheets, diffAgainst revisions and dryRun previews check work before committing it.',
  '',
  'CLEAR AND UNDO',
  'Clearing and undoing belong to the user unless they ask; whiteboard_history / whiteboard_undo exist for when',
  'they do. Read after external changes.',
  '',
  'After drawing, say in one or two sentences what the user is looking at and what you can change next.',
].join('\n')

/**
 * Wire one agent's board face: the five tools plus the board bootstrap section.
 * @param agent - the agent being announced or found live at activation.
 * @param store - the Host board store the tools mutate.
 * @param ready - resolves once the one-time legacy board migration has settled.
 * @param services - capture/frame services shared by every agent's board tools.
 * @returns whether the agent was wired (false for subagents).
 */
function wireAgent(agent: Agent, store: BoardStore, ready: Promise<unknown>, services: BoardToolServices): boolean {
  if (agent.session.header.origin === 'subagent') return false
  for (const definition of createBoardTools(store, ready, services)) agent.ctx.tools.register(definition)
  const prompt = agent.ctx.get('systemPrompt') as PromptFace | undefined
  if (prompt !== undefined) {
    let order = BOARD_SECTION_ORDER_FALLBACK
    try {
      const plan = prompt.getSectionOrder('PLAN_POLICY')
      if (typeof plan === 'number' && Number.isFinite(plan)) order = plan + 10
    } catch {
      // The composition has no allocation table; the fallback order is fine.
    }
    prompt.section({ name: 'whiteboard:board', order, text: BOARD_POLICY })
  }
  return true
}

/**
 * Register the board face for every main agent of this plugin's lifetime, and for
 * the live ones that already exist.
 * @param ctx - Host plugin context.
 * @param store - the Host board store.
 * @param ready - resolves once the one-time legacy board migration has settled.
 * @param services - capture/frame services shared by every agent's board tools.
 */
export function registerBoardFace(
  ctx: Context, store: BoardStore, ready: Promise<unknown>, services: BoardToolServices,
): void {
  ctx.on('agent/created', ({ agent }) => {
    try {
      if (wireAgent(agent, store, ready, services)) {
        ctx.logger.debug(`whiteboard: board tools and policy registered for ${agent.id}`)
      }
    } catch (error) {
      // Never fail an agent's creation over the board: the conversation matters more.
      ctx.logger.warn(`whiteboard: could not register the board face for ${agent.id}: ${String(error)}`)
    }
  })
  for (const agent of ctx.agents.list()) {
    try {
      wireAgent(agent, store, ready, services)
    } catch (error) {
      ctx.logger.warn(`whiteboard: could not register the board face for the live agent ${agent.id}: ${String(error)}`)
    }
  }
}

/** The policy text, exported for tests that assert its size and hard rules. */
export const BOARD_POLICY_TEXT = BOARD_POLICY
