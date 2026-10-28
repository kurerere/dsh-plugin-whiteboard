/**
 * Browser-side frame capture for `whiteboard_look`.
 *
 * The board tools live on the Host, but only this browser can see the board: the
 * pixels exist in the panel's `<canvas>` / WebGL stage and nowhere else. So the
 * Host parks a {@link CaptureRequest} behind {@link CAPTURE_POLL_PATH}, the open
 * panel polls for it, and the panel answers with one PNG on
 * {@link CAPTURE_SUBMIT_PATH}.
 *
 * The product decision behind this module is **no headless rendering**: a frame
 * is only ever taken of a board the user can actually see. Therefore:
 *
 * - {@link useCapture} polls only while the tab is on screen (the sidebar says
 *   `visible !== false`), the document is visible, and the stage has been
 *   measured. A hidden, collapsed or background tab stops entirely instead of
 *   rendering a screenshot the user cannot check;
 * - a capture always takes **the surface currently displayed**, even when the
 *   request names the other one. The answer reports the real surface, which is
 *   how the contract lets the panel narrow a request;
 * - failures are ordinary (WebGL unavailable, stage just mounted, canvas gone):
 *   they are answered as an error and never shown in the board UI.
 *
 * {@link capture2d} is the 2D half of that. The 3D half lives in `render3d.tsx`,
 * because only the engine holds the live camera and the material state that
 * `debug: 'shadow-only'` toggles.
 */

import { useEffect, useRef } from 'react'
import {
  CAPTURE_POLL_PATH, CAPTURE_SUBMIT_PATH,
  type CaptureAnswer, type CaptureOptions, type CaptureRequest, type CaptureViewport,
} from '../shared.ts'
import type { BoardMode, BoardState, Camera3D } from '../scene.ts'
import { overlayShapeIds } from './overlay.ts'
import { wakeBoard } from './poll.ts'

/** How often the open panel asks the Host whether a frame is wanted, in ms. */
const POLL_INTERVAL = 250

/** Default longest side of a 2D capture, in pixels. */
const DEFAULT_2D_WIDTH = 1024

/**
 * How long one capture waits for the board on screen to catch up to
 * {@link CaptureRequest.rev}, in ms.
 *
 * A mutation reaches the Host before this tab's board poll applies it, and the
 * Host asks for an automatic frame the moment the mutation returns. The wait is
 * one board-poll window, not the capture deadline: once it expires the frame is
 * taken anyway, because a frame one revision late still answers the question.
 */
const REVISION_WAIT_MS = 500

/** Step of {@link REVISION_WAIT_MS}, in ms. */
const REVISION_STEP_MS = 40

/**
 * Requests currently being answered by this page.
 *
 * Module-level rather than effect-level: switching 2D/3D tears the polling effect
 * down and back up, and the Host may still hand the same request to the new
 * effect. Without this set a surface switch mid-capture would shoot (and submit)
 * the same frame twice.
 */
const answering = new Set<string>()

/** Document-relative route URL (the page may be served under a token prefix). */
const route = (path: string): string => path.slice(1)

/** One captured frame, in the shape the answer route needs. */
export interface CaptureFrame {
  /** Bare base64 PNG (no `data:image/png;base64,` prefix). */
  readonly png: string
  /** Frame width in output pixels. */
  readonly width: number
  /** Frame height in output pixels. */
  readonly height: number
  /** The surface that was actually captured, not necessarily the requested one. */
  readonly mode: BoardMode
  /** Live camera at capture time (3D only). */
  readonly camera?: Camera3D
  /** Stage size in CSS pixels. */
  readonly viewport?: CaptureViewport
}

/** What the capture hook needs from the board that is on screen. */
export interface CaptureSource {
  /** Main Session id that owns the board. */
  readonly sessionId: string
  /** Surface displayed right now; reported on a failed capture. */
  readonly surface: BoardMode
  /** Whether the sidebar says this tab is visible; `undefined` polls (unknown answer). */
  readonly visible: boolean | undefined
  /** True once the stage is measured and its canvas / WebGL engine is mounted. */
  readonly ready: boolean
  /** Revision of the board this tab currently displays. */
  readonly revision: number
  /**
   * Take the frame the request asks for. May throw; the thrown message becomes
   * the tool error the model reads.
   */
  readonly snapshot: (options: CaptureOptions) => CaptureFrame
}

/**
 * Longest-side limit of a captured PNG.
 * @param value - `CaptureOptions.maxWidth`, which the model may omit or misuse.
 * @param fallback - per-surface default (2D 1024, 3D 1280).
 * @returns a usable limit in pixels; small frames are never upscaled.
 */
export function captureWidthLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.max(Math.round(value), 32), 4096)
}

/**
 * Output size of a capture: the source scaled so its longest side fits `limit`.
 * @param width - source width in pixels.
 * @param height - source height in pixels.
 * @param limit - longest side of the output, in pixels.
 * @returns the output size, preserving aspect ratio and never larger than the source.
 */
