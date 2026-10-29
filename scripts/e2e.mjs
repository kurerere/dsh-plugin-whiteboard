#!/usr/bin/env node
/**
 * scripts/e2e.mjs — end-to-end verification for the **model C** whiteboard:
 * the sidebar tab is a view of the *main conversation's* board, not a chat.
 *
 * What it asserts (narrative in notes/harness.md):
 *
 *   load      the app boots clean; the 画板 tab is keyed by the main Session and
 *             renders the board document at
 *             `<dsh home>/storages/whiteboard/<mainSessionId>.json` (after the
 *             one-time migration that adopted the legacy child-session boards)
 *   headline  with the tab CLOSED, a request from the MAIN composer draws on that
 *             board: the document file gains shapes and the tab shows them when it
 *             is opened afterwards (this is the point of the refactor)
 *   say       typing in the TAB's own input sends an ordinary user turn into the
 *             main conversation (client submission path, or `/api/whiteboard.say`)
 *             and the assistant answers it
 *   regress   undo button, Ctrl+Z, clear + undo-clear, 2D↔3D, PNG export (2D and
 *             3D), and reload persistence
 *   tools     the board tools belong to the main agent (host-side `tool/call`
 *             records) and a subagent does not get them (subagent session log)
 *
 * Board documents and session logs are read from disk, so every claim has a
 * host-side witness next to the browser observation.
 *
 *   node scripts/e2e.mjs [--phase load|headline|say|regress|tools|look|all]
 *                        [--headed] [--url <tokenized url>] [--out <report.json>]
 *                        [--timeout 240000] [--draw-prompt "…"] [--look-prompt "…"]
 *                        [--keep-session]
 *
 * The browser is a system Chrome when one is available (macOS default, or
 * `WBDEV_CHROME_PATH`); that lets the harness run from an npx Playwright package
 * without downloading a second browser. WebGL gets SwiftShader flags so the 3D
 * phase works headless.
 *
 * Screenshots and the JSON report land in .wbdev/shots/.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { loadPlaywright } from './pw.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const WORKSPACE = dirname(PLUGIN_DIR)
const HOME = process.env.WBDEV_HOME || join(WORKSPACE, '.wbdev')
const SHOTS = join(HOME, 'shots')
const BOARD_DIR = join(HOME, 'storages', 'whiteboard')
const SESSIONS_DIR = join(HOME, 'sessions')
const LEGACY_PREFIX = 'session-whiteboard-'

// Board tab DOM (src/client/mounts.tsx). These class names are the plugin's own;
// the shipped chrome around them is addressed by role/aria only.
const ROOT = '.dshwb-root'
const BOARD = '.dshwb-board'
const META = '.dshwb-meta'
const HINT = '.dshwb-boardHint'
const INPUT = '.dshwb-input'
const STAGE = '.dshwb-stage'

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const opts = {
  phase: arg('phase', 'all'),
  headed: has('headed'),
  url: arg('url', null),
  out: arg('out', join(SHOTS, `e2e-c-all-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)),
  timeoutMs: Number(arg('timeout', 240_000)),
  drawPrompt: arg('draw-prompt', '在画板上画一个三栏看板：待办 / 进行中 / 完成，三列并排，画完告诉我你画了什么。'),
  sayPrompt: arg('say-prompt', '在白板上补一行标题：审批流程'),
  lookPrompt: arg(
    'look-prompt',
    '在画板上画一个简单的 3D 球（画板 tab 已经打开），画完后必须调用 whiteboard_look 看一下，最后用一句话说你看到了什么。',
  ),
  keepSession: has('keep-session'),
}
const PHASES = ['load', 'headline', 'say', 'regress', 'tools', 'look']
const RUN = opts.phase === 'all' ? PHASES : [opts.phase]
if (!RUN.every((p) => PHASES.includes(p))) {
  console.error(`e2e: unknown phase "${opts.phase}" (use ${PHASES.join('|')}|all)`)
  process.exit(2)
}

mkdirSync(SHOTS, { recursive: true })
const hostFile = join(HOME, 'host.json')
if (!existsSync(hostFile)) {
  console.error('e2e: no .wbdev/host.json — run: node scripts/dev.mjs start')
  process.exit(1)
}
const host = JSON.parse(readFileSync(hostFile, 'utf8'))
const url = opts.url ?? host.url
if (!url) {
  console.error('e2e: host.json has no url — run: node scripts/dev.mjs restart')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const report = {
  startedAt: new Date().toISOString(),
  phase: opts.phase,
  host: { port: host.port, profile: host.profile, startedAt: host.startedAt, logFile: host.logFile },
  build: host.build,
  url: url.replace(/(token=)[^&]+/, '$1***'),
  steps: [],
  boards: {},
  routes: [],
  console: [],
  pageErrors: [],
  failedRequests: [],
  httpErrors: [],
  screenshots: [],
  exports: [],
  phases: {},
}
let FAILS = 0
let PASSES = 0
const check = (name, ok, detail) => {
  const status = ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'
  if (status === 'PASS') PASSES++
  else if (status === 'FAIL') FAILS++
  report.steps.push({ name, status, detail })
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok === true
}
const shots = []
async function shot(page, name) {
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path })
  shots.push(path)
  report.screenshots = shots
  console.log(`      shot ${path}`)
  return path
}

// ---------------------------------------------------------------------------
// disk probes (host-side witnesses)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const boardFile = (sessionId) => join(BOARD_DIR, `${sessionId}.json`)

function readBoardDoc(sessionId) {
  try {
    return JSON.parse(readFileSync(boardFile(sessionId), 'utf8'))
  } catch {
    return null
  }
}

/** Where the Host writes frames captured by `whiteboard_look` / auto-frames. */
const FRAMES_DIR = join(BOARD_DIR, 'frames')

/** Every persisted frame, oldest first, with its byte size and mtime. */
function listFrames() {
  try {
    const out = []
    for (const session of readdirSync(FRAMES_DIR)) {
      const dir = join(FRAMES_DIR, session)
      if (!statSync(dir).isDirectory()) continue
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.png')) continue
        const file = join(dir, name)
        const st = statSync(file)
        out.push({ file, bytes: st.size, mtime: st.mtimeMs })
      }
    }
    return out.sort((a, b) => a.mtime - b.mtime)
  } catch {
    return []
  }
}

/** Read a PNG's signature and IHDR dimensions without an image decoder. */
function pngInfo(file) {
  try {
    const buf = readFileSync(file)
    const ok = buf.length >= 33
      && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    return {
      ok,
      width: ok ? buf.readUInt32BE(16) : 0,
      height: ok ? buf.readUInt32BE(20) : 0,
      bytes: buf.length,
      file,
    }
  } catch {
    return { ok: false, width: 0, height: 0, bytes: 0, file }
  }
}

function boardCounts(doc) {
  const board = doc?.board ?? doc ?? {}
  return {
    rev: typeof doc?.rev === 'number' ? doc.rev : (typeof board.rev === 'number' ? board.rev : 0),
    mode: board.mode ?? null,
    shapes: Array.isArray(board.canvas?.shapes) ? board.canvas.shapes.length : 0,
    objects: Array.isArray(board.scene?.objects) ? board.scene.objects.length : 0,
  }
}

function listBoardDocs() {
  try {
    return readdirSync(BOARD_DIR)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const id = n.slice(0, -5)
        const file = join(BOARD_DIR, n)
        return { name: n, id, legacy: n.startsWith(LEGACY_PREFIX), bytes: statSync(file).size, counts: boardCounts(readBoardDoc(id)) }
      })
  } catch {
    return []
  }
}

function listSessions() {
  try {
    const out = []
    for (const ws of readdirSync(SESSIONS_DIR)) {
      const wsDir = join(SESSIONS_DIR, ws)
      if (!statSync(wsDir).isDirectory()) continue
      for (const id of readdirSync(wsDir)) {
        const dir = join(wsDir, id)
        if (!statSync(dir).isDirectory()) continue
        const log = join(dir, 'session.v4.jsonl.zstd')
        if (!existsSync(log)) continue
        out.push({ id, log, bytes: statSync(log).size, mtime: statSync(log).mtimeMs })
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Decode one session log. The writer appends one zstd frame per flush, so the file
 * is a concatenation of frames; `zstdDecompressSync` decodes a single frame, hence
 * the magic scan.
 * @param sessionId - session whose `session.v4.jsonl.zstd` to read.
 * @returns parsed records (header first), or [] when unreadable.
 */
function sessionRecords(sessionId) {
  const entry = listSessions().find((s) => s.id === sessionId)
  if (!entry) return []
  const buf = readFileSync(entry.log)
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
      /* torn tail frame */
    }
  }
  const records = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* torn line */
    }
  }
  return records
}

const countTypes = (records) => {
  const out = {}
  for (const r of records) out[r.type] = (out[r.type] ?? 0) + 1
  return out
}
const toolCalls = (records) => records.filter((r) => r.type === 'tool/call').map((r) => r.data?.name).filter(Boolean)
const userTexts = (records) =>
  records
    .filter((r) => r.type === 'user/message')
    .flatMap((r) => (r.data?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text))
