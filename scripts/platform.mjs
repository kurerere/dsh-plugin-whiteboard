/**
 * scripts/platform.mjs — the OS primitives `scripts/dev.mjs` stands on.
 *
 * dev.mjs used to speak only cmd.exe: every command went through `%ComSpec% /d /s /c`,
 * the port owner came from `netstat`, liveness from `tasklist`, and teardown from
 * `taskkill`. That is why the harness was Windows-only. The primitives below are the
 * *only* OS-specific code left — each has a Windows branch and a POSIX branch, and the
 * rest of the script never asks which OS it is on.
 *
 *   runShell / runArgv       run a command to completion, stdout+stderr merged
 *   spawnDetached            start a process in its own group/session and return at once
 *   listenerPid              pid of whatever LISTENs on a TCP port (netstat / lsof)
 *   isAlive                  does this pid still exist (signal 0 — no external tool)
 *   killTree                 SIGTERM→SIGKILL the process group / taskkill the tree
 *
 * Kept out of dev.mjs so the parsers are reachable from a unit test that runs on any
 * platform (scripts/platform.test.mjs); CI is what proves the POSIX branch, because a
 * contributor's machine can only run one of the two.
 *
 * Plain Node, no dependencies, like the rest of scripts/.
 */
import { spawn, spawnSync } from 'node:child_process'

export const IS_WINDOWS = process.platform === 'win32'

const COMSPEC = process.env.ComSpec || 'cmd.exe'
const POSIX_SHELL = '/bin/sh'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// quoting
// ---------------------------------------------------------------------------

/**
 * Quote one argument for the shell the command line will be handed to.
 *
 * Windows (`cmd.exe`): wrap when the argument carries whitespace or a metacharacter,
 * and escape embedded quotes the way the MSVC runtime splits argv. POSIX (`sh`):
 * wrap in single quotes, escaping a single quote as `'\''` — the only sequence `sh`
 * cannot misread.
 */
export function quoteArg(arg) {
  const s = String(arg)
  if (IS_WINDOWS) return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** One argv, quoted and joined into a single shell command line. */
export function quoteArgv(argv) {
  return argv.map(quoteArg).join(' ')
}

// ---------------------------------------------------------------------------
// running a command
// ---------------------------------------------------------------------------

/**
 * Run one shell command line to completion.
 *
 * `windowsVerbatimArguments` is load-bearing on Windows: without it Node re-quotes the
 * single `/c` argument and cmd.exe sees literal backslash-escaped quotes. Spawning
 * through ComSpec explicitly (instead of `shell: true`) keeps Node's deprecation
 * warning out of the output and the quoting ours.
 */
export function runShell(cmdline, { cwd, env, timeout = 300_000 } = {}) {
  const res = IS_WINDOWS
    ? spawnSync(COMSPEC, ['/d', '/s', '/c', `"${cmdline}"`], {
        cwd,
        env,
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawnSync(POSIX_SHELL, ['-c', cmdline], { cwd, env, encoding: 'utf8', timeout })
  return {
    status: res.status,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim(),
    error: res.error,
  }
}

/** Run an argv through the platform shell. */
export function runArgv(argv, opts) {
  return runShell(quoteArgv(argv), opts)
}

/**
 * Start a process that must outlive this script: new session (POSIX) / detached
 * console (Windows), stdio handed to the caller, and `unref()` so the script can exit.
 *
 * The detached child is a process-group leader on POSIX, which is what lets
 * `killTree` signal the whole tree later.
 */
export function spawnDetached(cmdline, { cwd, env, stdio }) {
  const child = IS_WINDOWS
    ? spawn(COMSPEC, ['/d', '/s', '/c', `"${cmdline}"`], {
        cwd,
        env,
        detached: true,
        windowsHide: true,
        stdio,
        windowsVerbatimArguments: true,
      })
    : spawn(POSIX_SHELL, ['-c', cmdline], { cwd, env, detached: true, stdio })
  child.unref()
  return child
}

// ---------------------------------------------------------------------------
// process liveness and teardown
// ---------------------------------------------------------------------------

/**
 * Does this pid still exist? `signal 0` asks the kernel without touching the process,
 * so this needs no `tasklist`/`ps` and behaves the same on every OS. EPERM means the
 * process is there but belongs to another user — alive, which is what the caller asks.
 */
export function isAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * Kill one pid and its tree.
 *
 * Windows: `taskkill /T /F` walks the tree. POSIX: the Host was spawned detached, so
 * its pid leads its own process group and a negative pid signals the group; a pid that
 * is not a group leader (a listener found by `lsof`) makes that throw, and the plain
 * pid is signalled instead. Escalate SIGTERM→SIGKILL and wait in between, because a
 * Host that is mid-write should get the chance to flush.
 */
export async function killTree(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return
  if (IS_WINDOWS) {
    runShell(`taskkill /PID ${n} /T /F`)
    return
  }
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    if (!isAlive(n)) return
    try {
      process.kill(-n, sig)
    } catch {
      try {
        process.kill(n, sig)
      } catch {
        /* already gone */
      }
    }
    for (let i = 0; i < 20 && isAlive(n); i++) await sleep(100)
  }
}

// ---------------------------------------------------------------------------
// which pid listens on a TCP port
// ---------------------------------------------------------------------------

/** Parse `netstat -ano -p tcp` for the pid LISTENing on `port`. Exported to be tested. */
export function parseNetstat(text, port) {
  for (const line of String(text).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const [, local, , state, pid] = cols
    if (!String(local).endsWith(`:${port}`)) continue
    if (state !== 'LISTENING') continue
    return Number(pid) || 0
  }
  return 0
}

/** Parse `lsof -t` output (one pid per line) for the first listener. Exported to be tested. */
export function parseLsof(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)$/)
    if (m) return Number(m[1])
  }
  return 0
}

let lsofMissing = false
let netstatMissing = false

/** Whether this platform has a working way to name a port's owner (used by tests/CI). */
export function listenerPidSupported() {
  if (IS_WINDOWS) return !netstatMissing
  return !lsofMissing
}

/**
 * Pid LISTENing on a TCP port, or 0 when nothing is (or when this platform cannot say).
 *
 * Returning 0 rather than throwing on a missing tool is deliberate: every caller treats
 * 0 as "port free", and the Host's own boot failure is the honest symptom if the tool is
 * absent. A warning is printed once so the degradation is not silent.
 */
export function listenerPid(port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n <= 0) return 0
  if (IS_WINDOWS) {
    if (netstatMissing) return 0
    const res = runShell('netstat -ano -p tcp')
    if (res.status !== 0 && !res.out) {
      netstatMissing = true
      warnOnce('netstat is unavailable; port-owner detection is off')
      return 0
    }
    return parseNetstat(res.out, n)
  }
  if (lsofMissing) return 0
  const res = runShell(`lsof -nP -iTCP:${n} -sTCP:LISTEN -t`)
  // lsof exits 1 with empty output when nothing matches; 127 means it is not installed.
  if (res.status === 127 || /not found|command not found/i.test(res.out)) {
    lsofMissing = true
    warnOnce('lsof is not installed; port-owner detection is off (brew install lsof / apt install lsof)')
    return 0
  }
  return parseLsof(res.out)
}

const warned = new Set()
function warnOnce(message) {
  if (warned.has(message)) return
  warned.add(message)
  console.error(`platform: ${message}`)
}
