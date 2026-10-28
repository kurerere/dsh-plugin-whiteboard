/**
 * Host side of the board's picture channel.
 *
 * The model's `whiteboard_look` asks for a frame; the **open panel** answers.
 * There is deliberately no headless renderer: the user agreed that a frame is
 * only available while the sidebar tab is on screen, which is exactly when the
 * picture is useful and exactly when the live camera (including the user's own
 * orbit) is the truth. A closed panel therefore never produces a frame; the
 * request times out with a readable error instead of rendering somewhere nobody
 * can see.
 *
 * The broker owns only correlation and timeouts; the panel owns pixels. A frame
 * is submitted as base64 PNG, persisted under
 * `<dsh home>/storages/whiteboard/frames/<session>/<hash>.png`, and — when the
 * deployment mounts a durable attachment store — normalized into an image
 * attachment the model can see inline. The path remains the fallback: a model
 * with `read_image` can read the exact same file.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { boardStorageDirectory, type BoardStore } from './board-store.ts'
import {
  type CaptureAnswer, type CaptureOptions, type CaptureRequest, type CaptureViewport,
} from './shared.ts'

/** Error thrown when no panel is polling for the board (or the request expired). */
export class CaptureUnavailableError extends Error {
  /** Stable marker for callers that want to fall back to text only. */
  readonly code = 'CAPTURE_UNAVAILABLE'

  /**
   * @param message - model-facing explanation.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CaptureUnavailableError'
  }
}

/** One frame request and the answer that will settle it. */
interface PendingCapture {
  readonly request: CaptureRequest
  readonly resolve: (answer: CaptureAnswer) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  /** When a panel took the request; a second take waits for a short grace period. */
  takenAt?: number
}

/** How long a taken request is reserved for the panel that took it. */
const TAKE_GRACE_MS = 1_500

/** How recently a panel must have polled to count as "on screen". */
const VIEWER_WINDOW_MS = 3_000

/** Bounds on a requested output width. */
const MIN_FRAME_WIDTH = 64
const MAX_FRAME_WIDTH = 2_048

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
  request(sessionId: string, options: CaptureOptions, timeoutMs?: number): Promise<CaptureAnswer>
  /**
   * Hand the next waiting request to a polling panel.
   * @param sessionId - board key.
   * @returns a request the panel should capture, or undefined when none waits.
   */
  take(sessionId: string): CaptureRequest | undefined
  /**
   * Accept one panel answer.
   * @param answer - the uploaded frame or failure.
   * @returns whether the answer matched a live request.
   */
  submit(answer: CaptureAnswer): { accepted: boolean; error?: string }
  /**
   * Whether a panel polled recently for this board.
   * @param sessionId - board key.
   * @returns true when a capture is likely to be answered.
   */
  hasViewer(sessionId: string): boolean
  /**
   * Last viewport reported with a frame, for `whiteboard_read` and the API manifest.
   * @param sessionId - board key.
   * @returns the last known stage size, or undefined.
   */
  lastViewport(sessionId: string): CaptureViewport | undefined
  /**
   * Remember the panel's current palette, reported by its state poll.
   * @param sessionId - board key.
   * @param theme - the theme the panel is painting in.
   */
  noteTheme(sessionId: string, theme: 'light' | 'dark'): void
  /**
   * Last theme the panel reported, for the API manifest.
   * @param sessionId - board key.
   * @returns the last known theme, or undefined before the first poll.
   */
  lastTheme(sessionId: string): 'light' | 'dark' | undefined
  /**
   * Remember the app-wide palette reported by the client plugin itself.
   * @param theme - the app theme.
   */
  noteAppTheme(theme: 'light' | 'dark'): void
  /**
   * App-wide theme reported before any board tab existed.
   * @returns the app theme, or undefined before the client reported one.
   */
  lastAppTheme(): 'light' | 'dark' | undefined
  /** Reject every waiting request and stop accepting new ones. */
  dispose(): void
}

