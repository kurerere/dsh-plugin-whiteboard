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
 * - a plain capture always takes **the surface currently displayed**, even when
 *   the request names the other one. The answer reports the real surface, which
 *   is how the contract lets the panel narrow a request;
 * - an explicit request may ask for a frame the user is not looking at — a dry
 *   run previews an uncommitted document, a `diffAgainst` look re-renders an
 *   earlier one — and those are rendered **offscreen, inside this same tab**, by
 *   {@link CaptureSource.snapshot} / {@link CaptureSource.renderBaseline}. They
 *   never move the live stage; a closed panel still fails with the readable
 *   error the tool shows the model;
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
  type CaptureAnswer, type CaptureBaseline, type CaptureOptions, type CaptureRequest, type CaptureViewport,
} from '../shared.ts'
import { isBoardState, type BoardMode, type BoardState, type Camera3D, type Vec3 } from '../scene.ts'
import { diffFrames, type DiffMeta, type DiffResult } from './diff.ts'
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
 * Relative camera-distance change that still counts as "the same view".
 *
 * A stored frame is compared pixel for pixel, so any orbit or dolly shows up as
 * changed pixels. These tolerances are therefore tight enough to catch a nudged
 * camera and wide enough to forgive float noise in the reported camera.
 */
const CAMERA_DISTANCE_TOLERANCE = 0.02

/** Camera-orbit change, in degrees, that still counts as "the same view". */
const CAMERA_ANGLE_TOLERANCE = 1.5

/** Field-of-view change, in degrees, that still counts as "the same view". */
const CAMERA_FOV_TOLERANCE = 1.5

/** Relative aspect-ratio change that still counts as "the same frame shape". */
const ASPECT_TOLERANCE = 0.01

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
  /**
   * Captions of the views a contact sheet contains (`0°`, `90°`, … or
   * `#2 directional 1.6`), top-left to right. Absent on an ordinary frame; the
   * answer forwards them so the tool can say what the sheet shows.
   */
  readonly tiles?: string[]
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
   *
   * A plain request takes what the user sees. A dry-run request
   * ({@link CaptureRequest.preview}) renders that uncommitted document offscreen
   * instead, and the answer reports the preview document's own surface — that is
   * the whole point of a dry run: the user's stage does not have to move for the
   * model to see the result.
   */
  readonly snapshot: (options: CaptureOptions, request: CaptureRequest) => CaptureFrame
  /**
   * Render an earlier document for a `diffAgainst` look, offscreen, with the
   * current view and the exact size of the frame it is compared with.
   *
   * A 2D baseline is painted at the live canvas's own backing resolution (see
   * `renderBoardFrame`), because that is how the live frame was rasterized before
   * it was downscaled; a 3D baseline is rendered at the exact frame size with the
   * live stage's `viewport`, so id plates land on the same pixels they occupy in
   * the frame they are compared with.
   */
  readonly renderBaseline: (
    board: BoardState,
    options: CaptureOptions,
    camera?: Camera3D,
    size?: { width: number; height: number },
    viewport?: CaptureViewport,
  ) => CaptureFrame
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

/** `2D` / `3D`, for sentences the model repeats. */
function surfaceName(mode: BoardMode): string {
  return mode === '3d' ? '3D' : '2D'
}

/** Read one frame's camera offset from its target, in world units. */
function viewOffset(camera: Camera3D): Vec3 {
  const [x, y, z] = camera.position
  const [targetX, targetY, targetZ] = camera.target
  return [x - targetX, y - targetY, z - targetZ]
}

function vectorLength([x, y, z]: Vec3): number {
  return Math.hypot(x, y, z)
}

