/**
 * The 2D surface of the board: one `<canvas>` that draws the whole
 * {@link Canvas2D} document in a fixed logical `0..1000` square.
 *
 * The page *frame* (surface, corner radius, hairline border, elevation shadow)
 * is DOM — it inherits the shipped composer/guide-card material for free and
 * keeps the canvas free of border and shadow work. The canvas fills that square
 * exactly, so its transform is a single uniform scale: one logical unit is
 * `edge / 1000` device pixels regardless of the panel's shape, which is what
 * makes a drawing look the same in a wide and a narrow sidebar.
 *
 * Every shape kind, style channel (`fill`, `stroke`, `strokeWidth`, `opacity`,
 * `dash`, `shadow`) and the model's palette tokens are implemented here. New
 * shape ids fade and grow in over {@link APPEAR_MS} so a tool call that adds
 * five shapes reads as one deliberate gesture rather than a jump cut.
 *
 * {@link renderBoardFrame} is the same painter without a stage and without the
 * animation: it draws the whole document into an offscreen canvas, which is what
 * a dry-run preview and a `diffAgainst` baseline need.
 */

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { BOARD_EXTENT, type Canvas2D, type Paint, type Shape2D } from '../scene.ts'
import type { CaptureOptions } from '../shared.ts'
import { type Bounds, shapeBounds } from './board.ts'
import { captureWidthLimit, encodePng, type CaptureFrame } from './capture.ts'
import { overlayShapeIds } from './overlay.ts'
import {
  fontStack, gridPaint, resolvePaint, shadowPaint, subscribeTheme, surfacePaint, TEXT_WEIGHT,
} from './palette.ts'

/** Appear animation length of one new shape, in milliseconds. */
const APPEAR_MS = 180

/** Dot grid pitch and dot radius, in logical units. */
const GRID_STEP = 25
const GRID_DOT = 1.15

/** Default outline of a shape whose style names none. */
const DEFAULT_STROKE_WIDTH = 3

/** Default edge of a static frame (preview / diff baseline), in pixels. */
const STATIC_EDGE = 1024

/** Most a diff baseline is rendered past the frame size it will be scaled to. */
const BASELINE_SCALE_LIMIT = 3

/**
 * Output pixels per CSS pixel used to size id labels on a static frame.
 *
 * A static render has no measured stage, so labels are sized as they are on a 2×
 * display, which is what a modern panel reports through `devicePixelRatio`. At
 * equal output size that matches the label scale of a live capture, so a diff
 * baseline's plates line up with the current frame's instead of lighting up as
 * changed pixels.
 */
const STATIC_LABEL_UNIT = 2

/** Props of the 2D surface. */
export interface Board2DProps {
  /** The surface document. */
  canvas: Canvas2D
  /** Edge length of the square page, in CSS pixels. */
  size: number
  /** Rendered inside the page while the board is empty. */
  hint?: ReactNode
}