const resultTexts = (records) =>
  records
    .filter((r) => r.type === 'tool/result')
    .map((r) => ((r.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ')))

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------
const { pw, dir, pin } = await loadPlaywright()
report.pw = { dir, pin }
console.log(`e2e: playwright ${pin}; phase ${opts.phase}`)
console.log(`e2e: url ${report.url}`)

// Prefer the machine's Chrome so an npx Playwright package does not also need a
// matching browser revision. WebGL gets SwiftShader flags for the 3D phase.
const systemChrome = process.env.WBDEV_CHROME_PATH
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null)
const launchOptions = {
  headless: !opts.headed,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
}
if (systemChrome !== null && existsSync(systemChrome)) launchOptions.executablePath = systemChrome
else if (systemChrome !== null) console.log(`e2e: chrome not found at ${systemChrome}; falling back to Playwright's browser`)

const browser = await pw.chromium.launch(launchOptions)
report.browser = {
  version: browser.version(),
  executablePath: launchOptions.executablePath ?? null,
  args: launchOptions.args,
}
const context = await browser.newContext({
  viewport: { width: 1500, height: 950 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
  acceptDownloads: true,
})
const page = await context.newPage()
page.setDefaultTimeout(25_000)

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    report.console.push({ type: m.type(), text: m.text().slice(0, 1200), location: m.location() })
  }
})
page.on('pageerror', (e) => report.pageErrors.push(String(e?.stack ?? e).slice(0, 2000)))
page.on('requestfailed', (r) =>
  report.failedRequests.push({ url: r.url().slice(0, 400), error: r.failure()?.errorText ?? 'unknown' }),
)
page.on('response', async (r) => {
  const u = r.url()
  if (!/\/api\/whiteboard\./.test(u)) return
  const entry = { method: r.request().method(), path: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 200), status: r.status() }
  try {
    if ((r.headers()['content-type'] ?? '').includes('json')) entry.body = await r.json()
  } catch {
    /* body already consumed */
  }
  if (report.routes.length < 200) report.routes.push(entry)
})
page.on('response', (r) => {
  if (r.status() >= 400) report.httpErrors.push({ status: r.status(), url: r.url().slice(0, 400) })
})

const consoleErrors = () => report.console.filter((c) => c.type === 'error')

// ---- page helpers ---------------------------------------------------------

async function dismissOverlays() {
  for (let i = 0; i < 4; i++) {
    const cont = page.getByRole('button', { name: /^继续$|^Continue$/ })
    if (await cont.count()) {
      await cont.first().click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(700)
      continue
    }
    const dialog = page.getByRole('dialog')
    if (await dialog.count()) {
      const close = dialog.getByRole('button', { name: /关闭|close/i })
      if (await close.count()) {
        await close.first().click({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(500)
        continue
      }
    }
    break
  }
}

async function openApp() {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector('#root > *', { timeout: 60_000 })
  await page.waitForTimeout(2200)
  await dismissOverlays()
  report.theme = await page.evaluate(() => (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'))
  return page
}

const mainSessionId = () =>
  page.evaluate(() => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null)

async function selectSession(sessionId) {
  const row = page.locator(`[data-row-key="session:${sessionId}"]`)
  if (await row.count()) {
    await row.first().click()
    await page.waitForTimeout(1200)
    return true
  }
  return false
}

async function newSession() {
  const before = await mainSessionId()
  const btn = page.getByRole('button', { name: /^新建会话$|^new session$/i })
  await btn.first().click()
  await page.waitForTimeout(1800)
  const after = await mainSessionId()
  return { before, after, created: after !== null && after !== before }
}

async function ensureSidebar() {
  const open = page.getByRole('button', { name: /打开右侧边栏|open right sidebar/i })
  if (await open.count()) {
    await open.first().click()
    await page.waitForTimeout(1200)
  }
}

async function guideEntries() {
  return page.evaluate(() => {
    const titleEls = [...document.querySelectorAll('[class*="entryTitle"], [class*="entry_title"]')]
    const seen = new Set()
    const out = []
    for (const t of titleEls) {
      const card = t.closest('button, [role="button"]') ?? t.closest('[class*="entry"]')
      const title = (t.textContent ?? '').trim()
      if (!card || !title || seen.has(card)) continue
      seen.add(card)
      out.push({ title, html: (card.outerHTML ?? '').slice(0, 300) })
    }
    return out
  })
}

async function clickGuide(title) {
  return page.evaluate((wanted) => {
    const titles = [...document.querySelectorAll('[class*="entryTitle"], [class*="entry_title"]')]
    const hit = titles.find((el) => (el.textContent ?? '').trim() === wanted)
    const card = hit?.closest('[class*="entry"]') ?? hit?.parentElement
    const btn = card?.closest('button, [role="button"]') ?? card
    if (!btn) return false
    btn.click()
    return true
  }, title)
}

async function openWhiteboardTab() {
  await ensureSidebar()
  if ((await page.locator(ROOT).count()) === 0) {
    let entries = await guideEntries()
    if (entries.length === 0) {
      const addTab = page.getByRole('button', { name: /新标签页|new tab|add tab/i })
      if (await addTab.count()) {
        await addTab.first().click()
        await page.waitForTimeout(1200)
        entries = await guideEntries()
      }
    }
    const ok = await clickGuide('画板')
    if (!ok) throw new Error(`画板 guide card not found among [${entries.map((e) => e.title).join(' | ')}]`)
  }
  await page.waitForSelector(ROOT, { timeout: 20_000 })
  await page.waitForTimeout(1200)
  return boardDom()
}

async function closeWhiteboardTab() {
  if ((await page.locator(ROOT).count()) === 0) return true
  const close = page.getByRole('button', { name: /^关闭$|^Close$/ }).first()
  if (await close.count()) await close.click({ timeout: 8000 }).catch(() => {})
  for (let i = 0; i < 24; i++) {
    if ((await page.locator(ROOT).count()) === 0) return true
    await page.waitForTimeout(250)
  }
  return (await page.locator(ROOT).count()) === 0
}

async function boardDom() {
  return page.evaluate(
    (sel) => {
      const root = document.querySelector(sel.root)
      const board = document.querySelector(sel.board)
      const meta = document.querySelector(sel.meta)
      const countMatch = (meta?.innerText ?? '').match(/(\d+)/)
      return {
        present: Boolean(root),
        sessionId: root?.getAttribute('data-whiteboard') ?? null,
        view: board?.getAttribute('data-view') ?? null,
        pinned: board?.getAttribute('data-pinned') ?? null,
        meta: meta?.innerText ?? null,
        metaTone: meta?.getAttribute('data-tone') ?? null,
        count: countMatch ? Number(countMatch[1]) : null,
        canvasCount: document.querySelectorAll(`${sel.root} canvas`).length,
        hint: Boolean(document.querySelector(sel.hint)),
        stale: Boolean(document.querySelector(sel.stale)),
        input: Boolean(document.querySelector(sel.input)),
        // Whether the panel is fullscreen, i.e. whether the tab owns an input. The
        // tab offers one only when the conversation's composer is out of view.
        standalone: root?.getAttribute('data-standalone') ?? null,
        buttons: [...document.querySelectorAll(`${sel.root} button`)].map((b) => ({
          aria: b.getAttribute('aria-label'),
          text: (b.textContent ?? '').trim().slice(0, 12),
          disabled: b.disabled === true,
        })),
        text: (root?.innerText ?? '').slice(0, 900),
        tabTitles: [...document.querySelectorAll('[class*="tabTitle"], [class*="tab_title"]')].map((e) => (e.textContent ?? '').trim()),
        legacyHits: (document.documentElement.innerHTML.match(/session-whiteboard-[0-9a-z-]+/gi) ?? []).length,
      }
    },
    { root: ROOT, board: BOARD, meta: META, hint: HINT, input: INPUT, stale: '.dshwb-stale' },
  )
}

/**
 * Wait until the tab's count line equals a known surface count.
 *
 * The tab polls the state route (350 ms while a turn runs, 1.5 s idle), so right
 * after a tool call writes the document the meta line can still show the previous
 * revision. Waiting for the poll tick keeps the report from pairing a stale count
 * with a fresh document.
 * @param expected - surface count the document already has.
 * @param timeoutMs - how long to wait for the next poll.
 */
async function waitTabCount(expected, timeoutMs = 8000) {
  const started = Date.now()
  let dom = await boardDom()
  while (dom.count !== expected && Date.now() - started < timeoutMs) {
    await page.waitForTimeout(250)
    dom = await boardDom()
  }
  return { ok: dom.count === expected, dom, elapsedMs: Date.now() - started }
}

/**
 * Wait until a board document stops changing, then return its counts.
 *
 * A drawing turn writes one revision per tool batch, so a snapshot taken as soon as
 * the first batch lands can be several batches behind the tab's later poll. Waiting
 * for the document to be quiet keeps the report self-consistent.
 * @param sid - conversation whose board document to settle.
 * @param quietMs - how long the document must stay unchanged.
 * @param maxMs - give up waiting after this long.
 */
async function settleBoard(sid, quietMs = 2500, maxMs = 25_000) {
  const started = Date.now()
  let last = boardCounts(readBoardDoc(sid))
  let stableSince = Date.now()
  while (Date.now() - started < maxMs) {
    await page.waitForTimeout(400)
    const now = boardCounts(readBoardDoc(sid))
    if (now.rev !== last.rev || now.shapes !== last.shapes || now.objects !== last.objects) {
      last = now
      stableSince = Date.now()
      continue
    }
    if (Date.now() - stableSince >= quietMs) break
  }
  return last
}

/**
 * Identity of the dev Host right now: listener pid, boot timestamp, log file and
 * the client bundle it reports. Sampled at the start and at the end of a run so the
 * artifact can prove the Host was not restarted underneath it.
 */
function hostIdentity() {
  try {
    const out = execFileSync(process.execPath, [join(PLUGIN_DIR, 'scripts', 'dev.mjs'), 'status'], {
      cwd: PLUGIN_DIR,
      encoding: 'utf8',
      timeout: 30_000,
    })
    const client = /client\.js (\d+)B sha=([0-9a-f]+)/.exec(out)
    return {
      pid: /pid (\d+) alive/.exec(out)?.[1] ?? null,
      startedAt: /started ([\dT:.-]+Z)/.exec(out)?.[1] ?? null,
      logFile: /dev: log (.+)/.exec(out)?.[1]?.trim() ?? null,
      client: client ? { bytes: Number(client[1]), sha: client[2] } : null,
    }
  } catch (err) {
    return { error: String(err).slice(0, 240) }
  }
}

/** Every `whiteboard: adopted board <legacy> as <parent>` line in the home's logs. */
function adoptionLines() {
  const dir = join(HOME, 'logs')
  const out = []
  if (!existsSync(dir)) return out
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.log'))) {
    let text = ''
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /whiteboard: adopted board (\S+) as (\S+)/.exec(line)
      if (m) out.push({ legacy: m[1], parent: m[2], log: file })
    }
  }
  return out
}

/**
 * Compare the tab's count with the document on disk *in the same instant*.
 *
 * A drawing turn keeps writing batches, so a snapshot taken before the tab is opened
 * can be older than what the tab then polls. Both sides are re-read every iteration;
 * the assertion is that the tab shows the document that exists while it is observed.
 * @param sid - conversation the tab must be showing.
 * @param timeoutMs - how long to wait for a matching observation.
 */
async function tabMatchesDocument(sid, timeoutMs = 25_000) {
  const started = Date.now()
  let dom = await boardDom()
  let counts = boardCounts(readBoardDoc(sid))
  for (;;) {
    counts = boardCounts(readBoardDoc(sid))
    dom = await boardDom()
    const expected = dom.view === '3d' ? counts.objects : counts.shapes
    if (dom.count === expected) return { ok: true, dom, counts, elapsedMs: Date.now() - started }
    if (Date.now() - started > timeoutMs) return { ok: false, dom, counts, elapsedMs: Date.now() - started }
    await page.waitForTimeout(400)
  }
}

/**
 * Wait until no turn is open for a conversation, judged from the session log.
 *
 * Board mutations (undo/clear/export) must not be fired into a turn that is still
 * drawing: the drawing tool and the mutation both write the same document, and the
 * interleaving is not what the regression assertions are about.
 * @param sid - conversation whose turns to watch.
 * @param timeoutMs - give up after this long.
 */
async function waitForIdle(sid, timeoutMs = 240_000) {
  const started = Date.now()
  for (;;) {
    const records = sessionRecords(sid)
    const starts = records.filter((r) => r.type === 'turn/start').length
    const ends = records.filter((r) => r.type === 'turn/end').length
    const open = starts - ends
    if (open <= 0) return { ok: true, open, starts, ends, elapsedMs: Date.now() - started }
    if (Date.now() - started > timeoutMs) return { ok: false, open, starts, ends, elapsedMs: Date.now() - started }
    await page.waitForTimeout(700)
  }
}

const barButton = (label) => page.getByRole('button', { name: label, exact: true })

/**
 * Switch the board's surface when the bar offers the switch.
 *
 * The 2D/3D control exists only when both surfaces have content — with one surface
 * there is nothing to choose, because the board shows the one that has a drawing.
 * So this returns false instead of failing when there is no control to click.
 * @param mode - the surface to show.
 * @returns whether a control was clicked.
 */
async function setView(mode) {
  const label = mode === '3d' ? '3D' : '2D'
  const button = page.locator(`${ROOT} button`, { hasText: new RegExp(`^${label}$`) }).first()
  if ((await button.count()) === 0) return false
  await button.click()
  await page.waitForTimeout(1000)
  return true
}

async function mainComposer() {
  const found = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 60 && r.height > 12 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    // The shipped composer is a Lexical contenteditable; the whiteboard tab's own
    // input is <input class="dshwb-input"> and is excluded here.
    const candidates = [...document.querySelectorAll('[data-composer-input], [data-lexical-editor], [contenteditable="true"]')]
      .filter((el) => visible(el) && !el.closest('.dshwb-root'))
    const seat = [...document.querySelectorAll('[data-composer-seat]')].find(visible)
    const target = candidates.at(-1) ?? (seat ? seat.querySelector('[contenteditable="true"]') : null)
    if (!target) return false
    target.setAttribute('data-wbdev-main-composer', '1')
    return true
  })
  if (!found) throw new Error('main composer (Lexical contenteditable) not found')
  return page.locator('[data-wbdev-main-composer="1"]')
}

