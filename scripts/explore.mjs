#!/usr/bin/env node
/**
 * scripts/explore.mjs — throwaway DOM reconnaissance against the running dev Host.
 *
 * Boots Chromium through the pinned playwright-core the machine already has
 * (see notes/harness.md), opens the app, dismisses the first-run preview notice,
 * and dumps the right sidebar's guide entries with their DOM markers — the facts
 * scripts/e2e.mjs asserts on. Screenshots and HTML snapshots land in .wbdev/shots/.
 *
 *   node scripts/explore.mjs [--headed] [--url <tokenized url>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const WORKSPACE = dirname(PLUGIN_DIR)
const HOME = process.env.WBDEV_HOME || join(WORKSPACE, '.wbdev')
const SHOTS = join(HOME, 'shots')

// Pinned Playwright: this machine ships playwright-core 1.63.0 in another
// project's pnpm store plus its chromium-1243 browsers at D:\Caches\playwright
// (PLAYWRIGHT_BROWSERS_PATH). See notes/harness.md.
const PINNED = '1.63.0'
function resolvePlaywright() {
  const candidates = [
    process.env.WBDEV_PLAYWRIGHT_DIR,
    join(WORKSPACE, 'node_modules', 'playwright-core'),
    `H:/tauri/tauri_sylixos_monitor/node_modules/.pnpm/playwright-core@${PINNED}/node_modules/playwright-core`,
  ].filter(Boolean)
  for (const dir of candidates) {
    const entry = join(dir, 'index.js')
    if (existsSync(entry)) return { dir, entry }
  }
  const store = 'H:/tauri/tauri_sylixos_monitor/node_modules/.pnpm'
  if (existsSync(store)) {
    for (const name of readdirSync(store)) {
      if (!name.startsWith(`playwright-core@${PINNED}`)) continue
      const entry = join(store, name, 'node_modules', 'playwright-core', 'index.js')
      if (existsSync(entry)) return { dir: dirname(entry), entry }
    }
  }
  throw new Error(
    `playwright-core ${PINNED} not found. Set WBDEV_PLAYWRIGHT_DIR=<package dir> (see notes/harness.md)`,
  )
}

async function loadPlaywright() {
  const { dir, entry } = resolvePlaywright()
  const mod = await import(pathToFileURL(entry).href)
  return { pw: mod.default ?? mod, dir }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const hostFile = join(HOME, 'host.json')
if (!existsSync(hostFile)) throw new Error('no .wbdev/host.json — run node scripts/dev.mjs start')
const host = JSON.parse(readFileSync(hostFile, 'utf8'))
const url = arg('url', host.url)
mkdirSync(SHOTS, { recursive: true })

const { pw, dir } = await loadPlaywright()
console.log(`pw: playwright-core from ${dir}`)
console.log(`url: ${url.replace(/(token=)[^&]+/, '$1***')}`)

const browser = await pw.chromium.launch({ headless: !has('headed'), args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
const page = await context.newPage()
const notes = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') notes.push(`[console.${m.type()}] ${m.text().slice(0, 400)}`)
})
page.on('pageerror', (e) => notes.push(`[pageerror] ${String(e).slice(0, 400)}`))

const shot = async (name) => {
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path })
  console.log(`shot: ${path}`)
}

/** Everything a selector could hang off, scoped to a region. */
const dumpRegion = async (label, rootSelector) =>
  page.evaluate(
    ({ label, rootSelector }) => {
      const root = rootSelector ? document.querySelector(rootSelector) : document.body
      if (!root) return { label, missing: rootSelector }
      const pick = (el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.className ?? '').toString().slice(0, 140),
        role: el.getAttribute('role'),
        aria: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 140),
        kids: el.children.length,
      })
      const tokens = new Set()
      for (const el of root.querySelectorAll('*')) {
        for (const c of (el.className ?? '').toString().split(/\s+/)) if (c) tokens.add(c)
      }
      return {
        label,
        text: (root.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 2500),
        buttons: [...root.querySelectorAll('button, [role="button"], [role="tab"], a')].map(pick).slice(0, 80),
        tokens: [...tokens].sort().slice(0, 250),
        svgCount: root.querySelectorAll('svg').length,
        canvasCount: root.querySelectorAll('canvas').length,
      }
    },
    { label, rootSelector },
  )

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForSelector('#root > *', { timeout: 60_000 }).catch(() => {})
await page.waitForTimeout(3000)
await shot('explore-01-app')

// First-run preview notice (Chinese UI): a primary 继续 (Continue) button.
const continueBtn = page.getByRole('button', { name: '继续', exact: true })
if (await continueBtn.count()) {
  await continueBtn.first().click()
  console.log('dismissed: first-run notice (继续)')
  await page.waitForTimeout(1200)
  await shot('explore-02-after-notice')
}

console.log(JSON.stringify(await dumpRegion('body', null), null, 2))

// Open the right sidebar if it is collapsed, then look at the guide.
const openRight = page.getByRole('button', { name: '打开右侧边栏' })
if (await openRight.count()) {
  await openRight.first().click()
  console.log('clicked: 打开右侧边栏')
  await page.waitForTimeout(1500)
}
await shot('explore-03-right-sidebar')

// The right sidebar's tab strip: its add-tab control opens the guide.
const addTab = page.getByRole('button', { name: '新标签页' })
if (await addTab.count()) {
  await addTab.first().click()
  console.log('clicked: 新标签页 (add tab)')
  await page.waitForTimeout(1500)
  await shot('explore-04-guide')
}

// Locate the right sidebar container from the collapse control's ancestor chain.
const sidebarInfo = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? '').includes('右侧边栏'),
  )
  if (!btn) return null
  const chain = []
  let el = btn
  for (let i = 0; i < 8 && el; i++) {
    chain.push({ tag: el.tagName.toLowerCase(), cls: (el.className ?? '').toString().slice(0, 160), kids: el.children.length })
    el = el.parentElement
  }
  return chain
})
console.log('--- right-sidebar control ancestor chain ---')
console.log(JSON.stringify(sidebarInfo, null, 2))

if (sidebarInfo) {
  // The docked pane's content root: last ancestor before the panel wrapper.
  const info = await dumpRegion('right-sidebar-ish', 'body')
  console.log('--- body after opening (buttons/tokens) ---')
  console.log(JSON.stringify({ text: info.text.slice(0, 1500), buttons: info.buttons, tokens: info.tokens }, null, 2))
}

writeFileSync(join(SHOTS, 'explore-05.html'), await page.content())
console.log('--- notes ---')
for (const n of notes) console.log(n)
await browser.close()