export function captureSize(width: number, height: number, limit: number): { width: number; height: number } {
  const sourceWidth = Math.max(1, Math.round(width))
  const sourceHeight = Math.max(1, Math.round(height))
  const longest = Math.max(sourceWidth, sourceHeight)
  if (longest <= limit) return { width: sourceWidth, height: sourceHeight }
  const ratio = limit / longest
  return { width: Math.max(1, Math.round(sourceWidth * ratio)), height: Math.max(1, Math.round(sourceHeight * ratio)) }
}

/**
 * Encode a canvas as a bare base64 PNG.
 *
 * The contract accepts the `data:` form too, but the Host pays for every byte of
 * the answer, so the prefix is dropped here rather than there.
 * @param canvas - canvas to encode.
 * @returns the base64 payload, without a `data:image/png;base64,` prefix.
 */
export function encodePng(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/png')
  const comma = url.indexOf(',')
  return comma === -1 ? url : url.slice(comma + 1)
}

/**
 * Output pixels per CSS pixel for a captured copy of the 2D canvas.
 * @param source - the live canvas the copy came from.
 * @param pixels - width of the output copy.
 * @returns the label scale; the backing-store ratio when the canvas cannot be measured.
 */
function cssUnit(source: HTMLCanvasElement, pixels: number): number {
  if (source.clientWidth > 0) return pixels / source.clientWidth
  return Math.min(globalThis.devicePixelRatio || 1, 2)
}

/** The stage size the answer reports, in CSS pixels. */
function viewportOf(element: HTMLElement): CaptureViewport {
  return {
    width: Math.max(1, element.clientWidth),
    height: Math.max(1, element.clientHeight),
    dpr: globalThis.devicePixelRatio || 1,
  }
}

/**
 * Capture the 2D stage as it is on screen.
 *
 * The canvas paints its own surface and dot grid, so the copy needs no background
 * of its own: a straight `drawImage` is the frame. Labels are painted **after**
 * the optional downscale, so they stay a fixed legible size instead of shrinking
 * along with the drawing.
 * @param stage - the stage element that holds the board canvas.
 * @param board - the board document the canvas was drawn from.
 * @param options - what the model asked for.
 * @returns the frame, with the stage viewport and the real surface.
 */
export function capture2d(stage: HTMLElement, board: BoardState, options: CaptureOptions): CaptureFrame {
  const source = stage.querySelector('canvas')
  // `clientWidth === 0` is a collapsed panel: the backing store still holds the
  // last frame, but the tab is not on screen, so there is nothing to look at.
  if (source === null || source.width === 0 || source.height === 0 || source.clientWidth === 0) {
    throw new Error('the 2D canvas is not on screen')
  }
  const size = captureSize(source.width, source.height, captureWidthLimit(options.maxWidth, DEFAULT_2D_WIDTH))
  const output = document.createElement('canvas')
  output.width = size.width
  output.height = size.height
  const context = output.getContext('2d')
  if (context === null) throw new Error('cannot create a 2D context for the capture')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, output.width, output.height)
  if (options.overlay === 'ids') {
    overlayShapeIds(context, board.canvas.shapes, output.width, cssUnit(source, output.width))
  }
  return {
    png: encodePng(output),
    width: output.width,
    height: output.height,
    mode: '2d',
    viewport: viewportOf(stage),
  }
}

/**
 * Wait, briefly, for the displayed board to reach the revision a request names.
 *
 * A tool mutation lands on the Host before this tab's board poll applies it, and
 * the automatic frame after a draw is requested immediately — capturing the older
 * pixels would show the model a board without the shapes it just added. The panel
 * therefore asks for an immediate refresh and waits out one board-poll window.
 * It never blocks the answer for longer than {@link REVISION_WAIT_MS}, and an
 * older request (or an unknown revision) costs nothing.
 * @param request - the frame request, with the revision it should show.
 * @param sessionId - board key, for the immediate-fetch wake-up.
 * @param displayed - reads the revision the canvas is currently drawing.
 */
async function alignRevision(request: CaptureRequest, sessionId: string, displayed: () => number): Promise<void> {
  if (!(request.rev > displayed())) return
  wakeBoard(sessionId)
  const deadline = Date.now() + REVISION_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => { globalThis.setTimeout(() => { resolve() }, REVISION_STEP_MS) })
    if (displayed() >= request.rev) return
  }
}

/**
 * Poll the Host for capture requests while the board is on screen, and answer
 * them with a frame of the surface currently displayed.
 *
 * The loop is deliberately serial: a tick only schedules the next one after the
 * request it found has been captured and submitted, so at most one capture exists
 * at a time. `AbortController` covers the in-flight poll on hide and on unmount;
 * the answer POST is intentionally not aborted with it, because the frame the
 * model is waiting for is worth delivering even if the tab closes mid-round-trip.
 * @param source - session identity, what is on screen, and the capture callback.
 */