async function sendFromMainComposer(text) {
  for (let attempt = 0; attempt < 14; attempt++) {
    const box = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return r.width > 60 && r.height > 12 && s.visibility !== 'hidden' && s.display !== 'none'
      }
      // The shipped composer is a Lexical contenteditable; the whiteboard tab's
      // own input is <input class="dshwb-input"> and is excluded here. No injected
      // attribute is used, so a reload or re-render cannot invalidate the target.
      const candidates = [...document.querySelectorAll('[data-composer-input], [data-lexical-editor], [contenteditable="true"]')]
        .filter((el) => visible(el) && !el.closest('.dshwb-root'))
      const target = candidates.at(-1)
      if (target === undefined) return null
      target.focus()
      const r = target.getBoundingClientRect()
      return { x: Math.round(r.x + Math.min(r.width / 2, 200)), y: Math.round(r.y + r.height / 2) }
    })
    if (box !== null) {
      await page.mouse.click(box.x, box.y)
      await page.waitForTimeout(200)
      await page.keyboard.type(text, { delay: 5 })
      await page.waitForTimeout(200)
      await page.keyboard.press('Enter')
      return Date.now()
    }
    if (attempt === 4 || attempt === 9) await dismissOverlays().catch(() => {})
    await page.waitForTimeout(1200)
  }
  throw new Error('main composer not found after 14 attempts')
}

/** The panel chrome's presentation control, by its shipped copy (zh and en). */
const FULLSCREEN_ENTER = 'button[aria-label="全屏"], button[aria-label="Fullscreen"], button[title="全屏"], button[title="Fullscreen"]'
const FULLSCREEN_EXIT = 'button[aria-label="退出全屏"], button[aria-label="Exit fullscreen"], button[title="退出全屏"], button[title="Exit fullscreen"]'

/** Whether the tab currently owns an input (panel presented fullscreen). */
const tabStandalone = () =>
  page.evaluate(() => document.querySelector('.dshwb-root')?.getAttribute('data-standalone') === 'true')

/**
 * Put the panel into the presentation where the tab owns its input, or take it out.
 *
 * The tab deliberately offers an input only while the panel fills the window: docked
 * beside the conversation, the shipped composer is the one input, so anything that
 * wants to type in the tab has to enter the fullscreen presentation first.
 * @param on - true to enter fullscreen, false to return to the docked column.
 */
async function setTabFullscreen(on) {
  if (await tabStandalone() === on) return
  const enter = page.locator(FULLSCREEN_ENTER)
  const exit = page.locator(FULLSCREEN_EXIT)
  const button = (await enter.count()) > 0 ? enter.first() : exit.first()
  await button.click()
  for (let i = 0; i < 25; i++) {
    if (await tabStandalone() === on) {
      await page.waitForTimeout(250)
      return
    }
    await page.waitForTimeout(200)
  }
  throw new Error(`the panel did not ${on ? 'enter' : 'leave'} fullscreen`)
}

async function sendFromTabComposer(text) {
  await setTabFullscreen(true)
  const input = page.locator(`${ROOT} ${INPUT}`)
  await input.click()
  await input.fill(text)
  await page.waitForTimeout(120)
  await input.press('Enter')
  const sent = Date.now()
  await setTabFullscreen(false)
  return sent
}

const transcriptText = () =>
  page.evaluate(() => {
    const scroll = document.querySelector('[data-conversation-scroll]')
    return (scroll?.innerText ?? document.body.innerText ?? '').slice(0, 60_000)
  })

async function fetchState(sessionId) {
  return page.evaluate(async (sid) => {
    try {
      const res = await fetch(`api/whiteboard.state?sessionId=${encodeURIComponent(sid)}`, { cache: 'no-store' })
      return { status: res.status, json: await res.json().catch(() => null) }
    } catch (err) {
      return { error: String(err) }
    }
  }, sessionId)
}

async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return { ok: true, value, elapsedMs: Date.now() - started }
    if (Date.now() - started > timeoutMs) return { ok: false, value: null, elapsedMs: Date.now() - started }
    await page.waitForTimeout(intervalMs)
  }
}

/**
 * Select a conversation through the sidebar, tolerating a virtualized tree: the
 * row is looked up, scrolled into view and clicked, and the sidebar list is nudged
 * toward older rows while the row is not rendered yet.
 * @param sessionId - conversation to select.
 */
async function selectSessionRobust(sessionId) {
  const sel = `[data-row-key="session:${sessionId}"]`
  for (let i = 0; i < 30; i++) {
    const row = page.locator(sel)
    if ((await row.count()) > 0) {
      await row.first().scrollIntoViewIfNeeded().catch(() => {})
      await row.first().click().catch(() => {})
      await page.waitForTimeout(900)
      if ((await mainSessionId()) === sessionId) return true
    }
    await page.evaluate(() => {
      const row = document.querySelector('[data-row-key^="session:"]')
      let node = row?.parentElement ?? null
      while (node && node.scrollHeight <= node.clientHeight + 4) node = node.parentElement
      if (node) node.scrollTop = Math.min(node.scrollTop + Math.max(160, node.clientHeight * 0.7), node.scrollHeight)
    })
    await page.waitForTimeout(300)
  }
  return false
}

/**
 * Pick the conversation whose board the load phase should verify: the current one
 * when it already owns a board, else the richest migrated board on disk (selected
 * through the sidebar row, which carries `data-row-key="session:<id>"`). The
 * sidebar selection is shared UI state, but this is the dev Host and the check is
 * about a specific conversation's migrated board.
 * @returns the chosen session id plus whether it had to be selected.
 */
async function pickBoardConversation() {
  const current = await mainSessionId()
  const currentCounts = boardCounts(readBoardDoc(current))
  if (currentCounts.rev > 0) return { sid: current, selected: false, counts: currentCounts }
  const richest = listBoardDocs()
    .filter((b) => !b.legacy)
    .filter((b) => b.counts.rev > 0)
    .sort((a, b) => b.counts.shapes + b.counts.objects - (a.counts.shapes + a.counts.objects))[0]
  if (richest === undefined) return { sid: current, selected: false, counts: currentCounts }
  const selected = await selectSessionRobust(richest.id)
  const sid = selected ? ((await mainSessionId()) ?? current) : current
  return { sid, selected, counts: boardCounts(readBoardDoc(sid)) }
}

async function saveDownload(namePrefix, trigger) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), trigger()])
  const suggested = download.suggestedFilename()
  const path = join(SHOTS, `export-${namePrefix}-${suggested}`)
  await download.saveAs(path)
  const size = existsSync(path) ? statSync(path).size : 0
  report.exports.push({
    suggested,
    path,
    bytes: size,
    sha: existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12) : null,
  })
  return { suggested, path, size }
}