/** Normalise untrusted tool options into the wire options. */
function sanitizeOptions(options: CaptureOptions): CaptureOptions {
  const out: CaptureOptions = {}
  if (options.mode === 'auto' || options.mode === '2d' || options.mode === '3d') out.mode = options.mode
  if (options.overlay === 'ids' || options.overlay === 'none') out.overlay = options.overlay
  if (options.debug === 'lit' || options.debug === 'shadow-only') out.debug = options.debug
  if (typeof options.maxWidth === 'number' && Number.isFinite(options.maxWidth)) {
    out.maxWidth = Math.min(MAX_FRAME_WIDTH, Math.max(MIN_FRAME_WIDTH, Math.round(options.maxWidth)))
  }
  return out
}

/**
 * Build the capture broker for one plugin instance.
 * @param store - the board store used to stamp each request with the current revision.
 * @returns the broker; call `dispose()` with the plugin lifetime.
 */
export function createCaptureService(store: BoardStore): CaptureService {
  const pending = new Map<string, PendingCapture>()
  /** Per-board FIFO of request ids. */
  const queues = new Map<string, string[]>()
  /** Last poll time per board. */
  const lastPoll = new Map<string, number>()
  /** Last stage size per board. */
  const viewports = new Map<string, CaptureViewport>()
  /** Last theme the panel reported per board. */
  const themes = new Map<string, 'light' | 'dark'>()
  /** Theme the client plugin reported at activation, before any tab opened. */
  let appTheme: 'light' | 'dark' | undefined
  let disposed = false

  const removeFromQueue = (sessionId: string, id: string): void => {
    const queue = queues.get(sessionId)
    if (queue === undefined) return
    const index = queue.indexOf(id)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) queues.delete(sessionId)
  }

  const settle = (id: string, answer?: CaptureAnswer, error?: unknown): void => {
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    clearTimeout(entry.timer)
    removeFromQueue(entry.request.sessionId, id)
    if (answer !== undefined) {
      if (answer.viewport !== undefined) viewports.set(entry.request.sessionId, answer.viewport)
      entry.resolve(answer)
      return
    }
    entry.reject(error)
  }

  const request = (sessionId: string, options: CaptureOptions, timeoutMs = 4_000): Promise<CaptureAnswer> => {
    if (disposed) {
      return Promise.reject(new CaptureUnavailableError('the whiteboard host is shutting down; no frame can be captured'))
    }
    const snapshot = store.read(sessionId)
    const id = `cap-${randomUUID()}`
    const requestValue: CaptureRequest = {
      id,
      sessionId,
      rev: snapshot.rev,
      mode: snapshot.board.mode,
      options: sanitizeOptions(options),
    }
    return new Promise<CaptureAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(id, undefined, new CaptureUnavailableError(
          'the 画板 panel is not on screen, so there is no frame to look at. '
          + 'Open the 画板 tab in the right sidebar and call whiteboard_look again; '
          + 'whiteboard_read still works without the panel.',
        ))
      }, Math.max(1, timeoutMs))
      // A pending capture must not keep the Host process alive on its own.
      ;(timer as unknown as { unref?: () => void }).unref?.()
      pending.set(id, { request: requestValue, resolve, reject, timer })
      const queue = queues.get(sessionId)
      if (queue === undefined) queues.set(sessionId, [id])
      else queue.push(id)
    })
  }

  const take = (sessionId: string): CaptureRequest | undefined => {
    lastPoll.set(sessionId, Date.now())
    const queue = queues.get(sessionId)
    if (queue === undefined) return undefined
    while (queue.length > 0) {
      const id = queue[0]
      if (id === undefined) return undefined
      const entry = pending.get(id)
      if (entry === undefined) {
        queue.shift()
        continue
      }
      if (entry.takenAt !== undefined && Date.now() - entry.takenAt < TAKE_GRACE_MS) return undefined
      entry.takenAt = Date.now()
      return entry.request
    }
    return undefined
  }

  const submit = (answer: CaptureAnswer): { accepted: boolean; error?: string } => {
    const entry = pending.get(answer.requestId)
    if (entry === undefined) {
      return { accepted: false, error: 'unknown or expired capture request' }
    }
    if (answer.error !== undefined && answer.error !== '') {
      settle(answer.requestId, undefined, new Error(answer.error))
      return { accepted: true, error: answer.error }
    }
    if (!Number.isFinite(answer.width) || !Number.isFinite(answer.height)
      || answer.width <= 0 || answer.height <= 0 || answer.png === '') {
      const error = 'the panel returned an empty or malformed frame'
      settle(answer.requestId, undefined, new Error(error))
      return { accepted: false, error }
    }
    settle(answer.requestId, answer)
    return { accepted: true }
  }

  const hasViewer = (sessionId: string): boolean => {
    const last = lastPoll.get(sessionId)
    return last !== undefined && Date.now() - last <= VIEWER_WINDOW_MS
  }

  return {
    request,
    take,
    submit,
    hasViewer,
    lastViewport: sessionId => viewports.get(sessionId),
    noteTheme(sessionId, theme): void {
      themes.set(sessionId, theme)
    },
    lastTheme: sessionId => themes.get(sessionId),
    noteAppTheme(theme): void {
      appTheme = theme
    },
    lastAppTheme: () => appTheme,
    dispose(): void {
      disposed = true
      for (const id of [...pending.keys()]) {
        settle(id, undefined, new CaptureUnavailableError('the whiteboard host is shutting down; no frame can be captured'))
      }
      queues.clear()
      lastPoll.clear()
      viewports.clear()
      themes.clear()
      appTheme = undefined
    },
  }
}

