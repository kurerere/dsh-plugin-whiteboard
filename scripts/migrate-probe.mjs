#!/usr/bin/env node
/**
 * scripts/migrate-probe.mjs — verify the legacy-board migration on an ISOLATED dev
 * home, never touching the Host the maintainer is using.
 *
 * The migration runs once at plugin activation and is idempotent, so it cannot be
 * exercised repeatedly on the main dev home. This script copies real legacy
 * whiteboard Sessions (their session log, the parent's session log, and the legacy
 * board document) into a second home, boots that home, and asserts the documented
 * host rules from **file outcomes only**:
 *
 *   adopt            a legacy parent with no board receives the legacy document,
 *                    byte-identical, and the legacy file is left in place
 *   no-overwrite     a parent that already owns a board keeps it (marker intact)
 *   newest-wins      several legacy boards for one parent: the newest child's
 *                    document wins (by the child session's `createdAt`)
 *   missing parent   a legacy board whose parent Session does not exist is left
 *                    alone (no target document is created)
 *   orphan           a legacy-named board with no session at all is left alone
 *
 * Plugin `ctx.logger.info` output is not captured in the harness log directory (that
 * file only holds this harness's own boot lines), so no assertion here depends on a
 * log line.
 *
 *   node scripts/migrate-probe.mjs [--home H:\dsh-plugins\.wbdev2] [--port 57091]
 *                                  [--source-home H:\dsh-plugins\.wbdev]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const WORKSPACE = dirname(PLUGIN_DIR)
const DEV_HOME = join(WORKSPACE, '.wbdev')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const HOME = resolve(arg('home', join(WORKSPACE, '.wbdev2')))
const SOURCE = resolve(arg('source-home', DEV_HOME))
const PORT = Number(arg('port', 57091))
const BOARD_SRC = join(SOURCE, 'storages', 'whiteboard')
const BOARD_DST = join(HOME, 'storages', 'whiteboard')
const LEGACY = 'session-whiteboard-'

if (!existsSync(join(HOME, 'profiles', 'wb', 'cordis.patch.yml')) && !existsSync(join(HOME, 'config.patch.yml'))) {
  console.error(`migrate-probe: ${HOME} is not a set-up dev home — run: node scripts/dev.mjs setup --home ${HOME}`)
  process.exit(1)
}

let FAILS = 0
const check = (name, ok, detail) => {
  if (ok === false) FAILS++
  console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok === true
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) : null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readRecords(logPath) {
  const buf = readFileSync(logPath)
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
  }
  let text = ''
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      /* torn tail */
    }
  }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* torn line */
    }
  }
  return out
}

/** sessionId → { dir, ws, header } for one home. */
function sessionsOf(home) {
  const root = join(home, 'sessions')
  const map = new Map()
  if (!existsSync(root)) return map
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws)
    if (!statSync(wsDir).isDirectory()) continue
    for (const id of readdirSync(wsDir)) {
      const dir = join(wsDir, id)
      if (!statSync(dir).isDirectory()) continue
      const log = join(dir, 'session.v4.jsonl.zstd')
      if (!existsSync(log)) continue
      map.set(id, { dir, ws, header: readRecords(log)[0] ?? {} })
    }
  }
  return map
}

const dev = (mode, ...args) =>
  execFileSync(process.execPath, [join(PLUGIN_DIR, 'scripts', 'dev.mjs'), mode, '--home', HOME, '--port', String(PORT), ...args], {
    cwd: PLUGIN_DIR,
    encoding: 'utf8',
    timeout: 180_000,
  })

/** Copy a legacy session + its parent's session + the legacy board document in. */
function install(pair, { withParent = true } = {}) {
  const src = sessionsOf(SOURCE)
  const legacy = src.get(pair.legacy)
  mkdirSync(join(HOME, 'sessions', legacy.ws), { recursive: true })
  cpSync(legacy.dir, join(HOME, 'sessions', legacy.ws, pair.legacy), { recursive: true })
  if (withParent) {
    const parent = src.get(pair.parent)
    if (parent !== undefined) cpSync(parent.dir, join(HOME, 'sessions', parent.ws, pair.parent), { recursive: true })
  }
  mkdirSync(BOARD_DST, { recursive: true })
  copyFileSync(join(BOARD_SRC, `${pair.legacy}.json`), join(BOARD_DST, `${pair.legacy}.json`))
}

