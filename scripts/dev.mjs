#!/usr/bin/env node
/**
 * scripts/dev.mjs — isolated development Host for dsh-plugin-whiteboard.
 *
 * The DeepSeek Harness desktop app that hosts the maintainer's own session loads
 * plugins at startup, so restarting it would kill that session. This script owns a
 * throwaway Harness home instead:
 *
 *   .wbdev/                      <- DSH_HOME (outside every repo, survive reinstall)
 *     .env, .credentials.yaml    <- copied once from the real DSH home
 *     profiles/wb/package.json   <- bundle selection: dsh-base, dsh-web-app, the plugins
 *     profiles/wb/cordis.patch.yml <- magpie provider + default model + theme
 *     logs/host-<stamp>.log      <- stdout/stderr of the detached Host
 *     host.json                  <- {pid, port, url, logFile, build fingerprints}
 *     shots/                     <- e2e screenshots
 *
 * Commands:
 *   node scripts/dev.mjs setup [--reset]      create/refresh .wbdev + link the plugins
 *   node scripts/dev.mjs start [--port N]     boot the Host detached, wait for HTTP readiness
 *   node scripts/dev.mjs stop                 stop the Host (and anything left on its port)
 *   node scripts/dev.mjs restart              stop + start
 *   node scripts/dev.mjs status               pid / port / HTTP / build fingerprints
 *   node scripts/dev.mjs logs [--tail N]      tail the current Host log
 *   node scripts/dev.mjs url [--show-token]   print the app URL (token masked by default)
 *   node scripts/dev.mjs rebuild              pnpm run build in the plugin, then restart
 *
 * Global flags: --home <dir>  --profile <name>  --port <n>  --show-token  --reset  --refresh
 *
 * Everything is plain Node (no dependencies) so it runs without a build step.
 */
import { spawnSync } from 'node:child_process'
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync, writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// The OS-specific primitives (shell, detach, port owner, liveness, teardown). Everything
// in this file is platform-neutral; see scripts/platform.mjs for the five that are not.
import {
  isAlive, killTree, listenerPid, quoteArgv, runShell, spawnDetached,
} from './platform.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const WORKSPACE = dirname(PLUGIN_DIR)

const WHITEBOARD_PKG = 'dsh-plugin-whiteboard'
const SIDE_CHAT_PKG = 'dsh-plugin-side-chat'
const SIDE_CHAT_DIR = join(WORKSPACE, SIDE_CHAT_PKG)
const PLUGIN_DIRS = [join(WORKSPACE, SIDE_CHAT_PKG), PLUGIN_DIR]
const BUNDLES_BASE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const DEFAULT_HOME = join(WORKSPACE, '.wbdev')
const DEFAULT_PROFILE = 'wb'
const DEFAULT_PORT = 57090
const REAL_DSH_HOME = process.env.WBDEV_REAL_HOME || join(homedir(), '.dsh')
// Files a test Host needs from the real home. .env carries MAGPIE_GATEWAY_KEY,
// .credentials.yaml the local secret store; the anonymous id keeps analytics quiet.
const HOME_FILES = ['.env', '.credentials.yaml', '.anonymous-user-id']

