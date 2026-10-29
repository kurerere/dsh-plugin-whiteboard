// Host integration tests for the model-facing board tools: the full `read`
// report, the `look` image result — including the deep modes (per-light,
// turntable, diffAgainst) — the dry-run path that never commits, the build id
// `whiteboard_api` reports, and the diagnostics that make a wrong shadow visible
// without a browser. The capture broker itself is tested in capture.test.mjs;
// this file proves the tool layer wires it into the result the model receives.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createBoardTools } from '../src/tools.ts'
import { CaptureUnavailableError, createCaptureService } from '../src/capture.ts'

/** The version this checkout builds; `whiteboard_api.build` must report it. */
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** One 3D board: a transparent sphere, a hand-made shadow, one casting light. */
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

/** The same board one revision earlier: the sphere only. */
const previousBoard = {
  ...board,
  rev: 6,
  scene: { ...board.scene, objects: board.scene.objects.slice(0, 1) },
}

/** A 2D board for the surface-mismatch and per-light-on-2D cases. */
const flatBoard = {
  rev: 3,
  mode: '2d',
  canvas: { background: null, grid: true, shapes: [] },
  scene: board.scene,
}

/**
 * A store stub with every method the tools call. `history` keeps the memory-only
 * undo stack real enough to resolve `previous` / `rev:N`.
 * @param {Record<string, unknown>} [overrides] - methods to replace for one test.
 */
function storeWith(overrides = {}) {
  return {
    read: () => ({ rev: board.rev, board }),
    canUndo: () => true,
    history: () => [{ rev: 6, kind: 'draw' }],
    previous: () => ({ rev: 6, board: previousBoard }),
    revision: (_sessionId, rev) => (rev === 6 ? { rev: 6, board: previousBoard } : undefined),
    ...overrides,
  }
}

/** The default store: a live 3D board with one retained revision. */
const store = storeWith()

/** Build the frame store stub; `saved` records every save with its meta. */
function makeFrames(seedRecords = []) {
  const saved = []
  const records = new Map()
  for (const record of seedRecords) records.set(record.hash, { ...record })
  return {
    saved,
    records,
    async save(sessionId, png, meta) {
      const hash = `c0ffee${String(saved.length + 1).padStart(10, '0')}`
      const path = `/tmp/whiteboard-${hash}.png`
      const bytes = png.length
      const at = new Date().toISOString()
      saved.push({ sessionId, png, meta, path, hash })
      records.set(hash, { hash, path, bytes, at, ...meta })
      return { path, hash, bytes, data: Buffer.from(png), record: { hash, path, bytes, at, ...meta } }
    },
    async list() {
      return [...records.values()].map(({ data: _data, ...record }) => record)
    },
    async byHash(_sessionId, prefix) {
      const wanted = String(prefix).toLowerCase()
      return [...records.values()].find(record => record.hash.toLowerCase().startsWith(wanted))
    },
    async read(_sessionId, hash) {
      const record = records.get(hash)
      return record === undefined ? undefined : { record, data: record.data ?? Buffer.alloc(0) }
    },
    async prune() {
      return 0
    },
  }
}

/** A stored frame for the image-baseline test. */
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04])
const IMAGE_RECORD = {
  hash: 'ab12cd34ef567890',
  path: '/tmp/whiteboard-ab12cd34ef567890.png',
  bytes: IMAGE_BYTES.length,
  at: '2026-01-01T00:00:00.000Z',
  width: 800,
  height: 600,
  mode: '3d',
  rev: 5,
  source: 'look',
  camera: board.scene.camera,
  data: IMAGE_BYTES,
}

/** The attachment the Host would produce from a frame. */
const ATTACHMENT = {
  attachmentId: 'sha256:test',
  mediaType: 'image/png',
  bytes: 8,
  width: 640,
  height: 480,
  name: 'whiteboard-test.png',
}

/**
 * A capture stub that records every request and answers immediately; frame
 * bytes are not decoded here. `extra` is merged into the answer, so a test can
 * ask for tiles/diff/preview as if the panel returned them.
 * @param {{ extra?: object, fail?: Error, viewer?: boolean, viewport?: object }} [behaviour]
 *   canned answer bits, a failure, viewer presence, or the last polled viewport.
 */