/** Remove our fixtures (board documents + copied session directories) between tests. */
function clean(ids) {
  for (const id of ids) {
    for (const home of [BOARD_DST]) {
      if (!existsSync(home)) continue
      for (const name of readdirSync(home)) {
        if (name === `${id}.json` || name.startsWith(`${LEGACY}${id}`)) rmSync(join(home, name), { force: true })
      }
    }
    const root = join(HOME, 'sessions')
    if (!existsSync(root)) continue
    for (const ws of readdirSync(root)) {
      const dir = join(root, ws, id)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Boot the isolated home and wait until the plugin has finished activating. */
async function boot() {
  dev('stop')
  const out = dev('start')
  const log = /dev: url (\S+)/.exec(out)
  await sleep(2500)
  return { url: log?.[1] ?? null }
}

// ---------------------------------------------------------------------------
// fixtures discovered from the source home
// ---------------------------------------------------------------------------
const srcSessions = sessionsOf(SOURCE)
const boardNames = existsSync(BOARD_SRC) ? readdirSync(BOARD_SRC).filter((f) => f.endsWith('.json')) : []
const pairs = [...srcSessions.entries()]
  .filter(([id]) => id.startsWith(LEGACY) && boardNames.includes(`${id}.json`))
  .map(([id, meta]) => ({ legacy: id, parent: meta.header.parentSession, createdAt: meta.header.createdAt ?? 0 }))
  .filter((p) => typeof p.parent === 'string' && p.parent.startsWith('session-'))
  .sort((a, b) => b.createdAt - a.createdAt)

console.log(`migrate-probe: home ${HOME} (port ${PORT}), source ${SOURCE}`)
console.log(`migrate-probe: ${pairs.length} legacy board/session pair(s) available`)
for (const p of pairs) console.log(`  ${p.legacy} -> ${p.parent} (createdAt ${p.createdAt})`)
if (pairs.length < 3) {
  console.error('migrate-probe: need at least three legacy pairs')
  process.exit(1)
}

const board = (id) => join(BOARD_DST, `${id}.json`)
const allIds = pairs.flatMap((p) => [p.legacy, p.parent])

// ===========================================================================
// test 1 — adopt onto a parent that has no board
// ===========================================================================
const adopt = pairs[0]
console.log(`\n=== test 1: adopt ${adopt.legacy} -> ${adopt.parent} ===`)
clean(allIds)
install(adopt)
check('target document absent before boot', !existsSync(board(adopt.parent)), board(adopt.parent))
await boot()
check('migration created the parent document', existsSync(board(adopt.parent)), board(adopt.parent))
check(
  'adopted document is byte-identical to the legacy source',
  sha(board(adopt.parent)) === sha(board(adopt.legacy)),
  `sha ${sha(board(adopt.parent))} == ${sha(board(adopt.legacy))} (${statSync(board(adopt.parent)).size} B)`,
)
check('legacy document left in place', existsSync(board(adopt.legacy)), `${statSync(board(adopt.legacy)).size} B`)
check(
  'migration is idempotent (a second boot changes nothing)',
  (() => {
    const before = sha(board(adopt.parent))
    dev('stop')
    dev('start')
    return sha(board(adopt.parent)) === before
  })(),
  'second boot reuses the same document',
)

// ===========================================================================
// test 2 — never overwrite a board the conversation already owns
// ===========================================================================
const keep = pairs.find((p) => p.parent !== adopt.parent) ?? pairs[1]
console.log(`\n=== test 2: keep an existing board for ${keep.parent} (legacy ${keep.legacy}) ===`)
clean(allIds)
install(keep)
const marker = {
  version: 1,
  rev: 7,
  board: {
    mode: '2d',
    canvas: { background: null, grid: true, shapes: [{ id: 'migration-marker', kind: 'text', x: 500, y: 500, text: 'KEEP ME', size: 24, fill: 'ink', align: 'center', baseline: 'middle' }] },
    scene: { background: null, grid: true, autoRotate: false, camera: { position: [6.4, 4.6, 8.2], target: [0, 0, 0] }, lights: [], objects: [] },
  },
}
writeFileSync(board(keep.parent), JSON.stringify(marker, null, 2))
const markerSha = sha(board(keep.parent))
await boot()
const kept = JSON.parse(readFileSync(board(keep.parent), 'utf8'))
check('existing board was not overwritten', sha(board(keep.parent)) === markerSha && kept?.board?.canvas?.shapes?.[0]?.id === 'migration-marker', `sha ${markerSha}, rev ${kept?.rev}, shape ${kept?.board?.canvas?.shapes?.[0]?.id}`)
check('the legacy document for an already-owned parent is left in place', existsSync(board(keep.legacy)), `${statSync(board(keep.legacy)).size} B`)

// ===========================================================================
// test 3 — several legacy boards for one parent: the newest child wins
// ===========================================================================
const byParent = new Map()
for (const p of pairs) byParent.set(p.parent, [...(byParent.get(p.parent) ?? []), p])
const shared = [...byParent.values()].filter((list) => list.length >= 2)[0]
console.log(`\n=== test 3: newest-wins for ${shared?.[0]?.parent} (${shared?.map((p) => `${p.legacy.slice(-8)}@${p.createdAt}`).join(' vs ')}) ===`)
if (shared === undefined) {
  check('newest legacy board wins when several share a parent', 'skip', 'no parent with two legacy boards in the source home')
} else {
  clean(allIds)
  for (const p of shared) install(p)
  const newest = [...shared].sort((a, b) => b.createdAt - a.createdAt)[0]
  const oldest = [...shared].sort((a, b) => a.createdAt - b.createdAt)[0]
  check('target document absent before boot', !existsSync(board(newest.parent)), board(newest.parent))
  await boot()
  check(
    'the newest legacy board became the parent document',
    sha(board(newest.parent)) === sha(board(newest.legacy)),
    `winner sha ${sha(board(newest.parent))} == ${sha(board(newest.legacy))} (${newest.legacy.slice(-8)}@${newest.createdAt}); older ${oldest.legacy.slice(-8)}@${oldest.createdAt} sha ${sha(board(oldest.legacy))}`,
  )
  check(
    'the older sibling document is not the one adopted',
    sha(board(newest.parent)) !== sha(board(oldest.legacy)),
    `parent sha ${sha(board(newest.parent))} vs older legacy sha ${sha(board(oldest.legacy))}`,
  )
  check('both legacy documents remain on disk', existsSync(board(newest.legacy)) && existsSync(board(oldest.legacy)), 'left in place')
}

// ===========================================================================
// test 4 — unreachable legacy boards are left alone
// ===========================================================================
console.log('\n=== test 4: unreachable legacy boards stay untouched ===')
clean(allIds)
const orphan = `${LEGACY}${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`
const orphanDoc = { version: 1, rev: 3, board: { mode: '2d', canvas: { shapes: [{ id: 'orphan', kind: 'text', x: 1, y: 1, text: 'ORPHAN' }] }, scene: { objects: [] } } }
writeFileSync(join(BOARD_DST, `${orphan}.json`), JSON.stringify(orphanDoc))
const orphanSha = sha(join(BOARD_DST, `${orphan}.json`))
// A legacy session whose parent Session is missing from this home: install without parent.
const missing = pairs[pairs.length - 1]
install(missing, { withParent: false })
const missingTarget = board(missing.parent)
const missingSha = sha(board(missing.legacy))
await boot()
check('orphan legacy board is untouched', sha(join(BOARD_DST, `${orphan}.json`)) === orphanSha, `sha ${orphanSha}`)
check('no parent document was created for the missing parent', !existsSync(missingTarget), `${missingTarget} absent`)
check('the legacy document for the missing parent is untouched', sha(board(missing.legacy)) === missingSha, `sha ${missingSha}`)

dev('stop')
console.log(`\nmigrate-probe: ${FAILS === 0 ? 'ALL PASS' : `${FAILS} FAIL`}`)
process.exitCode = FAILS === 0 ? 0 : 1
