#!/usr/bin/env node
/**
 * scripts/theme.mjs — switch the dev Host's colour scheme through the app's own
 * Settings UI (no restart, no config editing).
 *
 * The `ui-theme` settings namespace is persisted host-side in
 * `$DSH_HOME/cordis.patch.yml`, so one click changes the theme for every browser
 * attached to the dev Host — including the icon-preview screenshots scripts/e2e.mjs
 * takes. The preference is durable: it survives the next `dev.mjs restart`.
 *
 *   node scripts/theme.mjs            # print the current preference
 *   node scripts/theme.mjs light      # 浅色
 *   node scripts/theme.mjs dark       # 深色
 *   node scripts/theme.mjs system     # 跟随系统
 *   [--headed] [--url <tokenized url>]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlaywright } from './pw.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const WORKSPACE = dirname(PLUGIN_DIR)
const HOME = process.env.WBDEV_HOME || join(WORKSPACE, '.wbdev')

const TARGETS = {
  light: { label: /^浅色$|^light$/i, dark: false },
  dark: { label: /^深色$|^dark$/i, dark: true },
  system: { label: /^跟随系统$|^system$/i, dark: null },
}

const argv = process.argv.slice(2)
const want = argv.find((a) => !a.startsWith('--')) ?? null
const headed = argv.includes('--headed')
const urlArg = (() => {
  const i = argv.indexOf('--url')
  return i === -1 ? null : argv[i + 1]
})()

const hostFile = join(HOME, 'host.json')
if (!existsSync(hostFile)) {
  console.error('theme: no .wbdev/host.json — run: node scripts/dev.mjs start')
  process.exit(1)
}
const host = JSON.parse(readFileSync(hostFile, 'utf8'))
const url = urlArg ?? host.url
if (want && !TARGETS[want]) {
  console.error(`theme: unknown target "${want}" (use light|dark|system)`)
  process.exit(1)
}

const { pw, pin } = await loadPlaywright()
const browser = await pw.chromium.launch({ headless: !headed, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()

const state = () =>
  page.evaluate(() => ({
    dark: document.body.hasAttribute('data-ds-dark-theme'),
    source: document.documentElement.dataset.dsThemeSource ?? null,
  }))

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForSelector('#root > *', { timeout: 60_000 })
await page.waitForTimeout(2000)
const cont = page.getByRole('button', { name: /^继续$|^Continue$/ })
if (await cont.count()) {
  await cont.first().click()
  await page.waitForTimeout(700)
}

if (!want) {
  const now = await state()
  console.log(`theme: dark=${now.dark} source=${now.source} (pw ${pin})`)
  await browser.close()
  process.exit(0)
}

// account menu -> 设置 -> 外观 cube
const acct = page.getByRole('button', { name: /账号菜单|account menu/i })
if (!(await acct.count())) throw new Error('account menu button not found')
await acct.first().click()
await page.waitForTimeout(700)
const settings = page.getByRole('menuitem', { name: /设置|settings/i })
if (!(await settings.count())) throw new Error('settings menu item not found')
await settings.first().click()
await page.waitForTimeout(1200)

const cubes = page.locator('[class*="themeCube"]')
const count = await cubes.count()
if (!count) throw new Error('theme cubes not found in the settings dialog')
const labels = []
for (let i = 0; i < count; i++) labels.push((await cubes.nth(i).innerText()).trim())
const target = TARGETS[want]
let clicked = false
for (let i = 0; i < count; i++) {
  const label = labels[i]
  if (!target.label.test(label)) continue
  await cubes.nth(i).click()
  clicked = true
  break
}
if (!clicked) throw new Error(`theme option not found among [${labels.join(', ')}]`)
await page.waitForTimeout(1200)
const after = await state()
const expected = target.dark
const ok = expected === null ? true : after.dark === expected
console.log(`theme: clicked "${want}" -> dark=${after.dark} source=${after.source} ${ok ? 'OK' : 'MISMATCH'}`)
if (!ok) process.exitCode = 1
await browser.close()