// The harness overlay patch (`.wbdev/config.patch.yml`, passed with `dsh --patch`
// on every boot). Only what chat needs: the magpie gateway, one default model, web
// search, the colour scheme, and the settings rows that keep the first-run wizard
// out of the way. No MCP servers (they slow boot and are not under test).
// It lives OUTSIDE the profile on purpose: the app's settings provider rewrites
// profiles/<name>/cordis.patch.yml, and the harness config must not be in the way.
const patchTemplate = (theme) => `# Harness config overlay for the throwaway dev Host — passed as \`dsh --patch\`.
# Not the profile's own cordis.patch.yml: the app's settings provider rewrites that
# one when a setting changes. scripts/dev.mjs setup regenerates this file.
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: ${theme}
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
    performanceUsage: detailed
- id: ui-settings-account
  name: "@deepseek-ai/dsh-client-ui-settings-account"
  config:
    version: 1
    step: done
    usage: detailed
    developerTools: true
    purpose: null
    process: standard
    completion: api-key
- id: session-log-deepseek
  name: "@deepseek-ai/dsh-session-log-deepseek"
  config:
    enabled: false
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      magpie:
        displayName: Magpie
        apiKeyEnv: MAGPIE_GATEWAY_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1
        models:
          - id: auto/deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash · Group · routing group
            contextWindow: 1000000
            maxTokens: 384000
            input: [text, image]
            reasoningEfforts:
              low: low
              high: high
              max: max
          - id: acoinfo/deepseek-flash
            name: DeepSeek V4.1 Flash · ACOINFO
            contextWindow: 1000000
            maxTokens: 384000
            input: [text, image]
            reasoningEfforts:
              low: low
              high: high
              max: max
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: magpie
    model: acoinfo/deepseek-flash
    reasoningEffort: max
- id: web-search-deepseek
  name: "@deepseek-ai/dsh-web-search-deepseek"
  config:
    apiKeyEnv: MAGPIE_GATEWAY_KEY
    baseURL: "http://127.0.0.1:3425/v1"
    model: "acoinfo/deepseek-flash"
`

const TEMPLATE_DARK = patchTemplate('dark')
const TEMPLATE_LIGHT = patchTemplate('light')
const TEMPLATES = { dark: TEMPLATE_DARK, light: TEMPLATE_LIGHT }

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const opts = {
    cmd: argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help',
    home: process.env.WBDEV_HOME || DEFAULT_HOME,
    profile: process.env.WBDEV_PROFILE || DEFAULT_PROFILE,
    port: Number(process.env.WBDEV_PORT || DEFAULT_PORT),
    theme: null,
    tail: 80,
    reset: false,
    refresh: false,
    showToken: false,
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--home') opts.home = argv[++i]
    else if (a === '--profile') opts.profile = argv[++i]
    else if (a === '--port') opts.port = Number(argv[++i])
    else if (a === '--tail') opts.tail = Number(argv[++i])
    else if (a === '--theme') opts.theme = argv[++i]
    else if (a === '--reset') opts.reset = true
    else if (a === '--refresh') opts.refresh = true
    else if (a === '--show-token') opts.showToken = true
    else die(`unknown argument: ${a}`)
  }
  if (opts.theme && !TEMPLATES[opts.theme]) die(`bad --theme: ${opts.theme} (dark|light)`)
  opts.home = resolve(opts.home)
  if (!/^[A-Za-z0-9._-]+$/.test(opts.profile)) die(`bad profile name: ${opts.profile}`)
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) die(`bad port: ${opts.port}`)
  return opts
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------
const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function die(msg) {
  console.error(`dev: ${msg}`)
  process.exit(1)
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

/** Child env: inherit the machine, drop the parent Harness session's DSH_* so the
 *  desktop app's home/profile/session can never leak into the throwaway Host. */
function hostEnv(home) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('DSH_')) delete env[key]
  env.DSH_HOME = home
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

/** Run the dsh CLI. Windows ships it as a batch launcher (`dsh.cmd`) and POSIX as an
 *  executable script, so one shell invocation covers both — the platform branch lives
 *  in runShell, not here. */
function runDsh(args, { home, cwd = PLUGIN_DIR, timeout = 300_000 } = {}) {
  return runShell(quoteArgv(['dsh', ...args]), { cwd, env: hostEnv(home), timeout })
}

async function probeHttp(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'wbdev/1' },
    })
    return { status: res.status, location: res.headers.get('location') ?? '' }
  } catch (err) {
    return { error: err?.code ?? err?.name ?? String(err) }
  }
}