/**
 * Provenance of the client bundle the Host is actually serving: the boot entry for
 * this plugin must serve exactly `lib/client.js` from the workspace (plus the one
 * appended sourceMappingURL line), so a green run cannot be a stale bundle.
 */
async function bundleProvenance() {
  const served = await page.evaluate(async () => {
    const boot = globalThis.__DSH_BOOT__
    const entries = boot?.entries ?? []
    const entry = entries.find((e) => /whiteboard/.test(`${e.id ?? ''} ${e.url ?? ''}`))
    if (entry === undefined) return { ids: entries.map((e) => e.id) }
    const res = await fetch(entry.url, { cache: 'no-store' })
    const text = await res.text()
    return { id: entry.id, url: entry.url, rev: entry.rev, status: res.status, text }
  })
  if (served.text === undefined) return { ok: false, detail: `no whiteboard boot entry among ${JSON.stringify(served.ids)}` }
  const disk = join(PLUGIN_DIR, 'lib', 'client.js')
  const diskBytes = readFileSync(disk)
  const servedBytes = Buffer.from(served.text, 'utf8')
  const tail = servedBytes.length - diskBytes.length
  const head = servedBytes.subarray(0, diskBytes.length)
  const same = tail >= 0 && createHash('sha256').update(head).digest('hex') === createHash('sha256').update(diskBytes).digest('hex')
  return {
    ok: same,
    detail: `${served.id} rev ${served.rev} served ${servedBytes.length} B vs disk ${diskBytes.length} B (${tail} B sourceMappingURL tail)`,
    url: served.url,
    rev: served.rev,
  }
}

// ---------------------------------------------------------------------------
// phase: load
// ---------------------------------------------------------------------------
async function phaseLoad() {
  const boardsBefore = listBoardDocs()
  const sessionsAtStart = listSessions()
  await openApp()
  check('app loaded', true, `${await page.title()} (theme ${report.theme}, pw ${pin})`)
  const provenance = await bundleProvenance()
  report.bundle = { url: provenance.url, rev: provenance.rev, ok: provenance.ok }
  check('the Host serves the freshly built client bundle', provenance.ok, provenance.detail)
  check('no page errors at load', report.pageErrors.length === 0, `${report.pageErrors.length} page errors`)
  check('no console errors at load', consoleErrors().length === 0, `${consoleErrors().length} console errors`)
  check(
    'no failed requests at load',
    report.failedRequests.length === 0,
    report.failedRequests.map((r) => `${r.url} ${r.error}`).slice(0, 3).join(' | ') || 'none',
  )

  // (a) Whatever the app restored. After a restart that is usually a brand-new
  // conversation, which legitimately has no board document: assert that state
  // explicitly instead of asking it to carry the migrated one.
  const restored = await mainSessionId()
  const sessionsAfterBoot = listSessions()
  const restoredCounts = boardCounts(readBoardDoc(restored))
  report.phases.load = {
    restoredSessionId: restored,
    restoredCounts,
    sessions: { atStart: sessionsAtStart.length, afterBoot: sessionsAfterBoot.length },
  }
  check(
    'main session id in DOM',
    Boolean(restored && restored.startsWith('session-')),
    `${restored ?? 'missing'} (sessions at start ${sessionsAtStart.length} -> after boot ${sessionsAfterBoot.length})`,
  )
  if (restoredCounts.rev === 0) {
    check('restored conversation owns no board document yet', readBoardDoc(restored) === null, readBoardDoc(restored) === null ? 'no file' : 'file exists')
    const boardsAtOpen = listBoardDocs()
    const sessionsBeforeClick = listSessions().length
    const dom0 = await openWhiteboardTab()
    const sessionsAfterClick = listSessions().length
    const emptyShown = /画板还是空的/.test(dom0.text) || dom0.hint
    check('fresh conversation shows the empty-board state', emptyShown, (dom0.text.match(/画板还是空的[\s\S]{0,40}/) ?? [''])[0].replace(/\n/g, ' '))
    check('fresh conversation board count reads 0', dom0.count === 0, `meta ${dom0.meta ?? 'absent'}`)
    check(
      'opening the tab created no Session (immediately before/after the click)',
      sessionsAfterClick === sessionsBeforeClick,
      `${sessionsBeforeClick} -> ${sessionsAfterClick}`,
    )
    check('opening the tab created no board document', listBoardDocs().length === boardsAtOpen.length, `${listBoardDocs().length} documents`)
    await shot(page, 'c-00-empty-board')
    await closeWhiteboardTab()
  } else {
    check('restored conversation already owns a board', true, `rev ${restoredCounts.rev}, ${restoredCounts.shapes} shapes, ${restoredCounts.objects} objects`)
  }

  // (b) The conversation that adopted a migrated board, verified through its
  // document and through the state route the tab polls. NOTE: the sidebar renders
  // only the six most recent conversations and has no scroll container, so a
  // 14-hour-old conversation cannot be selected through the UI; the tab's data
  // source is asserted here, and the live render path by the headline phase.
  const legacyParents = listSessions()
    .filter((s) => s.id.startsWith(LEGACY_PREFIX))
    .map((s) => ({ legacy: s.id, parent: sessionRecords(s.id)[0]?.parentSession }))
    .filter((l) => typeof l.parent === 'string' && l.parent.startsWith('session-'))
  const migrated = legacyParents
    .map((l) => ({ ...l, counts: boardCounts(readBoardDoc(l.parent)) }))
    .filter((m) => m.counts.rev > 0)
    .sort((a, b) => b.counts.shapes + b.counts.objects - (a.counts.shapes + a.counts.objects))[0]
  report.phases.load.migratedParent = migrated ? { id: migrated.parent, legacy: migrated.legacy, counts: migrated.counts } : null
  report.phases.load.legacyParents = [...new Set(legacyParents.map((l) => `${l.legacy} -> ${l.parent}`))]
  if (migrated !== undefined) {
    check(
      'the migrated parent owns a board document',
      migrated.counts.rev > 0,
      `${migrated.parent} rev ${migrated.counts.rev}, ${migrated.counts.shapes} shapes, ${migrated.counts.objects} objects; file ${boardFile(migrated.parent)}`,
    )
    // Byte-identity only holds at adoption time: this run (and earlier ones) have
    // drawn on the parent board since, so the proof of adoption is the Host's own
    // log line, and the current sizes are reported for context instead.
    const adopted = adoptionLines().find((l) => l.legacy === migrated.legacy && l.parent === migrated.parent)
    check(
      'adoption is evidenced by the parent document (plugin logs are not in .wbdev/logs)',
      adopted !== undefined ? true : 'skip',
      adopted
        ? `whiteboard: adopted board ${adopted.legacy} as ${adopted.parent} (${adopted.log}); now ${statSync(boardFile(migrated.parent)).size} B vs legacy ${statSync(boardFile(migrated.legacy)).size} B (parent drawn on since adoption)`
        : `the wrapper log at ${join(HOME, 'logs')} only holds dev.mjs boot lines, so ctx.logger.info is not readable there; the parent document + state route below carry the evidence. Legacy source ${statSync(boardFile(migrated.legacy)).size} B, parent now ${statSync(boardFile(migrated.parent)).size} B`,
    )
    const migratedState = await fetchState(migrated.parent)
    const stateCounts = boardCounts(migratedState.json ? { board: migratedState.json.board } : null)
    check(
      'the state route serves the migrated board for that conversation',
      migratedState.status === 200 && stateCounts.rev === migrated.counts.rev && stateCounts.shapes === migrated.counts.shapes,
      `route ${migratedState.status} rev ${migratedState.json?.rev} / file rev ${migrated.counts.rev}, ${stateCounts.shapes} shapes`,
    )
    report.phases.load.migratedRoute = {
      status: migratedState.status,
      rev: migratedState.json?.rev,
      shapes: stateCounts.shapes,
      canUndo: migratedState.json?.canUndo,
    }
  } else {
    check('the migrated parent owns a board document', 'skip', 'no legacy session resolves to a parent with a board')
  }

  // The conversation on screen: the tab must be keyed by it and match its document
  // (empty conversation => the empty state, which the fresh-session case asserted).
  const sid = (await mainSessionId()) ?? restored
  const boardsAtTab = listBoardDocs()
  const sessionsBeforeClick = listSessions().length
  const dom = (await page.locator(ROOT).count()) > 0 ? await boardDom() : await openWhiteboardTab()
  const sessionsAfterClick = listSessions().length
  const doc = readBoardDoc(sid)
  const counts = boardCounts(doc)
  report.boards[sid] = { ...counts, bytes: doc ? statSync(boardFile(sid)).size : 0 }
  // The board is polled (350 ms while running, 1.5 s idle), so give the first paint
  // one tick before comparing the tab's count with the document on disk.
  const synced = await waitTabCount(dom.view === '3d' ? counts.objects : counts.shapes)
  check('whiteboard tab rendered', dom.present, dom.present ? '.dshwb-root' : '.dshwb-root missing')
  check('tab is keyed by the MAIN session', dom.sessionId === sid, `${dom.sessionId} vs ${sid}`)
  check('tab title is 画板', dom.tabTitles.includes('画板'), JSON.stringify(dom.tabTitles))
  // One conversation, one input: while the panel is docked beside the conversation,
// the shipped composer is the only one, so the tab must not offer a second.
check('docked tab offers no second input', !dom.input, dom.input ? 'input.dshwb-input present while docked' : 'none, as designed')
check('docked tab reports it is not standalone', dom.standalone === 'false', `data-standalone=${dom.standalone}`)
// …and it must offer one exactly when the panel fills the window and covers that composer.
await setTabFullscreen(true)
const wide = await boardDom()
check('fullscreen tab offers its own input', wide.input, wide.input ? 'input.dshwb-input present' : 'missing')
check('fullscreen tab reports it is standalone', wide.standalone === 'true', `data-standalone=${wide.standalone}`)
check(
  'fullscreen empty state points at the input it owns',
  wide.hint ? !/在对话里说想画什么/.test(wide.text) : true,
  wide.hint ? wide.text.slice(0, 120) : 'board not empty, copy not checked',
)
await shot(page, 'c-01b-fullscreen-input')
await setTabFullscreen(false)
const back = await boardDom()
check('returning to the docked column drops the input again', !back.input, back.input ? 'input.dshwb-input still present' : 'gone')
  check('no 「开始画板」 CTA (no child session in C mode)', !/开始画板/.test(dom.text), dom.text.slice(0, 80))
  check('no 「正在绘制」 pill', !/正在绘制/.test(dom.text), dom.text.slice(0, 80))
  check(
    'no conversation drawer / shipped composer inside the tab',
    !dom.buttons.some((b) => b.aria === '发送消息'),
    dom.buttons.map((b) => b.aria ?? b.text).join(', '),
  )
  check('board canvas mounted', dom.canvasCount > 0, `${dom.canvasCount} canvas`)
  check(
    'tab count matches this conversation\'s document',
    synced.ok,
    `tab ${synced.dom?.meta ?? dom.meta} vs doc ${dom.view === '3d' ? counts.objects : counts.shapes} ${dom.view} rev ${counts.rev} (poll sync ~${synced.elapsedMs} ms)`,
  )
  const legacyInDom = (await page.content()).match(/session-whiteboard-[0-9a-z-]+/gi) ?? []
  check('no legacy child-session id anywhere in the DOM', legacyInDom.length === 0, legacyInDom.slice(0, 3).join(' , ') || 'none')
  check(
    'opening the tab created no Session (immediately before/after the click)',
    sessionsAfterClick === sessionsBeforeClick,
    `${sessionsBeforeClick} -> ${sessionsAfterClick}`,
  )
  check('opening the tab created no board document', listBoardDocs().length === boardsAtTab.length, `${listBoardDocs().length} documents`)
  check(
    'no new legacy board documents created',
    listBoardDocs().filter((b) => b.legacy).length === boardsBefore.filter((b) => b.legacy).length,
    `${listBoardDocs().filter((b) => b.legacy).length} legacy docs`,
  )

  await shot(page, 'c-01-tab-migrated')
  report.phases.load.sessionId = sid
  report.phases.load.counts = counts
  report.phases.load.dom = { view: dom.view, count: synced.dom?.count ?? dom.count, canvas: dom.canvasCount }
  report.phases.load.sessions.beforeTabClick = sessionsBeforeClick
  report.phases.load.sessions.afterTabClick = sessionsAfterClick
  return sid
}