function captureStub({ extra = {}, fail = undefined, viewer = true, viewport = undefined } = {}) {
  const requests = []
  const request = async (sessionId, options, timeoutMs, requestExtra) => {
    requests.push({ sessionId, options: { ...options }, timeoutMs, extra: requestExtra })
    if (fail !== undefined) throw fail
    const mode = options.mode === undefined || options.mode === 'auto' ? board.mode : options.mode
    return {
      requestId: 'cap-test',
      png: 'iVBORw0KGgo=',
      width: 640,
      height: 480,
      mode,
      camera: board.scene.camera,
      viewport: { width: 1180, height: 860, dpr: 2 },
      ...(requestExtra?.preview === undefined ? {} : { preview: true }),
      ...extra,
    }
  }
  return {
    requests,
    request,
    captures: {
      hasViewer: () => viewer,
      lastViewport: () => viewport,
      lastTheme: () => undefined,
      lastAppTheme: () => undefined,
      request,
    },
  }
}

/**
 * Build the seven tools bound to stubs.
 * @param {{ store?: object, capture?: object, frames?: object, attach?: Function, services?: boolean }} [options]
 *   overrides; `services: false` builds tools with no capture channel at all.
 */
function buildTools(options = {}) {
  const capture = options.capture ?? captureStub()
  const frames = options.frames ?? makeFrames()
  const attach = options.attach ?? (async () => ATTACHMENT)
  const definitions = options.services === false
    ? createBoardTools(options.store ?? store, Promise.resolve())
    : createBoardTools(options.store ?? store, Promise.resolve(), {
      captures: capture.captures,
      frames,
      attachImage: attach,
    })
  const tool = (name) => {
    const definition = definitions.find(candidate => candidate.name === name)
    assert.ok(definition, `${name} is not registered`)
    return definition
  }
  return { capture, frames, definitions, tool }
}

/** A tool-run context only needs the owning agent for the board key. */
const exec = { agent: { id: 'session-test' } }

test('whiteboard_read returns geometry, lights, bounds and diagnostics', async () => {
  const { tool } = buildTools()
  const text = await tool('whiteboard_read').execute({}, exec)
  assert.match(text, /"rev": 7/)
  assert.match(text, /"canUndo": true/)
  assert.match(text, /"glass"/)
  assert.match(text, /"bounds"/)
  assert.match(text, /"casts": true/)
  assert.match(text, /"checks"/)
  assert.match(text, /"id": "shadow.single"/)
  assert.match(text, /Transparent object\(s\) explicitly cast a solid shadow: glass/)
  assert.match(text, /hand-made shadows \(contact\)/)
  assert.match(text, /"viewport": null/)
})

test('whiteboard_look returns the frame plus an inline image block', async () => {
  const { tool, frames } = buildTools()
  const look = tool('whiteboard_look')
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
  assert.equal(value.checks.length, 6)
  assert.equal(value.checks.find(check => check.id === 'shadow.single').pass, true)
  assert.equal(value.checks.find(check => check.id === 'shadow.opaque').pass, false)
  const blocks = look.output.render({}, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /whiteboard_look: captured the 3D panel/)
  assert.match(blocks[0].text, /Checks: 4\/6 passed(?:;|\b)/)
  assert.match(blocks[0].text, /failing: shadow\.opaque, shadow\.fake\./)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'sha256:test')
  // The frame is indexed with the metadata the deep-look slice added.
  assert.equal(frames.saved.length, 1)
  const meta = frames.saved[0].meta
  assert.equal(meta.source, 'look')
  assert.equal(meta.width, 640)
  assert.equal(meta.height, 480)
  assert.equal(meta.mode, '3d')
  assert.equal(meta.rev, 7)
  assert.deepEqual(meta.camera, board.scene.camera)
  assert.equal(meta.options.debug, 'lit')
})