/** One shape's eased appear state. */
interface Appear {
  /** Start timestamp, or `NEGATIVE_INFINITY` for shapes that must not animate. */
  readonly start: number
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function easeOut(progress: number): number {
  const inverse = 1 - progress
  return 1 - inverse * inverse * inverse
}

/** Lazily built dot-grid geometry (logical units, independent of panel size). */
let gridPath: Path2D | undefined

function gridGeometry(): Path2D | undefined {
  if (typeof Path2D === 'undefined') return undefined
  if (gridPath !== undefined) return gridPath
  const path = new Path2D()
  for (let x = GRID_STEP; x < BOARD_EXTENT; x += GRID_STEP) {
    for (let y = GRID_STEP; y < BOARD_EXTENT; y += GRID_STEP) {
      path.moveTo(x + GRID_DOT, y)
      path.arc(x, y, GRID_DOT, 0, Math.PI * 2)
    }
  }
  gridPath = path
  return path
}

function roundedRect(path: Path2D, x: number, y: number, width: number, height: number, radius: number): void {
  const limit = Math.min(Math.abs(width), Math.abs(height)) / 2
  const corner = Math.max(0, Math.min(radius, limit))
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

/** Cache of parsed `path` shape data, keyed by the raw `d`. */
const pathCache = new Map<string, Path2D>()

function parsedPath(data: string): Path2D | undefined {
  if (typeof Path2D === 'undefined' || data === '') return undefined
  const cached = pathCache.get(data)
  if (cached !== undefined) return cached
  let path: Path2D | undefined
  try {
    path = new Path2D(data)
  } catch {
    return undefined
  }
  if (pathCache.size > 240) pathCache.clear()
  pathCache.set(data, path)
  return path
}

/** Apply the stroke/fill/opacity style channels shared by every shape. */
function applyStyle(context: CanvasRenderingContext2D, shape: Shape2D, alpha: number): void {
  context.globalAlpha = clamp01(num(shape.opacity, 1)) * alpha
  context.lineWidth = Math.max(0.4, num(shape.strokeWidth, DEFAULT_STROKE_WIDTH))
  context.lineCap = 'round'
  context.lineJoin = 'round'
  const dash = Array.isArray(shape.dash) ? shape.dash.filter(value => typeof value === 'number' && value > 0) : []
  context.setLineDash(dash)
  if (shape.shadow === true) {
    context.shadowColor = shadowPaint()
    context.shadowBlur = 22
    context.shadowOffsetY = 7
  } else {
    context.shadowColor = 'transparent'
    context.shadowBlur = 0
    context.shadowOffsetY = 0
  }
}

function paintPath(
  context: CanvasRenderingContext2D,
  path: Path2D,
  fill: Paint | null | undefined,
  stroke: Paint | null | undefined,
): void {
  if (fill !== null && fill !== undefined) {
    context.fillStyle = resolvePaint(fill)
    context.fill(path)
  }
  if (stroke !== null) {
    context.strokeStyle = resolvePaint(stroke ?? 'ink')
    context.stroke(path)
  }
}

/** Arrow head geometry: a filled triangle at one end of the shaft. */
function arrowHead(
  context: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  fromX: number,
  fromY: number,
  size: number,
  color: Paint | null | undefined,
): void {
  const dx = tipX - fromX
  const dy = tipY - fromY
  const length = Math.hypot(dx, dy)
  if (length < 0.0001) return
  const angle = Math.atan2(dy, dx)
  const spread = 0.42
  const wing = size
  context.beginPath()
  context.moveTo(tipX, tipY)
  context.lineTo(tipX - wing * Math.cos(angle - spread), tipY - wing * Math.sin(angle - spread))
  context.lineTo(tipX - wing * Math.cos(angle + spread), tipY - wing * Math.sin(angle + spread))
  context.closePath()
  context.fillStyle = resolvePaint(color ?? 'ink')
  context.fill()
}

function drawArrow(context: CanvasRenderingContext2D, shape: Extract<Shape2D, { kind: 'arrow' }>): void {
  const x1 = num(shape.x1)
  const y1 = num(shape.y1)
  const x2 = num(shape.x2)
  const y2 = num(shape.y2)
  const curve = num(shape.curve, 0)
  const midX = (x1 + x2) / 2
  const midY = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy) || 1
  const controlX = midX - (dy / length) * curve
  const controlY = midY + (dx / length) * curve
  const shaft = new Path2D()
  shaft.moveTo(x1, y1)
  if (Math.abs(curve) < 0.001) shaft.lineTo(x2, y2)
  else shaft.quadraticCurveTo(controlX, controlY, x2, y2)
  const width = Math.max(0.4, num(shape.strokeWidth, DEFAULT_STROKE_WIDTH))
  const head = Math.max(10, width * 3.6)
  const headStyle = shape.head ?? 'end'
  context.strokeStyle = resolvePaint(shape.stroke ?? 'ink')
  context.stroke(shaft)
  // Heads are filled with the line's own paint so a dashed arrow still reads.
  if (headStyle === 'end' || headStyle === 'both') arrowHead(context, x2, y2, controlX, controlY, head, shape.stroke ?? 'ink')
  if (headStyle === 'both') arrowHead(context, x1, y1, controlX, controlY, head, shape.stroke ?? 'ink')
}

function drawPolyline(context: CanvasRenderingContext2D, shape: Extract<Shape2D, { kind: 'polyline' }>): void {
  const points = Array.isArray(shape.points) ? shape.points : []
  if (points.length < 2) return
  const path = new Path2D()
  const [first] = points
  if (first === undefined) return
  path.moveTo(num(first[0]), num(first[1]))
  if (shape.smooth === true && points.length > 2) {
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index]
      const next = points[index + 1]
      if (point === undefined || next === undefined) continue
      const midX = (num(point[0]) + num(next[0])) / 2
      const midY = (num(point[1]) + num(next[1])) / 2
      path.quadraticCurveTo(num(point[0]), num(point[1]), midX, midY)
    }
    const last = points[points.length - 1]
    const beforeLast = points[points.length - 2]
    if (last !== undefined && beforeLast !== undefined) path.lineTo(num(last[0]), num(last[1]))
  } else {
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index]
      if (point === undefined) continue
      path.lineTo(num(point[0]), num(point[1]))
    }
  }
  if (shape.closed === true) path.closePath()
  paintPath(context, path, shape.fill, shape.stroke ?? (shape.fill === undefined || shape.fill === null ? 'ink' : null))
}

