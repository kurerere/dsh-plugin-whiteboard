/**
 * The 3D surface of the board: a three.js scene driven by {@link Scene3D}.
 *
 * three.js is bundled into this plugin's browser artifact (it is a dependency,
 * not a shell platform module), so the scene ships with the plugin and needs no
 * global. The package's `OrbitControls` addon is deliberately not used — the
 * controller below is a small amount of pointer math, which keeps the bundle
 * honest and lets the camera follow the board document instead of fighting it.
 *
 * Everything the board document can say is rendered: all six primitives, the
 * standard-material channels (color, metalness, roughness, opacity, wireframe,
 * emissive), the light rig, the ground grid, `autoRotate`, per-object `spin`,
 * and the camera. New objects pop in (scale + ease-out-back) so a tool call that
 * adds a group of objects reads as one motion.
 *
 * Besides the plain frame, the engine can produce **contact sheets**: one view
 * per shadow-casting light (`debug: 'per-light'`) or four yaws around the scene
 * target (`angles: 'turntable'`), composed by `sheet.ts` into a single captioned
 * picture. It can also render an **arbitrary document** once (`renderDocument`)
 * for dry-run previews and diff baselines. Both reuse the one renderer and one
 * scene graph and always put the live stage back exactly as they found it: the
 * extra views are rendered synchronously, into a 2D canvas, and the orbit, the
 * lights and the applied document are restored before the frame is handed back.
 */

import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import {
  ACESFilmicToneMapping, AmbientLight, BoxGeometry, Color, ConeGeometry, CylinderGeometry, DataTexture,
  DirectionalLight, DoubleSide, EquirectangularReflectionMapping, FrontSide, GridHelper, Group, Mesh,
  MeshStandardMaterial, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight,
  RGBAFormat, Scene, ShadowMaterial, SphereGeometry, SRGBColorSpace, TorusGeometry, UnsignedByteType, Vector3,
  WebGLRenderer, type BufferGeometry, type Object3D as ThreeObject, type WebGLRenderTarget,
} from 'three'
import { type Camera3D, type Object3D, type Scene3D, shadowCasters } from '../scene.ts'
import type { CaptureOptions, CaptureViewport } from '../shared.ts'
import { captureSize, captureWidthLimit, encodePng } from './capture.ts'
import { drawIdLabel } from './overlay.ts'
import { currentTheme, resolvePaint, subscribeTheme, surfacePaint, type ThemeMode } from './palette.ts'
import { composeSheet, type SheetTile } from './sheet.ts'

/** Appear animation length of one new object, in milliseconds. */
const APPEAR_MS = 420

/** Default longest side of a captured 3D frame, in pixels. */
const DEFAULT_CAPTURE_WIDTH = 1280

/**
 * Stage size assumed when an engine host has not been laid out, in CSS pixels.
 *
 * The preview/dry-run engine is mounted in a fixed 960×600 box (see
 * `notes/deep-look-contract.md`), so a real measurement normally exists; but a
 * `renderDocument` must not depend on a layout pass having happened, and
 * rendering a preview at 1×1 would answer with a useless picture.
 */
const FALLBACK_STAGE_WIDTH = 960
const FALLBACK_STAGE_HEIGHT = 600

/** Space around a contact sheet's grid, in pixels (mirrors `sheet.ts`'s default). */
const SHEET_PAD = 12
/** Space between contact-sheet tiles, in pixels (mirrors `sheet.ts`'s default). */
const SHEET_GAP = 10
/** Tiles per row of a turntable / per-light contact sheet. */
const SHEET_COLUMNS = 2
/**
 * Aspect-ratio window of one contact-sheet tile.
 *
 * A sidebar panel is usually narrower than it is tall, and a tile that copied
 * that aspect would make a 2×2 sheet absurdly tall; square tiles keep the four
 * views comparable. A wide stage keeps its own (landscape) shape up to 16:9.
 */
const TILE_ASPECT_MIN = 1
const TILE_ASPECT_MAX = 16 / 9

/** Tile captions of the four turntable views, in yaw order from the live camera. */
const TURNTABLE_LABELS: readonly string[] = ['0°', '90°', '180°', '270°']

/** Heading of a turntable contact sheet. */
const TURNTABLE_TITLE = 'Turntable (4 views)'

/** Ground grid and floor size, in world units. */
const GROUND_EXTENT = 24
const GROUND_DIVISIONS = 24

/** Vertical orbit clamp, in radians. */
const PHI_MIN = 0.12
const PHI_MAX = Math.PI - 0.12

/** One frame the 3D stage hands to the tab, in the answer route's shape. */
export interface Board3DFrame {
  /** Bare base64 PNG (no `data:image/png;base64,` prefix). */
  readonly png: string
  /** Frame width in output pixels. */
  readonly width: number
  /** Frame height in output pixels. */
  readonly height: number
  /** Live camera at capture time. */
  readonly camera: Camera3D
  /** Stage size in CSS pixels. */
  readonly viewport: CaptureViewport
  /**
   * Captions of the views a contact sheet contains, top-left to bottom-right
   * (`0°`, `90°`, … or `#2 directional 1.6`). Absent on an ordinary frame.
   */
  readonly tiles?: string[]
}

/**
 * The 3D stage's capture handle.
 *
 * The tab keeps one in a ref (see {@link Board3DProps.captureRef}) so the capture
 * hook can take a frame without importing three.js or reaching into the engine.
 */
export interface Board3DCapture {
  /**
   * Take one frame of the view currently on screen.
   *
   * Routes the requested mode: `debug: 'per-light'` and `angles: 'turntable'`
   * answer with a contact sheet, everything else with the plain frame.
   * @param options - requested overlay/debug state and output size.
   * @returns the PNG plus the camera and viewport that produced it.
   */
  capture(options: CaptureOptions): Board3DFrame
  /**
   * The camera the live orbit currently describes.
   * @returns position/target/fov as the board document stores them.
   */
  view(): Camera3D
  /**
   * Render an arbitrary scene document once, off the live stage.
   *
   * For a dry-run preview or a diff baseline: the document is applied to this
   * engine, one frame is taken with the requested camera, and the previous
   * document and orbit are put back before returning. Nothing the user sees
   * changes.
   * @param scene - the document to render.
   * @param options - overlay/debug state and output size limit.
   * @param camera - camera to render with; absent keeps the live orbit.
   * @param size - exact output size in pixels; absent uses the stage size.
   * @param viewport - the live stage viewport this frame stands in for: it becomes
   *   the reported viewport and the scale of the `ids` labels, and with a `size`
   *   that matches that viewport it also replays the live capture's supersampling,
   *   so a document baseline is the same picture the live frame was.
   * @returns the frame, with that document's camera and the reference viewport.
   */
  renderDocument(
    scene: Scene3D,
    options: CaptureOptions,
    camera?: Camera3D,
    size?: { width: number; height: number },
    viewport?: CaptureViewport,
  ): Board3DFrame
}

