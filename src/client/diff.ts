/**
 * The before / after / changed sheet of a `diffAgainst` look.
 *
 * A diff is a *picture* question — "did the board change, and where?" — so it is
 * answered with one image the model can read at a glance: the baseline frame, the
 * new frame, and the new frame with everything that moved lifted out of a dimmed
 * copy and boxed. The numbers travel beside the sheet ({@link CaptureDiff}), so a
 * caption is never the only evidence.
 *
 * Two properties matter more than the pixel math:
 *
 * - **Nothing here touches a stage.** Both frames arrive as PNGs, are decoded with
 *   `createImageBitmap`, and the sheet is composed on plain 2D canvases. A diff
 *   therefore cannot flash, resize or redraw the board the user is looking at.
 * - **The comparison is honest about its own quality.** The thresholds below
 *   absorb antialiasing, not a different view: when the baseline was taken with
 *   another camera, surface or frame shape, the caller says so through
 *   `meta.comparable` / `meta.note` and the sheet is still useful, just labelled
 *   approximate.
 *
 * The noise threshold is per channel (RGB only): a pixel counts as changed when
 * any channel moved by more than {@link NOISE_THRESHOLD}, which ignores a
 * one-unit rounding wobble from scaling a baseline onto a slightly different
 * frame size while keeping a genuine tint change visible.
 */

import type { CaptureDiff } from '../shared.ts'
import type { CaptureFrame } from './capture.ts'
import { fontStack, resolvePaint, surfacePaint, withAlpha } from './palette.ts'
import { composeSheet, type SheetTile } from './sheet.ts'

/** Per-channel RGB delta that still counts as the same pixel. */
const NOISE_THRESHOLD = 8

/** Smallest and largest total sheet width, in pixels (three columns). */
const SHEET_MIN_WIDTH = 720
const SHEET_MAX_WIDTH = 1800

/** Output pixels of padding around the changed bounding box. */
const BOUNDS_PAD = 2

/** Opacity of the after frame inside the `changed` panel. */
const AFTER_DIM = 0.42

/** One composed diff: the sheet plus the numbers that describe it. */
export interface DiffResult {
  /** Bare base64 PNG of the three-panel sheet. */
  readonly png: string
  /** Sheet width in output pixels. */
  readonly width: number
  /** Sheet height in output pixels. */
  readonly height: number
  /** Pixel comparison, with `bounds` in **after-frame** pixels. */
  readonly diff: CaptureDiff
  /** Panel captions, suitable for `CaptureAnswer.tiles`. */
  readonly tiles: string[]
}

/** Caller-supplied facts about the comparison that this module cannot know. */
export interface DiffMeta {
  /** Label the model used (`previous`, `rev:12`, `frame:ab12cd34`). */
  readonly label: string
  /** Revision the baseline belongs to. */
  readonly rev: number
  /** Whether the baseline was re-rendered from a document or decoded from a PNG. */
  readonly kind: 'document' | 'image'
  /** False when camera / surface / frame shape make the comparison approximate. */
  readonly comparable: boolean
  /** One sentence explaining what was compared and whether to trust it. */
  readonly note: string
}

/** A canvas plus the 2D context every caller here needs. */
interface Surface {
  readonly canvas: HTMLCanvasElement
  readonly context: CanvasRenderingContext2D
}

/** Changed pixels, their box, and a red mask at the after frame's resolution. */
interface Compared {
  readonly changedPixels: number
  readonly changedRatio: number
  readonly bounds: { x: number; y: number; width: number; height: number } | undefined
  readonly mask: HTMLCanvasElement
}

function surfaceOf(width: number, height: number): Surface {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('cannot create a 2D context for the diff')
  return { canvas, context }
}

/**
 * Encode a canvas as a bare base64 PNG.
 *
 * Local on purpose: `capture.ts` imports this module for its diff answer, so the
 * sheets here must not import that module back at runtime.
 * @param canvas - canvas to encode.
 * @returns the base64 payload, without a `data:image/png;base64,` prefix.
 */
function base64Png(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/png')
  const comma = url.indexOf(',')
  return comma === -1 ? url : url.slice(comma + 1)
}

/**
 * Decode a captured PNG into a bitmap.
 *
 * The answer route accepts a bare base64 payload or a `data:` URL, and a stored
 * frame may carry either, so both forms are read here.
 * @param png - bare base64 PNG or `data:image/png;base64,…` URL.
 * @param label - what the frame is, for a readable failure.
 * @returns the decoded bitmap, which the caller must close.
 */
async function decode(png: string, label: string): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') throw new Error('this browser cannot decode images for a diff')
  const comma = png.indexOf(',')
  const payload = png.startsWith('data:') && comma !== -1 ? png.slice(comma + 1) : png
  if (payload === '') throw new Error(`${label} has no image data`)
  let bytes: Uint8Array<ArrayBuffer>
  try {
    const binary = globalThis.atob(payload)
    const buffer = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) buffer[index] = binary.charCodeAt(index)
    bytes = buffer
  } catch {
    throw new Error(`${label} is not readable base64 PNG data`)
  }
  try {
    return await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  } catch {
    throw new Error(`${label} is not a readable PNG image`)
  }
}

