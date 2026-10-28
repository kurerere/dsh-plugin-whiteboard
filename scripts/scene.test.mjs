// Reducer tests for the board document. Node strips the TypeScript types, so
// the shared module is imported straight from src/ — the same code the Host and
// the browser bundle run.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CAMERA, MAX_OBJECTS, MAX_SHAPES,
  applyBoardEvent, applyClear, applyDraw, applyScene3D, boardEventKind, describeBoard,
  emptyBoard, isBoardState, shapeIds,
} from '../src/scene.ts'

test('an empty board satisfies the projection validator', () => {
  const board = emptyBoard()
  assert.equal(isBoardState(board), true)
  assert.deepEqual(board.canvas.shapes, [])
  assert.deepEqual(board.scene.objects, [])
  assert.equal(board.mode, '2d')
})

test('the validator rejects values a renderer could not use', () => {
  assert.equal(isBoardState(null), false)
  assert.equal(isBoardState({}), false)
  assert.equal(isBoardState({ ...emptyBoard(), mode: 'isometric' }), false)
  assert.equal(isBoardState({ ...emptyBoard(), scene: { ...emptyBoard().scene, camera: {} } }), false)
})

test('event kinds resolve from plugin records, logical names and short names', () => {
  assert.equal(boardEventKind('plugin:dsh-plugin-whiteboard/draw'), 'draw')
  assert.equal(boardEventKind('whiteboard/scene3d'), 'scene3d')
  assert.equal(boardEventKind('clear'), 'clear')
  assert.equal(boardEventKind('turn/start'), undefined)
  assert.equal(boardEventKind('drawing/board'), undefined)
})

test('a draw event appends, updates and removes shapes', () => {
  let board = emptyBoard()
  board = applyDraw(board, {
    ops: [
      { op: 'add', shape: { id: 'rect-1', kind: 'rect', x: 10, y: 20, w: 100, h: 60, fill: 'blue' } },
      { op: 'add', shape: { id: 'text-1', kind: 'text', x: 50, y: 50, text: 'hello', size: 24 } },
    ],
  })
  assert.deepEqual(shapeIds(board), ['rect-1', 'text-1'])
  assert.equal(board.rev, 1)
  assert.equal(board.mode, '2d')

  board = applyDraw(board, { ops: [{ op: 'update', id: 'rect-1', patch: { fill: 'orange', kind: 'ellipse' } }] })
  const updated = board.canvas.shapes[0]
  assert.equal(updated.kind, 'rect', 'an update must not rewrite the shape kind')
  assert.equal(updated.fill, 'orange')

  board = applyDraw(board, { ops: [{ op: 'remove', id: 'text-1' }] })
  assert.deepEqual(shapeIds(board), ['rect-1'])

  board = applyDraw(board, { ops: [{ op: 'clear' }] })
  assert.deepEqual(shapeIds(board), [])
})

test('an unknown update or remove target is ignored instead of throwing', () => {
  const board = applyDraw(emptyBoard(), {
    ops: [{ op: 'update', id: 'ghost', patch: { fill: 'red' } }, { op: 'remove', id: 'ghost' }],
  })
  assert.deepEqual(shapeIds(board), [])
  assert.equal(board.rev, 1)
})

test('the shape cap drops the oldest shapes', () => {
  const ops = Array.from({ length: MAX_SHAPES + 5 }, (_, index) => ({
    op: 'add',
    shape: { id: `rect-${index}`, kind: 'rect', x: index, y: 0, w: 10, h: 10 },
  }))
  const board = applyDraw(emptyBoard(), { ops })
  assert.equal(board.canvas.shapes.length, MAX_SHAPES)
  assert.equal(board.canvas.shapes[0].id, 'rect-5')
})

test('a canvas view patch changes background and grid only', () => {
  const board = applyDraw(emptyBoard(), { ops: [], view: { background: 'white', grid: false } })
  assert.equal(board.canvas.background, 'white')
  assert.equal(board.canvas.grid, false)
})

