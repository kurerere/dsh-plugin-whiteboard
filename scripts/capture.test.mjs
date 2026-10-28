// Host-side tests for the picture channel: the capture broker and the frame
// store. These do not need a browser; they prove the correlation, timeout,
// heartbeat and durability rules the panel relies on.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { CaptureUnavailableError, createCaptureService, createFrameStore } from '../src/capture.ts'

/** A valid 2×2 opaque RGB PNG; the frame store only accepts a real signature. */
function pngBytes() {
  const width = 2
  const height = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const index = row + 1 + x * 3
      raw[index] = 30 + x * 10
      raw[index + 1] = 120
      raw[index + 2] = 220
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG = pngBytes()
const board = {
  rev: 4,
  mode: '3d',
  canvas: { background: null, grid: true, shapes: [] },
  scene: {
    background: null,
    grid: true,
    autoRotate: false,
    camera: { position: [6.4, 4.6, 8.2], target: [0, 0, 0], fov: 45 },
    lights: [],
    objects: [],
  },
}

/** A store stub: capture only reads the current snapshot. */
const store = { read: () => ({ rev: board.rev, board }) }

test('a request waits for a panel and resolves with its answer', async () => {
  const captures = createCaptureService(store)
  assert.equal(captures.hasViewer('session-a'), false)
  const waiting = captures.request('session-a', { mode: '3d', overlay: 'ids', maxWidth: 512 })
  const request = captures.take('session-a')
  assert.ok(request)
  assert.equal(request.rev, 4)
  assert.equal(request.mode, '3d')
  assert.equal(request.options.maxWidth, 512)
  // Taking is the panel's heartbeat.
  assert.equal(captures.hasViewer('session-a'), true)
  const accepted = captures.submit({
    requestId: request.id,
    png: PNG.toString('base64'),
    width: 2,
    height: 2,
    mode: '3d',
    viewport: { width: 800, height: 600, dpr: 2 },
  })
  assert.deepEqual(accepted, { accepted: true })
  const answer = await waiting
  assert.equal(answer.requestId, request.id)
  assert.equal(answer.mode, '3d')
  assert.deepEqual(captures.lastViewport('session-a'), { width: 800, height: 600, dpr: 2 })
  captures.dispose()
})

test('a request with no panel rejects with a readable error', async () => {
  const captures = createCaptureService(store)
  // Keep the test process alive while the service's unref'd deadline fires.
  const keepAlive = setTimeout(() => {}, 1_000)
  try {
    await assert.rejects(
      captures.request('session-b', {}, 25),
      (error) => error instanceof CaptureUnavailableError && /画板 panel is not on screen/.test(error.message),
    )
  } finally {
    clearTimeout(keepAlive)
    captures.dispose()
  }
})

test('a taken request is reserved for the panel that took it', async () => {
  const captures = createCaptureService(store)
  const waiting = captures.request('session-c', {})
  const first = captures.take('session-c')
  assert.ok(first)
  assert.equal(captures.take('session-c'), undefined)
  captures.submit({ requestId: first.id, png: PNG.toString('base64'), width: 2, height: 2, mode: '3d' })
  await waiting
  captures.dispose()
})

test('dispose rejects outstanding requests', async () => {
  const captures = createCaptureService(store)
  const waiting = captures.request('session-d', {}, 5_000)
  captures.dispose()
  await assert.rejects(waiting, CaptureUnavailableError)
})

test('the frame store writes one content-addressed PNG under DSH_HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wb-frames-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  try {
    const frames = createFrameStore()
    const first = await frames.save('session-e', PNG.toString('base64'))
    const second = await frames.save('session-e', `data:image/png;base64,${PNG.toString('base64')}`)
    assert.equal(first.hash, second.hash, 'same pixels must reuse the same hash')
    assert.equal(first.path, second.path)
    assert.equal(first.bytes, PNG.length)
    assert.ok(first.path.startsWith(join(home, 'storages', 'whiteboard', 'frames', 'session-e')))
    assert.deepEqual(await readFile(first.path), PNG)
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the frame store refuses bytes that are not a PNG', async () => {
  const frames = createFrameStore()
  await assert.rejects(frames.save('session-f', Buffer.from('not a png').toString('base64')), /not a PNG/)
})