/**
 * Send one request from the main composer and measure the wall clock until the
 * board document first mutates and until its content first differs.
 * @param sid - conversation whose board document to watch.
 * @param prompt - text to send.
 */
async function measureMainTurn(sid, prompt) {
  const before = boardCounts(readBoardDoc(sid))
  const t0 = Date.now()
  await sendFromMainComposer(prompt)
  let firstMutationMs = null
  let firstShapeMs = null
  const drawn = await waitFor(async () => {
    const c = boardCounts(readBoardDoc(sid))
    if (c.rev > before.rev && firstMutationMs === null) firstMutationMs = Date.now() - t0
    const contentChanged = c.shapes !== before.shapes || c.objects !== before.objects
    if (contentChanged && firstShapeMs === null) firstShapeMs = Date.now() - t0
    return c.rev > before.rev && contentChanged ? c : null
  }, opts.timeoutMs, 250)
  return { before, drawn, firstMutationMs, firstShapeMs, after: boardCounts(readBoardDoc(sid)) }
}

// ---------------------------------------------------------------------------
// phase: headline
// ---------------------------------------------------------------------------
async function phaseHeadline() {
  await openApp()
  await ensureSidebar()
  const closed = await closeWhiteboardTab()
  check('tab closed before the headline test', closed, closed ? '.dshwb-root gone' : 'tab would not close')

  // The current conversation is the subject: model C gives it a board. (Creating a
  // new Session is optional: the app reuses an empty conversation, so `--new-session`
  // is only used against a fresh home where that is known to produce a new id.)
  const sid = await mainSessionId()
  const before = boardCounts(readBoardDoc(sid))
  // Cold vs warm matters for the latency number: the first request of a Session
  // pays for provider connect + prompt assembly, later ones do not.
  const priorRequests = sessionRecords(sid).filter((r) => r.type === 'request/header').length
  const coldStart = priorRequests === 0
  report.phases.headline = { sessionId: sid, before, priorRequests, coldStart }
  check(
    'conversation board document readable before the turn',
    Boolean(readBoardDoc(sid)) || before.rev === 0,
    `${before.rev} rev, ${before.shapes} shapes, ${before.objects} objects; ${coldStart ? 'cold (first request of the session)' : `warm (${priorRequests} earlier request(s))`}`,
  )

  const sessionsBefore = listSessions().map((s) => s.id).sort()
  const legacyBefore = listBoardDocs().filter((b) => b.legacy).length
  const cold = await measureMainTurn(sid, opts.drawPrompt)
  check('prompt sent from the MAIN composer (tab closed)', true, opts.drawPrompt.slice(0, 56))
  check(
    'board document changed with the tab closed',
    cold.drawn.ok,
    cold.drawn.ok
      ? `${cold.before.shapes}->${cold.after.shapes} shapes, ${cold.before.objects}->${cold.after.objects} objects; first mutation ~${cold.firstMutationMs ?? '?'} ms, first new content ~${cold.firstShapeMs ?? '?'} ms`
      : `no board change within ${opts.timeoutMs} ms (rev stayed ${cold.before.rev})`,
  )
  // The plugin opens the board by itself the first time a conversation's board
  // gains content (once per conversation), so what used to be "the tab stayed
  // closed" is now "nobody clicked, and the board came into view anyway".
  const revealed = await waitFor(async () => (await page.locator(ROOT).count()) > 0, 12_000)
  check(
    'the first drawing opened the board by itself',
    revealed.ok,
    revealed.ok ? `the whiteboard tab appeared without a click (~${revealed.elapsedMs} ms after the turn started)` : 'the tab never opened',
  )
  check('no Session was created by the drawing turn', listSessions().length === sessionsBefore.length, `${listSessions().length} sessions (was ${sessionsBefore.length})`)
  check('no legacy board document was created', listBoardDocs().filter((b) => b.legacy).length === legacyBefore, `${legacyBefore} legacy docs`)

  // Warm comparison measured in the same run: a second request on the same
  // conversation, so the release note can pair the cold number with a warm one.
  let warm = null
  if (cold.drawn.ok) {
    warm = await measureMainTurn(sid, '在画板上再加一行小字：审批通过')
    check(
      'a warm follow-up request draws too',
      warm.drawn.ok,
      warm.drawn.ok
        ? `${warm.before.shapes}->${warm.after.shapes} shapes; first mutation ~${warm.firstMutationMs ?? '?'} ms, first new content ~${warm.firstShapeMs ?? '?'} ms`
        : 'no second board change within the timeout',
    )
  }

  const idleAfterDraw = await waitForIdle(sid)
  check(
    'the drawing turn finished before the tab comparison',
    idleAfterDraw.ok,
    `turn/start ${idleAfterDraw.starts} / turn/end ${idleAfterDraw.ends} (waited ~${idleAfterDraw.elapsedMs} ms)`,
  )
  const finalCounts = await settleBoard(sid)
  const state = await fetchState(sid)
  const stateCounts = boardCounts(state.json ? { board: state.json.board } : null)
  check(
    'state route serves the same board as the document file',
    state.status === 200 && stateCounts.rev === finalCounts.rev,
    `route ${state.status} rev ${state.json?.rev} / file rev ${finalCounts.rev}`,
  )

  const transcript = await transcriptText()
  check(
    'main transcript grew with the turn',
    transcript.includes(opts.drawPrompt.slice(0, 8)) && transcript.length > 100,
    `${transcript.length} chars`,
  )
  const dom = await openWhiteboardTab()
  const tabSynced = await tabMatchesDocument(sid)
  check(
    'tab shows the board drawn while it was closed',
    tabSynced.ok && tabSynced.dom?.sessionId === sid,
    `tab data-whiteboard ${tabSynced.dom?.sessionId ?? 'missing'} count ${tabSynced.dom?.meta ?? 'none'} vs file ${boardFile(sid)} ${tabSynced.counts.shapes} shapes/${tabSynced.counts.objects} objects rev ${tabSynced.counts.rev} (matched after ~${tabSynced.elapsedMs} ms)`,
  )
  await shot(page, 'c-02-headline-board')

  report.phases.headline = {
    ...report.phases.headline,
    latency: {
      note: 'wall clock from the Enter press of the main composer to the board document mutation; it includes the provider round trip, so a cold first request of a Session is much slower than a warm follow-up measured in the same run',
      cold: { coldStart, priorRequests, firstMutationMs: cold.firstMutationMs, firstShapeMs: cold.firstShapeMs, boardBefore: cold.before },
      warm:
        warm === null
          ? null
          : { firstMutationMs: warm.firstMutationMs, firstShapeMs: warm.firstShapeMs, boardBefore: warm.before },
    },
    after: finalCounts,
    stateRoute: { status: state.status, rev: state.json?.rev, canUndo: state.json?.canUndo },
    replyText: transcript.slice(-700),
  }
  return sid
}

