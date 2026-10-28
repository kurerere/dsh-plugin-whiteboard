/**
 * The labels a capture paints over its frame.
 *
 * `whiteboard_look` may ask for `overlay: 'ids'`. The model then sees the picture
 * and the element ids in the same image, which is what lets it say "move `b2`
 * left" about something it drew two turns ago instead of guessing from geometry.
 *
 * These helpers only ever touch a **copy** of the stage: the capture pipeline
 * copies the live 2D canvas (or the WebGL frame) onto an offscreen canvas first,
 * so labels cannot flash on screen, cannot disturb the appear animation, and
 * leave the live canvas — and therefore 「导出」 — byte-identical to what the user
 * sees.
 *
 * Sizes run through one `unit`, output pixels per CSS pixel. A label drawn at
 * `12 * unit` therefore stays ~12 CSS pixels whether the frame came from a 2×
 * backing store or was downscaled to `maxWidth`, instead of shrinking with the
 * picture.
 */

import { BOARD_EXTENT, type Shape2D } from '../scene.ts'
import { shapeBounds } from './board.ts'
import { fontStack } from './palette.ts'

/** Label type size in CSS pixels. */
const LABEL_SIZE = 12

/**
 * Label plate: near-opaque ink with a white glyph. It is deliberately not a
 * theme token — the plate has to read over a light drawing, a dark drawing, and
 * a 3D object of any color, and the theme's own label color would vanish into
 * half of those.
 */
const LABEL_PLATE = 'rgba(15, 17, 21, 0.76)'

/** Label text paint. */
const LABEL_TEXT = '#ffffff'

/**
 * Trace a rounded rectangle into a path.
 * @param path - path to append to.
 * @param x - left edge, in output pixels.
 * @param y - top edge, in output pixels.
 * @param width - plate width, in output pixels.
 * @param height - plate height, in output pixels.
 * @param radius - corner radius, clamped to half the shorter side.
 */
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
 * Paint one id label centered on a point.
 * @param context - context of the capture output; never the live stage.
 * @param x - center x, in output pixels.
 * @param y - center y, in output pixels.
 * @param id - element id to print.
 * @param unit - output pixels per CSS pixel, which sizes the label.
 */
export function drawIdLabel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  id: string,
  unit: number,
): void {
  const size = Math.max(9, LABEL_SIZE * unit)
  const paddingX = size * 0.42
  const paddingY = size * 0.26
  context.save()
  context.font = `600 ${size}px ${fontStack()}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const width = context.measureText(id).width + paddingX * 2
  const height = size + paddingY * 2
  const path = new Path2D()
  roundedRect(path, x - width / 2, y - height / 2, width, height, size * 0.34)
  context.fillStyle = LABEL_PLATE
  context.fill(path)
  context.fillStyle = LABEL_TEXT
  context.fillText(id, x, y)
  context.restore()
}

/**
 * Label every 2D shape at the center of its bounding box.
 *
 * The canvas document is a fixed {@link BOARD_EXTENT}-unit square, so the whole
 * overlay is one uniform scale from document units to output pixels. Shapes share
 * the same scale as the drawing they sit on, which is what keeps a label on the
 * object the model named even when the panel is wide or narrow.
 * @param context - context of the capture output copy.
 * @param shapes - shapes of the board document, in draw order.
 * @param pixels - square output size of the canvas layer, in pixels.
 * @param unit - output pixels per CSS pixel, which sizes the labels.
 */
export function overlayShapeIds(
  context: CanvasRenderingContext2D,
  shapes: readonly Shape2D[],
  pixels: number,
  unit: number,
): void {
  if (pixels <= 0) return
  const scale = pixels / BOARD_EXTENT
  for (const shape of shapes) {
    const bounds = shapeBounds(shape)
    // A `path` shape has no cheap bounds (`Path2D` exposes none), so it stays
    // unlabeled rather than getting a plate at a guessed position.
    if (bounds === undefined) continue
    drawIdLabel(context, (bounds.x + bounds.w / 2) * scale, (bounds.y + bounds.h / 2) * scale, shape.id, unit)
  }
}
