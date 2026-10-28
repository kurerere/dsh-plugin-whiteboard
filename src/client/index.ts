/**
 * dsh-plugin-whiteboard — browser face.
 *
 * - Registers a right-sidebar tab type (`whiteboard`) whose body is the board of
 *   the Session the sidebar belongs to. The tab body slot is session-scoped, so
 *   its `sessionId`/`useSession` are that main Session — no Session is retained
 *   and no Session is created here.
 * - The tab's own single-line input sends an ordinary user message into that
 *   conversation: first through the documented client service the shipped
 *   composer uses (`ISession.beginSubmission` + `ISession.prompt`, borrowed from
 *   `ctx.sessions.binding`), falling back to this plugin's `whiteboard.say` route
 *   when the client has no retained binding for the Session.
 * - Reads the living board by polling this plugin's Host state route, which is
 *   keyed by the main Session.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SAY_PATH, THEME_PATH, type WhiteboardSaid } from '../shared.ts'
import type { BoardMode } from '../scene.ts'
import { GuideArtworkWhiteboard } from './artwork.tsx'
import { en, NS, zh, type WhiteboardKey } from './locales.ts'
import { WhiteboardModel } from './model.ts'
import { wakeBoard } from './poll.ts'
import { WhiteboardTab, type WhiteboardTabInjected } from './mounts.tsx'
import { currentTheme, subscribeTheme } from './palette.ts'
import { createBoardReveal, type RevealSidebarFace } from './reveal.ts'
import STYLES from './styles.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Whiteboard copy. */
    whiteboard: WhiteboardKey
  }
}

/** Stable tab implementation id (also the body slot key). */
const TAB_ID = 'dsh-plugin-whiteboard'
/** Right-sidebar tab kind. */
const TAB_KIND = 'whiteboard'
/** Package id stamped on the injected style tag. */
const STYLE_ID = 'dsh-plugin-whiteboard'
/** Guide entry order: right after the side chat's (55). */
const GUIDE_ORDER = 60

/** Required browser services. */
export const inject = ['slots', 'locale', 'sessions']

/** Document-relative route URL (the page may be served under a token prefix). */
const route = (path: string): string => path.slice(1)

/**
 * Send one user message into the main conversation that owns a board.
 *
 * The shipped composer's own path is the client Session face, so that is used
 * first: it registers the local submission echo (the conversation shows the
 * message on this frame, before the Host confirms it) and reuses that echo's
 * `requestId` as the prompt identity. A client generation with no retained
 * binding for the Session — the situation the Host route exists for — falls back
 * to `whiteboard.say`.
 * @param session - registered client Session service.
 * @param sessionId - main Session id.
 * @param text - the message to send.
 */
async function say(
  session: ISessions,
  sessionId: string,
  text: string,
): Promise<void> {
  const id = sessionId as SessionId
  const binding = session.binding(id)
  if (binding !== undefined) {
    const handle = binding.session.beginSubmission({ mode: 'queue', text, attachments: [] })
    const result = await binding.session
      .prompt([{ type: 'text', text }], 'queue', undefined, handle.requestId)
      .catch((failure: unknown) => {
        handle.abandon()
        throw failure
      })
    if (!result.ok) {
      handle.abandon()
      const detail = (result.error as { message?: unknown }).message
      throw new Error(typeof detail === 'string' ? detail : 'the Session refused the message')
    }
    wakeBoard(sessionId)
    return
  }
  const response = await globalThis.fetch(route(SAY_PATH), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text, requestId: globalThis.crypto.randomUUID() }),
  })
  const body = await response.json().catch(() => ({})) as Partial<WhiteboardSaid> & { error?: unknown }
  if (!response.ok || body.accepted !== true) {
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  }
  wakeBoard(sessionId)
}

/**
 * Client plugin body.
 * @param ctx - browser root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'whiteboard: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = STYLE_ID
    tag.textContent = STYLES
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'whiteboard: stylesheet')

  // The API manifest reports the palette the user is actually looking at. That
  // must be known before the 画板 tab is opened (the model may call
  // whiteboard_api on a conversation that has never shown the board), so the
  // client reports the app theme at activation and on every flip.
  ctx.effect(() => {
    let last: 'light' | 'dark' | undefined
    const report = (): void => {
      const theme = currentTheme()
      if (theme === last) return
      last = theme
      void globalThis.fetch(route(THEME_PATH), {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme }),
      }).catch(() => {
        // An older Host may not serve the route; the per-board poll remains the fallback.
      })
    }
    const stop = subscribeTheme(report)
    report()
    return stop
  }, 'whiteboard: report the app theme')

  const model = new WhiteboardModel()
  // Host and Client faces type-check in one program, so `ctx.sessions` resolves to
  // the Host service here; at runtime this is the browser's `ISessions`.
  const sessions = ctx.sessions as unknown as ISessions

  const tabFace: WhiteboardTabInjected = {
    say: (sessionId, text) => say(sessions, sessionId, text),
    clear: (sessionId: string, mode: BoardMode) => model.clear(sessionId, mode),
    undo: sessionId => model.undo(sessionId),
    drafts: model.drafts,
  }

  // The dock surface is optional: without the right sidebar this plugin
  // contributes nothing visible rather than failing to mount.
  ctx.inject(['sidebarRightTabs'], (dock: ClientContext) => {
    dock.effect(() => dock.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: () => t('tab.title'),
      guide: [{
        id: 'whiteboard',
        order: GUIDE_ORDER,
        title: () => t('tab.title'),
        description: () => t('tab.guideDescription'),
        icon: GuideArtworkWhiteboard,
      }],
    }), 'whiteboard: tab type')

    dock.effect(() => dock.slots.inject('sidebar.right.pane.tab', () => dock.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
      inject: () => tabFace,
    }, WhiteboardTab)), 'whiteboard: tab body')

    // A drawing produced by an ordinary message is invisible until the tab is
    // open, so the first drawing of the conversation on screen opens it — once,
    // then never again for that conversation (see ./reveal.ts for why).
    dock.effect(() => {
      const controller = dock.get('sidebarRight') as RevealSidebarFace | undefined
      if (controller === undefined) return () => {}
      const reveal = createBoardReveal({ route, sidebar: controller, kind: TAB_KIND })
      return () => { reveal.dispose() }
    }, 'whiteboard: reveal the board on its first drawing')
  })
}
