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
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ACESFilmicToneMapping, AmbientLight, BoxGeometry, Color, ConeGeometry, CylinderGeometry, DataTexture,
  DirectionalLight, DoubleSide, EquirectangularReflectionMapping, FrontSide, GridHelper, Group, Mesh,
  MeshStandardMaterial, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight,
  RGBAFormat, Scene, ShadowMaterial, SphereGeometry, SRGBColorSpace, TorusGeometry, UnsignedByteType, Vector3,
  WebGLRenderer, type BufferGeometry, type Object3D as ThreeObject, type WebGLRenderTarget,
} from 'three'
import { type Camera3D, type Object3D, type Scene3D } from '../scene.ts'
import { currentTheme, resolvePaint, subscribeTheme, type ThemeMode } from './palette.ts'

/** Appear animation length of one new object, in milliseconds. */
const APPEAR_MS = 420

/** Ground grid and floor size, in world units. */
const GROUND_EXTENT = 24
const GROUND_DIVISIONS = 24

/** Vertical orbit clamp, in radians. */
const PHI_MIN = 0.12
const PHI_MAX = Math.PI - 0.12

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

/** A live three.js view of one board scene. */
interface Engine {
  update(scene: Scene3D): void
  resize(): void
  resetCamera(camera: Camera3D): void
  dispose(): void
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
 * Configure one directional light as the scene's shadow caster.
 * @param light - the light to arm.
 */
function armShadow(light: DirectionalLight): void {
  light.castShadow = true
  light.shadow.mapSize.set(2048, 2048)
  light.shadow.camera.near = 0.5
  light.shadow.camera.far = 60
  light.shadow.camera.left = -11
  light.shadow.camera.right = 11
  light.shadow.camera.top = 11
  light.shadow.camera.bottom = -11
  light.shadow.bias = -0.0004
  light.shadow.normalBias = 0.03
  light.shadow.radius = 2.5
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
  const floorMaterial = new ShadowMaterial({ color: 0x000000, opacity: 0.1, transparent: true })
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
        armShadow(light)
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
        // Wireframes are line art, not solids: they must not throw a filled shadow.
        mesh.castShadow = object.wireframe !== true
        mesh.receiveShadow = true
        scene.add(mesh)
        entry = {
          mesh,
          geometryKey: geometryKey(object),
          styleKey: styleKey(object),
          appearStart: primed ? stamp : Number.NEGATIVE_INFINITY,
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
      entry.mesh.castShadow = object.wireframe !== true
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
 * @param props - the scene document and the camera-reset counter.
 * @returns the WebGL canvas, or a readable notice when WebGL is unavailable.
 */
export function Board3D({ scene, resetKey, hint, fallback }: Board3DProps) {
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