export function useCapture(source: CaptureSource): void {
  const { sessionId, surface, visible, ready, revision } = source
  /** Latest capture callback: a draw must not re-arm the poll. */
  const snapshot = useRef(source.snapshot)
  snapshot.current = source.snapshot
  /** Latest revision the canvas shows, for waiting out a just-applied mutation. */
  const currentRevision = useRef(revision)
  currentRevision.current = revision
  /** Latest surface, for the error answer of a capture that was already polling. */
  const reported = useRef<BoardMode>(surface)
  reported.current = surface
  /** The effect below is armed only while the tab is genuinely capturable. */
  const active = ready && visible !== false

  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined
    let disposed = false
    let polling = false
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    let controller: AbortController | undefined

    const submit = async (answer: CaptureAnswer): Promise<void> => {
      try {
        await globalThis.fetch(route(CAPTURE_SUBMIT_PATH), {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(answer),
        })
      } catch {
        // The tool call has its own timeout on the Host. A lost answer is not an
        // error the board can explain to the user, and it is not one to paint.
      }
    }

    const answer = async (request: CaptureRequest): Promise<void> => {
      answering.add(request.id)
      try {
        await alignRevision(request, sessionId, () => currentRevision.current)
        let frame: CaptureFrame | undefined
        let failure = 'the board could not be captured'
        try {
          frame = snapshot.current(request.options)
        } catch (error) {
          if (error instanceof Error && error.message !== '') failure = error.message
        }
        const body: CaptureAnswer = frame === undefined
          ? {
            requestId: request.id,
            png: '',
            width: 0,
            height: 0,
            mode: reported.current,
            error: failure,
          }
          : {
            requestId: request.id,
            png: frame.png,
            width: frame.width,
            height: frame.height,
            mode: frame.mode,
            ...(frame.camera === undefined ? {} : { camera: frame.camera }),
            ...(frame.viewport === undefined ? {} : { viewport: frame.viewport }),
          }
        await submit(body)
      } finally {
        answering.delete(request.id)
      }
    }

    const schedule = (): void => {
      // A hidden document stops the loop rather than keeping a timer alive; the
      // visibility listener below is what starts it again.
      if (disposed || document.visibilityState !== 'visible') return
      if (timer !== undefined) globalThis.clearTimeout(timer)
      timer = globalThis.setTimeout(() => { void tick() }, POLL_INTERVAL)
    }

    const tick = async (): Promise<void> => {
      if (disposed || polling) {
        schedule()
        return
      }
      polling = true
      try {
        if (document.visibilityState !== 'visible') return
        controller?.abort()
        const next = new AbortController()
        controller = next
        const query = new URLSearchParams({ sessionId })
        const response = await globalThis.fetch(`${route(CAPTURE_POLL_PATH)}?${query}`, {
          signal: next.signal,
          cache: 'no-store',
        })
        if (response.status === 204 || !response.ok) return
        const payload: unknown = await response.json().catch(() => undefined)
        const request = parseRequest(payload)
        if (request === undefined || answering.has(request.id)) return
        await answer(request)
      } catch {
        // A failed poll is the normal state of a Host that is not asking — an
        // older Host has no capture route at all. The next tick simply asks again.
      } finally {
        polling = false
        schedule()
      }
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        if (timer !== undefined) globalThis.clearTimeout(timer)
        timer = undefined
        void tick()
        return
      }
      controller?.abort()
      if (timer !== undefined) globalThis.clearTimeout(timer)
      timer = undefined
    }

    document.addEventListener('visibilitychange', onVisibility)
    // Ask at once: the tab being shown is exactly when a model may already be
    // waiting, and an idle answer is one cheap 204.
    void tick()

    return () => {
      disposed = true
      controller?.abort()
      if (timer !== undefined) globalThis.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, sessionId])
}

/**
 * Read one poll response into a request, ignoring anything this build cannot use.
 *
 * The route is remote input like any other, so every field the hook touches is
 * checked here even though the Host is this plugin's own code: a malformed answer
 * must be a quiet miss, never a thrown render path or an answer with undefined
 * fields.
 * @param payload - parsed JSON body, or undefined when the body was not JSON.
 * @returns a capture request, or undefined when the answer was malformed.
 */
function parseRequest(payload: unknown): CaptureRequest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const request = (payload as { request?: unknown }).request
  if (typeof request !== 'object' || request === null) return undefined
  const record = request as Record<string, unknown>
  const id = record['id']
  const sessionId = record['sessionId']
  if (typeof id !== 'string' || id === '' || typeof sessionId !== 'string') return undefined
  const rev = record['rev']
  return {
    id,
    sessionId,
    rev: typeof rev === 'number' && Number.isFinite(rev) ? rev : 0,
    mode: record['mode'] === '3d' ? '3d' : '2d',
    options: parseOptions(record['options']),
  }
}

/**
 * Read the subset of {@link CaptureOptions} this build understands.
 * @param value - raw `options` field of a request.
 * @returns a normalized options object; `{}` when absent or malformed.
 */
function parseOptions(value: unknown): CaptureOptions {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const options: CaptureOptions = {}
  const mode = record['mode']
  if (mode === '2d' || mode === '3d' || mode === 'auto') options.mode = mode
  const overlay = record['overlay']
  if (overlay === 'none' || overlay === 'ids') options.overlay = overlay
  const debug = record['debug']
  if (debug === 'lit' || debug === 'shadow-only') options.debug = debug
  const maxWidth = record['maxWidth']
  if (typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0) options.maxWidth = maxWidth
  return options
}