test('whiteboard_look falls back to the PNG path when no attachment store exists', async () => {
  const { tool } = buildTools({ attach: async () => undefined })
  const look = tool('whiteboard_look')
  const value = await look.execute({}, exec)
  assert.equal(value.image, undefined)
  const blocks = look.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /open it with read_image/)
})

test('whiteboard_look rejects per-light on the 2D canvas', async () => {
  const { tool, capture } = buildTools({
    store: storeWith({ read: () => ({ rev: flatBoard.rev, board: flatBoard }) }),
  })
  const look = tool('whiteboard_look')
  await assert.rejects(look.execute({ debug: 'per-light' }, exec), (error) => {
    assert.match(error.message, /per-light/)
    assert.match(error.message, /3D/)
    return true
  })
  await assert.rejects(look.execute({ angles: 'turntable' }, exec), (error) => {
    assert.match(error.message, /turntable/)
    assert.match(error.message, /3D/)
    return true
  })
  assert.equal(capture.requests.length, 0, 'a rejected look never asks the panel for a frame')
})

test('whiteboard_look rejects per-light when no light casts a shadow', async () => {
  const darkBoard = {
    ...board,
    scene: { ...board.scene, lights: [{ kind: 'ambient', color: 'white', intensity: 0.55 }] },
  }
  const { tool, capture } = buildTools({ store: storeWith({ read: () => ({ rev: board.rev, board: darkBoard }) }) })
  await assert.rejects(tool('whiteboard_look').execute({ debug: 'per-light' }, exec), (error) => {
    assert.match(error.message, /per-light/)
    assert.match(error.message, /castShadow/)
    return true
  })
  assert.equal(capture.requests.length, 0)
})

test('whiteboard_look rejects the two contact sheets combined', async () => {
  const { tool } = buildTools()
  await assert.rejects(
    tool('whiteboard_look').execute({ debug: 'per-light', angles: 'turntable' }, exec),
    /cannot be combined/,
  )
})

test('whiteboard_look passes a per-light contact sheet through', async () => {
  const tiles = ['#2 directional 1.6']
  const { tool, capture, frames } = buildTools({
    capture: captureStub({ extra: { tiles, width: 1_280, height: 900 } }),
  })
  const look = tool('whiteboard_look')
  const value = await look.execute({ debug: 'per-light', overlay: 'ids' }, exec)
  const request = capture.requests[0]
  assert.equal(request.options.mode, '3d', 'a contact sheet captures the 3D surface explicitly')
  assert.equal(request.options.debug, 'per-light')
  assert.equal(request.extra === undefined || request.extra.baseline === undefined, true, 'a sheet needs no baseline')
  assert.deepEqual(value.tiles, tiles)
  assert.match(value.summary, /per-light/)
  assert.match(value.summary, /1 caster/)
  const details = JSON.parse(value.details)
  assert.deepEqual(details.tiles, tiles)
  assert.equal(value.frame.width, 1_280)
  assert.equal(frames.saved[0].meta.source, 'look', 'a contact sheet is still a look frame')
  assert.deepEqual(frames.saved[0].meta.options.debug, 'per-light')
  // The sheet is still one image block plus its text.
  assert.equal(look.output.render({}, value).length, 2)
})

test('whiteboard_look accepts the turntable contact sheet', async () => {
  const tiles = ['0°', '90°', '180°', '270°']
  const { tool, capture } = buildTools({
    capture: captureStub({ extra: { tiles, width: 1_280, height: 700 } }),
  })
  const value = await tool('whiteboard_look').execute({ angles: 'turntable' }, exec)
  const request = capture.requests[0]
  assert.equal(request.options.mode, '3d')
  assert.equal(request.options.angles, 'turntable')
  assert.deepEqual(value.tiles, tiles)
  assert.match(value.summary, /turntable/)
  assert.match(value.summary, /4 views/)
})

