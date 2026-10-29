/**
 * scripts/pw.mjs — where the dev harness finds Playwright.
 *
 * The harness deliberately does not vendor Playwright. It looks for a package
 * that already exists on the machine, in this order:
 *
 *   1. `WBDEV_PLAYWRIGHT_DIR` (a directory containing `index.js`),
 *   2. the workspace's own `node_modules/playwright-core` / `playwright`,
 *   3. an npm `_npx` cache entry (`~/.npm/_npx/<id>/node_modules/playwright[-core]`),
 *   4. the maintainer's pinned Windows pnpm store (kept for the original machine).
 *
 * The browser is a separate choice: `scripts/e2e.mjs` prefers a system Chrome
 * (`WBDEV_CHROME_PATH` or the macOS default) so an ephemeral npx package does not
 * need its own browser download. Set `WBDEV_PLAYWRIGHT_DIR` to any
 * `playwright`/`playwright-core` package directory if discovery picks the wrong one.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The maintainer's original pin, still used for the Windows store fallback. */
export const PLAYWRIGHT_PIN = '1.63.0'
const WINDOWS_STORE = 'H:/tauri/tauri_sylixos_monitor/node_modules/.pnpm'

/** Read the package version beside one entry point, for the run report. */
function packageVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Playwright packages cached by `npx`, newest-discovery order as read from disk. */
function npxCandidates() {
  const root = join(homedir(), '.npm', '_npx')
  if (!existsSync(root)) return []
  const found = []
  for (const name of readdirSync(root)) {
    const modules = join(root, name, 'node_modules')
    for (const pkg of ['playwright-core', 'playwright']) {
      const dir = join(modules, pkg)
      if (existsSync(join(dir, 'index.js'))) found.push(dir)
    }
  }
  return found
}

/**
 * Resolve one Playwright package directory.
 * @returns `{ dir, entry, pin }` where `pin` is the package's real version.
 * @throws when no package can be found.
 */
export function resolvePlaywright() {
  const candidates = [
    process.env.WBDEV_PLAYWRIGHT_DIR,
    join(process.cwd(), 'node_modules', 'playwright-core'),
    join(process.cwd(), 'node_modules', 'playwright'),
    ...npxCandidates(),
    `${WINDOWS_STORE}/playwright-core@${PLAYWRIGHT_PIN}/node_modules/playwright-core`,
  ].filter(Boolean)

  for (const dir of candidates) {
    const entry = join(dir, 'index.js')
    if (existsSync(entry)) return { dir, entry, pin: packageVersion(dir) }
  }

  if (existsSync(WINDOWS_STORE)) {
    for (const name of readdirSync(WINDOWS_STORE)) {
      if (!name.startsWith(`playwright-core@${PLAYWRIGHT_PIN}`)) continue
      const entry = join(WINDOWS_STORE, name, 'node_modules', 'playwright-core', 'index.js')
      if (existsSync(entry)) return { dir: dirname(entry), entry, pin: PLAYWRIGHT_PIN }
    }
  }

  throw new Error(
    'Playwright not found. Set WBDEV_PLAYWRIGHT_DIR to a playwright/playwright-core package directory, '
      + 'or make one available with: npx --yes playwright@1.63.0',
  )
}

/** Load the discovered package. */
export async function loadPlaywright() {
  const found = resolvePlaywright()
  const mod = await import(pathToFileURL(found.entry).href)
  return { pw: mod.default ?? mod, ...found }
}
