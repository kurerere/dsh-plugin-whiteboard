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
import {
  createCaptureService, createFrameStore, createImageAttacher, sanitizeCaptureDiff, sanitizeCaptureTiles,
} from './capture.ts'
import { migrateLegacyBoards } from './migrate.ts'
import {
  CAPTURE_POLL_PATH, CAPTURE_SUBMIT_PATH, CLEAR_PATH, isLegacyWhiteboardId, SAY_PATH, STATE_PATH, THEME_PATH, UNDO_PATH,
  type CaptureAccepted, type CaptureAnswer, type CapturePollAnswer, type CaptureViewport,
  type WhiteboardCleared, type WhiteboardSaid, type WhiteboardSnapshot, type WhiteboardUndone,
} from './shared.ts'
import type { Camera3D, Vec3 } from './scene.ts'
import type { BoardToolServices } from './tools.ts'

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

/** Read one optional `[x, y, z]` vector from an untrusted frame upload. */
function asVec3(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const [x, y, z] = value
  if (typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)
    || typeof z !== 'number' || !Number.isFinite(z)) return undefined
  return [x, y, z]
}

/** Read one optional camera from an untrusted frame upload. */
function asCamera(value: unknown): Camera3D | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const position = asVec3(record['position'])
  const target = asVec3(record['target'])
  const fov = record['fov']
  if (position === undefined || target === undefined || typeof fov !== 'number' || !Number.isFinite(fov)) {
    return undefined
  }
  return { position, target, fov }
}

/** Read one optional stage viewport from an untrusted frame upload. */
function asViewport(value: unknown): CaptureViewport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const width = record['width']
  const height = record['height']
  const dpr = record['dpr']
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return undefined
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined
  if (typeof dpr !== 'number' || !Number.isFinite(dpr) || dpr <= 0) return undefined
  return { width, height, dpr }
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
  const captures = createCaptureService(store)
  const services: BoardToolServices = {
    captures,
    frames: createFrameStore(ctx.logger),
    attachImage: createImageAttacher(ctx),
  }

  ctx.effect(() => () => {
    captures.dispose()
    store.dispose()
  }, 'whiteboard: lifetime')

  registerBoardFace(ctx, store, ready, services)

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
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('sessionId')
      if (!validSessionId(sessionId)) return Promise.resolve(fail(400, 'invalid sessionId'))
      const theme = url.searchParams.get('theme')
      return ready.then(() => {
        try {
          // The panel's ordinary state poll is also the cheapest place to learn
          // which palette it is painting in and how big its stage is; the API
          // manifest reports both before any frame has been captured.
          if (theme === 'light' || theme === 'dark') captures.noteTheme(sessionId, theme)
          const vw = url.searchParams.get('vw')
          const vh = url.searchParams.get('vh')
          const dpr = url.searchParams.get('dpr')
          if (vw !== null && vh !== null && dpr !== null) {
            captures.noteViewport(sessionId, { width: Number(vw), height: Number(vh), dpr: Number(dpr) })
          }
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
    path: CAPTURE_POLL_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!validSessionId(sessionId)) return Promise.resolve(fail(400, 'invalid sessionId'))
      return ready.then(() => {
        try {
          // Taking a request is also the panel's heartbeat: `hasViewer` is what
          // lets a mutation decide whether an automatic frame is worth waiting for.
          const pending = captures.take(sessionId)
          return pending === undefined
            ? new Response(null, { status: 204, headers: NO_STORE })
            : json({ request: pending } satisfies CapturePollAnswer)
        } catch (error) {
          return failure(error)
        }
      })
    },
  })

  ctx.connection.fetch.register({
    path: CAPTURE_SUBMIT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readBody(request)
      if (body === undefined) return fail(400, 'invalid JSON body')
      const requestId = body['requestId']
      const png = body['png']
      const width = body['width']
      const height = body['height']
      const mode = body['mode']
      const failureText = body['error']
      if (typeof requestId !== 'string' || requestId === '') return fail(400, 'invalid requestId')
      if (typeof png !== 'string' || png.length > 8_000_000) return fail(400, 'invalid png')
      if (typeof width !== 'number' || !Number.isFinite(width) || width < 0) return fail(400, 'invalid width')
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return fail(400, 'invalid height')
      if (mode !== '2d' && mode !== '3d') return fail(400, 'mode must be "2d" or "3d"')
      const camera = body['camera'] === undefined ? undefined : asCamera(body['camera'])
      const viewport = body['viewport'] === undefined ? undefined : asViewport(body['viewport'])
      // Deep-look extras travel with the same frame: a diff summary, contact-sheet
      // captions and the dry-run flag. They are parsed with the camera's
      // discipline — shape-checked, copied, and dropped when malformed — because
      // the frame itself is still a usable PNG without them.
      const diff = body['diff'] === undefined ? undefined : sanitizeCaptureDiff(body['diff'])
      const tiles = body['tiles'] === undefined ? undefined : sanitizeCaptureTiles(body['tiles'])
      const preview = body['preview'] === true ? true : undefined
      const answer: CaptureAnswer = {
        requestId,
        png,
        width,
        height,
        mode,
        ...(camera === undefined ? {} : { camera }),
        ...(viewport === undefined ? {} : { viewport }),
        ...(diff === undefined ? {} : { diff }),
        ...(tiles === undefined ? {} : { tiles }),
        ...(preview === undefined ? {} : { preview }),
        ...(typeof failureText === 'string' && failureText !== '' ? { error: failureText } : {}),
      }
      try {
        const result = captures.submit(answer)
        return json(result satisfies CaptureAccepted, result.accepted ? 200 : 410)
      } catch (error) {
        return failure(error)
      }
    },
  })

  ctx.connection.fetch.register({
    path: THEME_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readBody(request)
      if (body === undefined) return fail(400, 'invalid JSON body')
      const theme = body['theme']
      if (theme !== 'light' && theme !== 'dark') return fail(400, 'theme must be "light" or "dark"')
      // App-wide, not per board: it is what whiteboard_api reports before any
      // 画板 tab has existed, so a palette decision is not made against a guess.
      captures.noteAppTheme(theme)
      return json({ accepted: true })
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