test('a per-light sheet from a pinned 2D panel is refused and never saved', async () => {
  const { tool, frames } = buildTools({ capture: captureStub({ extra: { mode: '2d' } }) })
  await assert.rejects(tool('whiteboard_look').execute({ debug: 'per-light' }, exec), (error) => {
    assert.match(error.message, /needs a 3D contact sheet/)
    assert.match(error.message, /showing the 2D surface/)
    assert.match(error.message, /nothing was saved/)
    return true
  })
  assert.equal(frames.saved.length, 0, 'no misleading 2D frame is persisted')
})

test('a contact sheet without captions is refused', async () => {
  const { tool } = buildTools({ capture: captureStub() })
  await assert.rejects(tool('whiteboard_look').execute({ angles: 'turntable' }, exec), (error) => {
    assert.match(error.message, /without contact-sheet captions/)
    return true
  })
})

test('a diff from a pinned 2D panel is refused and never saved', async () => {
  const { tool, frames } = buildTools({ capture: captureStub({ extra: { mode: '2d' } }) })
  await assert.rejects(tool('whiteboard_look').execute({ diffAgainst: 'previous' }, exec), (error) => {
    assert.match(error.message, /needs a 3D comparison/)
    assert.match(error.message, /showing the 2D surface/)
    return true
  })
  assert.equal(frames.saved.length, 0)
})

test('a diff without statistics is refused', async () => {
  const { tool } = buildTools({ capture: captureStub() })
  await assert.rejects(tool('whiteboard_look').execute({ diffAgainst: 'previous' }, exec), (error) => {
    assert.match(error.message, /without diff statistics/)
    return true
  })
})

test('diffAgainst previous builds a document baseline from the undo history', async () => {
  const diff = {
    kind: 'document',
    label: 'previous',
    rev: 6,
    changedPixels: 1_200,
    changedRatio: 0.023,
    bounds: { x: 10, y: 20, width: 300, height: 200 },
    comparable: true,
    note: '2.3% of the frame changed between rev 6 and rev 7.',
  }
  const { tool, capture, frames } = buildTools({
    capture: captureStub({ extra: { diff, width: 960, height: 720, tiles: ['before', 'after', 'changed'] } }),
  })
  const look = tool('whiteboard_look')
  const value = await look.execute({ diffAgainst: 'previous' }, exec)
  const request = capture.requests[0]
  assert.equal(request.extra.baseline.kind, 'document')
  assert.equal(request.extra.baseline.label, 'previous')
  assert.equal(request.extra.baseline.rev, 6)
  assert.deepEqual(request.extra.baseline.board, previousBoard, 'the whole earlier document travels to the panel')
  assert.equal(request.options.mode, '3d', 'a diff captures the board surface explicitly')
  assert.deepEqual(value.diff, diff)
  assert.deepEqual(value.tiles, ['before', 'after', 'changed'])
  assert.match(value.summary, /diff against previous/)
  assert.match(value.summary, /2\.3% changed/)
  assert.equal(frames.saved[0].meta.source, 'diff', 'a diff sheet is indexed as a diff frame')
  const details = JSON.parse(value.details)
  assert.deepEqual(details.diff, diff)
  assert.equal(details.baseline.rev, 6)
})

test('diffAgainst previous relabels an empty earlier document to the current surface', async () => {
  const empty = {
    rev: 6,
    mode: '2d',
    canvas: { background: null, grid: true, shapes: [] },
    scene: { ...board.scene, objects: [] },
  }
  const { tool, capture } = buildTools({
    store: storeWith({ previous: () => ({ rev: 6, board: empty }) }),
    capture: captureStub({
      extra: {
        diff: {
          kind: 'document', label: 'previous', rev: 6, changedPixels: 0, changedRatio: 0,
          comparable: true, note: 'no visible change',
        },
      },
    }),
  })
  await tool('whiteboard_look').execute({ diffAgainst: 'previous' }, exec)
  const request = capture.requests[0]
  assert.equal(request.extra.baseline.board.mode, '3d', 'an empty baseline follows the surface being compared')
  assert.equal(request.extra.baseline.board.scene.objects.length, 0)
})