function dot([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): number {
  return ax * bx + ay * by + az * bz
}

function clampUnit(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value
}

/**
 * How far two cameras are apart, in the three ways that change pixels.
 * @param current - camera the new frame was taken with.
 * @param baseline - camera recorded with the stored frame.
 * @returns relative distance change, orbit angle in degrees, and fov change.
 */
function cameraDelta(current: Camera3D, baseline: Camera3D): { distance: number; angle: number; fov: number } {
  const offsetA = viewOffset(current)
  const offsetB = viewOffset(baseline)
  const lengthA = vectorLength(offsetA)
  const lengthB = vectorLength(offsetB)
  const longest = Math.max(lengthA, lengthB, 1e-6)
  const distance = Math.abs(lengthA - lengthB) / longest
  const angle = lengthA < 1e-6 || lengthB < 1e-6
    ? 0
    : (Math.acos(clampUnit(dot(offsetA, offsetB) / (lengthA * lengthB))) * 180) / Math.PI
  return { distance, angle, fov: Math.abs(current.fov - baseline.fov) }
}

/** Whether two frames have (nearly) the same aspect ratio. */
function sameAspect(before: { width: number; height: number }, after: { width: number; height: number }): boolean {
  const ratioBefore = before.width / Math.max(1, before.height)
  const ratioAfter = after.width / Math.max(1, after.height)
  return Math.abs(ratioBefore - ratioAfter) / Math.max(ratioBefore, ratioAfter, 1e-6) <= ASPECT_TOLERANCE
}

/**
 * Describe one comparison for the model.
 *
 * A document baseline is re-rendered from the saved document with the current
 * view, the current size and the current viewport, so it is comparable by
 * construction — unless the two documents are of different surfaces, which the
 * tools reject but a stale request may still carry. A stored frame cannot prove
 * it was taken from the same view, so every mismatch that would put unrelated
 * pixels in the red mask is listed in the note instead of being hidden.
 * @param frame - the frame that was just captured.
 * @param baseline - what it was compared with.
 * @returns the diff metadata the answer carries.
 */
function baselineMeta(frame: CaptureFrame, baseline: CaptureBaseline): DiffMeta {
  if (baseline.kind === 'document') {
    if (baseline.board.mode === frame.mode) {
      return {
        label: baseline.label,
        rev: baseline.rev,
        kind: 'document',
        comparable: true,
        note: `Compared with ${baseline.label}, re-rendered from the saved document with the same view,`
          + ' size and viewport, so the changed pixels are content changes.',
      }
    }
    return {
      label: baseline.label,
      rev: baseline.rev,
      kind: 'document',
      comparable: false,
      note: `Approximate comparison with ${baseline.label}: that document shows the`
        + ` ${surfaceName(baseline.board.mode)} surface and this frame shows the ${surfaceName(frame.mode)} one.`,
    }
  }

  const problems: string[] = []
  if (baseline.mode !== frame.mode) {
    problems.push(`it shows the ${surfaceName(baseline.mode)} surface and this frame shows the ${surfaceName(frame.mode)} one`)
  }
  if (frame.mode === '3d') {
    if (baseline.camera === undefined) {
      problems.push('it does not record the camera it was taken with')
    } else if (frame.camera === undefined) {
      problems.push('this frame does not report its camera')
    } else {
      const delta = cameraDelta(frame.camera, baseline.camera)
      if (delta.distance > CAMERA_DISTANCE_TOLERANCE) {
        problems.push(`the camera distance changed by ${(delta.distance * 100).toFixed(1)}%`)
      }
      if (delta.angle > CAMERA_ANGLE_TOLERANCE) problems.push(`the camera was orbited by ${delta.angle.toFixed(1)}°`)
      if (delta.fov > CAMERA_FOV_TOLERANCE) problems.push(`the field of view changed by ${delta.fov.toFixed(1)}°`)
    }
  }
  if (!sameAspect(baseline, frame)) {
    problems.push(`the frame shape changed (${baseline.width}×${baseline.height} → ${frame.width}×${frame.height}),`
      + ' so the stored frame was scaled to fit')
  }
  if (problems.length === 0) {
    return {
      label: baseline.label,
      rev: baseline.rev,
      kind: 'image',
      comparable: true,
      note: `Compared with the stored frame ${baseline.label}, taken with the same`
        + ` ${frame.mode === '3d' ? 'camera, size and surface' : 'size and surface'},`
        + ' so the changed pixels are content changes.',
    }
  }
  return {
    label: baseline.label,
    rev: baseline.rev,
    kind: 'image',
    comparable: false,
    note: `Approximate comparison with the stored frame ${baseline.label}: ${problems.join('; ')}.`,
  }
}

/**
 * Compare the fresh frame with the request's baseline.
 *
 * A document baseline is re-rendered here (the panel never reads the global
 * board state behind the cache), at the current frame's exact size — and, for 3D,
 * with the live stage's viewport, which is what makes an `ids` overlay land on the
 * same pixels in both pictures so the diff reports content changes only. An image
 * baseline is handed to `diff.ts` as it is and only labelled with what is known
 * about it.
 * @param frame - the frame that was just captured.
 * @param baseline - the earlier document or stored frame.
 * @param options - the options the frame was rendered with, so the baseline shows
 *   the same overlays as the picture it is compared with.
 * @param render - the offscreen baseline renderer of the mounted surface.
 * @returns the composed sheet and its numbers.
 */
async function diffAgainst(
  frame: CaptureFrame,
  baseline: CaptureBaseline,
  options: CaptureOptions,
  render: CaptureSource['renderBaseline'],
): Promise<DiffResult> {
  const meta = baselineMeta(frame, baseline)
  if (baseline.kind === 'image') {
    const stored: CaptureFrame = {
      png: baseline.png,
      width: baseline.width,
      height: baseline.height,
      mode: baseline.mode,
      ...(baseline.camera === undefined ? {} : { camera: baseline.camera }),
    }
    return diffFrames(stored, frame, meta)
  }
  const before = render(
    baseline.board,
    options,
    frame.camera,
    { width: frame.width, height: frame.height },
    frame.viewport,
  )
  return diffFrames(before, frame, meta)
}

/**
 * The answer for a captured frame: the frame itself, plus the diff sheet when the
 * request carried a baseline and the preview flag when it rendered a dry run.
 * @param request - the request being answered.
 * @param frame - its frame (the preview document's, when the request had one).
 * @param render - the offscreen baseline renderer of the mounted surface.
 * @returns the answer body, ready to POST; throws when the baseline cannot be read.
 */
async function frameAnswer(
  request: CaptureRequest,
  frame: CaptureFrame,
  render: CaptureSource['renderBaseline'],
): Promise<CaptureAnswer> {
  const answer: CaptureAnswer = {
    requestId: request.id,
    png: frame.png,
    width: frame.width,
    height: frame.height,
    mode: frame.mode,
    ...(frame.camera === undefined ? {} : { camera: frame.camera }),
    ...(frame.viewport === undefined ? {} : { viewport: frame.viewport }),
    ...(request.preview === undefined ? {} : { preview: true }),
    // A 3D contact sheet answers with one PNG plus the captions of its views;
    // the frame carries them, the answer has to forward them.
    ...(frame.tiles === undefined || frame.tiles.length === 0 ? {} : { tiles: frame.tiles }),
  }
  const baseline = request.baseline
  if (baseline === undefined) return answer
  const compared = await diffAgainst(frame, baseline, request.options, render)
  // The sheet replaces the picture; the camera and viewport stay the live
  // stage's, because they describe where the user is looking, not the sheet. Its
  // captions replace the frame's, which a diff request never has.
  return {
    ...answer,
    png: compared.png,
    width: compared.width,
    height: compared.height,
    diff: compared.diff,
    tiles: compared.tiles,
  }
}

/** The error answer for a request that could not be answered. */
function failed(requestId: string, error: string, mode: BoardMode): CaptureAnswer {
  return { requestId, png: '', width: 0, height: 0, mode, error }
}

/** The message of a thrown value, with a usable fallback. */
function failureOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'the board could not be captured'
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
 * them with a frame of the surface the request asks for.
 *
 * The loop is deliberately serial: a tick only schedules the next one after the
 * request it found has been captured and submitted, so at most one capture exists
 * at a time. `AbortController` covers the in-flight poll on hide and on unmount;
 * the answer POST is intentionally not aborted with it, because the frame the
 * model is waiting for is worth delivering even if the tab closes mid-round-trip.
 * @param source - session identity, what is on screen, and the capture callbacks.
 */
export function useCapture(source: CaptureSource): void {
  const { sessionId, surface, visible, ready, revision } = source
  /** Latest capture callback: a draw must not re-arm the poll. */
  const snapshot = useRef(source.snapshot)
  snapshot.current = source.snapshot
  /** Latest offscreen baseline renderer, for the same reason. */
  const renderBaseline = useRef(source.renderBaseline)
  renderBaseline.current = source.renderBaseline
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
        let body: CaptureAnswer
        try {
          // The whole request reaches the surface: a preview document and a diff
          // baseline are rendered offscreen, a plain look is taken as before.
          const frame = snapshot.current(request.options, request)
          body = await frameAnswer(request, frame, renderBaseline.current)
        } catch (error) {
          body = failed(request.id, failureOf(error), reported.current)
        }
        await submit(body)
      } finally {
        answering.delete(request.id)
      }
    }

    /**
     * Answer a request this build cannot read. The model gets the reason instead
     * of a timeout: a malformed baseline is a bug on the Host side of the
     * contract, and the sentence is the only way it reaches a log.
     */
    const reject = async (rejected: RejectedRequest): Promise<void> => {
      answering.add(rejected.requestId)
      try {
        await submit(failed(rejected.requestId, rejected.error, rejected.mode))
      } finally {
        answering.delete(rejected.requestId)
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
        const parsed = parseRequest(payload)
        if (parsed === undefined) return
        if (parsed.kind === 'rejected') {
          if (!answering.has(parsed.requestId)) await reject(parsed)
          return
        }
        if (answering.has(parsed.request.id)) return
        await answer(parsed.request)
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

/** Result of reading one optional wire value: it, or the sentence to answer with. */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

/** A request whose optional payload this build cannot use, with the reason. */
interface RejectedRequest {
  readonly kind: 'rejected'
  readonly requestId: string
  readonly mode: BoardMode
  readonly error: string
}

/** One poll body, read defensively: a request, or one this build must refuse. */
type ParsedPoll = { readonly kind: 'request'; readonly request: CaptureRequest } | RejectedRequest

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a finite 3-tuple, or undefined when it is not one. */
function parseVec3(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const [x, y, z] = value as unknown[]
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined
  if (typeof y !== 'number' || !Number.isFinite(y)) return undefined
  if (typeof z !== 'number' || !Number.isFinite(z)) return undefined
  return [x, y, z]
}

/** Read one camera, or undefined when it is not a usable framing. */
function parseCamera(value: unknown): Camera3D | undefined {
  if (!isRecord(value)) return undefined
  const position = parseVec3(value['position'])
  const target = parseVec3(value['target'])
  const fov = value['fov']
  if (position === undefined || target === undefined) return undefined
  if (typeof fov !== 'number' || !Number.isFinite(fov) || fov <= 0) return undefined
  return { position, target, fov }
}

/**
 * Read the optional `baseline` field.
 *
 * Both kinds are validated down to what the renderers and the comparison touch:
 * a document baseline must be a board document (so it can be re-rendered), an
 * image baseline must carry real PNG data, a usable size and its surface. What
 * is missing cannot be guessed, so the request is refused with a sentence
 * instead of producing a diff against nothing.
 * @param value - raw `baseline` field; undefined when the request has none.
 * @returns the baseline, undefined, or the error to answer with.
 */
function parseBaseline(value: unknown): Parsed<CaptureBaseline | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isRecord(value)) return { ok: false, error: 'the diff baseline is neither a document nor a stored frame' }
  const label = value['label']
  const revision = value['rev']
  if (typeof label !== 'string' || label === '') return { ok: false, error: 'the diff baseline has no label' }
  if (typeof revision !== 'number' || !Number.isFinite(revision)) {
    return { ok: false, error: 'the diff baseline has no revision' }
  }
  const rev = Math.trunc(revision)
  if (value['kind'] === 'document') {
    const board = value['board']
    if (!isBoardState(board)) return { ok: false, error: 'the diff baseline document is not a usable board document' }
    return { ok: true, value: { kind: 'document', rev, label, board } }
  }
  if (value['kind'] === 'image') {
    const png = value['png']
    const width = value['width']
    const height = value['height']
    const mode = value['mode']
    if (typeof png !== 'string' || png === '') return { ok: false, error: 'the baseline frame has no image data' }
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
      return { ok: false, error: 'the baseline frame has no usable width' }
    }
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
      return { ok: false, error: 'the baseline frame has no usable height' }
    }
    if (mode !== '2d' && mode !== '3d') return { ok: false, error: 'the baseline frame does not name its surface' }
    const image: CaptureBaseline = {
      kind: 'image',
      rev,
      label,
      png,
      width: Math.round(width),
      height: Math.round(height),
      mode,
    }
    const camera = parseCamera(value['camera'])
    if (camera !== undefined) image.camera = camera
    return { ok: true, value: image }
  }
  return { ok: false, error: 'the diff baseline is neither a document nor a stored frame' }
}

