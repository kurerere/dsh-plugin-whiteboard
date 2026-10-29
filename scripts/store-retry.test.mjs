// The atomic replace must survive a document that somebody else is holding open.
//
// Why this test exists: the store writes `temp` and renames it over the live
// document. On Windows that rename fails while another handle has the target open
// without delete sharing (an editor, a scanner, a test reading the file), which is
// a few-hundred-millisecond condition, not a broken workspace. Before the retry
// was added, one such overlap surfaced as a failed undo — the user saw an error
// and had to press the button again.
//
// The lock is real, held by a second process with `FileShare.None`, so this fails
// deterministically if the retry is removed. Windows only: the equivalent POSIX
// failure needs a read-only directory rather than an open handle, and the plugin
// ships for dsh's Web/Desktop client on Windows.
//
// The last two cases cover the memory-only history accessors the deep-look slice
// added (`previous`, `revision`): `diffAgainst: 'previous' | 'rev:<n>'` re-renders
// exactly what they return, so they are tested against the real store rather than
// a stub. They run on every platform.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createBoardStore } from '../src/board-store.ts'
import { applyDraw, emptyBoard } from '../src/scene.ts'

const isWindows = process.platform === 'win32'
const skip = isWindows ? false : 'the Windows sharing-failure path is the one under test'

/** The test's throwaway dsh home, so the real one is never touched. */
const home = await mkdtemp(join(tmpdir(), 'wb-store-'))
process.env['DSH_HOME'] = home

/** Board key used by every case. */
const BOARD = 'session-retry-probe'

/** A logger-shaped stub; the store only reports through it. */
const ctx = { logger: { info() {}, warn() {}, debug() {} } }

/** Absolute path of the document the store will write. */
const documentPath = join(home, 'storages', 'whiteboard', `${BOARD}.json`)

/**
 * Append one canonical text op, so a mutation has something recognisable to land.
 * The flat model-facing op shape is normalised by `tools.ts`; the reducer takes
 * canonical ops only (`{ op: 'add', shape }`).
 * @param label - text to store, greppable in the durable document.
 * @returns the fold the store applies.
 */
function draw(label) {
  return board => applyDraw(board, {
    ops: [{ op: 'add', shape: { id: `text-${label}`, kind: 'text', x: 40, y: 60, text: label, size: 20 } }],
  })
}

/**
 * Hold the document open with `FileShare.None` for `milliseconds`.
 * @param milliseconds - how long the second process keeps the handle.
 * @returns a promise that resolves once the lock is **held** (not released).
 */
function holdDocument(milliseconds) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$handle = [System.IO.File]::Open('${documentPath.replace(/'/g, "''")}', 'Open', 'Read', 'None')`,
    'Write-Output "locked"',
    '[Console]::Out.Flush()',
    `Start-Sleep -Milliseconds ${milliseconds}`,
    '$handle.Close()',
  ].join('\n')
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const released = new Promise((resolve) => { child.once('exit', resolve) })
  const held = new Promise((resolve, reject) => {
    let seen = ''
    child.stdout.on('data', (chunk) => {
      seen += String(chunk)
      if (seen.includes('locked')) resolve()
    })
    child.stderr.on('data', (chunk) => { reject(new Error(`lock helper failed: ${String(chunk)}`)) })
    child.once('error', reject)
  })
  return { held, released, child }
}

after(async () => {
  await rm(home, { recursive: true, force: true })
})

test('a save whose target is briefly held open still succeeds', { skip }, async () => {
  const store = createBoardStore(ctx)
  await store.mutate(BOARD, draw('first'))
  const before = store.read(BOARD).rev

  // 120 ms is inside the retry budget (15+30+45+60+75 ms) but beyond one attempt.
  const lock = holdDocument(120)
  await lock.held
  const started = Date.now()
  const after = await store.mutate(BOARD, draw('second'))
  const elapsed = Date.now() - started
  await lock.released

  assert.ok(after.rev > before, `rev did not advance (${before} -> ${after.rev})`)
  assert.ok(elapsed < 2_000, `the retry took ${elapsed} ms, which is not a transient wait`)
  const stored = JSON.parse(await readFile(documentPath, 'utf8'))
  assert.equal(stored.rev, after.rev, 'the durable document does not match the returned revision')
  assert.ok(JSON.stringify(stored).includes('second'), 'the retried save did not land its content')
  store.dispose()
})