test('diffAgainst rev:N resolves a retained revision', async () => {
  const calls = []
  const { tool, capture } = buildTools({
    store: storeWith({
      revision: (_sessionId, rev) => {
        calls.push(rev)
        return rev === 6 ? { rev: 6, board: previousBoard } : undefined
      },
    }),
    capture: captureStub({
      extra: {
        diff: {
          kind: 'document', label: 'rev:6', rev: 6, changedPixels: 0, changedRatio: 0,
          comparable: true, note: 'no visible change',
        },
      },
    }),
  })
  const value = await tool('whiteboard_look').execute({ diffAgainst: 'rev:6' }, exec)
  assert.deepEqual(calls, [6])
  assert.match(value.summary, /diff against rev:6/)
  assert.equal(capture.requests[0].extra.baseline.kind, 'document')
  assert.equal(capture.requests[0].extra.baseline.label, 'rev:6')
  assert.equal(capture.requests[0].extra.baseline.rev, 6)
})

test('diffAgainst a frame hash builds an image baseline', async () => {
  const frames = makeFrames([IMAGE_RECORD])
  const { tool, capture } = buildTools({
    frames,
    capture: captureStub({
      extra: {
        diff: {
          kind: 'image', label: `frame:${IMAGE_RECORD.hash}`, rev: 5, changedPixels: 0, changedRatio: 0,
          comparable: true, note: 'no visible change',
        },
      },
    }),
  })
  await tool('whiteboard_look').execute({ diffAgainst: 'ab12cd' }, exec)
  const baseline = capture.requests[0].extra.baseline
  assert.equal(baseline.kind, 'image')
  assert.match(baseline.label, /^frame:/)
  assert.equal(baseline.png, IMAGE_BYTES.toString('base64'), 'the stored PNG travels as bare base64')
  assert.equal(baseline.width, 800)
  assert.equal(baseline.height, 600)
  assert.equal(baseline.mode, '3d')
  assert.deepEqual(baseline.camera, board.scene.camera, 'the frame camera is the baseline camera')
  assert.equal(baseline.rev, 5)
})

test('diffAgainst rejects an unknown selector and lists the three forms', async () => {
  const { tool, capture } = buildTools()
  await assert.rejects(tool('whiteboard_look').execute({ diffAgainst: 'latest' }, exec), (error) => {
    assert.match(error.message, /previous/)
    assert.match(error.message, /rev:/)
    assert.match(error.message, /hash/i)
    return true
  })
  assert.equal(capture.requests.length, 0)
})

test('diffAgainst names the retained revisions when one is missing', async () => {
  const { tool } = buildTools()
  await assert.rejects(tool('whiteboard_look').execute({ diffAgainst: 'rev:99' }, exec), (error) => {
    assert.match(error.message, /99/)
    assert.match(error.message, /Retained revisions/)
    assert.match(error.message, /rev:6/)
    return true
  })
})

test('diffAgainst names the saved frames when a hash is missing', async () => {
  const { tool } = buildTools()
  await assert.rejects(tool('whiteboard_look').execute({ diffAgainst: 'ffffffff' }, exec), (error) => {
    assert.match(error.message, /matches no saved frame/)
    assert.match(error.message, /Available frames/)
    return true
  })
})

test('diffAgainst previous without history names what is available', async () => {
  const { tool, capture } = buildTools({
    store: storeWith({ previous: () => undefined, history: () => [] }),
  })
  await assert.rejects(tool('whiteboard_look').execute({ diffAgainst: 'previous' }, exec), (error) => {
    assert.match(error.message, /history is empty/)
    assert.match(error.message, /Retained revisions/)
    assert.match(error.message, /Accepted forms/)
    return true
  })
  assert.equal(capture.requests.length, 0)
})