// ---------------------------------------------------------------------------
// phase: say
// ---------------------------------------------------------------------------
async function phaseSay() {
  await openApp()
  await openWhiteboardTab()
  const sid = await mainSessionId()
  const recordsBefore = countTypes(sessionRecords(sid))
  const transcriptBefore = await transcriptText()
  const routesBefore = report.routes.length

  const t0 = Date.now()
  await sendFromTabComposer(opts.sayPrompt)
  const echoed = await waitFor(async () => {
    const text = await transcriptText()
    return text.includes('审批流程') && text.length > transcriptBefore.length ? text : null
  }, 60_000, 400)
  check(
    'tab input appears in the main transcript',
    echoed.ok ? true : 'skip',
    echoed.ok
      ? `visible after ~${Date.now() - t0} ms`
      : 'not visible in the transcript pane (it virtualizes older turns); the session-log assertion below is the authoritative proof',
  )

  const answered = await waitFor(async () => {
    const counts = countTypes(sessionRecords(sid))
    return (counts['assistant/message'] ?? 0) > (recordsBefore['assistant/message'] ?? 0) ? counts : null
  }, opts.timeoutMs, 600)
  check(
    'assistant answered the tab input (host-side session log)',
    answered.ok,
    answered.ok
      ? `assistant/message ${recordsBefore['assistant/message'] ?? 0} -> ${answered.value['assistant/message']}`
      : 'no new assistant/message record',
  )

  const records = sessionRecords(sid)
  // A say can be queued behind a running turn (`mode: 'queue'` never interrupts),
  // so the user turn may arrive after the previous answer; wait for the record
  // instead of sampling once, and report where it landed.
  const splicedBefore = records.filter((r) => r.type === 'agent/inbox/spliced').length
  const userTurn = await waitFor(
    () => (userTexts(sessionRecords(sid)).some((t) => t.includes('审批流程')) ? sessionRecords(sid) : null),
    90_000,
    800,
  )
  let landed = null
  if (userTurn.ok) {
    const index = userTurn.value.findIndex(
      (r) => r.type === 'user/message' && (r.data?.content ?? []).some((c) => c.type === 'text' && (c.text ?? '').includes('审批流程')),
    )
    landed = { index, records: userTurn.value.length, elapsedMs: userTurn.elapsedMs, spliced: userTurn.value.filter((r) => r.type === 'agent/inbox/spliced').length }
  }
  check(
    'session log holds the tab input as a user turn',
    userTurn.ok,
    userTurn.ok
      ? `record #${landed.index} of ${landed.records} after ~${landed.elapsedMs} ms; agent/inbox/spliced ${splicedBefore} -> ${landed.spliced}`
      : `${userTexts(records).length} user turns, none with the text after 90 s`,
  )
  const idleAfterSay = await waitForIdle(sid)
  check(
    'the say turn finished',
    idleAfterSay.ok,
    `turn/start ${idleAfterSay.starts} / turn/end ${idleAfterSay.ends} (waited ~${idleAfterSay.elapsedMs} ms)`,
  )
  const usedRoute = report.routes.slice(routesBefore).filter((r) => r.path?.includes('whiteboard.say'))
  check('say path observed', true, usedRoute.length ? `POST /api/whiteboard.say x${usedRoute.length}` : 'client submission path (no route call)')

  const dom = await boardDom()
  check('tab still shows this conversation\'s board', dom.sessionId === sid, `${dom.sessionId} vs ${sid}`)
  await shot(page, 'c-03-say')

  report.phases.say = {
    sessionId: sid,
    echoMs: Date.now() - t0,
    transcriptChars: (await transcriptText()).length,
    records: { before: recordsBefore, after: countTypes(sessionRecords(sid)) },
    userTurnLanded: landed,
    sayRouteCalls: usedRoute.length,
    board: boardCounts(readBoardDoc(sid)),
  }
}

// ---------------------------------------------------------------------------
// phase: regress
// ---------------------------------------------------------------------------
async function phaseRegress() {
  await openApp()
  await openWhiteboardTab()
  const sid = await mainSessionId()
  // Never mutate while a turn is drawing; settle both the log state and the file.
  const idleAtRegress = await waitForIdle(sid)
  check('no turn is running before the regression checks', idleAtRegress.ok, `open turns ${idleAtRegress.open} (waited ~${idleAtRegress.elapsedMs} ms)`)
  await settleBoard(sid)
  let initial = boardCounts(readBoardDoc(sid))
  // A conversation that never drew has no board and no undo history, so seed one
  // through the tab's own input (which also exercises the say path again).
  if (initial.shapes === 0) {
    const t = Date.now()
    await sendFromTabComposer('在画板上画一个三行的清单：登录 / 校验 / 完成')
    const seeded = await waitFor(async () => {
      const c = boardCounts(readBoardDoc(sid))
      return c.shapes > 0 ? c : null
    }, opts.timeoutMs, 400)
    check('regression seed: 2D content drawn', seeded.ok, seeded.ok ? `${seeded.value.shapes} shapes after ~${Date.now() - t} ms` : 'no shapes within the timeout')
    initial = boardCounts(readBoardDoc(sid))
  }
  check('board has content to regress on', initial.shapes > 0 || initial.objects > 0, `${initial.shapes} shapes / ${initial.objects} objects`)
  await setView('2d')

  // 1. Undo button.
  const undoBtn = barButton('撤销')
  const undoEnabled = (await undoBtn.count()) > 0 && !(await undoBtn.isDisabled())
  check('undo button enabled after a draw', undoEnabled, undoEnabled ? 'canUndo=true' : 'button disabled/missing')
  if (undoEnabled) {
    const beforeUndo = boardCounts(readBoardDoc(sid))
    await undoBtn.click()
    const undone = await waitFor(async () => {
      const c = boardCounts(readBoardDoc(sid))
      return c.rev > beforeUndo.rev ? c : null
    }, 20_000, 300)
    check('undo button stepped the board back', undone.ok, undone.ok ? `rev ${beforeUndo.rev} -> ${undone.value.rev}` : 'rev did not move')
    report.phases.undo = { before: beforeUndo, after: boardCounts(readBoardDoc(sid)) }
    await shot(page, 'c-04-undo')
  }

  // 2. Ctrl+Z (the document-level keyboard path). If the button above consumed the
  //    only undoable step, arm one with a clear so the keyboard path is real.
  let undoableForKeys = !(await barButton('撤销').isDisabled().catch(() => true))
  if (!undoableForKeys) {
    const clearForStep = barButton('清空')
    if ((await clearForStep.count()) > 0) {
      await clearForStep.click()
      await page.waitForTimeout(250)
      const arm = page.getByRole('button', { name: /^确认清空$/ })
      if (await arm.count()) {
        await arm.first().click()
        await page.waitForTimeout(1500)
      }
      undoableForKeys = !(await barButton('撤销').isDisabled().catch(() => true))
    }
  }
  if (undoableForKeys) {
    // The handler ignores the shortcut while a text field has focus.
    const focusBefore = await page.evaluate(() => document.activeElement?.tagName ?? 'none')
    if (/INPUT|TEXTAREA/.test(focusBefore)) await page.keyboard.press('Escape')
    await page.locator(STAGE).click({ position: { x: 40, y: 40 } }).catch(() => {})
    const focusNow = await page.evaluate(() => ({ tag: document.activeElement?.tagName ?? 'none', cls: String(document.activeElement?.className ?? '').slice(0, 48) }))
    const beforeKey = boardCounts(readBoardDoc(sid))
    await page.keyboard.press('Control+Z')
    const keyUndone = await waitFor(async () => {
      const c = boardCounts(readBoardDoc(sid))
      return c.rev > beforeKey.rev ? c : null
    }, 15_000, 300)
    check(
      'Ctrl+Z stepped the board back',
      keyUndone.ok,
      keyUndone.ok
        ? `rev ${beforeKey.rev} -> ${keyUndone.value.rev} (focus ${focusNow.tag} ${focusNow.cls})`
        : `rev did not move (focus ${focusNow.tag} ${focusNow.cls})`,
    )
  } else {
    check('Ctrl+Z stepped the board back', 'skip', 'no undoable step available for the keyboard path')
  }

  // 3. Clear + undo-the-clear.
  const clearBtn = barButton('清空')
  if ((await clearBtn.count()) > 0) {
    const beforeClear = boardCounts(readBoardDoc(sid))
    await clearBtn.click()
    await page.waitForTimeout(300)
    const armed = await page.getByRole('button', { name: /^确认清空$/ }).count()
    check('clear arms on the first click', armed > 0, armed > 0 ? 'aria 确认清空' : 'no armed state')
    if (armed > 0) {
      await page.getByRole('button', { name: /^确认清空$/ }).first().click()
      const cleared = await waitFor(async () => {
        const c = boardCounts(readBoardDoc(sid))
        return c.shapes === 0 ? c : null
      }, 15_000, 300)
      check('clear emptied the 2D surface (host document)', cleared.ok, cleared.ok ? `rev ${beforeClear.rev} -> ${cleared.value.rev}, shapes 0` : `${boardCounts(readBoardDoc(sid)).shapes} shapes left`)
      await shot(page, 'c-05-clear')
      const undoAfterClear = barButton('撤销')
      if ((await undoAfterClear.count()) > 0 && !(await undoAfterClear.isDisabled())) {
        await undoAfterClear.click()
        const restored = await waitFor(async () => {
          const c = boardCounts(readBoardDoc(sid))
          return c.shapes > 0 ? c : null
        }, 15_000, 300)
        check('undo restores a cleared board', restored.ok, restored.ok ? `${restored.value.shapes} shapes back` : 'board stayed empty')
      }
    }
  }

  // 4. 2D <-> 3D toggle, with a 3D build through the tab input when the board has
  //    no scene yet (a 3D export needs objects to be worth anything).
  await setView('3d')
  if (boardCounts(readBoardDoc(sid)).objects === 0) {
    await waitForIdle(sid)
    const t = Date.now()
    await sendFromTabComposer('用 3D 场景搭一个小台灯')
    const built = await waitFor(async () => {
      const c = boardCounts(readBoardDoc(sid))
      return c.objects > 0 ? c : null
    }, opts.timeoutMs, 500)
    check('regression seed: 3D scene built', built.ok, built.ok ? `${built.value.objects} objects after ~${Date.now() - t} ms` : 'no objects within the timeout')
  }
  // Capture the 3D scene only after the turn ended: a mid-turn shot shows a
  // half-built lamp, which cannot answer "does a finished scene look right".
  const idleAfter3d = await waitForIdle(sid)
  check(
    'the 3D build turn finished before the screenshot',
    idleAfter3d.ok,
    `turn/start ${idleAfter3d.starts} / turn/end ${idleAfter3d.ends} (waited ~${idleAfter3d.elapsedMs} ms)`,
  )
  const seeded3d = await settleBoard(sid)
  const synced3d = await waitTabCount(seeded3d.objects, 20_000)
  const dom3d = synced3d.dom
  check('2D -> 3D toggle switches the surface', dom3d.view === '3d', `data-view=${dom3d.view}`)
  check('3D stage renders a canvas', dom3d.canvasCount > 0, `${dom3d.canvasCount} canvas, meta ${dom3d.meta}`)
  check(
    'the scene is finished when the screenshot is taken (file == tab)',
    synced3d.ok,
    `document ${seeded3d.objects} objects, tab ${synced3d.dom?.meta ?? dom3d.meta}, open turns ${idleAfter3d.open}`,
  )
  await page.waitForTimeout(1600)
  const shotCounts = boardCounts(readBoardDoc(sid))
  const shotDom = await boardDom()
  const shotPath = await shot(page, 'c-06-3d')
  report.phases.scene3d = {
    shot: shotPath,
    objectsAtShot: shotCounts.objects,
    tabMetaAtShot: shotDom.meta,
    openTurnsAtShot: idleAfter3d.open,
    note: 'objects counted from the document and the tab in the same instant as the screenshot, after turn/end',
  }
  await setView('2d')
  const dom2d = await boardDom()
  check('3D -> 2D toggle returns to the canvas', dom2d.view === '2d', `data-view=${dom2d.view}`)

  // 5. PNG export on both surfaces. If the clear above was not undone, draw again
  //    through the tab input so the export has something to render.
  if (boardCounts(readBoardDoc(sid)).shapes === 0) {
    await sendFromTabComposer('在画板上画一个两行的清单：待办 / 完成')
    await waitFor(async () => {
      const c = boardCounts(readBoardDoc(sid))
      return c.shapes > 0 ? c : null
    }, opts.timeoutMs, 400)
    await waitForIdle(sid)
  }
  const counts2d = boardCounts(readBoardDoc(sid))
  if (counts2d.shapes > 0) {
    try {
      const dl = await saveDownload('2d', () => barButton('导出').click())
      check('2D export downloads a PNG', /\.png$/i.test(dl.suggested) && dl.size > 1000, `${dl.suggested} ${dl.size} B`)
    } catch (err) {
      check('2D export downloads a PNG', false, err.message)
    }
  } else {
    check('2D export downloads a PNG', 'skip', '2D surface empty')
  }
  if (counts2d.objects > 0) {
    await setView('3d')
    await page.waitForTimeout(1200)
    try {
      const dl = await saveDownload('3d', () => barButton('导出').click())
      check('3D export downloads a PNG', /\.png$/i.test(dl.suggested) && dl.size > 1000, `${dl.suggested} ${dl.size} B`)
    } catch (err) {
      check('3D export downloads a PNG', false, err.message)
    }
    await setView('2d')
  } else {
    check('3D export downloads a PNG', 'skip', '3D surface empty')
  }

  // 6. Reload persistence. A drawing turn can still be flushing tool batches, so
  //    let the document settle first; persistence means the reload lost nothing,
  //    i.e. the revision never goes backwards and the content is still there.
  let settleRev = boardCounts(readBoardDoc(sid)).rev
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(500)
    const now = boardCounts(readBoardDoc(sid)).rev
    if (now === settleRev) break
    settleRev = now
  }
  const fileHash = () => createHash('sha256').update(readFileSync(boardFile(sid))).digest('hex').slice(0, 12)
  const beforeReload = boardCounts(readBoardDoc(sid))
  const hashBeforeReload = fileHash()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#root > *', { timeout: 60_000 })
  await page.waitForTimeout(2200)
  await dismissOverlays()
  // Before the board is opened again: what the reload left on disk.
  const diskRightAfterReload = boardCounts(readBoardDoc(sid))
  const hashRightAfterReload = fileHash()
  const domAfterReload = await openWhiteboardTab()
  const firstPaint = await boardDom()
  const afterReload = boardCounts(readBoardDoc(sid))
  const syncedReload = await waitTabCount(domAfterReload.view === '3d' ? afterReload.objects : afterReload.shapes)
  check(
    'board document did not regress across the reload (rev monotonic, content preserved)',
    afterReload.rev >= beforeReload.rev && afterReload.shapes >= beforeReload.shapes && afterReload.objects >= beforeReload.objects,
    `rev ${beforeReload.rev} -> ${afterReload.rev}, ${beforeReload.shapes}/${beforeReload.objects} -> ${afterReload.shapes}/${afterReload.objects} shapes/objects; file right after reload rev ${diskRightAfterReload.rev} hash ${hashBeforeReload} -> ${hashRightAfterReload}`,
  )
  check(
    'board survives a page reload (tab renders the document)',
    syncedReload.ok && (afterReload.shapes + afterReload.objects === 0 || (syncedReload.dom?.count ?? 0) > 0),
    `tab first paint ${firstPaint.meta ?? 'none'}, settled ${syncedReload.dom?.meta ?? domAfterReload.meta} (sync ~${syncedReload.elapsedMs} ms)`,
  )
  check('no console errors during the reload', consoleErrors().length === 0, `${consoleErrors().length} console errors`)
  await shot(page, 'c-07-reload')

  report.phases.reload = {
    beforeReload,
    diskRightAfterReload,
    hashBeforeReload,
    hashRightAfterReload,
    tabFirstPaint: { meta: firstPaint.meta, count: firstPaint.count },
    tabSettled: { meta: syncedReload.dom?.meta, count: syncedReload.dom?.count },
    revMonotonic: afterReload.rev >= beforeReload.rev,
  }
  report.phases.regress = {
    sessionId: sid,
    initial,
    after: boardCounts(readBoardDoc(sid)),
    undo: report.phases.undo,
    exports: report.exports,
  }
}