/**
 * Read the optional `preview` field of a dry run.
 *
 * A preview is a whole document — the panel renders it as if it had been
 * committed — so a value that only looks like a board is refused with a sentence
 * rather than drawn as an empty page.
 * @param value - raw `preview` field; undefined when the request has none.
 * @returns the document, undefined, or the error to answer with.
 */
function parsePreview(value: unknown): Parsed<BoardState | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isBoardState(value)) return { ok: false, error: 'the dry-run preview is not a usable board document' }
  return { ok: true, value }
}

/**
 * Read one poll response into a request, and say why when it cannot be used.
 *
 * The route is remote input like any other, so every field the hook touches is
 * checked here even though the Host is this plugin's own code: a malformed
 * envelope is a quiet miss, while a well-addressed request with an unusable
 * baseline or preview is answered with a readable error — the loop never throws
 * out of a poll and never leaves the model waiting for a frame that cannot exist.
 * @param payload - parsed JSON body, or undefined when the body was not JSON.
 * @returns the request, the rejection, or undefined when the envelope is malformed.
 */
function parseRequest(payload: unknown): ParsedPoll | undefined {
  if (!isRecord(payload)) return undefined
  const request = payload['request']
  if (!isRecord(request)) return undefined
  const id = request['id']
  const sessionId = request['sessionId']
  if (typeof id !== 'string' || id === '' || typeof sessionId !== 'string') return undefined
  const mode: BoardMode = request['mode'] === '3d' ? '3d' : '2d'
  const baseline = parseBaseline(request['baseline'])
  if (!baseline.ok) return { kind: 'rejected', requestId: id, mode, error: baseline.error }
  const preview = parsePreview(request['preview'])
  if (!preview.ok) return { kind: 'rejected', requestId: id, mode, error: preview.error }
  const rev = request['rev']
  const parsed: CaptureRequest = {
    id,
    sessionId,
    rev: typeof rev === 'number' && Number.isFinite(rev) ? rev : 0,
    mode,
    options: parseOptions(request['options']),
  }
  if (baseline.value !== undefined) parsed.baseline = baseline.value
  if (preview.value !== undefined) parsed.preview = preview.value
  return { kind: 'request', request: parsed }
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
  if (debug === 'lit' || debug === 'shadow-only' || debug === 'per-light') options.debug = debug
  const angles = record['angles']
  if (angles === 'default' || angles === 'turntable') options.angles = angles
  const maxWidth = record['maxWidth']
  if (typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0) options.maxWidth = maxWidth
  return options
}