/** One persisted frame. */
export interface SavedFrame {
  /** Absolute PNG path the model can open with `read_image`. */
  path: string
  /** Short content hash, stable for identical pixels. */
  hash: string
  /** Byte length of the PNG. */
  bytes: number
  /** The decoded bytes, so the attachment path does not read the file again. */
  data: Buffer
}

/** Durable PNG storage for captured frames. */
export interface FrameStore {
  /**
   * Persist one base64 PNG.
   * @param sessionId - board key.
   * @param png - base64 PNG, with or without a data-URL prefix.
   * @returns the saved frame.
   */
  save(sessionId: string, png: string): Promise<SavedFrame>
}

/** PNG signature; a frame that is not a PNG is a panel bug, not art. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Keep a session id usable as one directory name. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '_')
}

/**
 * Create the frame store under the current dsh home.
 * @returns the store; directories are created on the first save.
 */
export function createFrameStore(): FrameStore {
  const root = join(boardStorageDirectory(), 'frames')
  return {
    async save(sessionId: string, png: string): Promise<SavedFrame> {
      const raw = png.startsWith('data:') ? png.slice(png.indexOf(',') + 1) : png
      const data = Buffer.from(raw, 'base64')
      if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error('the panel returned a frame that is not a PNG')
      }
      const hash = createHash('sha256').update(data).digest('hex').slice(0, 16)
      const directory = join(root, safeSegment(sessionId))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, `${hash}.png`)
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, path)
      return { path, hash, bytes: data.length, data }
    },
  }
}

/** The PNG image metadata an `image` content block carries. */
export type AttachedImage = Omit<ImageBlock['attachment'], 'mediaType'> & { readonly mediaType: 'image/png' }

/** The part of the Host attachment service this plugin uses. */
interface AttachmentsFace {
  saveImage(input: { data: Buffer; mediaType: string; name?: string }): Promise<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }>
}

/**
 * Build the optional frame → image-attachment bridge.
 *
 * The attachment store is not a hard dependency: a deployment without it still
 * gets the PNG path, which `read_image` can open. A save failure is logged and
 * degrades to the path rather than failing the model's look.
 * @param ctx - Host plugin context.
 * @returns an attacher that resolves to undefined when the store is absent.
 */
export function createImageAttacher(
  ctx: Context,
): (frame: SavedFrame, name: string) => Promise<AttachedImage | undefined> {
  return async (frame: SavedFrame, name: string): Promise<AttachedImage | undefined> => {
    const attachments = (ctx as unknown as { get(name: string): unknown }).get('attachments') as AttachmentsFace | undefined
    if (attachments === undefined) return undefined
    try {
      const ref = await attachments.saveImage({ data: frame.data, mediaType: 'image/png', name })
      return {
        attachmentId: ref.attachmentId as AttachedImage['attachmentId'],
        mediaType: 'image/png',
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      }
    } catch (error) {
      ctx.logger.warn(`whiteboard: could not attach the captured frame: ${String(error)}`)
      return undefined
    }
  }
}