// ---------------------------------------------------------------------------
// phase: tools
// ---------------------------------------------------------------------------
async function phaseTools() {
  await openApp()
  await ensureSidebar()
  const sid = await mainSessionId()

  // **Authoritative host-side schema dump.** Every model request is recorded as a
  // `request/header` record whose `data.header.tools[]` is exactly the tool list
  // the agent was offered, so tool visibility can be asserted without asking the
  // model anything.
  const BOARD_TOOLS = new Set(['whiteboard_draw', 'whiteboard_3d', 'whiteboard_read', 'whiteboard_look', 'whiteboard_api'])
  const dump = listSessions().map(({ id }) => {
    const records = sessionRecords(id)
    const head = records[0] ?? {}
    const toolNames = new Set()
    let requests = 0
    for (const r of records) {
      if (r.type !== 'request/header') continue
      requests++
      for (const t of r.data?.header?.tools ?? []) if (t?.name) toolNames.add(t.name)
    }
    return {
      id,
      legacy: id.startsWith(LEGACY_PREFIX),
      origin: head.origin ?? 'main',
      parent: head.parentSession ?? null,
      requests,
      toolCount: toolNames.size,
      board: [...toolNames].filter((n) => BOARD_TOOLS.has(n)).sort(),
    }
  })
  report.toolSchemas = dump

  const currentMain = dump.filter((s) => !s.legacy && s.origin !== 'subagent' && s.board.length === BOARD_TOOLS.size)
  check(
    'main agent tool schema includes all five board tools',
    currentMain.length > 0,
    currentMain.length
      ? `${currentMain.length} main session(s) with ${currentMain[0].toolCount} tools incl. ${currentMain[0].board.join(', ')}`
      : `no main session offered the board tools (tool counts seen: ${[...new Set(dump.filter((s) => !s.legacy && s.origin !== 'subagent').map((s) => s.toolCount))].join(', ')})`,
  )
  const currentSubagents = dump.filter((s) => !s.legacy && s.origin === 'subagent')
  check(
    'no current subagent is offered a board tool',
    currentSubagents.length === 0 ? 'skip' : currentSubagents.every((s) => s.board.length === 0),
    currentSubagents.length
      ? `${currentSubagents.length} subagent session(s), tool counts ${[...new Set(currentSubagents.map((s) => s.toolCount))].join('/')}, board tools: ${currentSubagents.map((s) => s.board.join('+') || 'none').join(' , ')}`
      : 'no subagent request recorded yet (the probe below creates one)',
  )
  const legacyWithBoard = dump.filter((s) => s.legacy && s.board.length > 0)
  check(
    'only legacy whiteboard child sessions ever had the board tools as subagents',
    !dump.some((s) => !s.legacy && s.origin === 'subagent' && s.board.length > 0),
    `${legacyWithBoard.length} legacy child session(s) carry them (v1 whiteboard agents), ${currentSubagents.filter((s) => s.board.length > 0).length} current subagent session(s) do`,
  )

  const sessionsBefore = listSessions().map((s) => s.id)
  const prompts = [
    [
      '用 subagent 工具创建一个子代理，任务原话是：',
      '"检查你自己的工具列表里有没有 whiteboard_draw、whiteboard_3d、whiteboard_read、whiteboard_look、whiteboard_api 这五个工具。',
      '如果有，就调用 whiteboard_draw（ops 传空数组）并把结果贴出来；',
      '如果没有，只回复 NO_WHITEBOARD_TOOLS。"',
      '然后把子代理的最终回复原样贴给我，不要改写。',
    ].join('\n'),
    [
      '必须真的调用 subagent 工具（工具列表里名为 subagent 的那个）创建子代理，不要自己回答这个问题。',
      '子代理任务原话："检查你的工具列表里有没有 whiteboard_draw / whiteboard_3d / whiteboard_read / whiteboard_look / whiteboard_api；',
      '有就调用 whiteboard_draw（ops 传空数组），没有就只回复 NO_WHITEBOARD_TOOLS。"',
      '把子代理最终回复原样贴回来。',
    ].join('\n'),
  ]
  let replied = { ok: false, value: null, elapsedMs: 0 }
  const probeWait = Math.min(opts.timeoutMs, 90_000)
  for (const prompt of prompts) {
    await sendFromMainComposer(prompt)
    replied = await waitFor(async () => {
      const text = await transcriptText()
      return /NO_WHITEBOARD_TOOLS/i.test(text) ? text : null
    }, probeWait, 1500)
    if (replied.ok) break
    const fresh = listSessions().filter((s) => !sessionsBefore.includes(s.id) && !s.id.startsWith(LEGACY_PREFIX))
    if (fresh.length > 0) {
      // A subagent was spawned but has not answered yet: give it its own window.
      replied = await waitFor(async () => {
        const text = await transcriptText()
        return /NO_WHITEBOARD_TOOLS/i.test(text) ? text : null
      }, probeWait, 1500)
      if (replied.ok) break
    }
  }
  check(
    'subagent reported the board tools are absent',
    replied.ok ? true : 'skip',
    replied.ok
      ? 'reply contains NO_WHITEBOARD_TOOLS'
      : 'SKIP (the model did not spawn a subagent in this run) — the request/header schema dump above is the authoritative check',
  )

  const newSessions = listSessions().filter((s) => !sessionsBefore.includes(s.id) && !s.id.startsWith(LEGACY_PREFIX))
  const subagents = newSessions
    .map((s) => ({ ...s, records: sessionRecords(s.id) }))
    .filter((s) => s.records[0]?.origin === 'subagent' || s.records.some((r) => r.type === 'subagent/descriptor'))
  const sub = subagents.sort((a, b) => b.mtime - a.mtime)[0]
  check(
    'the subagent session exists (host-side)',
    sub ? true : 'skip',
    sub ? `${sub.id} (${sub.records.length} records)` : `SKIP — no subagent session among ${newSessions.length} new (the model did not spawn one)`,
  )
  if (sub) {
    const subCalls = [...new Set(toolCalls(sub.records))]
    const boardInSub = subCalls.filter((n) => /^whiteboard_/.test(n))
    check(
      'subagent session log never records a board tool call',
      boardInSub.length === 0,
      subCalls.length ? `subagent calls: ${subCalls.slice(0, 10).join(', ')}` : 'subagent made no tool calls',
    )
    // The schema dump for the new subagent is the decisive check: its own
    // `request/header` tool list must not contain a board tool.
    const subHeader = sub.records.find((r) => r.type === 'request/header')
    const subToolNames = (subHeader?.data?.header?.tools ?? []).map((t) => t?.name).filter(Boolean)
    const subBoard = subToolNames.filter((n) => BOARD_TOOLS.has(n))
    check(
      'the subagent\'s own request schema has no board tools',
      subHeader !== undefined && subBoard.length === 0,
      subHeader ? `${subToolNames.length} tools offered, board tools: ${subBoard.join(', ') || 'none'}` : 'the subagent recorded no request/header (it may not have called the model)',
    )
    const parent = sub.records[0]?.parentSession ?? null
    const parentIsMain = parent !== null && dump.some((s) => s.id === parent && s.origin !== 'subagent')
    check('the subagent hangs off the main conversation', parentIsMain, parent ? `parent ${parent}` : 'no parentSession in the subagent header')
    report.phases.tools = {
      subagentId: sub.id,
      subCalls,
      subToolCount: subToolNames.length,
      subBoardTools: subBoard,
      parent,
      transcriptTail: (await transcriptText()).slice(-800),
    }
  }
  await shot(page, 'c-08-tools')
  report.phases.tools = {
    ...(report.phases.tools ?? {}),
    mainToolCount: currentMain[0]?.toolCount ?? null,
    mainBoardTools: currentMain[0]?.board ?? [],
    scannedSessions: dump.length,
    sessionId: sid,
  }
}

