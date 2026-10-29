// Host-side tests for the durable frame store: content addressing, the
// newest-first index, prefix lookup, and pruning. These run without a browser and
// against a throwaway `DSH_HOME`, so a failing assertion cannot read or delete a
// real user's frames.
//
// The PNG builder is deliberately self-contained (the same shape as the one in
// capture.test.mjs): importing another `*.test.mjs` would register its tests a
// second time in this process.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { createFrameStore } from '../src/capture.ts'

/**
 * A valid opaque RGB PNG. `seed` changes one pixel so two frames hash
 * differently while both stay real PNGs.
 * @param {{ width?: number, height?: number, seed?: number }} [size] - frame shape and color seed.
 * @returns the encoded PNG bytes.
 */
function pngBytes({ width = 2, height = 2, seed = 0 } = {}) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const index = row + 1 + x * 3
      raw[index] = (30 + x * 10 + seed * 7) % 256
      raw[index + 1] = (120 + seed * 13) % 256
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

/** The 3D camera a captured frame carries. */
const CAMERA = { position: [6.4, 4.6, 8.2], target: [0, 0, 0], fov: 45 }

/** The capture options a look recorded. */
const OPTIONS = { mode: '3d', overlay: 'ids', debug: 'lit', maxWidth: 1_280 }

/** The metadata every save must carry since the deep-look slice. */
const META = { width: 640, height: 480, mode: '3d', rev: 7, source: 'look', camera: CAMERA, options: OPTIONS }

/** The per-session frames directory the store owns. */
const sessionDir = (home, sessionId) => join(home, 'storages', 'whiteboard', 'frames', sessionId)

/** Files in one directory (names only), or [] when it does not exist yet. */
async function filesIn(directory) {
  try {
    return (await readdir(directory)).sort()
  } catch {
    return []
  }
}

/** Let the index timestamps differ, so "newest first" cannot be an accident. */
const tick = () => new Promise(resolve => setTimeout(resolve, 6))

/**
 * Run one test against a fresh throwaway `DSH_HOME`.
 * @param {(frames: import('../src/capture.ts').FrameStore, home: string) => Promise<void>} run - test body.
 */