function tailFile(path, lines = 80) {
  if (!existsSync(path)) return ''
  const text = readFileSync(path, 'utf8')
  const all = text.split(/\r?\n/)
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

function maskUrl(url) {
  return url ? url.replace(/([?&]token=)[^&]+/, '$1***') : url
}

/** sha256 + size of a built artifact, or null when it does not exist yet. */
function artifact(path) {
  try {
    const st = statSync(path)
    const buf = readFileSync(path)
    return { path, size: st.size, mtime: st.mtime.toISOString(), sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) }
  } catch {
    return null
  }
}

function buildState(pluginDir) {
  const index = artifact(join(pluginDir, 'lib', 'index.js'))
  const client = artifact(join(pluginDir, 'lib', 'client.js'))
  return { built: Boolean(index && client), index, client }
}

// ---------------------------------------------------------------------------
// paths derived from the options
// ---------------------------------------------------------------------------
function paths(opts) {
  const profileDir = join(opts.home, 'profiles', opts.profile)
  return {
    home: opts.home,
    profileDir,
    manifest: join(profileDir, 'package.json'),
    // owned by the app's settings provider — never written by this script
    profilePatch: join(profileDir, 'cordis.patch.yml'),
    // harness config overlay, passed to every boot with `dsh --patch`
    configPatch: join(opts.home, 'config.patch.yml'),
    homePatch: join(opts.home, 'cordis.patch.yml'),
    logs: join(opts.home, 'logs'),
    shots: join(opts.home, 'shots'),
    host: join(opts.home, 'host.json'),
  }
}

// The overlay file is shared by every profile in one home; keep the name per theme
// so a light home can never silently boot dark.
function configPatchPath(opts) {
  return paths(opts).configPatch
}

function readHost(opts) {
  return readJson(paths(opts).host, null)
}

function writeHost(opts, host) {
  writeJson(paths(opts).host, host)
}

