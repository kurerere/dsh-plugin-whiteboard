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
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tools'
import { registerBoardFace } from './agent.ts'
import { createBoardStore, type ClearMode } from './board-store.ts'
import { migrateLegacyBoards } from './migrate.ts'
import {
  CLEAR_PATH, isLegacyWhiteboardId, SAY_PATH, STATE_PATH, UNDO_PATH,
  type WhiteboardCleared, type WhiteboardSaid, type WhiteboardSnapshot, type WhiteboardUndone,
} from './shared.ts'

export type * from './shared.ts'
export type { BoardState } from './scene.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'whiteboard'

/** Hard dependencies: routes, per-agent wiring and the legacy scan. */
export const inject = ['connection', 'agents', 'sessionQuery', 'tools']

const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,120}$/
const MAX_TEXT = 100_000
const NO_STORE = { 'cache-control': 'no-store' } as const

/**
 * The one method used from the session controller: the same admission path the
 * main composer calls, so the tab cannot diverge from it. Looked up lazily by
 * name, never imported — a deployment without the controller still loads.
 */
interface SessionControllerFace {
  prompt(
    request: {
      sessionId: string
      requestId: string
      mode: 'queue' | 'steer'
      content: { type: 'text'; text: string }[]
    },
    signal?: AbortSignal,
  ): Promise<{ accepted?: boolean } | undefined>
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

function fail(status: number, error: string, code?: string): Response {
  return json(code === undefined ? { error } : { error, code }, status)
}

function isClearMode(value: unknown): value is ClearMode {
  return value === '2d' || value === '3d' || value === 'all'
}

/**
 * A board belongs to a main Session; retired whiteboard child ids are refused so
 * a stale tab cannot resurrect the old keying.
 * @param value - candidate Session id from a body or query string.
 * @returns whether the id addresses a main Session.
 */
function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value) && !isLegacyWhiteboardId(value)
}

/** The controller service name, kept in one place so the probe can fake it. */
const SESSION_CONTROLLER = 'sessionController'

/**
 * Plugin body. The board takes no configuration: one board per main Session,
 * keyed by the Session itself, needs no knobs.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  const store = createBoardStore(ctx)
  // Start the one-time legacy scan immediately; every board entry point awaits it,
  // so a poll cannot observe a pre-migration empty board.
  const ready = migrateLegacyBoards(ctx).catch((error: unknown) => {
    ctx.logger.warn(`whiteboard: legacy board migration failed: ${String(error)}`)
    return undefined
  })

  ctx.effect(() => () => {
    store.dispose()
  }, 'whiteboard: lifetime')

  registerBoardFace(ctx, store, ready)

  const controller = (): SessionControllerFace | undefined => {
    const services = ctx as unknown as { get(name: string): unknown }
    return services.get(SESSION_CONTROLLER) as SessionControllerFace | undefined
  }

  const readBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
    try {
      const body = await request.json() as unknown
      return typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  const sessionField = (body: Record<string, unknown>, key: string): string | undefined => {
    const value = body[key]
    return validSessionId(value) ? value : undefined
  }

  const failure = (error: unknown): Response => {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') return fail(status, (error as Error).message)
    const code = (error as { code?: unknown }).code
    if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') return fail(404, 'session not found', code)
    ctx.logger.warn(`whiteboard: request failed: ${String(error)}`)
    return fail(500, String(error))
  }

  ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!validSessionId(sessionId)) return Promise.resolve(fail(400, 'invalid sessionId'))
      return ready.then(() => {
        try {
          // Memory-only after the first touch, so polling stays cheap. A Session
          // with no board document reads as an empty board; no file is created
          // until the first mutation.
          const snapshot = store.read(sessionId)
          return json({
            rev: snapshot.rev,
            board: snapshot.board,
            canUndo: store.canUndo(sessionId),
          } satisfies WhiteboardSnapshot)
        } catch (error) {
          return failure(error)
        }
      })
    },
  })

  ctx.connection.fetch.register({
    path: CLEAR_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readBody(request)
      const sessionId = body === undefined ? undefined : sessionField(body, 'sessionId')
      const mode = body === undefined ? undefined : body['mode']
      if (sessionId === undefined) return fail(400, 'invalid sessionId')
      if (mode !== undefined && !isClearMode(mode)) return fail(400, 'mode must be "2d", "3d", or "all"')
      await ready
      try {
        const snapshot = await store.clear(sessionId, isClearMode(mode) ? mode : 'all')
        return json({
          accepted: true,
          rev: snapshot.rev,
          canUndo: store.canUndo(sessionId),
        } satisfies WhiteboardCleared)
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.connection.fetch.register({
    path: UNDO_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readBody(request)
      const sessionId = body === undefined ? undefined : sessionField(body, 'sessionId')
      if (sessionId === undefined) return fail(400, 'invalid sessionId')
      await ready
      try {
        const outcome = await store.undo(sessionId)
        if (outcome === undefined) {
          // Nothing to step back: the button is disabled client-side, but two tabs
          // may still race. Not an error — report the current revision.
          const snapshot = store.read(sessionId)
          return json({
            accepted: true,
            rev: snapshot.rev,
            canUndo: false,
            reverted: 'none',
          } satisfies WhiteboardUndone)
        }
        return json({
          accepted: true,
          rev: outcome.snapshot.rev,
          canUndo: store.canUndo(sessionId),
          reverted: outcome.reverted,
        } satisfies WhiteboardUndone)
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.connection.fetch.register({
    path: SAY_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readBody(request)
      if (body === undefined) return fail(400, 'invalid JSON body')
      const sessionId = sessionField(body, 'sessionId')
      const text = body['text']
      const requestId = typeof body['requestId'] === 'string' && REQUEST_ID.test(body['requestId'])
        ? body['requestId']
        : globalThis.crypto.randomUUID()
      if (sessionId === undefined) return fail(400, 'invalid sessionId')
      if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT) return fail(400, 'invalid text')
      const target = controller()
      if (target === undefined) {
        return fail(503, 'the session controller is not mounted; cannot send to the conversation')
      }
      try {
        // The composer's own admission path: it resumes a cold Session with its own
        // preset composition, folds a duplicate `requestId` into the first send, and
        // records an ordinary user turn.
        await target.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, request.signal)
        return json({ accepted: true } satisfies WhiteboardSaid)
      } catch (error) {
        const code = (error as { code?: unknown }).code
        const message = error instanceof Error ? error.message : String(error)
        if (code === 'session/not-found') return fail(404, message)
        ctx.logger.warn(`whiteboard: say failed for ${sessionId}: ${message}`)
        return fail(500, message)
      }
    },
  })
}