async function withStore(run) {
  const home = await mkdtemp(join(tmpdir(), 'wb-frames-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  try {
    await run(createFrameStore(), home)
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('save writes one content-addressed PNG and returns its record', async () => {
  await withStore(async (frames, home) => {
    const png = pngBytes({ seed: 1 })
    const saved = await frames.save('session-a', png.toString('base64'), META)
    const expectedDir = sessionDir(home, 'session-a')
    assert.match(saved.hash, /^[0-9a-f]{16}$/, 'the hash is a 16-char hex prefix of sha256')
    assert.equal(saved.path, join(expectedDir, `${saved.hash}.png`))
    assert.equal(saved.bytes, png.length)
    assert.deepEqual(saved.data, png, 'the returned bytes are the frame itself')
    assert.deepEqual(await readFile(saved.path), png, 'the file on disk is the frame itself')
    assert.equal(saved.record.hash, saved.hash)
    assert.equal(saved.record.path, saved.path)
    assert.equal(saved.record.bytes, png.length)
    assert.equal(Number.isNaN(Date.parse(saved.record.at)), false, `at is ISO-8601, got ${saved.record.at}`)
    // The metadata is part of the record, not a side channel.
    assert.equal(saved.record.width, META.width)
    assert.equal(saved.record.height, META.height)
    assert.equal(saved.record.mode, META.mode)
    assert.equal(saved.record.rev, META.rev)
    assert.equal(saved.record.source, META.source)
    assert.deepEqual(saved.record.camera, CAMERA)
    assert.deepEqual(saved.record.options, OPTIONS)
  })
})

test('identical pixels reuse one file and one hash', async () => {
  await withStore(async (frames, home) => {
    const png = pngBytes({ seed: 2 })
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`
    const first = await frames.save('session-b', png.toString('base64'), META)
    await tick()
    const second = await frames.save('session-b', dataUrl, { ...META, source: 'auto' })
    assert.equal(first.hash, second.hash)
    assert.equal(first.path, second.path)
    assert.deepEqual(await filesIn(sessionDir(home, 'session-b')).then(names => names.filter(n => n.endsWith('.png'))), [
      `${first.hash}.png`,
    ], 'one hash, one PNG on disk')
  })
})

test('list is newest first and honours its limit', async () => {
  await withStore(async frames => {
    const saved = []
    for (const seed of [3, 4, 5]) {
      await tick()
      saved.push(await frames.save('session-c', pngBytes({ seed }).toString('base64'), { ...META, rev: seed }))
    }
    const all = await frames.list('session-c')
    assert.deepEqual(all.map(record => record.hash), saved.map(frame => frame.hash).reverse(), 'newest first')
    assert.deepEqual(all.map(record => record.rev), [5, 4, 3])
    const limited = await frames.list('session-c', 2)
    assert.deepEqual(limited.map(record => record.hash), [saved[2].hash, saved[1].hash], 'limit keeps the newest')
    assert.deepEqual(await frames.list('session-unknown'), [], 'an unknown board has no records')
  })
})

test('the record round-trips through read() and a new store instance', async () => {
  await withStore(async (frames, home) => {
    await tick()
    const saved = await frames.save('session-d', pngBytes({ seed: 6 }).toString('base64'), META)
    const listed = await frames.list('session-d')
    assert.equal(listed.length, 1)
    assert.deepEqual(listed[0], saved.record, 'list returns the same record save returned')

    const read = await frames.read('session-d', saved.hash)
    assert.ok(read !== undefined)
    assert.deepEqual(read.record, saved.record)
    assert.deepEqual(read.data, saved.data)
    assert.equal(await frames.read('session-d', 'ffffffffffffffff'), undefined, 'an unknown hash is undefined')

    // A fresh store (a Host restart) must find the same index on disk.
    process.env['DSH_HOME'] = home
    const restarted = createFrameStore()
    const afterRestart = await restarted.list('session-d')
    assert.deepEqual(afterRestart.map(record => record.hash), [saved.hash], 'the index survives re-instantiation')
    assert.deepEqual((await restarted.read('session-d', saved.hash)).data, saved.data)
  })
})

test('byHash finds a frame by a 6+ hex prefix, case-insensitively', async () => {
  await withStore(async frames => {
    const saved = await frames.save('session-e', pngBytes({ seed: 7 }).toString('base64'), META)
    const prefix = saved.hash.slice(0, 6)
    assert.equal((await frames.byHash('session-e', prefix)).hash, saved.hash)
    assert.equal((await frames.byHash('session-e', saved.hash.slice(0, 8).toUpperCase())).hash, saved.hash)
    assert.equal((await frames.byHash('session-e', saved.hash)).hash, saved.hash, 'a full hash is a prefix too')
    assert.equal(await frames.byHash('session-e', 'zzzzzz'), undefined, 'a non-hex prefix matches nothing')
    assert.equal(await frames.byHash('session-e', 'deadbeefdeadbeef'), undefined, 'a miss is undefined')
    // A prefix shorter than the documented minimum is not a selector.
    assert.equal(await frames.byHash('session-e', prefix.slice(0, 4)), undefined)
  })
})

test('prune keeps the newest records and deletes the files behind the rest', async () => {
  await withStore(async (frames, home) => {
    const saved = []
    for (const seed of [8, 9, 10]) {
      await tick()
      saved.push(await frames.save('session-f', pngBytes({ seed }).toString('base64'), META))
    }
    const removed = await frames.prune('session-f', 1)
    assert.equal(removed, 2, 'prune reports how many records it dropped')
    const kept = await frames.list('session-f')
    assert.deepEqual(kept.map(record => record.hash), [saved[2].hash], 'the newest record survives')
    assert.deepEqual(await filesIn(sessionDir(home, 'session-f')).then(names => names.filter(n => n.endsWith('.png'))), [
      `${saved[2].hash}.png`,
    ], 'the pruned PNGs are gone from disk')
    for (const frame of saved.slice(0, 2)) assert.equal(await frames.read('session-f', frame.hash), undefined)
  })
})

test('the index caps at 64 records and prunes the files past it', async () => {
  await withStore(async (frames, home) => {
    const saved = []
    for (let seed = 0; seed < 65; seed += 1) {
      saved.push(await frames.save('session-g', pngBytes({ seed }).toString('base64'), META))
    }
    const listed = await frames.list('session-g')
    assert.equal(listed.length, 64, 'the index keeps the newest 64 frames')
    assert.equal(listed[0].hash, saved[64].hash, 'the newest save is first')
    assert.equal(listed.some(record => record.hash === saved[0].hash), false, 'the oldest save was evicted')
    const pngs = (await filesIn(sessionDir(home, 'session-g'))).filter(name => name.endsWith('.png'))
    assert.equal(pngs.length, 64, 'the evicted PNG is deleted, not leaked')
    assert.equal(pngs.includes(`${saved[0].hash}.png`), false)
  })
})

test('the index is an atomic newest-first JSON array with no temp leftovers', async () => {
  await withStore(async (frames, home) => {
    await tick()
    const first = await frames.save('session-h', pngBytes({ seed: 11 }).toString('base64'), META)
    await tick()
    const second = await frames.save('session-h', pngBytes({ seed: 12 }).toString('base64'), META)
    const directory = sessionDir(home, 'session-h')
    const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
    assert.ok(Array.isArray(index), 'index.json is a JSON array')
    assert.deepEqual(index.map(record => record.hash), [second.hash, first.hash])
    for (const record of index) {
      assert.equal(typeof record.at, 'string')
      assert.equal(Number.isNaN(Date.parse(record.at)), false)
      assert.equal(record.mode, '3d')
    }
    const leftovers = (await filesIn(directory)).filter(name => name.includes('.tmp'))
    assert.deepEqual(leftovers, [], 'the atomic write leaves no temporary files behind')
    const info = await stat(join(directory, 'index.json'))
    assert.equal(info.mode & 0o777, 0o600, 'the index stays private to the user')
  })
})

test('a failed index write does not fail the save', async () => {
  await withStore(async (frames, home) => {
    // A directory where index.json belongs makes every atomic index write fail.
    const directory = sessionDir(home, 'session-i')
    await mkdir(join(directory, 'index.json'), { recursive: true })
    const png = pngBytes({ seed: 13 })
    const saved = await frames.save('session-i', png.toString('base64'), META)
    assert.deepEqual(await readFile(saved.path), png, 'the PNG is still written and returned')
  })
})

test('a frame that is not a PNG is rejected and leaves no record', async () => {
  await withStore(async (frames, home) => {
    await assert.rejects(
      frames.save('session-j', Buffer.from('not a png').toString('base64'), META),
      /not a PNG/,
    )
    assert.deepEqual(await frames.list('session-j'), [])
    assert.deepEqual(await filesIn(sessionDir(home, 'session-j')).then(names => names.filter(n => n.endsWith('.png'))), [])
  })
})