test('a 2D diff compares the canvas and captures it explicitly', async () => {
  const flat = {
    rev: 4,
    mode: '2d',
    canvas: { background: null, grid: true, shapes: [{ id: 'a', kind: 'rect', x: 10, y: 10, w: 40, h: 30 }] },
    scene: board.scene,
  }
  const before = { rev: 3, mode: '2d', canvas: { background: null, grid: true, shapes: [] }, scene: board.scene }
  const diff = {
    kind: 'document',
    label: 'previous',
    rev: 3,
    changedPixels: 300,
    changedRatio: 0.01,
    comparable: true,
    note: '1.0% of the frame changed.',
  }
  const { tool, capture, frames } = buildTools({
    store: storeWith({ read: () => ({ rev: flat.rev, board: flat }), previous: () => ({ rev: before.rev, board: before }) }),
    capture: captureStub({ extra: { diff, mode: '2d' } }),
  })
  const value = await tool('whiteboard_look').execute({ diffAgainst: 'previous' }, exec)
  assert.equal(capture.requests[0].options.mode, '2d', 'a 2D diff captures the canvas, not auto')
  assert.equal(capture.requests[0].extra.baseline.kind, 'document')
  assert.deepEqual(capture.requests[0].extra.baseline.board, before)
  assert.deepEqual(value.diff, diff)
  assert.equal(value.frame.mode, '2d')
  assert.equal(frames.saved[0].meta.source, 'diff')
  assert.equal(frames.saved[0].meta.mode, '2d')
  assert.match(value.summary, /diff against previous/)
})

test('diffAgainst refuses to compare across surfaces', async () => {
  const { tool, capture } = buildTools({
    store: storeWith({ previous: () => ({ rev: 6, board: { ...previousBoard, mode: '2d' } }) }),
  })
  await assert.rejects(tool('whiteboard_look').execute({ diffAgainst: 'previous' }, exec), (error) => {
    assert.match(error.message, /2D/)
    assert.match(error.message, /3D/)
    assert.match(error.message, /surface/)
    return true
  })
  assert.equal(capture.requests.length, 0)
})

test('diffAgainst cannot be combined with a contact sheet', async () => {
  const { tool } = buildTools()
  await assert.rejects(
    tool('whiteboard_look').execute({ debug: 'per-light', diffAgainst: 'previous' }, exec),
    /cannot be combined/,
  )
  await assert.rejects(
    tool('whiteboard_look').execute({ angles: 'turntable', diffAgainst: 'previous' }, exec),
    /cannot be combined/,
  )
})

test('a dry-run draw previews without committing', async () => {
  const flat = {
    rev: 8,
    mode: '2d',
    canvas: { background: null, grid: true, shapes: [] },
    scene: board.scene,
  }
  const mutating = storeWith({
    read: () => ({ rev: flat.rev, board: flat }),
    mutate: async () => {
      throw new Error('a dry run must not mutate the board')
    },
  })
  const { tool, capture, frames } = buildTools({ store: mutating })
  const draw = tool('whiteboard_draw')
  const value = await draw.execute({
    dryRun: true,
    ops: [{ op: 'add', kind: 'rect', id: 'a', x: 10, y: 10, w: 100, h: 60 }],
  }, exec)
  assert.deepEqual(value.added, ['a'])
  assert.equal(value.frame, undefined, 'a dry run has no committed frame')
  assert.equal(value.preview.path, frames.saved[0].path)
  assert.equal(value.preview.hash, frames.saved[0].hash)
  assert.equal(value.preview.mode, '2d')
  assert.equal(value.preview.width, 640)
  assert.equal(value.preview.rev, frames.saved[0].meta.rev)
  assert.equal(frames.saved[0].meta.rev, 8, 'the preview is stamped with the committed revision')
  assert.equal(frames.saved[0].meta.source, 'preview')
  assert.equal(frames.saved[0].meta.mode, '2d')
  assert.ok(Array.isArray(value.checks))
  assert.ok(Array.isArray(value.warnings))
  assert.equal(value.image.attachmentId, ATTACHMENT.attachmentId)

  const request = capture.requests[0]
  assert.equal(request.options.mode, '2d')
  assert.equal(request.options.overlay, 'ids')
  assert.equal(request.options.maxWidth, 1024)
  assert.equal(request.extra.preview.mode, '2d')
  assert.equal(request.extra.preview.canvas.shapes.length, 1, 'the preview document is the hypothetical board')
  assert.equal(request.extra.preview.canvas.shapes[0].id, 'a')
  assert.equal(flat.canvas.shapes.length, 0, 'the live document was never touched')

  const blocks = draw.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /dry run/i)
  assert.match(blocks[0].text, /nothing was committed/i)
  assert.equal(blocks.some(block => block.type === 'image'), true, 'the preview is attached inline')
})