/** Characters that may break anywhere: CJK ideographs, kana, fullwidth forms. */
const CJK = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/**
 * Split one paragraph into the smallest units a line may break between: a CJK
 * character on its own, a latin word with its trailing space kept on the same
 * unit so justification stays invisible.
 */
function breakUnits(paragraph: string): string[] {
  const units: string[] = []
  let word = ''
  for (const character of paragraph) {
    if (CJK.test(character)) {
      if (word !== '') {
        units.push(word)
        word = ''
      }
      units.push(character)
      continue
    }
    if (character === ' ') {
      units.push(`${word} `)
      word = ''
      continue
    }
    word += character
  }
  if (word !== '') units.push(word)
  return units
}

/** Break one unit that is wider than the whole line into character runs. */
function splitUnit(context: CanvasRenderingContext2D, unit: string, maxWidth: number): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const character of unit) {
    const candidate = piece + character
    if (piece !== '' && context.measureText(candidate).width > maxWidth) {
      pieces.push(piece)
      piece = character
    } else {
      piece = candidate
    }
  }
  if (piece !== '') pieces.push(piece)
  return pieces
}

/** Split one text block into lines that fit `maxWidth`, honouring `\n` and words. */
function wrapLines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (context.measureText(paragraph).width <= maxWidth) {
      lines.push(paragraph)
      continue
    }
    let line = ''
    for (const unit of breakUnits(paragraph)) {
      const candidate = line + unit
      if (line === '' || context.measureText(candidate).width <= maxWidth) {
        if (line === '' && context.measureText(unit).width > maxWidth) {
          const pieces = splitUnit(context, unit, maxWidth)
          for (const piece of pieces.slice(0, -1)) lines.push(piece)
          line = pieces[pieces.length - 1] ?? ''
        } else {
          line = candidate
        }
        continue
      }
      lines.push(line.trimEnd())
      line = unit.trimStart()
    }
    lines.push(line)
  }
  return lines
}

function drawText(context: CanvasRenderingContext2D, shape: Extract<Shape2D, { kind: 'text' }>): void {
  const text = typeof shape.text === 'string' ? shape.text : ''
  if (text === '') return
  const size = Math.max(1, num(shape.size, 22))
  const weight = TEXT_WEIGHT[shape.weight ?? 'regular']
  context.font = `${weight} ${size}px ${fontStack()}`
  context.textAlign = shape.align ?? 'left'
  context.textBaseline = 'top'
  const maxWidth = num(shape.maxWidth, 0)
  const lines = maxWidth > 0 ? wrapLines(context, text, maxWidth) : text.split('\n')
  const lineHeight = size * 1.32
  const total = lines.length * lineHeight
  const x = num(shape.x)
  const y = num(shape.y)
  const baseline = shape.baseline ?? 'top'
  const top = baseline === 'middle' ? y - total / 2 : baseline === 'bottom' ? y - total : y
  const fill = shape.fill ?? 'ink'
  lines.forEach((line, index) => {
    const lineY = top + index * lineHeight
    if (fill !== null) {
      context.fillStyle = resolvePaint(fill)
      context.fillText(line, x, lineY)
    }
    if (shape.stroke !== null && shape.stroke !== undefined) {
      context.strokeStyle = resolvePaint(shape.stroke)
      context.strokeText(line, x, lineY)
    }
  })
}