/**
 * Draw one frame onto a fresh opaque canvas at a target size.
 * @param source - decoded frame.
 * @param width - target width in pixels.
 * @param height - target height in pixels.
 * @returns the canvas, backgrounded with the board surface.
 */
function drawFrame(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const { canvas, context } = surfaceOf(width, height)
  context.fillStyle = surfacePaint()
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Read a canvas back as pixels, for the comparison loop. */
function pixelsOf(canvas: HTMLCanvasElement): ImageData {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('cannot read the diff pixels back')
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

/**
 * Compare two equally sized rasters.
 *
 * One pass over the pixels yields all three outputs: the changed count, the
 * bounding box in after-frame pixels, and an alpha mask that later becomes the
 * red overlay. The mask stores only alpha; its color is discarded by the
 * `source-in` fill that recolors it from the palette.
 * @param before - baseline pixels, already scaled to the after size.
 * @param after - new frame pixels.
 * @returns the counts, the box (absent when nothing changed) and the mask.
 */
function compare(before: ImageData, after: ImageData): Compared {
  const width = after.width
  const height = after.height
  const mask = surfaceOf(width, height)
  const maskData = mask.context.createImageData(width, height)
  const maskPixels = maskData.data
  const next = after.data
  const previous = before.data
  let changedPixels = 0
  let left = width
  let top = height
  let right = -1
  let bottom = -1

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const index = (row + x) * 4
      const red = (next[index] ?? 0) - (previous[index] ?? 0)
      const green = (next[index + 1] ?? 0) - (previous[index + 1] ?? 0)
      const blue = (next[index + 2] ?? 0) - (previous[index + 2] ?? 0)
      if (
        (red < 0 ? -red : red) <= NOISE_THRESHOLD
        && (green < 0 ? -green : green) <= NOISE_THRESHOLD
        && (blue < 0 ? -blue : blue) <= NOISE_THRESHOLD
      ) continue
      changedPixels += 1
      if (x < left) left = x
      if (y < top) top = y
      if (x > right) right = x
      if (y > bottom) bottom = y
      maskPixels[index + 3] = 255
    }
  }

  mask.context.putImageData(maskData, 0, 0)
  // Recolor the mask from the palette: `source-in` keeps the alpha silhouette
  // built above and takes the fill for every covered pixel.
  mask.context.globalCompositeOperation = 'source-in'
  mask.context.fillStyle = resolvePaint('red')
  mask.context.fillRect(0, 0, width, height)
  mask.context.globalCompositeOperation = 'source-over'

  if (changedPixels === 0) {
    return { changedPixels: 0, changedRatio: 0, bounds: undefined, mask: mask.canvas }
  }
  const x = Math.max(0, left - BOUNDS_PAD)
  const y = Math.max(0, top - BOUNDS_PAD)
  const w = Math.min(width - x, right - left + 1 + BOUNDS_PAD * 2)
  const h = Math.min(height - y, bottom - top + 1 + BOUNDS_PAD * 2)
  return {
    changedPixels,
    changedRatio: changedPixels / (width * height),
    bounds: { x, y, width: w, height: h },
    mask: mask.canvas,
  }
}

/** Trace a rounded rectangle into a path. */
function roundedRect(path: Path2D, x: number, y: number, width: number, height: number, radius: number): void {
  const corner = Math.max(0, Math.min(radius, Math.min(width, height) / 2))
  if (corner <= 0) {
    path.rect(x, y, width, height)
    return
  }
  path.moveTo(x + corner, y)
  path.lineTo(x + width - corner, y)
  path.arcTo(x + width, y, x + width, y + corner, corner)
  path.lineTo(x + width, y + height - corner)
  path.arcTo(x + width, y + height, x + width - corner, y + height, corner)
  path.lineTo(x + corner, y + height)
  path.arcTo(x, y + height, x, y + height - corner, corner)
  path.lineTo(x, y + corner)
  path.arcTo(x, y, x + corner, y, corner)
  path.closePath()
}

/**
 * Paint one verdict badge in the bottom-left corner of a panel.
 *
 * The plate is near-opaque black with white glyphs in both palettes, like the id
 * labels a capture can paint: the badge has to read over a light drawing, a dark
 * drawing, and the dimmed frame beneath it, none of which share a theme token
 * that survives all three.
 * @param context - panel context, already in output pixels.
 * @param width - panel width in pixels.
 * @param height - panel height in pixels.
 * @param text - the verdict (`2.3% changed`, `no visible change`).
 */
