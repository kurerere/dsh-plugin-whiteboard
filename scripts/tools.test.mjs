// Host integration tests for the model-facing board tools: the full `read`
// report, the `look` image result, and the diagnostics that make a wrong shadow
// visible without a browser. The capture itself is tested in capture.test.mjs;
// this file proves the tool layer wires it into the result the model receives.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBoardTools } from '../src/tools.ts'
import { createCaptureService } from '../src/capture.ts'

const board = {
  rev: 7,
  mode: '3d',
  canvas: { background: null, grid: true, shapes: [] },
  scene: {
    background: null,
    grid: true,
    autoRotate: false,
    camera: { position: [5, 4, 7.5], target: [0, 2.4, 0], fov: 40 },
    lights: [
      { kind: 'ambient', color: 'white', intensity: 0.55 },
      { kind: 'directional', color: 'white', intensity: 1.6, position: [5, 8, 6], castShadow: true },
      { kind: 'directional', color: 'blue', intensity: 0.5, position: [-6, 3, -5], castShadow: false },
    ],
    objects: [
      {
        id: 'glass', kind: 'sphere', position: [0, 3, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        color: 'yellow', metalness: 0.15, roughness: 0.08, opacity: 0.32, wireframe: false,
        emissive: 'amber', geometry: { radius: 1.3 }, castShadow: true,
      },
      {
        id: 'contact', kind: 'cylinder', position: [0, 0.07, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        color: 'black', metalness: 0.6, roughness: 0.5, opacity: 1, wireframe: false,
        emissive: null, geometry: { radius: 0.3, height: 0.14 },
      },
    ],
  },
}

/** A store stub with the two methods the read/look tools call. */
const store = {
  read: () => ({ rev: board.rev, board }),
  canUndo: () => true,
}

/** A capture stub that answers immediately; the frame bytes are not decoded here. */
function captureStub() {
  const service = createCaptureService(store)
  return {
    service,
    async request(_sessionId, options) {
      return {
        requestId: 'cap-test',
        png: 'iVBORw0KGgo=',
        width: 640,
        height: 480,
        mode: '3d',
        camera: board.scene.camera,
        viewport: { width: 1180, height: 860, dpr: 2 },
        options,
      }
    },
  }
}

/** The attachment the Host would produce from the frame. */
const ATTACHMENT = {
  attachmentId: 'sha256:test',
  mediaType: 'image/png',
  bytes: 8,
  width: 640,
  height: 480,
  name: 'whiteboard-test.png',
}

/** Build the four tools with a capture stub and an in-memory frame store. */
function tools() {
  const capture = captureStub()
  const frames = {
    async save(sessionId, png) {
      return { path: '/tmp/whiteboard-test.png', hash: 'test', bytes: png.length, data: Buffer.from(png) }
    },
  }
  return createBoardTools(store, Promise.resolve(), {
    captures: { ...capture.service, request: capture.request },
    frames,
    attachImage: async () => ATTACHMENT,
  })
}

/** A tool-run context only needs the owning agent for the board key. */
const exec = { agent: { id: 'session-test' } }

test('whiteboard_read returns geometry, lights, bounds and diagnostics', async () => {
  const read = tools().find(definition => definition.name === 'whiteboard_read')
  assert.ok(read)
  const text = await read.execute({}, exec)
  assert.match(text, /"rev": 7/)
  assert.match(text, /"canUndo": true/)
  assert.match(text, /"glass"/)
  assert.match(text, /"bounds"/)
  assert.match(text, /"casts": true/)
  assert.match(text, /Transparent object\(s\) explicitly cast a solid shadow: glass/)
  assert.match(text, /hand-made shadows \(contact\)/)
  assert.match(text, /"viewport": null/)
})

test('whiteboard_look returns the frame plus an inline image block', async () => {
  const look = tools().find(definition => definition.name === 'whiteboard_look')
  assert.ok(look)
  const value = await look.execute({ overlay: 'ids', debug: 'lit' }, exec)
  assert.equal(value.tool, 'whiteboard_look')
  assert.equal(value.frame.mode, '3d')
  assert.equal(value.frame.width, 640)
  assert.equal(value.frame.rev, 7)
  assert.equal(value.image.attachmentId, 'sha256:test')
  assert.deepEqual(value.warnings, [
    'Transparent object(s) explicitly cast a solid shadow: glass.',
    'Opaque object(s) look like hand-made shadows (contact); they are geometry, not light, and will not follow the light.',
  ])
  const blocks = look.output.render({}, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /whiteboard_look: captured the 3D panel/)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'sha256:test')
})

test('whiteboard_look falls back to the PNG path when no attachment store exists', async () => {
  const capture = captureStub()
  const frames = {
    async save(_sessionId, png) {
      return { path: '/tmp/whiteboard-test.png', hash: 'test', bytes: png.length, data: Buffer.from(png) }
    },
  }
  const definitions = createBoardTools(store, Promise.resolve(), {
    captures: { ...capture.service, request: capture.request },
    frames,
    attachImage: async () => undefined,
  })
  const look = definitions.find(definition => definition.name === 'whiteboard_look')
  assert.ok(look)
  const value = await look.execute({}, exec)
  assert.equal(value.image, undefined)
  const blocks = look.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /open it with read_image/)
})

test('whiteboard_3d accepts per-object and per-light shadow controls', async () => {
  let lastBoard = board
  const mutating = {
    read: () => ({ rev: lastBoard.rev, board: lastBoard }),
    canUndo: () => false,
    mutate: async (_sessionId, reduce) => {
      lastBoard = reduce(lastBoard)
      return { rev: lastBoard.rev, board: lastBoard }
    },
  }
  const definitions = createBoardTools(mutating, Promise.resolve())
  const scene = definitions.find(definition => definition.name === 'whiteboard_3d')
  assert.ok(scene)
  const result = await scene.execute({
    ops: [
      {
        op: 'add', kind: 'sphere', id: 'ball', position: [0, 1, 0],
        opacity: 0.4, castShadow: true, receiveShadow: false,
      },
      { op: 'update', id: 'glass', castShadow: false },
    ],
    view: {
      lights: [
        { kind: 'directional', intensity: 2, position: [1, 2, 3], castShadow: true, shadow: { radius: 3, mapSize: 1024 } },
        { kind: 'ambient', intensity: 0.2 },
      ],
    },
  }, exec)
  assert.deepEqual(result.added, ['ball'])
  assert.deepEqual(result.updated, ['glass'])
  const ball = lastBoard.scene.objects.find(object => object.id === 'ball')
  assert.equal(ball.castShadow, true)
  assert.equal(ball.receiveShadow, false)
  assert.equal(lastBoard.scene.objects.find(object => object.id === 'glass').castShadow, false)
  assert.deepEqual(lastBoard.scene.lights[0], {
    kind: 'directional', color: 'white', intensity: 2, position: [1, 2, 3],
    castShadow: true, shadow: { radius: 3, mapSize: 1024 },
  })
})