/** Props of the 3D surface. */
export interface Board3DProps {
  /** The scene document. */
  scene: Scene3D
  /** Bumping this counter snaps the camera back to the board's framing. */
  resetKey: number
  /** Rendered over the scene while the board is empty. */
  hint?: ReactNode
  /** Rendered instead of the scene when this environment has no WebGL. */
  fallback?: ReactNode
  /**
   * Filled with the live stage's capture handle once the engine exists, and
   * cleared when the stage unmounts, so a caller can take a frame of what the
   * user sees without holding the renderer.
   */
  captureRef?: MutableRefObject<Board3DCapture | undefined>
}

interface Entry {
  readonly mesh: Mesh
  geometryKey: string
  styleKey: string
  appearStart: number
  spinPhase: number
  readonly baseScale: Vector3
}

interface OrbitState {
  theta: number
  phi: number
  radius: number
  readonly target: Vector3
}

/** One view the engine renders into an output-size 2D canvas. */
interface ViewSpec {
  /** Backing-store (render) size in pixels. */
  readonly renderWidth: number
  readonly renderHeight: number
  /** Output size in pixels; the backing store is copied into it. */
  readonly outputWidth: number
  readonly outputHeight: number
  /** Camera aspect for this view (measured in CSS pixels, so it is exact). */
  readonly aspect: number
  /** Output pixels per CSS pixel, which sizes the `ids` labels. */
  readonly unit: number
  /** Yaw override, in radians; absent keeps the live orbit. */
  readonly theta?: number
  /** When set, only the document light at this index casts a shadow. */
  readonly light?: number
  /** Hide lit surfaces and keep only their shadows (`debug: 'shadow-only'`). */
  readonly shadowOnly?: boolean
  /** Draw one id label per object. */
  readonly ids?: boolean
}

/** A live three.js view of one board scene. */
interface Engine {
  update(scene: Scene3D): void
  resize(): void
  resetCamera(camera: Camera3D): void
  /** The camera the live orbit describes. */
  view(): Camera3D
  /** Take one frame of the current view, with the requested overlays and debug state. */
  capture(options: CaptureOptions): Board3DFrame
  /** Render an arbitrary document once without leaving the live stage changed. */
  renderDocument(
    scene: Scene3D,
    options: CaptureOptions,
    camera?: Camera3D,
    size?: { width: number; height: number },
    viewport?: CaptureViewport,
  ): Board3DFrame
  dispose(): void
}

/**
 * Format one light's intensity for a per-light caption.
 * @param value - the document's (already non-negative) intensity.
 * @returns a short decimal, e.g. `1.6`, `0.55`, `0`.
 */
function formatIntensity(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value * 100) / 100)
}

/**
 * The backing store a live capture of one stage viewport renders into.
 *
 * The live engine clamps the device pixel ratio to 2 (`resize` sets that pixel
 * ratio) and three.js sizes the canvas with `floor`, so mirroring both is what
 * lets a re-render of the same document land on the same pixels as the frame it
 * stands in for — which is the whole point of a diff baseline.
 * @param viewport - the live stage viewport a frame was captured on.
 * @returns the render size in device pixels.
 */