/** Draw one shape, including its share of the appear animation. */
function drawShape(
  context: CanvasRenderingContext2D,
  shape: Shape2D,
  appear: Appear | undefined,
  now: number,
): void {
  const progress = appear === undefined ? 1 : easeOut(clamp01((now - appear.start) / APPEAR_MS))
  if (progress <= 0) return
  context.save()
  applyStyle(context, shape, progress)

  const bounds: Bounds | undefined = shape.kind === 'text' ? undefined : shapeBounds(shape)
  const grow = 0.9 + 0.1 * progress
  if (bounds !== undefined && progress < 1 && shape.kind !== 'line' && shape.kind !== 'arrow') {
    const centerX = bounds.x + bounds.w / 2
    const centerY = bounds.y + bounds.h / 2
    context.translate(centerX, centerY)
    context.scale(grow, grow)
    context.translate(-centerX, -centerY)
  }

  const rotation = num('rotation' in shape ? shape.rotation : 0, 0)
  if (rotation !== 0 && bounds !== undefined && (shape.kind === 'rect' || shape.kind === 'ellipse')) {
    const centerX = bounds.x + bounds.w / 2
    const centerY = bounds.y + bounds.h / 2
    context.translate(centerX, centerY)
    context.rotate((rotation * Math.PI) / 180)
    context.translate(-centerX, -centerY)
  }

  switch (shape.kind) {
    case 'rect': {
      const path = new Path2D()
      roundedRect(path, num(shape.x), num(shape.y), num(shape.w), num(shape.h), num(shape.radius, 0))
      paintPath(context, path, shape.fill, shape.stroke ?? defaultStroke(shape))
      break
    }
    case 'ellipse': {
      const path = new Path2D()
      path.ellipse(num(shape.cx), num(shape.cy), Math.abs(num(shape.rx)), Math.abs(num(shape.ry)), 0, 0, Math.PI * 2)
      paintPath(context, path, shape.fill, shape.stroke ?? defaultStroke(shape))
      break
    }
    case 'line': {
      const path = new Path2D()
      path.moveTo(num(shape.x1), num(shape.y1))
      path.lineTo(num(shape.x2), num(shape.y2))
      context.strokeStyle = resolvePaint(shape.stroke ?? 'ink')
      context.stroke(path)
      break
    }
    case 'arrow':
      drawArrow(context, shape)
      break
    case 'polyline':
      drawPolyline(context, shape)
      break
    case 'path': {
      const path = parsedPath(typeof shape.d === 'string' ? shape.d : '')
      if (path !== undefined) paintPath(context, path, shape.fill, shape.stroke ?? defaultStroke(shape))
      break
    }
    case 'text':
      drawText(context, shape)
      break
    default:
      break
  }
  context.restore()
}

/** A shape with no fill and no declared stroke is an outline, not an empty box. */
function defaultStroke(shape: Shape2D): Paint | null {
  return shape.fill === null || shape.fill === undefined ? 'ink' : null
}

/** Everything one frame needs. */
interface Frame {
  readonly canvas: Canvas2D
  readonly appear: Map<string, Appear>
  readonly now: number
}

