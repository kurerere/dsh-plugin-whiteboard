/**
 * The client's defensive read of the `whiteboard` projection value.
 *
 * The Host folds the board from committed session events, so the value that
 * arrives is already canonical. It still crosses a wire boundary: this module
 * accepts `unknown`, checks the shape of every field the renderers touch, and
 * falls back to {@link emptyBoard} for anything it cannot trust. A malformed
 * projection then renders as an empty board instead of throwing inside a canvas
 * or a WebGL frame.
 *
 * It also owns the small geometry helpers both renderers share (shape bounds for
 * the appear animation, per-surface counts for the header).
 */

import {
  DEFAULT_CAMERA, DEFAULT_LIGHTS, emptyBoard,
  type BoardMode, type BoardState, type Camera3D, type Canvas2D, type Light3D,
  type Object3D, type Scene3D, type Shape2D, type Vec2, type Vec3,
} from '../scene.ts'

/** Axis-aligned box in the logical 2D space. */
export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function vec3Or(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return fallback
  const [x, y, z] = value as unknown[]
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return fallback
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback
  return [x, y, z]
}

function cameraOf(value: unknown, fallback: Camera3D): Camera3D {
  if (!isRecord(value)) return { ...fallback }
  return {
    position: vec3Or(value.position, fallback.position),
    target: vec3Or(value.target, fallback.target),
    fov: numberOr(value.fov, fallback.fov),
  }
}

function lightOf(value: unknown): Light3D | undefined {
  if (!isRecord(value)) return undefined
  const kind = value.kind
  if (kind !== 'ambient' && kind !== 'directional' && kind !== 'point') return undefined
  const light: Light3D = {
    kind,
    color: typeof value.color === 'string' ? value.color : 'white',
    intensity: numberOr(value.intensity, 1),
  }
  if (value.position !== undefined) light.position = vec3Or(value.position, [0, 0, 0])
  return light
}

function shapeOf(value: unknown): Shape2D | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.kind !== 'string') return undefined
  return value as unknown as Shape2D
}

function objectOf(value: unknown): Object3D | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.kind !== 'string') return undefined
  return value as unknown as Object3D
}

function canvasOf(value: unknown, fallback: Canvas2D): Canvas2D {
  if (!isRecord(value)) return { ...fallback, shapes: [] }
  const shapes: Shape2D[] = []
  if (Array.isArray(value.shapes)) {
    for (const entry of value.shapes) {
      const shape = shapeOf(entry)
      if (shape !== undefined) shapes.push(shape)
    }
  }
  return {
    background: typeof value.background === 'string' ? value.background : null,
    grid: value.grid !== false,
    shapes,
  }
}

function sceneOf(value: unknown, fallback: Scene3D): Scene3D {
  if (!isRecord(value)) return { ...fallback, objects: [] }
  const objects: Object3D[] = []
  if (Array.isArray(value.objects)) {
    for (const entry of value.objects) {
      const object = objectOf(entry)
      if (object !== undefined) objects.push(object)
    }
  }
  const lights: Light3D[] = []
  if (Array.isArray(value.lights)) {
    for (const entry of value.lights) {
      const light = lightOf(entry)
      if (light !== undefined) lights.push(light)
    }
  }
  return {
    background: typeof value.background === 'string' ? value.background : null,
    grid: value.grid !== false,
    autoRotate: value.autoRotate === true,
    camera: cameraOf(value.camera, fallback.camera),
    lights: lights.length === 0 ? DEFAULT_LIGHTS.map(light => ({ ...light })) : lights,
    objects,
  }
}

/**
 * Validate one projection value into a renderable board.
 * @param value - raw `unknown` read from the projection face.
 * @returns a board whose every renderer-facing field has the expected type.
 */
export function normalizeBoard(value: unknown): BoardState {
  const empty = emptyBoard()
  if (!isRecord(value)) return empty
  const mode: BoardMode = value.mode === '3d' ? '3d' : '2d'
  return {
    rev: Math.max(0, Math.trunc(numberOr(value.rev, 0))),
    mode,
    canvas: canvasOf(value.canvas, empty.canvas),
    scene: sceneOf(value.scene, empty.scene),
  }
}

/**
 * The center and radius a fresh shape grows from, for the appear animation.
 * @param shape - one board shape.
 * @returns a box in logical units, or undefined when the shape has no extent
 *   this module can compute (a `path` whose data it does not parse).
 */
export function shapeBounds(shape: Shape2D): Bounds | undefined {
  switch (shape.kind) {
    case 'rect': {
      const x = numberOr(shape.x, 0)
      const y = numberOr(shape.y, 0)
      return { x, y, w: numberOr(shape.w, 0), h: numberOr(shape.h, 0) }
    }
    case 'ellipse': {
      const rx = Math.abs(numberOr(shape.rx, 0))
      const ry = Math.abs(numberOr(shape.ry, 0))
      const cx = numberOr(shape.cx, 0)
      const cy = numberOr(shape.cy, 0)
      return { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 }
    }
    case 'line':
    case 'arrow': {
      const x1 = numberOr(shape.x1, 0)
      const y1 = numberOr(shape.y1, 0)
      const x2 = numberOr(shape.x2, 0)
      const y2 = numberOr(shape.y2, 0)
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
    }
    case 'polyline': {
      const points = Array.isArray(shape.points) ? shape.points : []
      return boundsOfPoints(points)
    }
    case 'text': {
      const size = numberOr(shape.size, 20)
      const text = typeof shape.text === 'string' ? shape.text : ''
      const lines = text.split('\n').length
      const widest = text.split('\n').reduce((longest, line) => Math.max(longest, line.length), 0)
      return {
        x: numberOr(shape.x, 0),
        y: numberOr(shape.y, 0),
        w: Math.max(widest * size * 0.6, size),
        h: Math.max(lines, 1) * size * 1.35,
      }
    }
    case 'path':
      return undefined
    default:
      return undefined
  }
}

function boundsOfPoints(points: readonly Vec2[]): Bounds | undefined {
  if (points.length === 0) return undefined
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2) continue
    const [x, y] = point
    if (typeof x !== 'number' || typeof y !== 'number') continue
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * How many things are on one surface.
 * @param board - current board.
 * @param mode - surface to count.
 * @returns shape count for `2d`, object count for `3d`.
 */
export function surfaceCount(board: BoardState, mode: BoardMode): number {
  return mode === '3d' ? board.scene.objects.length : board.canvas.shapes.length
}

/**
 * Whether a surface has nothing to draw.
 * @param board - current board.
 * @param mode - surface to check.
 * @returns true for an empty surface.
 */
export function isSurfaceEmpty(board: BoardState, mode: BoardMode): boolean {
  return surfaceCount(board, mode) === 0
}

/** Default geometry scale of the 3D stage, in world units. */
export const WORLD_EXTENT = 8

/**
 * A stable signature of the 3D camera, used to tell a tool-driven camera move
 * from the user orbiting the scene.
 * @param camera - board camera.
 * @returns a comparable string.
 */
export function cameraSignature(camera: Camera3D): string {
  const round = (value: number): number => Math.round(value * 1000) / 1000
  return `${round(camera.fov)}|${camera.position.map(round).join(',')}|${camera.target.map(round).join(',')}`
}

/** The board's default camera, re-exported for the 3D surface reset control. */
export const BOARD_DEFAULT_CAMERA: Camera3D = { ...DEFAULT_CAMERA }