test('a dry-run 3D batch previews the scene without committing', async () => {
  const mutating = storeWith({
    mutate: async () => {
      throw new Error('a dry run must not mutate the board')
    },
  })
  const { tool, capture } = buildTools({ store: mutating })
  const value = await tool('whiteboard_3d').execute({
    dryRun: true,
    ops: [{ op: 'add', kind: 'box', id: 'crate', position: [0, 0.5, 0], size: [1, 1, 1] }],
  }, exec)
  assert.deepEqual(value.added, ['crate'])
  assert.equal(capture.requests[0].options.mode, '3d')
  assert.equal(
    capture.requests[0].extra.preview.scene.objects.length,
    board.scene.objects.length + 1,
    'the preview document is the whole hypothetical scene',
  )
  assert.equal(value.preview.mode, '3d')
})

test('a committed draw still mutates and keeps its auto-frame behavior', async () => {
  let current = {
    rev: 8,
    mode: '2d',
    canvas: { background: null, grid: true, shapes: [] },
    scene: board.scene,
  }
  let mutations = 0
  const mutating = storeWith({
    read: () => ({ rev: current.rev, board: current }),
    mutate: async (_sessionId, reduce) => {
      mutations += 1
      current = reduce(current)
      return { rev: current.rev, board: current }
    },
  })
  const { tool, capture, frames } = buildTools({ store: mutating, capture: captureStub({ viewer: false }) })
  const value = await tool('whiteboard_draw').execute({
    ops: [{ op: 'add', kind: 'rect', id: 'a', x: 10, y: 10, w: 100, h: 60 }],
  }, exec)
  assert.equal(mutations, 1, 'a normal draw commits through the store')
  assert.equal(current.canvas.shapes.length, 1)
  assert.equal(value.preview, undefined, 'a committed draw has no preview block')
  assert.equal(value.checks, undefined, 'checks are a dry-run diagnostic')
  assert.equal(value.frame, undefined, 'no panel was on screen, so there is no auto frame')
  assert.equal(frames.saved.length, 0)
})

test('a dry run without the capture channel is a readable error', async () => {
  const mutating = storeWith({
    read: () => ({ rev: 8, board: { rev: 8, mode: '2d', canvas: { background: null, grid: true, shapes: [] }, scene: board.scene } }),
    mutate: async () => {
      throw new Error('a dry run must not mutate the board')
    },
  })
  const definitions = createBoardTools(mutating, Promise.resolve())
  const draw = definitions.find(definition => definition.name === 'whiteboard_draw')
  assert.ok(draw)
  await assert.rejects(draw.execute({
    dryRun: true,
    ops: [{ op: 'add', kind: 'rect', id: 'a', x: 10, y: 10, w: 100, h: 60 }],
  }, exec), (error) => {
    assert.match(error.message, /dry run/i)
    assert.match(error.message, /preview/i)
    return true
  })
})

test('a failed dry-run preview commits nothing and says so', async () => {
  const mutating = storeWith({
    read: () => ({ rev: 8, board: { rev: 8, mode: '2d', canvas: { background: null, grid: true, shapes: [] }, scene: board.scene } }),
    mutate: async () => {
      throw new Error('a dry run must not mutate the board')
    },
  })
  const capture = captureStub({ fail: new CaptureUnavailableError('the 画板 panel is not on screen') })
  const { tool } = buildTools({ store: mutating, capture })
  await assert.rejects(tool('whiteboard_draw').execute({
    dryRun: true,
    ops: [{ op: 'add', kind: 'rect', id: 'a', x: 10, y: 10, w: 100, h: 60 }],
  }, exec), (error) => {
    assert.match(error.message, /dry run/i)
    assert.match(error.message, /nothing was committed/i)
    return true
  })
})