/** A monotonic clock for the appear animation (frame and diff share it). */
function clock(): number {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/** Paint one frame into the backing store. */
function paint(context: CanvasRenderingContext2D, pixel: number, frame: Frame): void {
  paintInto(context, pixel, pixel, frame)
}

/**
 * Paint the document into a `width × height` rectangle, centered.
 *
 * The document is a fixed square ({@link BOARD_EXTENT} logical units). A square
 * output is the normal case and paints edge to edge with no padding; a
 * non-square output (an exact-size baseline for a frame of another shape, a
 * letterboxed preview) gets the surface everywhere and the square in the middle,
 * so the drawing is never stretched. Nothing here is duplicated per caller: the
 * live `<canvas>` and the static preview frame run this one function.
 * @param context - destination context.
 * @param width - destination width in output pixels.
 * @param height - destination height in output pixels.
 * @param frame - document, appear state and clock.
 */
function paintInto(context: CanvasRenderingContext2D, width: number, height: number, frame: Frame): void {
  const edge = Math.min(width, height)
  const offsetX = (width - edge) / 2
  const offsetY = (height - edge) / 2
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, width, height)
  // The canvas *is* the document, so it paints its own surface when the model
  // did not choose one: the PNG export of this canvas then has a real background
  // (a transparent export looks broken in any viewer).
  const background = frame.canvas.background
  context.fillStyle = background === null || background === undefined ? surfacePaint() : resolvePaint(background)
  context.fillRect(0, 0, width, height)
  const scale = edge / BOARD_EXTENT
  context.setTransform(scale, 0, 0, scale, offsetX, offsetY)
  if (frame.canvas.grid !== false) {
    const geometry = gridGeometry()
    if (geometry !== undefined) {
      context.fillStyle = gridPaint()
      context.fill(geometry)
    }
  }
  const shapes: readonly Shape2D[] = frame.canvas.shapes
  for (const shape of shapes) drawShape(context, shape, frame.appear.get(shape.id), frame.now)
  context.setTransform(1, 0, 0, 1, 0, 0)
}

/**
 * Rasterization size of a static 2D frame that has to be compared with a live one.
 *
 * A live 2D capture copies the canvas at its **backing-store** size and only then
 * downscales it to `maxWidth`; a baseline painted straight at the output size is
 * sharper than that, so the antialiased edges of every shape would differ by more
 * than the diff's noise threshold and a board that did not change would report
 * changed pixels. Painting the baseline at the same backing size and letting the
 * comparison downscale it puts both pictures through one resampling step.
 *
 * The scale is capped at {@link BASELINE_SCALE_LIMIT}× the requested size: a very
 * large panel (a 4K fullscreen tab) would otherwise ask the panel to paint,
 * encode and decode a multi-megapixel baseline for a diff of a picture that is
 * going to be at most a few hundred pixels wide on the sheet.
 * @param size - exact output size the caller wants, or undefined for the default.
 * @param backing - the live canvas's backing-store size, when it is measurable.
 * @returns the size to paint at (never smaller than `size`), or undefined when
 *   the caller asked for the default frame.
 */