function drawBadge(context: CanvasRenderingContext2D, width: number, height: number, text: string): void {
  const size = Math.max(12, Math.round(Math.min(width, height) / 34))
  const paddingX = size * 0.55
  const paddingY = size * 0.3
  context.save()
  context.font = `600 ${size}px ${fontStack()}`
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  const plateWidth = context.measureText(text).width + paddingX * 2
  const plateHeight = size + paddingY * 2
  const x = size
  const y = height - plateHeight - size
  const path = new Path2D()
  roundedRect(path, x, y, Math.min(plateWidth, width - x * 2), plateHeight, plateHeight / 2)
  context.fillStyle = withAlpha(resolvePaint('black'), 0.78)
  context.fill(path)
  context.fillStyle = resolvePaint('white')
  context.fillText(text, x + paddingX, y + plateHeight / 2)
  context.restore()
}

/**
 * Build the `changed` panel: the new frame dimmed, changed pixels in red, and the
 * box they occupy.
 * @param after - the new frame, at its own size.
 * @param compared - counts, box and mask from {@link compare}.
 * @param changed - whether anything changed, which picks the badge text.
 * @returns the panel canvas.
 */
function changedPanel(after: HTMLCanvasElement, compared: Compared, changed: boolean): HTMLCanvasElement {
  const { canvas, context } = surfaceOf(after.width, after.height)
  context.fillStyle = surfacePaint()
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.globalAlpha = AFTER_DIM
  context.drawImage(after, 0, 0, canvas.width, canvas.height)
  context.globalAlpha = 1
  context.drawImage(compared.mask, 0, 0)
  const bounds = compared.bounds
  if (bounds !== undefined) {
    const box = new Path2D()
    box.rect(bounds.x, bounds.y, bounds.width, bounds.height)
    // A light under-stroke keeps the box visible on top of red pixels and on a
    // dark scene alike; the red stroke is the actual signal.
    context.lineWidth = 5
    context.strokeStyle = withAlpha(resolvePaint('white'), 0.85)
    context.stroke(box)
    context.lineWidth = 3
    context.strokeStyle = resolvePaint('red')
    context.stroke(box)
  }
  const percent = `${(compared.changedRatio * 100).toFixed(compared.changedRatio > 0 && compared.changedRatio < 0.01 ? 2 : 1)}%`
  drawBadge(context, canvas.width, canvas.height, changed ? `${percent} changed` : 'no visible change')
  return canvas
}

/**
 * Compose the before / after / changed sheet for one comparison.
 *
 * The before frame is scaled to the after size before comparing, so a baseline
 * captured at another output size still lines up; `meta.comparable` and
 * `meta.note` carry the caller's verdict about how much that scaling (and any
 * camera change) costs.
 * @param before - baseline frame (document re-render or stored PNG).
 * @param after - the frame just captured.
 * @param meta - label, revision, kind and the caller's comparability verdict.
 * @returns the sheet PNG, its size, the diff numbers and the panel captions.
 */
export async function diffFrames(
  before: CaptureFrame,
  after: CaptureFrame,
  meta: DiffMeta,
): Promise<DiffResult> {
  const width = Math.max(1, Math.round(after.width))
  const height = Math.max(1, Math.round(after.height))
  // Decoded one at a time: a bitmap is not garbage-collected on a failed build,
  // so the first one is closed here when the second cannot be read.
  const previous = await decode(before.png, 'the baseline frame')
  let next: ImageBitmap
  try {
    next = await decode(after.png, 'the current frame')
  } catch (error) {
    previous.close()
    throw error
  }
  try {
    const beforeCanvas = drawFrame(previous, width, height)
    const afterCanvas = drawFrame(next, width, height)
    const compared = compare(pixelsOf(beforeCanvas), pixelsOf(afterCanvas))
    const changed = compared.changedPixels > 0
    const panels: SheetTile[] = [
      { canvas: beforeCanvas, label: `before · ${meta.label}` },
      { canvas: afterCanvas, label: 'after' },
      { canvas: changedPanel(afterCanvas, compared, changed), label: changed ? 'changed' : 'no change' },
    ]
    const sheet = composeSheet(panels, {
      columns: 3,
      width: Math.min(SHEET_MAX_WIDTH, Math.max(SHEET_MIN_WIDTH, width * 3)),
      title: `Diff vs ${meta.label}`,
    })
    const diff: CaptureDiff = {
      kind: meta.kind,
      label: meta.label,
      rev: meta.rev,
      changedPixels: compared.changedPixels,
      changedRatio: compared.changedRatio,
      ...(compared.bounds === undefined ? {} : { bounds: compared.bounds }),
      comparable: meta.comparable,
      note: meta.note,
    }
    return {
      png: base64Png(sheet.canvas),
      width: sheet.canvas.width,
      height: sheet.canvas.height,
      diff,
      tiles: sheet.labels,
    }
  } finally {
    previous.close()
    next.close()
  }
}