test('a 3D event adds objects and applies the camera and light view', () => {
  const board = applyScene3D(emptyBoard(), {
    ops: [
      {
        op: 'add',
        object: {
          id: 'box-1',
          kind: 'box',
          position: [1, 2, 3],
          rotation: [0, 45, 0],
          scale: [1, 1, 1],
          color: 'teal',
          metalness: 0.2,
          roughness: 0.4,
          opacity: 1,
          wireframe: false,
          emissive: null,
          geometry: { size: [2, 2, 2] },
        },
      },
    ],
    view: {
      camera: { position: [10, 10, 10], target: [0, 1, 0], fov: 60 },
      background: 'black',
      grid: false,
      autoRotate: true,
      lights: [{ kind: 'ambient', color: 'white', intensity: 0.8 }],
    },
  })
  assert.equal(board.mode, '3d')
  assert.equal(board.scene.objects.length, 1)
  assert.deepEqual(board.scene.objects[0].position, [1, 2, 3])
  assert.deepEqual(board.scene.camera, { position: [10, 10, 10], target: [0, 1, 0], fov: 60 })
  assert.equal(board.scene.background, 'black')
  assert.equal(board.scene.grid, false)
  assert.equal(board.scene.autoRotate, true)
  assert.deepEqual(board.scene.lights.map(light => light.kind), ['ambient'])
})

test('a partial camera patch keeps the untouched axes', () => {
  const board = applyScene3D(emptyBoard(), { ops: [], view: { camera: { fov: 30 } } })
  assert.deepEqual(board.scene.camera.position, DEFAULT_CAMERA.position)
  assert.equal(board.scene.camera.fov, 30)
})

test('the object cap drops the oldest objects', () => {
  const ops = Array.from({ length: MAX_OBJECTS + 3 }, (_, index) => ({
    op: 'add',
    object: { id: `box-${index}`, kind: 'box', position: [index, 0, 0] },
  }))
  const board = applyScene3D(emptyBoard(), { ops })
  assert.equal(board.scene.objects.length, MAX_OBJECTS)
  assert.equal(board.scene.objects[0].id, 'box-3')
})

test('clear resets one surface and leaves the other alone', () => {
  const drawn = applyDraw(emptyBoard(), {
    ops: [{ op: 'add', shape: { id: 'rect-1', kind: 'rect', x: 0, y: 0, w: 10, h: 10 } }],
  })
  const cleared = applyClear(drawn, { mode: '3d' })
  assert.deepEqual(shapeIds(cleared), ['rect-1'], 'clearing 3D must keep the canvas')
  assert.deepEqual(cleared.scene.camera, DEFAULT_CAMERA)

  const both = applyClear(cleared, { mode: 'all' })
  assert.deepEqual(shapeIds(both), [])
})

test('a non-board event returns the same reference so the projection can skip it', () => {
  const board = emptyBoard()
  assert.equal(applyBoardEvent(board, 'turn/start', { turn: 1 }), board)
  assert.equal(applyBoardEvent(board, 'plugin:dsh-plugin-whiteboard/draw', 'nonsense'), board)
})

test('a record-shaped event folds like its logical name', () => {
  const board = applyBoardEvent(emptyBoard(), 'plugin:dsh-plugin-whiteboard/draw', {
    ops: [{ op: 'add', shape: { id: 'rect-1', kind: 'rect', x: 0, y: 0, w: 10, h: 10 } }],
  })
  assert.deepEqual(shapeIds(board), ['rect-1'])
})

test('describeBoard names both surfaces', () => {
  const board = applyDraw(emptyBoard(), {
    ops: [{ op: 'add', shape: { id: 'rect-1', kind: 'rect', x: 0, y: 0, w: 10, h: 10 } }],
  })
  const text = describeBoard(board)
  assert.match(text, /Canvas \(2D\): 1 shapes — rect-1\(rect\)/)
  assert.match(text, /Scene \(3D\): empty/)
})