function viewportBacking(viewport: CaptureViewport): { width: number; height: number } {
  const declared = Number.isFinite(viewport.dpr) ? viewport.dpr : 1
  const ratio = Math.min(Math.max(declared, 1), 2)
  return {
    width: Math.max(1, Math.floor(viewport.width * ratio)),
    height: Math.max(1, Math.floor(viewport.height * ratio)),
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function easeOutBack(progress: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  const inverse = progress - 1
  return 1 + c3 * inverse * inverse * inverse + c1 * inverse * inverse
}

function clock(): number {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

function geometryKey(object: Object3D): string {
  const geometry = object.geometry
  return [
    object.kind,
    geometry.size?.join(',') ?? '',
    geometry.radius ?? '',
    geometry.radiusTop ?? '',
    geometry.radiusBottom ?? '',
    geometry.height ?? '',
    geometry.tube ?? '',
    geometry.segments ?? '',
  ].join('|')
}

/** Every standard-material channel the model may set, for change detection. */
function styleKey(object: Object3D): string {
  return [
    object.color,
    object.metalness ?? '',
    object.roughness ?? '',
    object.opacity ?? '',
    object.emissive ?? '',
    object.wireframe === true ? 'w' : '',
    object.kind,
  ].join('|')
}

function buildGeometry(object: Object3D): BufferGeometry {
  const geometry = object.geometry
  const segments = Math.round(clamp(geometry.segments ?? 32, 3, 96))
  switch (object.kind) {
    case 'box': {
      const [x, y, z] = geometry.size ?? [1, 1, 1]
      return new BoxGeometry(x, y, z)
    }
    case 'sphere':
      return new SphereGeometry(Math.max(0.05, geometry.radius ?? 0.7), segments, Math.max(2, Math.round(segments / 2)))
    case 'cylinder':
      return new CylinderGeometry(
        Math.max(0, geometry.radiusTop ?? geometry.radius ?? 0.5),
        Math.max(0, geometry.radiusBottom ?? geometry.radius ?? 0.5),
        Math.max(0.05, geometry.height ?? 1.4),
        segments,
      )
    case 'cone':
      return new ConeGeometry(
        Math.max(0.02, geometry.radiusBottom ?? geometry.radius ?? 0.8),
        Math.max(0.05, geometry.height ?? 1.5),
        segments,
      )
    case 'torus':
      return new TorusGeometry(
        Math.max(0.05, geometry.radius ?? 0.8),
        Math.max(0.01, geometry.tube ?? 0.25),
        Math.max(3, Math.round(segments / 2)),
        segments,
      )
    case 'plane': {
      const [x, y] = geometry.size ?? [2, 2]
      return new PlaneGeometry(Math.max(0.01, x), Math.max(0.01, y))
    }
    default:
      return new BoxGeometry(1, 1, 1)
  }
}

function materialFor(object: Object3D): MeshStandardMaterial {
  const opacity = clamp(object.opacity ?? 1, 0, 1)
  return new MeshStandardMaterial({
    color: new Color(resolvePaint(object.color)),
    emissive: new Color(object.emissive === null || object.emissive === undefined ? 0x000000 : resolvePaint(object.emissive)),
    emissiveIntensity: 0.6,
    metalness: clamp(object.metalness ?? 0.15, 0, 1),
    roughness: clamp(object.roughness ?? 0.45, 0, 1),
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 0.99,
    wireframe: object.wireframe === true,
    side: object.kind === 'plane' ? DoubleSide : FrontSide,
  })
}

function restyle(material: MeshStandardMaterial, object: Object3D): void {
  const opacity = clamp(object.opacity ?? 1, 0, 1)
  material.color.set(resolvePaint(object.color))
  material.emissive.set(object.emissive === null || object.emissive === undefined ? 0x000000 : resolvePaint(object.emissive))
  material.metalness = clamp(object.metalness ?? 0.15, 0, 1)
  material.roughness = clamp(object.roughness ?? 0.45, 0, 1)
  material.opacity = opacity
  material.transparent = opacity < 1
  material.depthWrite = opacity >= 0.99
  material.wireframe = object.wireframe === true
  material.side = object.kind === 'plane' ? DoubleSide : FrontSide
  material.needsUpdate = true
}

/**
 * Configure one light as a shadow caster.
 *
 * Both kinds the board can ask to cast are handled: a `directional` light gets an
 * orthographic shadow frustum sized to the ground grid, a `point` light keeps its
 * (perspective) one. `per-light` captures use this to arm a light the document
 * left unarmed, so "arm only this light" means the same thing as "this light
 * would cast if the document asked it to".
 * @param light - the light to arm.
 * @param shadow - optional map-size and softness overrides from the document.
 */
function armShadow(light: DirectionalLight | PointLight, shadow?: { radius?: number; mapSize?: number }): void {
  light.castShadow = true
  const mapSize = Math.max(256, Math.round(shadow?.mapSize ?? 2048))
  light.shadow.mapSize.set(mapSize, mapSize)
  light.shadow.camera.near = 0.5
  light.shadow.camera.far = 60
  if (light instanceof DirectionalLight) {
    light.shadow.camera.left = -11
    light.shadow.camera.right = 11
    light.shadow.camera.top = 11
    light.shadow.camera.bottom = -11
  }
  light.shadow.bias = -0.0004
  light.shadow.normalBias = 0.03
  light.shadow.radius = Math.max(0, shadow?.radius ?? 2.5)
  light.shadow.camera.updateProjectionMatrix()
}

/**
 * A tiny equirectangular studio used as the scene environment.
 *
 * Without one, a `metalness: 0.9` material has nothing to reflect and renders
 * almost black — the board would contradict the model's intent. The gradient
 * gives soft ambient reflections; the single bright blob is a "window" that
 * metals actually sparkle with, which is what makes a polished object read as
 * polished. PMREM turns it into the prefiltered mips a standard material samples.
 * @param theme - which palette's studio to build.
 * @returns the equirectangular source texture.
 */
function studioTexture(theme: ThemeMode): DataTexture {
  const width = 64
  const height = 32
  type Rgb = readonly [number, number, number]
  const dark = theme === 'dark'
  const sky: Rgb = dark ? [78, 84, 96] : [255, 255, 255]
  const horizon: Rgb = dark ? [38, 41, 47] : [236, 240, 246]
  const ground: Rgb = dark ? [12, 13, 15] : [198, 205, 216]
  const key: Rgb = dark ? [196, 212, 240] : [255, 252, 244]
  const data = new Uint8Array(width * height * 4)
  const blend = (from: Rgb, to: Rgb, amount: number): Rgb => [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ]
  for (let y = 0; y < height; y += 1) {
    const ratio = y / (height - 1)
    const base = ratio < 0.5 ? blend(sky, horizon, ratio * 2) : blend(horizon, ground, (ratio - 0.5) * 2)
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      // One soft "window" high and slightly to the left of the default camera.
      const along = (x / (width - 1) - 0.28) / 0.13
      const across = (ratio - 0.2) / 0.11
      const glow = Math.exp(-(along * along + across * across) * 0.8) * (dark ? 0.7 : 0.92)
      const color = blend(base, key, glow)
      data[index] = color[0]
      data[index + 1] = color[1]
      data[index + 2] = color[2]
      data[index + 3] = 255
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType)
  texture.mapping = EquirectangularReflectionMapping
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

function orbitFromCamera(camera: Camera3D, orbit: OrbitState): void {
  const offset = new Vector3(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  )
  const radius = Math.max(0.5, offset.length())
  orbit.radius = radius
  orbit.theta = Math.atan2(offset.x, offset.z)
  orbit.phi = clamp(Math.acos(clamp(offset.y / radius, -1, 1)), PHI_MIN, PHI_MAX)
  orbit.target.set(camera.target[0], camera.target[1], camera.target[2])
}

/** Camera signature of one board camera (detects tool-driven camera moves). */
function cameraKey(camera: Camera3D): string {
  const round = (value: number): number => Math.round(value * 1000) / 1000
  return `${camera.fov}|${camera.position.map(round).join(',')}|${camera.target.map(round).join(',')}`
}

/**
 * Build the renderer, scene, camera and interaction for one host element.
 * @param host - container the canvas is appended to.
 * @returns the engine, or undefined when WebGL is unavailable.
 */
function createEngine(host: HTMLDivElement): Engine | undefined {
  let renderer: WebGLRenderer
  try {
    // `preserveDrawingBuffer` keeps a frame readable after the compositor takes
    // it, which is what lets 「导出」 copy this canvas into a PNG; without it a
    // `drawImage` of the WebGL canvas yields an empty picture. The cost is one
    // retained buffer for this stage (not per frame), and it is scoped to this
    // renderer — the 2D canvas does not need it.
    renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    })
  } catch {
    return undefined
  }
  if (renderer.getContext() === null) {
    renderer.dispose()
    return undefined
  }

  const scene = new Scene()
  const camera = new PerspectiveCamera(45, 1, 0.05, 400)
  const orbit: OrbitState = { theta: 0.66, phi: 1.15, radius: 11, target: new Vector3() }
  const entries = new Map<string, Entry>()
  const lights: ThreeObject[] = []
  const ground = new Group()
  // A shadow-only catcher: opaque objects ground themselves on it without the
  // board having to paint a floor the model never asked for.
  const floorMaterial = new ShadowMaterial({ color: 0x000000, opacity: 0.22, transparent: true })
  const floor = new Mesh(new PlaneGeometry(GROUND_EXTENT * 1.8, GROUND_EXTENT * 1.8), floorMaterial)
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.004
  floor.receiveShadow = true
  ground.add(floor)
  scene.add(ground)

  let grid: GridHelper | undefined
  let environment: WebGLRenderTarget | undefined
  /** Last applied document; a theme flip re-resolves from it. */
  let lastScene: Scene3D | undefined
  let primed = false
  let signature = ''
  let autoRotate = false
  let dirty = true
  let disposed = false
  /**
   * True while a document is being rendered for a preview or a baseline.
   *
   * Swapping documents around a one-off render removes and re-adds objects, and
   * the appear animation would then pop them on the live stage when the previous
   * document comes back. Everything created while this flag is set simply starts
   * at full size, and the caller restores the animation phase of the entries that
   * already existed.
   */
  let instant = false
  let frame = 0
  let lastTime = clock()

  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  renderer.domElement.className = 'dshwb-gl'
  host.appendChild(renderer.domElement)

  const pmrem = new PMREMGenerator(renderer)

  function rebuildGrid(): void {
    if (grid !== undefined) {
      ground.remove(grid)
      grid.geometry.dispose()
      const material = Array.isArray(grid.material) ? grid.material[0] : grid.material
      material?.dispose()
    }
    const line = resolvePaint('muted')
    const next = new GridHelper(GROUND_EXTENT, GROUND_DIVISIONS, line, line)
    const material = Array.isArray(next.material) ? next.material[0] : next.material
    if (material !== undefined) {
      material.transparent = true
      material.opacity = 0.34
      material.depthWrite = false
    }
    ground.add(next)
    grid = next
    dirty = true
  }
  rebuildGrid()

  function rebuildEnvironment(): void {
    // Reflections carry the metalness channel; the modeled lights stay the
    // authority for shading, so the environment contribution stays modest. A
    // dark room reflects less, so it needs a little more help to still read.
    const theme = currentTheme()
    scene.environmentIntensity = theme === 'dark' ? 0.95 : 0.75
    environment?.dispose()
    environment = undefined
    const source = studioTexture(theme)
    environment = pmrem.fromEquirectangular(source)
    scene.environment = environment.texture
    source.dispose()
    dirty = true
  }
  rebuildEnvironment()

  function syncLights(state: Scene3D): void {
    for (const light of lights) scene.remove(light)
    lights.length = 0
    let directionalSeen = false
    for (const spec of state.lights) {
      const color = new Color(resolvePaint(spec.color))
      const intensity = Math.max(0, spec.intensity)
      if (spec.kind === 'ambient') {
        const light = new AmbientLight(color, intensity)
        scene.add(light)
        lights.push(light)
        continue
      }
      const [x, y, z] = spec.position ?? [0, 5, 0]
      if (spec.kind === 'directional') {
        const light = new DirectionalLight(color, intensity)
        light.position.set(x, y, z)
        // An explicit castShadow wins; otherwise only the first directional
        // casts, so a fill light cannot throw a second, contradictory shadow.
        const casts = spec.castShadow ?? !directionalSeen
        directionalSeen = true
        if (casts) armShadow(light, spec.shadow)
        scene.add(light)
        lights.push(light)
        continue
      }
      const light = new PointLight(color, intensity, 0, 2)
      light.position.set(x, y, z)
      scene.add(light)
      lights.push(light)
    }
  }

  function syncObjects(state: Scene3D): void {
    const wanted = new Set<string>()
    const stamp = clock()
    for (const object of state.objects) {
      wanted.add(object.id)
      let entry = entries.get(object.id)
      if (entry === undefined) {
        const mesh = new Mesh(buildGeometry(object), materialFor(object))
        // Opaque solids cast; wireframes and transparent shells do not, unless
        // the document says otherwise. A glass bulb must not throw a solid shadow.
        mesh.castShadow = object.castShadow ?? (object.wireframe !== true && (object.opacity ?? 1) >= 0.99)
        mesh.receiveShadow = object.receiveShadow ?? true
        scene.add(mesh)
        entry = {
          mesh,
          geometryKey: geometryKey(object),
          styleKey: styleKey(object),
          appearStart: primed && !instant ? stamp : Number.NEGATIVE_INFINITY,
          spinPhase: 0,
          baseScale: new Vector3(1, 1, 1),
        }
        entries.set(object.id, entry)
      } else {
        const key = geometryKey(object)
        if (key !== entry.geometryKey) {
          entry.mesh.geometry.dispose()
          entry.mesh.geometry = buildGeometry(object)
          entry.geometryKey = key
        }
        // Restyling forces a shader recompile, so only do it when a style
        // channel actually moved (a board revision can touch transform only).
        const style = styleKey(object)
        if (style !== entry.styleKey) {
          restyle(entry.mesh.material as MeshStandardMaterial, object)
          entry.styleKey = style
        }
      }
      const [px, py, pz] = object.position
      const [rx, ry, rz] = object.rotation
      const [sx, sy, sz] = object.scale
      entry.mesh.castShadow = object.castShadow ?? (object.wireframe !== true && (object.opacity ?? 1) >= 0.99)
      entry.mesh.receiveShadow = object.receiveShadow ?? true
      entry.mesh.position.set(px, py, pz)
      entry.mesh.rotation.set(radians(rx), radians(ry), radians(rz))
      entry.baseScale.set(Math.abs(sx) || 0.0001, Math.abs(sy) || 0.0001, Math.abs(sz) || 0.0001)
      entry.mesh.userData['rotationY'] = radians(ry)
      entry.mesh.userData['spin'] = object.spin ?? 0
    }
    for (const [id, entry] of [...entries]) {
      if (wanted.has(id)) continue
      scene.remove(entry.mesh)
      entry.mesh.geometry.dispose()
      const material = entry.mesh.material
      for (const item of Array.isArray(material) ? material : [material]) item.dispose()
      entries.delete(id)
    }
    primed = true
  }

  function applyCamera(next: Camera3D): void {
    camera.fov = clamp(next.fov, 15, 100)
    camera.updateProjectionMatrix()
    orbitFromCamera(next, orbit)
    signature = cameraKey(next)
    dirty = true
  }

  function update(state: Scene3D): void {
    lastScene = state
    autoRotate = state.autoRotate
    if (cameraKey(state.camera) !== signature) applyCamera(state.camera)
    scene.background = state.background === null ? null : new Color(resolvePaint(state.background))
    ground.visible = state.grid
    syncLights(state)
    syncObjects(state)
    dirty = true
  }

  function placeCamera(): void {
    const sinPhi = Math.sin(orbit.phi)
    camera.position.set(
      orbit.target.x + orbit.radius * sinPhi * Math.sin(orbit.theta),
      orbit.target.y + orbit.radius * Math.cos(orbit.phi),
      orbit.target.z + orbit.radius * sinPhi * Math.cos(orbit.theta),
    )
    camera.lookAt(orbit.target)
    camera.updateMatrixWorld()
  }

  function resize(): void {
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    dirty = true
  }

  /**
   * Hide the lit surfaces of every object while keeping them in the shadow pass.
   *
   * `debug: 'shadow-only'` exists so the model can look at the *shape* of the
   * scene — silhouettes and contact shadows — without the material colors hiding
   * mistakes in placement. Setting `visible = false` would remove the objects
   * from the shadow map too (the renderer skips invisible objects), so instead
   * only their color and depth writes are silenced: they still cast shadows onto
   * the `ShadowMaterial` floor, and nothing of their own surface reaches the
   * frame.
   * @returns a function that restores every material, the grid and the ground group.
   */
  function hideSurfaces(): () => void {
    const saved: { material: MeshStandardMaterial; colorWrite: boolean; depthWrite: boolean }[] = []
    for (const entry of entries.values()) {
      const materials = Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material]
      for (const material of materials) {
        if (!(material instanceof MeshStandardMaterial)) continue
        saved.push({ material, colorWrite: material.colorWrite, depthWrite: material.depthWrite })
        material.colorWrite = false
        material.depthWrite = false
      }
    }
    const gridWasVisible = grid === undefined ? false : grid.visible
    const groundWasVisible = ground.visible
    if (grid !== undefined) grid.visible = false
    // `update()` ties the whole ground group to the document's `grid` flag, but a
    // shadow-only frame is read *through* the floor: without the catcher a board
    // with `grid: false` would answer with a blank picture, so the catcher (not
    // the grid) is forced on for this one render.
    ground.visible = true
    return () => {
      for (const item of saved) {
        item.material.colorWrite = item.colorWrite
        item.material.depthWrite = item.depthWrite
      }
      if (grid !== undefined) grid.visible = gridWasVisible
      ground.visible = groundWasVisible
    }
  }

  /**
   * The live stage size, in CSS pixels.
   *
   * A frame answers with the size the user is looking at. An engine whose host has
   * never been laid out (an off-screen preview stage before its first
   * measurement) falls back to the box the tab mounts it in, so `renderDocument`
   * can still render a preview instead of a 1×1 picture.
   * @returns the stage's CSS size and the device pixel ratio.
   */
  function stageViewport(): CaptureViewport {
    const width = host.clientWidth
    const height = host.clientHeight
    const dpr = globalThis.devicePixelRatio || 1
    if (width > 0 && height > 0) return { width, height, dpr }
    return { width: FALLBACK_STAGE_WIDTH, height: FALLBACK_STAGE_HEIGHT, dpr }
  }

  /**
   * The camera the live orbit describes, in the board document's own shape.
   *
   * Computing it from the orbit (instead of reading `camera.position`) means a
   * `view()` taken between two animation frames still describes where the camera
   * *is going* — which is the camera the next frame will render.
   * @returns position, target and fov.
   */
  function orbitCamera(): Camera3D {
    const sinPhi = Math.sin(orbit.phi)
    return {
      position: [
        orbit.target.x + orbit.radius * sinPhi * Math.sin(orbit.theta),
        orbit.target.y + orbit.radius * Math.cos(orbit.phi),
        orbit.target.z + orbit.radius * sinPhi * Math.cos(orbit.theta),
      ],
      target: [orbit.target.x, orbit.target.y, orbit.target.z],
      fov: camera.fov,
    }
  }

  /**
   * Make sure the shadow-catcher floor is on screen for one render.
   *
   * A per-light tile is read for its **shadow**: the point is which light threw
   * it. `update()` ties the whole ground group to the document's `grid` flag, so a
   * board with `grid: false` would otherwise answer with tiles that have no
   * shadows in them at all, which makes the whole sheet meaningless. When the grid
   * is already on, the floor is there and nothing is touched.
   * @returns a function that restores the ground group's visibility.
   */
  function showShadowCatcher(): () => void {
    if (ground.visible) return () => {}
    ground.visible = true
    return () => {
      ground.visible = false
    }
  }

  /**
   * Paint one id label per object whose position projects inside the frame.
   *
   * The labels use the camera of the view being rendered, which is why this
   * cannot live in the tab: the model needs the ids of what it can see right now,
   * not of the document's default framing. Anything behind the viewer (`z > 1`
   * after the perspective divide) or outside the NDC box is skipped rather than
   * clamped to an edge, where a label would point at empty space.
   * @param context - context of the capture output copy, never the live stage.
   * @param width - output width in pixels.
   * @param height - output height in pixels.
   * @param unit - output pixels per CSS pixel, which sizes the labels.
   */
  function drawObjectLabels(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    unit: number,
  ): void {
    const point = new Vector3()
    for (const [id, entry] of entries) {
      point.copy(entry.mesh.position).project(camera)
      if (point.z > 1 || point.x < -1 || point.x > 1 || point.y < -1 || point.y > 1) continue
      drawIdLabel(context, (point.x + 1) * 0.5 * width, (1 - point.y) * 0.5 * height, id, unit)
    }
  }

  /**
   * Pixel size of one contact-sheet tile.
   *
   * Tiles are rendered at the width they will occupy in the sheet, so the
   * compositor never has to upscale them; the height follows the live stage's
   * aspect ratio up to a sensible landscape shape, so a tall sidebar panel does
   * not produce absurdly tall tiles.
   * @param limit - total sheet width in pixels, from `maxWidth`.
   * @param viewport - live stage size, whose aspect the tiles follow.
   * @returns the tile size in pixels.
   */
  function tileSize(limit: number, viewport: CaptureViewport): { width: number; height: number } {
    const usable = limit - SHEET_PAD * 2 - SHEET_GAP * (SHEET_COLUMNS - 1)
    const width = Math.max(8, Math.floor(usable / SHEET_COLUMNS))
    const aspect = clamp(viewport.width / Math.max(1, viewport.height), TILE_ASPECT_MIN, TILE_ASPECT_MAX)
    return { width, height: Math.max(1, Math.round(width / aspect)) }
  }

  /**
   * Make exactly one document light cast a shadow.
   *
   * `per-light` answers "which light produced that shadow?", so each tile arms a
   * single three.js light and stops the others from casting. The other lights stay
   * lit — they only lose their shadow — which keeps every tile lit the same way so
   * that the shadow is the only thing that differs between them. A light the
   * document never armed is armed here (with the document's `shadow` tuning), so
   * the tile shows the shadow that light *would* throw.
   * @param index - index of the light in the applied document's rig.
   * @returns a function that restores every light's shadow state.
   */
  function armOnlyLight(index: number): () => void {
    const applied = lastScene
    const saved: { light: DirectionalLight | PointLight; castShadow: boolean }[] = []
    lights.forEach((light, position) => {
      if (!(light instanceof DirectionalLight) && !(light instanceof PointLight)) return
      saved.push({ light, castShadow: light.castShadow })
      light.castShadow = position === index
      if (position === index) armShadow(light, applied?.lights[index]?.shadow)
    })
    return () => {
      for (const item of saved) item.light.castShadow = item.castShadow
    }
  }

  /**
   * Render one view of the scene as it stands, onto an output-size 2D canvas.
   *
   * This is the one place a frame is taken: the live capture, every contact-sheet
   * tile and every preview/baseline go through it, so a tile and a plain frame are
   * produced by exactly the same pipeline (`preserveDrawingBuffer` is what lets
   * the WebGL buffer be copied at all). The renderer size and the camera aspect are
   * left at this view's afterwards — the caller owns putting the live ones back.
   * @param spec - sizes, camera aspect and the debug/overlay state of this view.
   * @returns the new canvas, painted on the board surface.
   */
  function renderView(spec: ViewSpec): HTMLCanvasElement {
    const renderWidth = Math.max(1, Math.round(spec.renderWidth))
    const renderHeight = Math.max(1, Math.round(spec.renderHeight))
    const outputWidth = Math.max(1, Math.round(spec.outputWidth))
    const outputHeight = Math.max(1, Math.round(spec.outputHeight))
    const restoreSurfaces = spec.shadowOnly === true ? hideSurfaces() : undefined
    // `shadow-only` already forces the floor on; a per-light tile needs it too,
    // but without muting the surfaces the shadow is supposed to fall on.
    const restoreCatcher = spec.light === undefined || spec.shadowOnly === true ? undefined : showShadowCatcher()
    const restoreLights = spec.light === undefined ? undefined : armOnlyLight(spec.light)
    const liveTheta = orbit.theta
    try {
      if (spec.theta !== undefined) orbit.theta = spec.theta
      // Render at the backing-store size with a 1:1 pixel ratio: the buffer is
      // then exactly the size that was asked for, whatever the panel's dpr.
      renderer.setPixelRatio(1)
      renderer.setSize(renderWidth, renderHeight, false)
      camera.aspect = Math.max(0.0001, spec.aspect)
      camera.updateProjectionMatrix()
      placeCamera()
      renderer.render(scene, camera)
      const output = document.createElement('canvas')
      output.width = outputWidth
      output.height = outputHeight
      const context = output.getContext('2d')
      if (context === null) throw new Error('cannot create a 2D context for the capture')
      // The WebGL buffer is transparent wherever the scene painted nothing (no
      // background, an alpha material); the board surface is what the user sees
      // behind it, so the frame starts from that paint.
      context.fillStyle = surfacePaint()
      context.fillRect(0, 0, output.width, output.height)
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(renderer.domElement, 0, 0, output.width, output.height)
      if (spec.ids === true) drawObjectLabels(context, output.width, output.height, spec.unit)
      return output
    } finally {
      orbit.theta = liveTheta
      restoreLights?.()
      restoreCatcher?.()
      restoreSurfaces?.()
    }
  }

  /**
   * Take one frame of the scene as the user sees it right now.
   *
   * The normal animation loop only renders when something moved, so the capture
   * renders explicitly, then copies the WebGL buffer onto an opaque 2D canvas.
   * The copy is also where the `ids` overlay and the optional downscale happen —
   * the live stage is never touched.
   * @param options - requested overlay/debug state and output size.
   * @returns the PNG, the live camera and the stage viewport.
   */
  function captureSingle(options: CaptureOptions): Board3DFrame {
    // The panel may have been resized between the observer's last callback and
    // this request; a stale backing store would pair the pixels with a viewport
    // that does not describe them.
    resize()
    const viewport = stageViewport()
    const source = renderer.domElement
    const size = captureSize(
      source.width,
      source.height,
      captureWidthLimit(options.maxWidth, DEFAULT_CAPTURE_WIDTH),
    )
    const canvas = renderView({
      renderWidth: source.width,
      renderHeight: source.height,
      outputWidth: size.width,
      outputHeight: size.height,
      aspect: viewport.width / Math.max(1, viewport.height),
      unit: size.width / Math.max(1, viewport.width),
      shadowOnly: options.debug === 'shadow-only',
      ids: options.overlay === 'ids',
    })
    return {
      png: encodePng(canvas),
      width: size.width,
      height: size.height,
      camera: orbitCamera(),
      viewport,
    }
  }

  /**
   * Compose rendered tiles into the answer frame.
   *
   * A contact sheet still reports the **live** camera and stage viewport: the
   * extra views are how the model looked at the board, not a new place the camera
   * went, and the answer must not imply the user's view moved.
   * @param tiles - the rendered views, in reading order.
   * @param limit - total sheet width in pixels.
   * @param title - heading of the sheet.
   * @returns the contact-sheet frame with its tile captions.
   */
  function sheetFrame(tiles: SheetTile[], limit: number, title: string): Board3DFrame {
    const sheet = composeSheet(tiles, {
      columns: SHEET_COLUMNS,
      width: limit,
      gap: SHEET_GAP,
      pad: SHEET_PAD,
      title,
    })
    return {
      png: encodePng(sheet.canvas),
      width: sheet.canvas.width,
      height: sheet.canvas.height,
      camera: orbitCamera(),
      viewport: stageViewport(),
      tiles: sheet.labels,
    }
  }

  /**
   * Render four yaw views of the live scene as one 2×2 contact sheet.
   *
   * The views share the live orbit's pitch, distance and target and differ only in
   * yaw, so the sheet reads as one turntable of the board the user is looking at
   * rather than of its default framing.
   * @param options - overlay state and the sheet width limit.
   * @returns the contact sheet; its camera stays the live one.
   */
  function captureTurntable(options: CaptureOptions): Board3DFrame {
    const viewport = stageViewport()
    const limit = captureWidthLimit(options.maxWidth, DEFAULT_CAPTURE_WIDTH)
    const tile = tileSize(limit, viewport)
    const unit = Math.max(1, tile.width / Math.max(1, viewport.width))
    const base = orbit.theta
    const tiles: SheetTile[] = []
    for (const [index, label] of TURNTABLE_LABELS.entries()) {
      const canvas = renderView({
        renderWidth: tile.width,
        renderHeight: tile.height,
        outputWidth: tile.width,
        outputHeight: tile.height,
        aspect: tile.width / tile.height,
        unit,
        theta: base + (index * Math.PI) / 2,
        shadowOnly: options.debug === 'shadow-only',
        ids: options.overlay === 'ids',
      })
      tiles.push({ canvas, label })
    }
    return sheetFrame(tiles, limit, TURNTABLE_TITLE)
  }

  /**
   * Render one tile per shadow-casting light as a titled contact sheet.
   *
   * Each tile arms a single light (`armOnlyLight`), so the model can tell which
   * light produced which shadow instead of guessing from a composite picture. The
   * caster list is `shadowCasters` from `scene.ts` — the rule the Host validates
   * the tool call with — so the sheet cannot disagree with the tool about what
   * casts.
   * @param options - overlay state and the sheet width limit.
   * @returns the contact sheet; its camera stays the live one.
   */
  function capturePerLight(options: CaptureOptions): Board3DFrame {
    const applied = lastScene
    if (applied === undefined) throw new Error('the 3D stage is not ready')
    const casters = shadowCasters(applied.lights)
    if (casters.length === 0) {
      throw new Error(
        'per-light needs at least one casting light; set castShadow: true on a light in whiteboard_3d',
      )
    }
    const viewport = stageViewport()
    const limit = captureWidthLimit(options.maxWidth, DEFAULT_CAPTURE_WIDTH)
    const tile = tileSize(limit, viewport)
    const unit = Math.max(1, tile.width / Math.max(1, viewport.width))
    const tiles: SheetTile[] = []
    for (const index of casters) {
      const light = applied.lights[index]
      if (light === undefined) continue
      const canvas = renderView({
        renderWidth: tile.width,
        renderHeight: tile.height,
        outputWidth: tile.width,
        outputHeight: tile.height,
        aspect: tile.width / tile.height,
        unit,
        light: index,
        ids: options.overlay === 'ids',
      })
      tiles.push({ canvas, label: `#${index + 1} ${light.kind} ${formatIntensity(light.intensity)}` })
    }
    return sheetFrame(tiles, limit, `Per-light shadows (${casters.length} casters)`)
  }

  /**
   * Take the frame `whiteboard_look` asked for.
   *
   * `debug: 'per-light'` and `angles: 'turntable'` are contact sheets; everything
   * else is the plain frame the board shows. Whichever route runs, the live stage
   * is put back afterwards (`resize` re-measures it, `dirty` repaints the live
   * view), so taking a look never changes what the user sees.
   * @param options - the capture options the tool sent.
   * @returns one frame, possibly a contact sheet.
   */
  function capture(options: CaptureOptions): Board3DFrame {
    // A collapsed panel has no pixels to take (and resizing the renderer to its
    // 0×0 box would also throw away the last good frame): fail with a message the
    // model can act on instead of answering with a 1×1 picture.
    if (host.clientWidth === 0 || host.clientHeight === 0) {
      throw new Error('the 3D stage is not on screen')
    }
    try {
      if (options.debug === 'per-light') return capturePerLight(options)
      if (options.angles === 'turntable') return captureTurntable(options)
      return captureSingle(options)
    } finally {
      // A contact sheet left the renderer at tile size and the shadow-only frame
      // left the materials muted; `resize` restores the live size and pixel ratio,
      // and `dirty` makes the loop repaint the live view.
      resize()
      dirty = true
    }
  }

  /**
   * Render an arbitrary document once, without disturbing the live stage.
   *
   * Dry-run previews and diff baselines are documents the board never committed.
   * They are rendered by this same engine — there is no headless renderer — so the
   * document is applied, one frame is taken, and the previous document, the orbit,
   * the fov and the animation phase of every object are put back before returning;
   * `dirty` then repaints exactly what the user had.
   *
   * Nothing here reads the stage measurement when `size` is given, so an
   * off-screen preview stage (a fixed, hidden host) renders correctly, and the
   * appear animation is suppressed while documents are swapped so a preview cannot
   * make the live board pop.
   * @param next - the document to render.
   * @param options - overlay/debug state and the output size limit.
   * @param viewCamera - camera to render with; absent keeps the live orbit.
   * @param size - exact output size in pixels; absent uses the stage size.
   * @param viewport - the live stage viewport this frame stands in for. When it is
   *   given, the `ids` labels are scaled exactly as the live frame scales them
   *   (`output / viewport.width`), the frame reports that viewport, and a `size`
   *   that matches it also replays the live capture's supersampling — so a
   *   document baseline can be the same picture, not a noisier one. Omitted, the
   *   engine's own stage is the reference, which is what previews want.
   * @returns the frame, its camera and the reference viewport.
   */
  function renderDocument(
    next: Scene3D,
    options: CaptureOptions,
    viewCamera?: Camera3D,
    size?: { width: number; height: number },
    viewport?: CaptureViewport,
  ): Board3DFrame {
    const previous = lastScene
    const savedOrbit = {
      theta: orbit.theta,
      phi: orbit.phi,
      radius: orbit.radius,
      target: orbit.target.clone(),
    }
    const savedFov = camera.fov
    const savedSignature = signature
    const savedAutoRotate = autoRotate
    /** Animation phase of every object that exists now, restored below. */
    const phase = new Map<string, { spinPhase: number; appearStart: number }>()
    for (const [id, entry] of entries) {
      phase.set(id, { spinPhase: entry.spinPhase, appearStart: entry.appearStart })
    }
    instant = true
    try {
      update(next)
      if (viewCamera === undefined) {
        // Keep the live orbit: the document's own camera is framing advice for the
        // *board*, not for a preview taken from where the user is standing.
        orbit.theta = savedOrbit.theta
        orbit.phi = savedOrbit.phi
        orbit.radius = savedOrbit.radius
        orbit.target.copy(savedOrbit.target)
      } else {
        orbitFromCamera(viewCamera, orbit)
        camera.fov = clamp(viewCamera.fov, 15, 100)
      }
      camera.updateProjectionMatrix()
      const stage = stageViewport()
      // What the frame says it was rendered on, and the scale its labels use: the
      // caller's reference when it stands in for a live frame, this engine's own
      // stage otherwise.
      const reported = viewport ?? stage
      const limit = captureWidthLimit(options.maxWidth, DEFAULT_CAPTURE_WIDTH)
      const stageBacking = {
        width: Math.max(1, Math.round(stage.width * stage.dpr)),
        height: Math.max(1, Math.round(stage.height * stage.dpr)),
      }
      const exact = size === undefined
        ? undefined
        : { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) }
      // With both a size and a reference viewport, re-render at the backing store
      // the live frame was captured from and downscale into the size — the same
      // supersampling, so a document baseline differs only where the documents do.
      // The size has to be the one that backing store really produces; anything
      // else is rendered directly at the requested size.
      const referenceBacking = viewport === undefined ? undefined : viewportBacking(viewport)
      const replayed = referenceBacking === undefined || exact === undefined
        ? undefined
        : captureSize(referenceBacking.width, referenceBacking.height, limit)
      const supersampled = referenceBacking !== undefined && exact !== undefined && replayed !== undefined
        && replayed.width === exact.width && replayed.height === exact.height
      const output = exact ?? captureSize(stageBacking.width, stageBacking.height, limit)
      let rendered = exact ?? stageBacking
      let aspect = exact === undefined
        ? stage.width / Math.max(1, stage.height)
        : output.width / Math.max(1, output.height)
      if (supersampled && referenceBacking !== undefined && viewport !== undefined) {
        rendered = referenceBacking
        aspect = viewport.width / Math.max(1, viewport.height)
      }
      const used = orbitCamera()
      const canvas = renderView({
        renderWidth: rendered.width,
        renderHeight: rendered.height,
        outputWidth: output.width,
        outputHeight: output.height,
        aspect,
        // The live capture scales plates by its own panel width; a frame that
        // stands in for it has to do the same, or a diff pair reports every plate
        // as changed pixels.
        unit: viewport === undefined
          ? Math.max(1, output.width / Math.max(1, stage.width))
          : output.width / Math.max(1, viewport.width),
        shadowOnly: options.debug === 'shadow-only',
        ids: options.overlay === 'ids',
      })
      return {
        png: encodePng(canvas),
        width: output.width,
        height: output.height,
        camera: used,
        viewport: reported,
      }
    } finally {
      if (previous !== undefined) update(previous)
      for (const [id, entry] of entries) {
        const saved = phase.get(id)
        if (saved === undefined) continue
        entry.spinPhase = saved.spinPhase
        entry.appearStart = saved.appearStart
      }
      orbit.theta = savedOrbit.theta
      orbit.phi = savedOrbit.phi
      orbit.radius = savedOrbit.radius
      orbit.target.copy(savedOrbit.target)
      camera.fov = savedFov
      camera.updateProjectionMatrix()
      signature = savedSignature
      autoRotate = savedAutoRotate
      instant = false
      resize()
      dirty = true
    }
  }

  /**
   * The camera the live orbit describes.
   * @returns position, target and fov as the board document stores them.
   */
  function view(): Camera3D {
    return orbitCamera()
  }

  // ---- pointer orbit / pan / dolly (no addons) ----
  const canvas = renderer.domElement
  let pointer: { id: number; x: number; y: number; pan: boolean } | undefined = undefined

  const onPointerDown = (event: PointerEvent): void => {
    if (pointer !== undefined) return
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button === 2 || event.shiftKey }
    canvas.setPointerCapture(event.pointerId)
    canvas.dataset['dragging'] = pointer.pan ? 'pan' : 'orbit'
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (pointer === undefined || event.pointerId !== pointer.id) return
    const dx = event.clientX - pointer.x
    const dy = event.clientY - pointer.y
    pointer.x = event.clientX
    pointer.y = event.clientY
    if (pointer.pan) {
      const scale = orbit.radius * 0.0016
      const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      orbit.target.addScaledVector(right, -dx * scale)
      orbit.target.addScaledVector(up, dy * scale)
    } else {
      orbit.theta -= dx * 0.0075
      orbit.phi = clamp(orbit.phi - dy * 0.0075, PHI_MIN, PHI_MAX)
    }
    dirty = true
  }

  const endPointer = (event: PointerEvent): void => {
    if (pointer === undefined || event.pointerId !== pointer.id) return
    pointer = undefined
    delete canvas.dataset['dragging']
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  }

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    orbit.radius = clamp(orbit.radius * Math.exp(event.deltaY * 0.0012), 1.6, 60)
    dirty = true
  }

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)

  const stopTheme = subscribeTheme(() => {
    rebuildGrid()
    rebuildEnvironment()
    // Palette tokens resolve per theme, so every material and light has to be
    // re-resolved too — otherwise a theme flip leaves the scene in the old
    // palette until the next board revision.
    const current = lastScene
    if (current === undefined) return
    for (const entry of entries.values()) entry.styleKey = ''
    syncLights(current)
    syncObjects(current)
    dirty = true
  })

  function step(): void {
    if (disposed) return
    const time = clock()
    const delta = Math.min(0.1, (time - lastTime) / 1000)
    lastTime = time
    let animating = false
    if (autoRotate) {
      orbit.theta += delta * 0.3
      dirty = true
    }
    for (const entry of entries.values()) {
      const spin = typeof entry.mesh.userData['spin'] === 'number' ? entry.mesh.userData['spin'] : 0
      if (spin !== 0) {
        entry.spinPhase += spin * delta
        const base = typeof entry.mesh.userData['rotationY'] === 'number' ? entry.mesh.userData['rotationY'] : 0
        entry.mesh.rotation.y = base + radians(entry.spinPhase)
        animating = true
      }
      if (entry.appearStart === Number.NEGATIVE_INFINITY) {
        entry.mesh.scale.copy(entry.baseScale)
        continue
      }
      const progress = clamp((time - entry.appearStart) / APPEAR_MS, 0, 1)
      if (progress < 1) {
        entry.mesh.scale.copy(entry.baseScale).multiplyScalar(Math.max(0.001, easeOutBack(progress)))
        animating = true
      } else {
        entry.mesh.scale.copy(entry.baseScale)
      }
    }
    if (dirty || animating) {
      placeCamera()
      renderer.render(scene, camera)
      dirty = false
    }
    frame = globalThis.requestAnimationFrame(step)
  }
  frame = globalThis.requestAnimationFrame(step)

  return {
    update,
    resize,
    capture,
    view,
    renderDocument,
    resetCamera(next: Camera3D): void {
      applyCamera(next)
    },
    dispose(): void {
      disposed = true
      globalThis.cancelAnimationFrame(frame)
      stopTheme()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', endPointer)
      canvas.removeEventListener('pointercancel', endPointer)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      for (const entry of entries.values()) {
        entry.mesh.geometry.dispose()
        const material = entry.mesh.material
        for (const item of Array.isArray(material) ? material : [material]) item.dispose()
      }
      entries.clear()
      lights.length = 0
      grid?.geometry.dispose()
      const gridMaterial = grid === undefined ? undefined : Array.isArray(grid.material) ? grid.material[0] : grid.material
      gridMaterial?.dispose()
      floor.geometry.dispose()
      floorMaterial.dispose()
      environment?.dispose()
      pmrem.dispose()
      scene.clear()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

/**
 * The 3D surface.
 * @param props - the scene document, the camera-reset counter, and the capture ref.
 * @returns the WebGL canvas, or a readable notice when WebGL is unavailable.
 */
export function Board3D({ scene, resetKey, hint, fallback, captureRef }: Board3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const engineRef = useRef<Engine | undefined>(undefined)
  const [failure, setFailure] = useState(false)
  const latest = useRef<Scene3D>(scene)
  latest.current = scene

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const engine = createEngine(host)
    if (engine === undefined) {
      setFailure(true)
      return undefined
    }
    engineRef.current = engine
    engine.resize()
    engine.update(latest.current)
    const observer = new ResizeObserver(() => {
      engine.resize()
    })
    observer.observe(host)
    return () => {
      observer.disconnect()
      engineRef.current = undefined
      engine.dispose()
    }
  }, [])

  // The capture handle delegates through `engineRef` so it does not have to know
  // when the engine was created, and so the ref object it lives in can be a
  // stable parent `useRef` — the engine effect above deliberately runs once.
  useEffect(() => {
    if (captureRef === undefined) return undefined
    /** The live engine, or a message the capture hook turns into the tool error. */
    const engine = (): Engine => {
      const current = engineRef.current
      if (current === undefined) throw new Error('the 3D stage is not ready')
      return current
    }
    captureRef.current = {
      capture: (options: CaptureOptions): Board3DFrame => engine().capture(options),
      view: (): Camera3D => engine().view(),
      renderDocument: (
        target: Scene3D,
        options: CaptureOptions,
        camera?: Camera3D,
        size?: { width: number; height: number },
        viewport?: CaptureViewport,
      ): Board3DFrame => engine().renderDocument(target, options, camera, size, viewport),
    }
    return () => {
      captureRef.current = undefined
    }
  }, [captureRef])

  useEffect(() => {
    engineRef.current?.update(scene)
  }, [scene])

  useEffect(() => {
    if (resetKey === 0) return
    engineRef.current?.resetCamera(latest.current.camera)
  }, [resetKey])

  if (failure) {
    return <div className="dshwb-stage3d dshwb-stage3d--failed">{fallback ?? hint}</div>
  }

  return (
    <div className="dshwb-stage3d">
      <div ref={hostRef} className="dshwb-stage3dHost" />
      {hint === undefined ? null : <div className="dshwb-hint">{hint}</div>}
    </div>
  )
}







