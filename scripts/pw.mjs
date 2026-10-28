/**
 * scripts/pw.mjs — where the dev harness finds Playwright.
 *
 * The machine already has a pinned Playwright, so the harness never downloads one:
 *   playwright-core 1.63.0  (inside another project's pnpm store)
 *   chromium-1243 browsers  (PLAYWRIGHT_BROWSERS_PATH=D:\Caches\playwright,
 *                            also mirrored in %LOCALAPPDATA%\ms-playwright)
 * 1.63.0's browsers.json pins chromium-1243, which is exactly what is installed,
 * so `chromium.launch()` works with no network access.
 *
 * Override with WBDEV_PLAYWRIGHT_DIR=<dir containing index.js> or
 * WBDEV_PLAYWRIGHT_DIR points at any playwright/playwright-core package.
 * If that copy ever disappears, install the same pin with:
 *   npx --yes playwright@1.63.0
 * and point WBDEV_PLAYWRIGHT_DIR at the npx cache directory.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PLAYWRIGHT_PIN = '1.63.0'
const STORE = 'H:/tauri/tauri_sylixos_monitor/node_modules/.pnpm'

export function resolvePlaywright() {
  const candidates = [
    process.env.WBDEV_PLAYWRIGHT_DIR,
    // a workspace install, if someone adds one later
    join(process.cwd(), 'node_modules', 'playwright-core'),
    `${STORE}/playwright-core@${PLAYWRIGHT_PIN}/node_modules/playwright-core`,
  ].filter(Boolean)
  for (const dir of candidates) {
    const entry = join(dir, 'index.js')
    if (existsSync(entry)) return { dir, entry, pin: PLAYWRIGHT_PIN }
  }
  if (existsSync(STORE)) {
    for (const name of readdirSync(STORE)) {
      if (!name.startsWith(`playwright-core@${PLAYWRIGHT_PIN}`)) continue
      const entry = join(STORE, name, 'node_modules', 'playwright-core', 'index.js')
      if (existsSync(entry)) return { dir: dirname(entry), entry, pin: PLAYWRIGHT_PIN }
    }
  }
  throw new Error(
    `playwright-core ${PLAYWRIGHT_PIN} not found. Set WBDEV_PLAYWRIGHT_DIR to a playwright package directory, ` +
      `or install the pin with: npx --yes playwright@${PLAYWRIGHT_PIN}`,
  )
}

export async function loadPlaywright() {
  const found = resolvePlaywright()
  const mod = await import(pathToFileURL(found.entry).href)
  return { pw: mod.default ?? mod, ...found }
}
