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
 * `<dsh home>/storages/whiteboard/frames/<session>/<hash>.png` (see
 * `./frames.ts`, which also re-exports its old names from here), and — when the
 * deployment mounts a durable attachment store — normalized into an image
 * attachment the model can see inline. The path remains the fallback: a model
 * with `read_image` can read the exact same file.
 *
 * A deep look travels as the same single frame exchange: `request` carries an
 * optional earlier document/frame (`baseline`) or an uncommitted dry-run
 * document (`preview`), and the panel's answer may describe a contact sheet
 * (`tiles`) or a before/after comparison (`diff`). Those extra fields are
 * optional exactly as far as the wire is concerned — a frame with a diff sheet
 * is still just a PNG — so `submit` copies the ones it can trust and drops the
 * ones it cannot instead of rejecting the pixels.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import type { BoardStore } from './board-store.ts'
import type { SavedFrame } from './frames.ts'
import type { BoardState } from './scene.ts'
import {
  type CaptureAnswer, type CaptureBaseline, type CaptureDiff,
  type CaptureOptions, type CaptureRequest, type CaptureViewport,
} from './shared.ts'

// The frame store moved to `./frames.ts` (it grew an index, a listing and
// pruning); the old names stay importable from here so call sites and the
// published types keep working.
export { createFrameStore } from './frames.ts'
export type { FrameLogger, FrameMeta, FrameRecord, FrameSource, FrameStore, SavedFrame } from './frames.ts'

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

/** Most tile captions any contact sheet produces (a 3-column diff is the widest). */
const MAX_TILES = 8

/** Longest tile caption, diff label and diff note kept from the panel. */
const MAX_TILE_LABEL = 120
const MAX_DIFF_LABEL = 200
const MAX_DIFF_NOTE = 600

/**
 * Extra inputs one capture may carry beside the options.
 *
 * Both are optional and independent: `baseline` asks for a before/after sheet,
 * `preview` asks for an uncommitted dry-run document to be rendered instead of
 * the live surface.
 */
export interface CaptureRequestExtra {
  /** Earlier document or stored frame to compare the new frame with. */
  baseline?: CaptureBaseline
  /** Uncommitted document to render (never written to the board). */
  preview?: BoardState
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
   * @param extra - optional diff baseline and/or dry-run document.
   * @returns the panel's answer (PNG base64 + metadata).
   * @throws {@link CaptureUnavailableError} when no panel answers in time.
   */
  request(
    sessionId: string,
    options: CaptureOptions,
    timeoutMs?: number,
    extra?: CaptureRequestExtra,
  ): Promise<CaptureAnswer>
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

/**
 * Read the optional changed-pixel box a diff sheet reports.
 *
 * The box is in the **new frame's** output pixels; a malformed one is dropped
 * on its own, because the rest of the diff summary is still true without it.
 * @param value - untrusted `diff.bounds`.
 * @returns a copied box, or undefined.
 */
function sanitizeDiffBounds(value: unknown): CaptureDiff['bounds'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const x = record['x']
  const y = record['y']
  const width = record['width']
  const height = record['height']
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return undefined
  if (typeof y !== 'number' || !Number.isFinite(y) || y < 0) return undefined
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 0) return undefined
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return undefined
  return { x, y, width, height }
}

/**
 * Validate and copy an optional diff summary from the panel.
 *
 * The summary is explanatory metadata for the model: a malformed one is dropped
 * (with its bounds) rather than failing the frame, which is still a perfectly
 * good PNG.
 * @param value - untrusted `CaptureAnswer.diff`.
 * @returns a fresh, copied summary, or undefined when it is not usable.
 */
export function sanitizeCaptureDiff(value: unknown): CaptureDiff | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const kind = record['kind']
  const label = record['label']
  const rev = record['rev']
  const changedPixels = record['changedPixels']
  const changedRatio = record['changedRatio']
  const comparable = record['comparable']
  const note = record['note']
  if (kind !== 'document' && kind !== 'image') return undefined
  if (typeof label !== 'string' || label.length > MAX_DIFF_LABEL) return undefined
  if (typeof rev !== 'number' || !Number.isFinite(rev) || !Number.isInteger(rev) || rev < 0) return undefined
  if (typeof changedPixels !== 'number' || !Number.isFinite(changedPixels) || changedPixels < 0) return undefined
  if (typeof changedRatio !== 'number' || !Number.isFinite(changedRatio)
    || changedRatio < 0 || changedRatio > 1) return undefined
  if (typeof comparable !== 'boolean') return undefined
  if (typeof note !== 'string' || note.length > MAX_DIFF_NOTE) return undefined
  const bounds = sanitizeDiffBounds(record['bounds'])
  return {
    kind,
    label,
    rev,
    changedPixels,
    changedRatio,
    comparable,
    note,
    ...(bounds === undefined ? {} : { bounds }),
  }
}

/**
 * Validate and copy the optional contact-sheet captions from the panel.
 *
 * Captions are decoration, not data: entries that are not strings are dropped
 * one by one (a stray `null` must not cost the other captions) and the list is
 * cut to the documented maximum, because no sheet is wider than that.
 * @param value - untrusted `CaptureAnswer.tiles`.
 * @returns a copied caption list, or undefined when none survived.
 */
export function sanitizeCaptureTiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tiles: string[] = []
  for (const tile of value) {
    if (typeof tile !== 'string' || tile.length > MAX_TILE_LABEL) continue
    tiles.push(tile)
    if (tiles.length >= MAX_TILES) break
  }
  return tiles.length === 0 ? undefined : tiles
}

/** Normalise untrusted tool options into the wire options. */
function sanitizeOptions(options: CaptureOptions): CaptureOptions {
  const out: CaptureOptions = {}
  if (options.mode === 'auto' || options.mode === '2d' || options.mode === '3d') out.mode = options.mode
  if (options.overlay === 'ids' || options.overlay === 'none') out.overlay = options.overlay
  if (options.debug === 'lit' || options.debug === 'shadow-only' || options.debug === 'per-light') {
    out.debug = options.debug
  }
  if (options.angles === 'default' || options.angles === 'turntable') out.angles = options.angles
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

  const request = (
    sessionId: string,
    options: CaptureOptions,
    timeoutMs = 4_000,
    extra?: CaptureRequestExtra,
  ): Promise<CaptureAnswer> => {
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
      // The panel decides how the extra document/frame is rendered; the broker
      // only carries it, unchanged, to the one panel that can draw it.
      ...(extra?.baseline === undefined ? {} : { baseline: extra.baseline }),
      ...(extra?.preview === undefined ? {} : { preview: extra.preview }),
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
    // Optional answer fields are copies of what the panel said, never the
    // panel's own object: a malformed diff/tile list is dropped here, while the
    // frame itself (which is just a PNG) is still delivered.
    const diff = sanitizeCaptureDiff(answer.diff)
    const tiles = sanitizeCaptureTiles(answer.tiles)
    const preview = answer.preview === true
    const accepted: CaptureAnswer = {
      requestId: answer.requestId,
      png: answer.png,
      width: answer.width,
      height: answer.height,
      mode: answer.mode,
      ...(answer.camera === undefined ? {} : { camera: answer.camera }),
      ...(answer.viewport === undefined ? {} : { viewport: answer.viewport }),
      ...(diff === undefined ? {} : { diff }),
      ...(tiles === undefined ? {} : { tiles }),
      ...(preview ? { preview } : {}),
    }
    settle(answer.requestId, accepted)
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