test('a stuck target fails cleanly and leaves the document untouched', { skip }, async () => {
  const store = createBoardStore(ctx)
  await store.mutate(BOARD, draw('kept'))
  const before = await readFile(documentPath, 'utf8')

  const lock = holdDocument(3_000)
  await lock.held
  const started = Date.now()
  await assert.rejects(
    () => store.mutate(BOARD, draw('lost')),
    (error) => {
      assert.match(String(error.message), /could not save the board/)
      assert.match(String(error.message), /The board was not changed/)
      return true
    },
  )
  const elapsed = Date.now() - started
  lock.child.kill()
  await lock.released

  // Bounded retries, not an unbounded stall: six attempts top out around 225 ms.
  assert.ok(elapsed < 2_000, `the failure took ${elapsed} ms; the retry loop is not bounded`)
  assert.equal(await readFile(documentPath, 'utf8'), before, 'a failed save changed the document on disk')
  // Memory still serves the durable board, so the next poll does not regress.
  assert.equal(store.read(BOARD).rev, JSON.parse(before).rev)
  store.dispose()
})

test('the board document survives a save/undo round trip', { skip }, async () => {
  const store = createBoardStore(ctx)
  await store.mutate(BOARD, draw('one'))
  const two = await store.mutate(BOARD, draw('two'))
  const undone = await store.undo(BOARD)
  assert.ok(undone !== undefined, 'undo had nothing to step back')
  assert.ok(undone.snapshot.rev > two.rev, 'the restored board must publish a greater revision')
  const stored = JSON.parse(await readFile(documentPath, 'utf8'))
  assert.equal(stored.rev, undone.snapshot.rev)
  assert.deepEqual(stored.board.canvas.shapes, undone.snapshot.board.canvas.shapes)
  assert.equal(emptyBoard().mode, stored.board.mode)
  store.dispose()
})

/** A board key the history cases own, so the retry cases cannot cross-talk. */
const HISTORY_BOARD = 'session-history-probe'

test('previous() returns the document before the latest mutation', async () => {
  const store = createBoardStore(ctx)
  try {
    await store.mutate(HISTORY_BOARD, draw('first'))
    const second = await store.mutate(HISTORY_BOARD, draw('second'))
    const previous = store.previous(HISTORY_BOARD)
    assert.ok(previous !== undefined, 'a mutation must leave exactly one previous document')
    assert.equal(previous.rev, second.rev - 1, 'previous is the revision before the latest one')
    assert.equal(previous.board.rev, previous.rev, 'the snapshot and its board agree on the revision')
    const ids = previous.board.canvas.shapes.map(shape => shape.id)
    assert.ok(ids.includes('text-first'), 'previous still has the first batch')
    assert.equal(ids.includes('text-second'), false, 'previous is before the latest batch')
  } finally {
    store.dispose()
  }
})

test('revision() finds a retained document by its own board.rev, and nothing else', async () => {
  const store = createBoardStore(ctx)
  try {
    assert.equal(store.revision(HISTORY_BOARD, 0), undefined, 'a fresh store has no retained revision')
    await store.mutate(HISTORY_BOARD, draw('alpha'))
    const second = await store.mutate(HISTORY_BOARD, draw('beta'))
    const retained = store.revision(HISTORY_BOARD, second.rev - 1)
    assert.ok(retained !== undefined, 'the pre-mutation revision is retained')
    assert.equal(retained.board.rev, second.rev - 1)
    assert.equal(retained.board.canvas.shapes.some(shape => shape.id === 'text-beta'), false)
    assert.equal(store.revision(HISTORY_BOARD, 9_999), undefined, 'an unknown revision is undefined')
  } finally {
    store.dispose()
  }
})

test('the history is memory-only and resets when the board is replaced', async () => {
  const store = createBoardStore(ctx)
  try {
    await store.mutate(HISTORY_BOARD, draw('kept'))
    assert.ok(store.previous(HISTORY_BOARD) !== undefined)
    // `newBoard` keeps the durable document but drops steps: a replaced board is
    // not the same board.
    const replaced = await store.newBoard(HISTORY_BOARD)
    assert.ok(replaced.rev > 0, 'the durable board is still there')
    assert.equal(store.previous(HISTORY_BOARD), undefined, 'a replaced board keeps no pre-mutation document')
  } finally {
    store.dispose()
  }
  // A new store instance is what a Host restart looks like: the document loads,
  // the memory-only history does not.
  const restarted = createBoardStore(ctx)
  try {
    assert.ok(restarted.read(HISTORY_BOARD).rev > 0, 'the durable board survived the restart')
    assert.equal(restarted.previous(HISTORY_BOARD), undefined, 'history does not survive a Host restart')
    assert.equal(restarted.revision(HISTORY_BOARD, 1), undefined)
  } finally {
    restarted.dispose()
  }
})