test('a dry run with no panel on screen is a readable error', async () => {
  const mutating = storeWith({
    read: () => ({ rev: 8, board: { rev: 8, mode: '2d', canvas: { background: null, grid: true, shapes: [] }, scene: board.scene } }),
    mutate: async () => {
      throw new Error('a dry run must not mutate the board')
    },
  })
  const { tool } = buildTools({ store: mutating, capture: captureStub({ viewer: false }) })
  await assert.rejects(tool('whiteboard_draw').execute({
    dryRun: true,
    ops: [{ op: 'add', kind: 'rect', id: 'a', x: 10, y: 10, w: 100, h: 60 }],
  }, exec), (error) => {
    assert.match(error.message, /画板/)
    assert.match(error.message, /Nothing was committed/i)
    return true
  })
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

test('whiteboard_api can return one section of the contract', async () => {
  const { tool } = buildTools()
  const parsed = JSON.parse(await tool('whiteboard_api').execute({ section: 'current' }, exec))
  assert.equal(typeof parsed.apiVersion, 'string')
  assert.ok(parsed.current)
  assert.equal(parsed.ops, undefined)
  assert.equal(parsed.tools, undefined)
})

test('whiteboard_api reports the installed package version, not a bare dev', async () => {
  const { tool } = buildTools()
  const parsed = JSON.parse(await tool('whiteboard_api').execute({}, exec))
  // The defect this covers: the Host answered `build: "dev"` forever, so a model
  // could not tell 0.4.0 from a working tree. The package version is the build.
  assert.equal(parsed.build, packageVersion)
  assert.notEqual(parsed.build, 'dev')
  assert.match(parsed.build, /^\d+\.\d+\.\d+/)
})

test('whiteboard_api carries the build id in a single-section response too', async () => {
  const { tool } = buildTools()
  const parsed = JSON.parse(await tool('whiteboard_api').execute({ section: 'hints' }, exec))
  assert.equal(parsed.build, packageVersion)
  assert.ok(Array.isArray(parsed.hints))
  assert.equal(parsed.ops, undefined)
})

test('whiteboard_api reports the polled viewport before a frame is captured', async () => {
  const viewport = { width: 674, height: 867, dpr: 2 }
  const { tool } = buildTools({ capture: captureStub({ viewport }) })
  const parsed = JSON.parse(await tool('whiteboard_api').execute({ section: 'current' }, exec))
  assert.deepEqual(parsed.current.viewport, viewport)
})

test('whiteboard_history reports the undo stack', async () => {
  const { tool } = buildTools()
  const parsed = JSON.parse(await tool('whiteboard_history').execute({}, exec))
  assert.equal(parsed.canUndo, true)
  assert.deepEqual(parsed.history, [{ rev: 6, kind: 'draw' }])
})

test('whiteboard_undo steps back and reports the new revision', async () => {
  let rev = 7
  let canUndo = true
  const undoStore = {
    read: () => ({ rev, board }),
    canUndo: () => canUndo,
    history: () => [{ rev: 6, kind: 'draw' }],
    undo: async () => {
      if (!canUndo) return undefined
      canUndo = false
      rev += 1
      return { reverted: 'draw', snapshot: { rev, board } }
    },
  }
  const definitions = createBoardTools(undoStore, Promise.resolve())
  const undo = definitions.find(definition => definition.name === 'whiteboard_undo')
  assert.ok(undo)
  const value = await undo.execute({ steps: 2 }, exec)
  assert.deepEqual(value.reverted, ['draw'])
  assert.equal(value.rev, 8)
  assert.equal(value.canUndo, false)
  assert.equal(value.steps, 1)
  const blocks = undo.output.render({}, value)
  assert.match(blocks[0].text, /stepped back 1 \(draw\)/)
})

test('createCaptureService is still the broker the tool layer uses', () => {
  // A guard against the refactor splitting the wiring silently: the tools take a
  // CaptureService-shaped object, and createCaptureService is its canonical build.
  const captures = createCaptureService(store)
  assert.equal(typeof captures.request, 'function')
  assert.equal(typeof captures.take, 'function')
  assert.equal(typeof captures.submit, 'function')
  captures.dispose()
})
