// Sanity-check the committed runtime artifacts against the manifest and the
// wire contract in src/shared.ts.
//
// This is the last gate of `pnpm run check` that looks at what will actually be
// published, so it fails on the two mistakes a green typecheck cannot see: a
// runtime dependency that is not a shell platform module (the browser face would
// throw at load) and a route table that drifted from the contract (the two faces
// would talk past each other at runtime).
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const failures = []
const fail = (message) => failures.push(message)

/**
 * Packages the Host face may `import` at runtime.
 *
 * Only the one helper it genuinely needs: `defineTool`, from the tools runtime the
 * running installation owns (bundling it would pull in the tools runtime and its
 * own graph — see scripts/build.mjs). Everything else must arrive through a Cordis
 * service or a type-only import, which is erased.
 */
const HOST_RUNTIME_PACKAGES = new Set(['@deepseek-ai/dsh-tools'])

for (const path of [manifest.main, manifest.exports['./client'], manifest.dsh.bundle.patch]) {
  try { await stat(resolve(root, path)) } catch { fail(`missing ${path}`) }
}

// ---------------------------------------------------------------------------
// Browser face
// ---------------------------------------------------------------------------
const client = await readFile(resolve(root, 'lib/client.js'), 'utf8')
if (!client.includes(`window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}`)) {
  fail('lib/client.js does not register a factory under the package name')
}
if (/^\s*(import|export)\s/m.test(client)) fail('lib/client.js contains ESM syntax')
for (const match of client.matchAll(/require\("([^"]+)"\)/g)) {
  if (!/^(react|react\/jsx-runtime|react-dom|react-dom\/client|@deepseek-ai\/(cordis|dsh-client-store|dsh-client-ui-slots|dsh-client-ui-primitives|dsh-client-ui-dockkit)|zod|@tanstack\/react-virtual)$/.test(match[1])) {
    fail(`lib/client.js requires non-platform module ${match[1]}`)
  }
}
// three.js must be bundled into the browser face, not requested from the shell.
if (!client.includes('WebGLRenderer')) fail('lib/client.js does not carry the three.js renderer')
if (client.length < 400_000) fail(`lib/client.js looks too small for a bundled three.js (${client.length} bytes)`)

// ---------------------------------------------------------------------------
// Host face
// ---------------------------------------------------------------------------
const host = await readFile(resolve(root, 'lib/index.js'), 'utf8')
for (const match of host.matchAll(/from\s+"([^"]+)"/g)) {
  const specifier = match[1]
  if (specifier.startsWith('.')) {
    fail(`lib/index.js keeps relative import ${specifier}`)
    continue
  }
  // Node builtins are fine. A shared-identity dsh package is fine only when the
  // running installation owns it — that is what keeps brand checks (Session,
  // Agent, Context) working across the copy boundary — so the allowlist is
  // explicit instead of "anything that looks like a dsh package".
  if (specifier.startsWith('node:')) continue
  if (HOST_RUNTIME_PACKAGES.has(specifier)) continue
  fail(`lib/index.js imports undeclared runtime package ${specifier}`)}
// The Host face must not try to load three.js or DOM-only modules.
for (const forbidden of ['three', 'react-dom', 'react']) {
  if (new RegExp(`from\\s+"${forbidden}"`).test(host)) fail(`lib/index.js imports ${forbidden}`)
}

// ---------------------------------------------------------------------------
// Wire contract: every route the two faces share must be in the Host bundle,
// and no retired route may survive in either bundle.
// ---------------------------------------------------------------------------
const shared = await readFile(resolve(root, 'src/shared.ts'), 'utf8')
const routes = [...shared.matchAll(/export const (\w+_PATH)\s*=\s*'([^']+)'/g)].map(m => ({ name: m[1], path: m[2] }))
if (routes.length !== 7) fail(`expected 7 routes in src/shared.ts, found ${routes.length}`)
for (const { name, path } of routes) {
  if (!host.includes(path)) fail(`lib/index.js does not serve ${name} (${path})`)
}

/** Route names the retired child-Session design owned. */
const RETIRED_ROUTES = [
  '/api/whiteboard.create',
  '/api/whiteboard.prompt',
  '/api/whiteboard.cancel',
  '/api/whiteboard.close',
  '/api/whiteboard.list',
]
for (const retired of RETIRED_ROUTES) {
  if (host.includes(retired)) fail(`lib/index.js still serves retired route ${retired}`)
  if (client.includes(retired)) fail(`lib/client.js still calls retired route ${retired}`)
}

// The tools belong to the main agent, so their names travel through the Host.
for (const tool of ['whiteboard_draw', 'whiteboard_3d', 'whiteboard_read', 'whiteboard_look', 'whiteboard_api']) {
  if (!host.includes(tool)) fail(`lib/index.js does not register ${tool}`)
}
// Legacy boards are migrated once; the prefix must survive only for that.
if (!host.includes('session-whiteboard-')) fail('lib/index.js does not carry the legacy board prefix for migration')

// ---------------------------------------------------------------------------
// The bundle a Host actually loads must expose the plugin entry points.
// ---------------------------------------------------------------------------
const loaded = await import(pathToFileURL(resolve(root, manifest.main)).href)
if (loaded.name !== 'whiteboard') fail(`lib/index.js exports name ${String(loaded.name)}, expected "whiteboard"`)
if (typeof loaded.apply !== 'function') fail('lib/index.js has no apply()')
if (!Array.isArray(loaded.inject)) fail('lib/index.js has no inject array')
if (loaded.default !== undefined) fail('lib/index.js has a default export; the loader reads named exports')

const patch = await readFile(resolve(root, manifest.dsh.bundle.patch), 'utf8')
if (!patch.includes(`name: ${manifest.name}`)) fail('cordis.patch.yml row does not name the package')

if (failures.length > 0) {
  console.error(failures.map(f => `✗ ${f}`).join('\n'))
  process.exit(1)
}
console.log(`✓ artifacts consistent with package.json and the wire contract (${routes.length} routes, ${manifest.name}@${manifest.version})`)
