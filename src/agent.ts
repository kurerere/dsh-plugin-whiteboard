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
import { createBoardTools } from './tools.ts'

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
 * The drawing policy of one main agent.
 *
 * It is deliberately compact: every main-session request pays for it, drawing or
 * not (about 2.9k characters). The coordinate spaces, palette, liveness rule and
 * id discipline live here exactly once — the tool declarations point at this
 * section instead of repeating it, because duplication costs the same tax twice.
 */
const BOARD_POLICY = [
  'You also own the WHITEBOARD in the sidebar: a canvas of THIS conversation. The board tools are yours alone.',
  '',
  'DRAW ONLY WHEN ASKED',
  'Draw only when the user asks for a drawing — 画/画板/示意图/流程图/时间线/可视化, or "draw", "sketch", "diagram",',
  '"chart", "show it on the board". An ordinary question is not an ask: never illustrate an answer nobody asked to see,',
  'and never draw to decorate a reply.',
  '',
  'TWO SURFACES',
  '- 2D canvas (whiteboard_draw): a fixed 0..1000 square, origin top-left, x right, y DOWN, letterboxed into the panel.',
  '  Body text at least 14 units, headings 18-28, title up to 36.',
  '- 3D scene (whiteboard_3d): three.js world units, y UP, ground at y=0, default camera (6.4, 4.6, 8.2) looking at the',
  '  origin; stand an object on the ground at position [x, height/2, z]. Leave view.background unset so the scene follows',
  '  the panel theme; set it only for a specific requested backdrop.',
  'Pick ONE surface as the answer; use the other only when it adds something.',
  '',
  'DRAW IN SMALL LAYERS',
  'A tool call only reaches the board when the step ends, so one huge batch appears all at once and looks frozen. Use',
  '2-6 ops per call, one logical layer at a time (containers and titles, then content, then connectors, then labels),',
  'with one short line between layers.',
  'Never let drawing block or replace the task: if the user asks for a drawing mid-task, draw it (still in small',
  'layers), then continue the task. Do not abandon the task for the board, and do not hold the next task step hostage',
  'to a perfect board.',
  '',
  'IDS',
  'Calls append, they never replace. Results name the ids added, updated and removed: keep them and patch by id; never',
  'redraw a board to change one label. An unknown id rejects the whole batch and lists the ids that exist. Use clear',
  'only when the user asks to start over.',
  '',
  'LOOK',
  'Compose on a grid: aligned edges, consistent gaps, margins. Label every meaningful shape in 2-5 words. Use the',
  'palette tokens (ink, muted, blue, cyan, teal, green, lime, yellow, amber, orange, red, pink, purple, indigo, white,',
  'black) rather than hex, so light and dark both work; tint containers at 0.12-0.2 opacity with a solid stroke; aim',
  'for dozens of shapes (caps: 300 shapes, 120 objects) and 3-4 colors plus ink and muted.',
  '',
  'CONTINUITY AND UNDO',
  'The board is durable across turns and restarts: read it before revising old work, and keep the same ids between',
  'turns. The user can step one batch back from the board bar (Ctrl+Z), so after 撤销 the board may be one revision',
  'older than you remember — call whiteboard_read before redrawing. You cannot undo yourself; clear plus a redraw is',
  'your only destructive move.',
  '',
  'EXAMPLE (flow, layer 1 of 2)',
  '{"ops":[{"op":"add","kind":"rect","id":"a","x":70,"y":150,"w":210,"h":95,"radius":16,"fill":"blue","opacity":0.14,',
  '"stroke":"blue","strokeWidth":3},{"op":"add","kind":"text","x":175,"y":200,"text":"Collect","size":22,"weight":"bold",',
  '"align":"center","baseline":"middle","fill":"ink"}]}',
  '',
  'After drawing, say in one or two sentences what the user is looking at and what you can change next.',
].join('\n')

/**
 * Wire one agent's board face: the three tools plus the drawing policy section.
 * @param agent - the agent being announced or found live at activation.
 * @param store - the Host board store the tools mutate.
 * @param ready - resolves once the one-time legacy board migration has settled.
 * @returns whether the agent was wired (false for subagents).
 */
function wireAgent(agent: Agent, store: BoardStore, ready: Promise<unknown>): boolean {
  if (agent.session.header.origin === 'subagent') return false
  for (const definition of createBoardTools(store, ready)) agent.ctx.tools.register(definition)
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
 */
export function registerBoardFace(ctx: Context, store: BoardStore, ready: Promise<unknown>): void {
  ctx.on('agent/created', ({ agent }) => {
    try {
      if (wireAgent(agent, store, ready)) {
        ctx.logger.debug(`whiteboard: board tools and policy registered for ${agent.id}`)
      }
    } catch (error) {
      // Never fail an agent's creation over the board: the conversation matters more.
      ctx.logger.warn(`whiteboard: could not register the board face for ${agent.id}: ${String(error)}`)
    }
  })
  for (const agent of ctx.agents.list()) {
    try {
      wireAgent(agent, store, ready)
    } catch (error) {
      ctx.logger.warn(`whiteboard: could not register the board face for the live agent ${agent.id}: ${String(error)}`)
    }
  }
}

/** The policy text, exported for tests that assert its size and hard rules. */
export const BOARD_POLICY_TEXT = BOARD_POLICY