export function boardBaselineSize(
  size: { width: number; height: number } | undefined,
  backing: { width: number; height: number } | undefined,
): { width: number; height: number } | undefined {
  if (size === undefined) return undefined
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  const edge = Math.min(width, height)
  const source = backing === undefined ? 0 : Math.min(backing.width, backing.height)
  if (source <= edge) return { width, height }
  const scale = Math.min(source / edge, BASELINE_SCALE_LIMIT)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * Render the whole 2D document once, offscreen, with no appear animation.
 *
 * This is the 2D half of previews and diff baselines. A preview of an
 * uncommitted (dry-run) document must look exactly like the board would after
 * the commit, so nothing animates and the frame starts from the document alone
 * — the live canvas is never read, copied, resized or redrawn.
 *
 * The default output is a square of `options.maxWidth` (1024) pixels; callers
 * that need to line up with an existing frame (a `diffAgainst` baseline) pass
 * its exact `size` instead, and — when the live stage can be measured — the live
 * label `unit`, so the id plates land the same size a live capture would have
 * drawn them and the diff does not read them as content changes.
 * @param canvas - the 2D document to render.
 * @param options - requested overlay and longest side.
 * @param size - exact output size, in pixels; omitted means a square `maxWidth`.
 * @param unit - output pixels per CSS pixel for id labels; defaults to a 2× display.
 * @returns the frame, with `mode: '2d'` and no camera, viewport or tile captions
 *   (a 2D document is one picture; contact sheets are a 3D mode).
 */
export function renderBoardFrame(
  canvas: Canvas2D,
  options: CaptureOptions,
  size?: { width: number; height: number },
  unit?: number,
): CaptureFrame {
  const width = size === undefined ? captureWidthLimit(options.maxWidth, STATIC_EDGE) : Math.max(1, Math.round(size.width))
  const height = size === undefined ? width : Math.max(1, Math.round(size.height))
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const context = output.getContext('2d')
  if (context === null) throw new Error('cannot create a 2D context for the frame')
  paintInto(context, output.width, output.height, { canvas, appear: new Map<string, Appear>(), now: clock() })
  if (options.overlay === 'ids') {
    // The labels share the document's own scale, which is the square the
    // painting above centered; translate to it so a letterboxed frame still
    // lands every plate on its shape.
    const edge = Math.min(output.width, output.height)
    const labelUnit = unit !== undefined && Number.isFinite(unit) && unit > 0 ? unit : STATIC_LABEL_UNIT
    context.save()
    context.translate((output.width - edge) / 2, (output.height - edge) / 2)
    overlayShapeIds(context, canvas.shapes, edge, labelUnit)
    context.restore()
  }
  return { png: encodePng(output), width: output.width, height: output.height, mode: '2d' }
}

function paintSize(size: number): number {
  const ratio = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1
  return Math.max(1, Math.round(size * Math.min(ratio, 2)))
}

/**
 * The 2D surface.
 * @param props - the surface document and the page edge length in CSS pixels.
 * @returns a canvas plus the empty-board hint overlay.
 */
export function Board2D({ canvas, size, hint }: Board2DProps) {
  const nodeRef = useRef<HTMLCanvasElement | null>(null)
  const appearRef = useRef(new Map<string, Appear>())
  const seenRef = useRef<Set<string>>(new Set())
  const primedRef = useRef(false)
  const dirtyRef = useRef(true)
  const latest = useRef<Canvas2D>(canvas)
  latest.current = canvas

  useLayoutEffect(() => {
    const now = clock()
    const primed = primedRef.current
    const seen = new Set<string>()
    for (const shape of canvas.shapes) {
      seen.add(shape.id)
      if (seenRef.current.has(shape.id)) continue
      appearRef.current.set(shape.id, { start: primed ? now : Number.NEGATIVE_INFINITY })
    }
    for (const id of [...appearRef.current.keys()]) {
      if (!seen.has(id)) appearRef.current.delete(id)
    }
    seenRef.current = seen
    primedRef.current = true
    dirtyRef.current = true
  }, [canvas])

  useLayoutEffect(() => {
    const stop = subscribeTheme(() => {
      dirtyRef.current = true
    })
    return stop
  }, [])

  useLayoutEffect(() => {
    const node = nodeRef.current
    if (node === null) return
    const pixel = paintSize(size)
    if (node.width !== pixel || node.height !== pixel) {
      node.width = pixel
      node.height = pixel
    }
    dirtyRef.current = true
  }, [size])

  useLayoutEffect(() => {
    let frame = 0
    let disposed = false
    const context = nodeRef.current?.getContext('2d') ?? null
    const step = (): void => {
      if (disposed) return
      const node = nodeRef.current
      if (node !== null && context !== null) {
        const now = clock()
        let animating = false
        for (const entry of appearRef.current.values()) {
          if (entry.start !== Number.NEGATIVE_INFINITY && now - entry.start < APPEAR_MS) {
            animating = true
            break
          }
        }
        if (dirtyRef.current || animating) {
          paint(context, node.width, { canvas: latest.current, appear: appearRef.current, now })
          dirtyRef.current = false
        }
      }
      frame = globalThis.requestAnimationFrame(step)
    }
    frame = globalThis.requestAnimationFrame(step)
    return () => {
      disposed = true
      globalThis.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div className="dshwb-page" style={{ width: `${size}px`, height: `${size}px` }}>
      <canvas ref={nodeRef} className="dshwb-canvas" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true" />
      {hint === undefined ? null : <div className="dshwb-hint">{hint}</div>}
    </div>
  )
}