function readLogUrl(logFile) {
  try {
    const text = readFileSync(logFile, 'utf8')
    const m = text.match(/https?:\/\/[^\s"'<>]*\?token=[^\s"'<>]+/)
    return m ? m[0] : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
function setup(opts) {
  const p = paths(opts)
  log(`dev: home ${p.home}`)
  log(`dev: profile ${opts.profile} (${p.profileDir})`)

  ensureDir(p.home)
  ensureDir(p.logs)
  ensureDir(p.shots)

  // 1. credentials / env from the real Harness home (only when missing).
  for (const name of HOME_FILES) {
    const dest = join(p.home, name)
    if (existsSync(dest)) continue
    const src = join(REAL_DSH_HOME, name)
    if (!existsSync(src)) {
      log(`dev: [warn] ${src} missing; skipped`)
      continue
    }
    copyFileSync(src, dest)
    log(`dev: copied ${name} from ${REAL_DSH_HOME}`)
  }
  if (!existsSync(join(p.home, '.env'))) {
    log('dev: [warn] no .env — chat needs MAGPIE_GATEWAY_KEY, copy it from the real home')
  }

  // 2. --reset: drop the installed profile but keep the patch config.
  if (opts.reset && existsSync(p.profileDir)) {
    const savedPatch = existsSync(p.profilePatch) ? readFileSync(p.profilePatch, 'utf8') : null
    rmSync(p.profileDir, { recursive: true, force: true })
    ensureDir(p.profileDir)
    if (savedPatch) writeFileSync(p.profilePatch, savedPatch)
    log('dev: reset profile (kept cordis.patch.yml)')
  }
  // The app's local settings provider REWRITES the profile's cordis.patch.yml when
  // a setting changes (that is where ui-settings-* and ui-theme durability land), so
  // the harness config lives in its own overlay file and is passed with --patch at
  // boot — the app never touches it.
  const configPatch = configPatchPath(opts)
  const existingConfig = existsSync(configPatch) ? readFileSync(configPatch, 'utf8') : ''
  const isStub = existingConfig.trim() === '' || /^(#[^\n]*\n)*\s*\[\]\s*$/.test(existingConfig)
  if (!existingConfig || isStub) {
    writeFileSync(configPatch, TEMPLATES[opts.theme ?? 'dark'])
    log(`dev: wrote ${configPatch} (theme ${opts.theme}, magpie provider, default model)`)
  } else if (opts.theme) {
    const want = TEMPLATES[opts.theme]
    if (existingConfig !== want) {
      writeFileSync(configPatch, want)
      log(`dev: rewrote ${configPatch} for theme ${opts.theme}`)
    }
  }
  // Migrate an old home whose model config sat in the profile patch: the app may
  // have overwritten it, and two copies would only confuse the picture.
  if (existsSync(p.profilePatch)) {
    const current = readFileSync(p.profilePatch, 'utf8')
    if (current.includes('id: llm-pi-ai') || current.startsWith('# Thin patch layer for the throwaway')) {
      writeFileSync(
        p.profilePatch,
        '# App-owned settings layer for this dev profile (ui-settings-*, ui-theme…).\n' +
          '# The harness model/theme config lives in the home overlay passed with --patch;\n' +
          '# scripts/dev.mjs never edits this file.\n[]\n',
      )
      log('dev: moved model config out of the profile patch into the overlay')
    }
  }

  // 3. initialize the profile if needed (dsh seeds base + writes the manifest).
  if (!existsSync(p.manifest)) {
    log(`dev: initializing profile ${opts.profile}`)
    const init = runDsh(['plugin', '--profile', opts.profile, 'add', `link:${toPosix(PLUGIN_DIRS[0])}`], { home: p.home })
    if (init.status !== 0) {
      console.error(init.out)
      die('profile initialization failed')
    }
    log('dev: profile initialized')
  }

  // 4. link every plugin under test (link: keeps the workspace checkout live).
  const manifest = readJson(p.manifest)
  if (!manifest) die(`cannot read ${p.manifest}`)
  for (const dir of PLUGIN_DIRS) {
    const pkg = readJson(join(dir, 'package.json'))
    if (!pkg) {
      log(`dev: [warn] no package.json in ${dir}; skipped`)
      continue
    }
    const want = `link:${toPosix(dir)}`
    const have = manifest.dependencies?.[pkg.name]
    if (!opts.refresh && have === want) {
      log(`dev: ${pkg.name} already linked`)
      continue
    }
    const add = runDsh(['plugin', '--profile', opts.profile, 'add', want], { home: p.home })
    if (add.status !== 0) {
      console.error(add.out)
      die(`failed to link ${pkg.name}`)
    }
    log(`dev: linked ${pkg.name} -> ${dir}`)
    const next = readJson(p.manifest)
    if (next) Object.assign(manifest, next)
  }

  // 5. bundle selection: base + web app first, then every linked plugin.
  const current = readJson(p.manifest)
  if (!current) die(`cannot read ${p.manifest}`)
  const linkedPlugins = PLUGIN_DIRS.map((d) => readJson(join(d, 'package.json'))?.name).filter(Boolean)
  const desired = [...BUNDLES_BASE, ...linkedPlugins]
  const existing = current.dsh?.profile?.bundles ?? []
  const merged = [...new Set([...desired, ...existing])]
  if (JSON.stringify(existing) !== JSON.stringify(merged)) {
    current.dsh ??= {}
    current.dsh.profile ??= {}
    current.dsh.profile.bundles = merged
    writeJson(p.manifest, current)
    log(`dev: bundles -> ${merged.join(', ')}`)
  }

  // 6. patch layer.
  if (!existsSync(p.profilePatch)) {
    writeFileSync(p.profilePatch, PATCH_TEMPLATE)
    log('dev: wrote cordis.patch.yml (magpie provider + default model)')
  }
  // An empty/comments-only patch file fails boot; the home-level layer is optional
  // but a stale one from a real home would drag MCP servers in, so never copy it.

  // 7. summary.
  log('')
  for (const dir of PLUGIN_DIRS) {
    const pkg = readJson(join(dir, 'package.json'))
    const st = buildState(dir)
    log(
      `dev: ${pkg?.name ?? dir}  built=${st.built ? 'yes' : 'NO'}` +
        (st.client ? `  client.js=${st.client.size}B sha=${st.client.sha256}` : '') +
        (st.index ? `  index.js=${st.index.size}B sha=${st.index.sha256}` : ''),
    )
  }
  log(`dev: harness overlay ${p.configPatch}`)
  log(`dev: app-owned profile patch ${p.profilePatch} (never edited by this script)`)
  log(`dev: next -> node scripts/dev.mjs start`)
}

function toPosix(p) {
  return p.replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------
async function start(opts) {
  const p = paths(opts)
  if (!existsSync(p.manifest)) die(`profile ${opts.profile} not initialized — run: node scripts/dev.mjs setup`)
  if (!existsSync(p.configPatch)) die(`missing harness overlay ${p.configPatch} — run: node scripts/dev.mjs setup`)

  const previous = readHost(opts)
  if (previous?.pid && (isAlive(previous.hostPid) || isAlive(previous.launcherPid))) {
    const probe = await probeHttp(previous.url ?? `http://127.0.0.1:${previous.port}/`)
    if (probe.status === 200 || probe.status === 303) {
      log(`dev: already running (pid ${previous.hostPid ?? previous.pid})`)
      log(`dev: url ${maskUrl(previous.url)}`)
      log(`dev: log ${previous.logFile}`)
      return
    }
    log(`dev: pid ${previous.hostPid ?? previous.pid} alive but not answering; restarting`)
    await stop(opts, { quiet: true })
  }

  const busy = listenerPid(opts.port)
  if (busy) await stop(opts, { quiet: true })
  const stillBusy = listenerPid(opts.port)
  if (stillBusy) die(`port ${opts.port} is already used by pid ${stillBusy} — stop it or pass --port`)

  ensureDir(p.logs)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const logFile = join(p.logs, `host-${stamp}.log`)
  const fd = openSync(logFile, 'w')
  writeSync(fd, `# wbdev host start ${new Date().toISOString()}\n# DSH_HOME=${p.home}\n# profile=${opts.profile} port=${opts.port}\n`)

  // Launcher flags (--patch) come before the app's own args (--port, --no-open).
  const args = ['--profile', opts.profile, '--patch', p.configPatch, '--port', String(opts.port), '--no-open']
  const child = spawnDetached(quoteArgv(['dsh', ...args]), {
    cwd: PLUGIN_DIR,
    env: hostEnv(p.home),
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)

  const state = {
    profile: opts.profile,
    home: p.home,
    port: opts.port,
    pid: child.pid,
    logFile,
    startedAt: new Date().toISOString(),
    baseUrl: `http://127.0.0.1:${opts.port}/`,
    url: null,
    build: { whiteboard: buildState(PLUGIN_DIR), sideChat: buildState(SIDE_CHAT_DIR) },
  }

  log(`dev: host pid ${child.pid} booting on port ${opts.port} (log ${logFile})`)
  const ready = await waitReady({ child, logFile, port: opts.port, timeoutMs: 90_000 })
  if (!ready) {
    writeJson(p.host, state)
    console.error('dev: host did not become ready; log tail:')
    console.error(tailFile(logFile, 40))
    await stop(opts, { quiet: true })
    process.exit(1)
  }

  state.url = ready
  // The detached launcher is a shell (cmd.exe or /bin/sh); the Host that owns the port
  // is its child, which is why the pid reported here is a launcher and not the Host.
  state.hostPid = listenerPid(opts.port) || child.pid
  state.launcherPid = child.pid
  writeHost(opts, state)
  log(`dev: ready in ${((Date.now() - Date.parse(state.startedAt)) / 1000).toFixed(1)}s (host pid ${state.hostPid})`)
  log(`dev: url ${maskUrl(state.url)}`)
  log(`dev: full url (with token) -> node scripts/dev.mjs url`)
  const wb = state.build.whiteboard
  log(
    `dev: whiteboard build at boot: ${wb.built ? `lib/index.js+lib/client.js sha=${wb.client.sha256} size=${wb.client.size}B` : 'NOT BUILT (bundle will be skipped by the loader)'}`,
  )
}

async function waitReady({ child, logFile, port, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  let url = null
  let foreignSince = 0
  while (Date.now() < deadline) {
    url ??= readLogUrl(logFile)
    if (url) {
      const probe = await probeHttp(url)
      if (probe.status === 200 || probe.status === 303) return url
    } else {
      // A 401 here is another Host already holding the port; its token never
      // appears in our log, so give up instead of burning the whole timeout.
      const probe = await probeHttp(`http://127.0.0.1:${port}/`)
      if (probe.status === 401) {
        foreignSince ||= Date.now()
        if (Date.now() - foreignSince > 8000) return null
      } else {
        foreignSince = 0
      }
    }
    if (!isAlive(child.pid)) return null
    await sleep(300)
  }
  return null
}

async function stop(opts, { quiet = false } = {}) {
  const p = paths(opts)
  const host = readHost(opts)
  // The port this home actually booted on: never fall back to the default while a
  // host.json records a different one, or `stop --home other` would kill the main
  // dev Host on the default port.
  const port = host?.port ?? opts.port
  const pids = new Set([host?.hostPid, host?.launcherPid, host?.pid].filter(Boolean))
  let killed = 0
  for (const pid of pids) {
    if (!isAlive(pid)) continue
    await killTree(pid)
    killed++
    if (!quiet) log(`dev: stopped pid ${pid} (port ${port})`)
  }
  // Anything else still holding the port (a reparented Host, a stale boot).
  for (let i = 0; i < 20; i++) {
    const busy = listenerPid(port)
    if (!busy) break
    await killTree(busy)
    killed++
    if (!quiet) log(`dev: stopped leftover listener pid ${busy} on port ${port}`)
    await sleep(250)
  }
  if (existsSync(p.host)) rmSync(p.host, { force: true })
  if (!killed && !quiet) log('dev: nothing was running')
  const leaked = listenerPid(port)
  if (leaked) die(`port ${port} still held by pid ${leaked}`)
}

// ---------------------------------------------------------------------------
// status / logs / url / rebuild / help
// ---------------------------------------------------------------------------
async function status(opts) {
  const p = paths(opts)
  const host = readHost(opts)
  const wb = buildState(PLUGIN_DIR)
  const listening = listenerPid(opts.port)
  if (!host) {
    log(`dev: no host.json (never started)  port=${opts.port} listener=${listening || 'none'}`)
  } else {
    const alive = isAlive(host.hostPid) || isAlive(host.launcherPid) || isAlive(host.pid)
    const probe = await probeHttp(host.url ?? `http://127.0.0.1:${opts.port}/`)
    log(
      `dev: pid ${host.hostPid ?? host.pid} alive=${alive} port=${host.port} listener=${listening || 'none'} http=${probe.status ?? probe.error}`,
    )
    log(`dev: url ${maskUrl(host.url)}`)
    log(`dev: log ${host.logFile}`)
    log(`dev: started ${host.startedAt}`)
  }
  log(
    `dev: whiteboard build now: ${wb.built ? 'yes' : 'NO'}` +
      (wb.client ? `  client.js ${wb.client.size}B sha=${wb.client.sha256} mtime=${wb.client.mtime}` : ''),
  )
  log(`dev: profile ${p.profileDir}`)
}

function logs(opts) {
  const host = readHost(opts)
  const p = paths(opts)
  const file = host?.logFile ?? newestLog(p.logs)
  if (!file) die('no log files yet')
  log(`dev: ${file}`)
  log(tailFile(file, opts.tail))
}

function newestLog(logsDir) {
  try {
    const files = readdirSync(logsDir)
      .filter((f) => f.startsWith('host-') && f.endsWith('.log'))
      .map((f) => ({ f, t: statSync(join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    return files.length ? join(logsDir, files[0].f) : null
  } catch {
    return null
  }
}

function printUrl(opts) {
  const host = readHost(opts)
  if (!host?.url) die('host is not running — node scripts/dev.mjs start')
  log(opts.showToken ? host.url : maskUrl(host.url))
}

async function rebuild(opts) {
  log('dev: pnpm run build')
  const res = runShell(quoteArgv(['pnpm', 'run', 'build']), {
    cwd: PLUGIN_DIR,
    env: hostEnv(paths(opts).home),
    timeout: 600_000,
  })
  const out = res.out
  if (res.status !== 0) {
    console.error(out.split(/\r?\n/).slice(-60).join('\n'))
    die(`build failed (exit ${res.status}) — host left as it was`)
  }
  log(out.split(/\r?\n/).slice(-5).join('\n'))
  const wb = buildState(PLUGIN_DIR)
  if (!wb.built) die('build exited 0 but lib/index.js or lib/client.js is missing')
  log(`dev: built lib/index.js ${wb.index.size}B sha=${wb.index.sha256} / lib/client.js ${wb.client.size}B sha=${wb.client.sha256}`)
  // Awaited: teardown is asynchronous on both platforms (taskkill / SIGTERM→SIGKILL),
  // and starting the new Host before the old one released the port is a race.
  await stop(opts, { quiet: true })
  await start(opts)
}

function help() {
  log(`usage: node scripts/dev.mjs <setup|start|stop|restart|status|logs|url|rebuild|verify> [flags]

  setup     create/refresh .wbdev (DSH_HOME) + profile ${DEFAULT_PROFILE} + link the plugins
  start     boot the Host detached (dsh --profile ${DEFAULT_PROFILE} --port ${DEFAULT_PORT} --no-open)
  stop      stop the Host and anything left listening on its port
  restart   stop + start
  status    pid / port / HTTP / build fingerprints
  logs      tail the current Host log   [--tail 80]
  url       print the app URL           [--show-token]
  rebuild   pnpm run build, then restart the Host
  verify    rebuild, then run scripts/e2e.mjs (the whole loop in one command)

flags: --home <dir> (default ${DEFAULT_HOME})  --profile <name>  --port <n>
       --theme dark|light (setup: colour scheme in the harness overlay)
       --reset (setup: reinstall the profile, keep the patch config)
       --refresh (setup: re-link the plugins even when the spec matches)
       --show-token (print the full tokenized URL)`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const opts = parseArgv(process.argv.slice(2))
switch (opts.cmd) {
  case 'setup':
    setup(opts)
    break
  case 'start':
    await start(opts)
    break
  case 'stop':
    await stop(opts)
    break
  case 'restart':
    await stop(opts, { quiet: true })
    await start(opts)
    break
  case 'status':
    await status(opts)
    break
  case 'logs':
    logs(opts)
    break
  case 'url':
    printUrl(opts)
    break
  case 'rebuild':
    await rebuild(opts)
    break
  case 'verify':
    await rebuild(opts)
    log('dev: e2e')
    {
      const res = spawnSync(process.execPath, ['scripts/e2e.mjs'], {
        cwd: PLUGIN_DIR,
        stdio: 'inherit',
        env: hostEnv(paths(opts).home),
      })
      process.exitCode = res.status ?? 1
    }
    break
  case 'help':
  default:
    help()
    if (opts.cmd !== 'help') process.exitCode = 1
}