// ---------------------------------------------------------------------------
// phase: look
// ---------------------------------------------------------------------------
/**
 * The picture loop: with the board tab on screen, the model draws and calls
 * `whiteboard_look`, the panel answers with a frame, and the Host persists it.
 * Both the tool call (session log) and the PNG (frame store) are host-side
 * witnesses, so a green result cannot be a transcript-only illusion.
 */
async function phaseLook() {
  await openApp()
  const fresh = await newSession()
  // Prefer the id the app reported after creating the conversation; `mainSessionId`
  // can still describe the previous one while the new view mounts.
  const sid = fresh.created ? fresh.after : ((await mainSessionId()) ?? fresh.before)
  if (sid === null) throw new Error('no main session after 新建会话')
  if ((await mainSessionId()) !== sid) {
    const selected = await selectSession(sid)
    if (!selected) throw new Error(`could not select the look conversation ${sid}`)
  }
  // The capture route is polled only while this tab is on screen; open it before
  // asking for a look, then let the model draw and inspect in the same turn.
  const dom = await openWhiteboardTab()
  if (dom.sessionId !== sid) throw new Error(`the tab is bound to ${dom.sessionId ?? 'none'}, expected ${sid}`)
  const framesBefore = listFrames()
  const turnsBefore = countTypes(sessionRecords(sid))
  const t0 = Date.now()
  await sendFromMainComposer(opts.lookPrompt)
  const started = await waitFor(() => {
    const counts = countTypes(sessionRecords(sid))
    return (counts['turn/start'] ?? 0) > (turnsBefore['turn/start'] ?? 0) ? counts : null
  }, 60_000, 500)
  check(
    'look turn started',
    started.ok,
    started.ok ? `turn/start ${started.value['turn/start']} (${started.elapsedMs} ms)` : 'no turn/start within 60 s',
  )
  const idle = await waitForIdle(sid, opts.timeoutMs)
  check(
    'look turn finished',
    idle.ok,
    `turn/start ${idle.starts} / turn/end ${idle.ends} (~${idle.elapsedMs} ms)`,
  )

  const calls = toolCalls(sessionRecords(sid))
  const lookCalls = calls.filter((name) => name === 'whiteboard_look')
  check(
    'whiteboard_look was called by the main agent',
    lookCalls.length > 0,
    lookCalls.length > 0
      ? `${lookCalls.length} whiteboard_look call(s)`
      : `no whiteboard_look in [${[...new Set(calls)].slice(0, 12).join(', ')}]`,
  )

  const grown = await waitFor(() => {
    const now = listFrames()
    return now.length > framesBefore.length ? now : null
  }, 30_000, 500)
  const beforeFiles = new Set(framesBefore.map((frame) => frame.file))
  const freshFrames = (grown.ok ? grown.value : listFrames()).filter((frame) => !beforeFiles.has(frame.file))
  check(
    'a new PNG frame was persisted under storages/whiteboard/frames',
    freshFrames.length > 0,
    `${framesBefore.length} -> ${framesBefore.length + freshFrames.length} frames`,
  )
  const newest = freshFrames.at(-1)
  const info = newest === undefined ? null : pngInfo(newest.file)
  check(
    'the captured frame is a valid PNG with dimensions',
    info?.ok === true,
    info === null ? 'no new frame' : `${info.width}x${info.height} ${info.bytes}B ${info.file}`,
  )
  const transcript = await transcriptText()
  await shot(page, 'c-09-look')
  report.phases.look = {
    sessionId: sid,
    elapsedMs: Date.now() - t0,
    newSession: fresh,
    turnStarted: started.ok,
    lookCalls,
    frames: freshFrames.map((frame) => frame.file),
    png: info,
    tab: { sessionId: dom.sessionId, view: dom.view, meta: dom.meta },
    transcriptTail: transcript.slice(-800),
  }
  return sid
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
// Sampled before and after the phases: if the dev Host is restarted underneath a
// run, the artifact must say so instead of looking like a product failure.
const hostAtStart = hostIdentity()
report.host = { ...report.host, atStart: hostAtStart }
let mainSid = null
try {
  if (RUN.includes('load')) mainSid = await phaseLoad()
  if (RUN.includes('headline')) mainSid = await phaseHeadline()
  if (RUN.includes('say')) await phaseSay()
  if (RUN.includes('regress')) await phaseRegress()
  if (RUN.includes('tools')) await phaseTools()
  if (RUN.includes('look')) mainSid = await phaseLook()
} catch (err) {
  check(`phase ${opts.phase} completed`, false, err.stack?.split('\n').slice(0, 3).join(' | ') ?? String(err))
  try {
    await shot(page, 'c-failure')
  } catch {
    /* page may be gone */
  }
}

// ---------------------------------------------------------------------------
// verdict + report
// ---------------------------------------------------------------------------
report.finishedAt = new Date().toISOString()
const hostAtEnd = hostIdentity()
const restartDetected = !(hostAtStart.pid === hostAtEnd.pid && hostAtStart.startedAt === hostAtEnd.startedAt)
report.host = { ...report.host, atEnd: hostAtEnd, restartDetected }
report.verdict = {
  passes: PASSES,
  fails: FAILS,
  mainSessionId: mainSid,
  consoleErrors: consoleErrors().length,
  pageErrors: report.pageErrors.length,
  failedRequests: report.failedRequests.length,
  httpErrors: report.httpErrors.length,
  host: {
    pid: hostAtEnd.pid,
    pidAtStart: hostAtStart.pid,
    startedAt: hostAtEnd.startedAt,
    startedAtStart: hostAtStart.startedAt,
    restartDetected,
    log: hostAtEnd.logFile,
  },
  build: {
    whiteboard: host.build?.whiteboard ?? null,
    sideChat: host.build?.sideChat ?? null,
    bundleRev: report.bundle?.rev ?? null,
    hostStartedAt: host.startedAt,
    hostLog: host.logFile,
  },
  boardDocs: listBoardDocs().map((b) => ({ id: b.id, legacy: b.legacy, bytes: b.bytes, shapes: b.counts.shapes, objects: b.counts.objects, rev: b.counts.rev })),
  sessions: listSessions().length,
}
writeFileSync(opts.out, JSON.stringify(report, null, 2))

console.log('')
console.log('--- summary ---')
console.log(`phase: ${opts.phase} | theme: ${report.theme ?? '?'} | session: ${report.verdict.mainSessionId ?? 'n/a'}`)
console.log(`assertions: ${PASSES} PASS, ${FAILS} FAIL`)
console.log(
  `errors: console ${report.verdict.consoleErrors}, page ${report.verdict.pageErrors}, http ${report.verdict.httpErrors}, failed-requests ${report.verdict.failedRequests}`,
)
for (const r of report.routes.slice(-6)) console.log(`route: ${r.method} ${r.path} -> ${r.status}`)
for (const b of report.verdict.boardDocs) {
  console.log(`board: ${b.id}${b.legacy ? ' (legacy)' : ''} rev=${b.rev} shapes=${b.shapes} objects=${b.objects} ${b.bytes}B`)
}
console.log(`report: ${opts.out}`)
console.log(`shots: ${shots.join(', ')}`)

await browser.close()
process.exitCode = FAILS === 0 ? 0 : 1
