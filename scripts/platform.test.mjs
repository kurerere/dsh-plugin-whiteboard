/**
 * scripts/platform.test.mjs — the OS branches of scripts/platform.mjs.
 *
 * Only one of the two branches can run on any given machine (a contributor is on
 * Windows *or* macOS *or* Linux), which is exactly why this file exists: CI runs it on
 * all three, so a change that works on the author's machine and nowhere else fails
 * there instead of in a release note.
 *
 * The parsers take text, the quoting test runs a real shell, and the liveness and
 * port-owner tests use real processes — the two things that actually differ per OS.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  IS_WINDOWS,
  isAlive,
  listenerPid,
  listenerPidSupported,
  parseLsof,
  parseNetstat,
  quoteArgv,
  runShell,
} from './platform.mjs'

/** Arguments whose shell meaning must not change when they travel through quoteArgv. */
const TRICKY = [
  'plain',
  'with space',
  'amp&ersand',
  'pi|pe',
  'less<than',
  'great>er',
  'caret^x',
  "it's",
  'quote"inside',
  '中文 路径',
  '--flag=value',
  '-n',
]

const scratch = []
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

test('quoteArgv quotes for the shell it will be handed to', () => {
  assert.equal(quoteArgv(['a b']), IS_WINDOWS ? '"a b"' : "'a b'")
  assert.equal(quoteArgv(['plain']), 'plain')
})

test('quoteArgv round-trips every tricky argument through the real shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-platform-'))
  scratch.push(dir)
  // A helper FILE, not `node -e "…"`: quoting a script inline would test cmd.exe's
  // parsing of nested quotes rather than the argv we care about.
  const helper = join(dir, 'argv.mjs')
  await writeFile(helper, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  const res = runShell(quoteArgv([process.execPath, helper, ...TRICKY]))
  assert.equal(res.status, 0, res.out)
  assert.deepEqual(JSON.parse(res.out), TRICKY)
})

test('parseNetstat picks the LISTENING row and ignores the rest', () => {
  const text = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000',
    '  TCP    127.0.0.1:57090        0.0.0.0:0              LISTENING       48812',
    '  TCP    127.0.0.1:57090        127.0.0.1:50000        ESTABLISHED     40000',
    '  TCP    127.0.0.1:57091        0.0.0.0:0              LISTENING       11111',
    '  TCP    [::]:57090             [::]:0                 LISTENING       48813',
  ].join('\r\n')
  assert.equal(parseNetstat(text, 57090), 48812, 'ipv4 row wins because it comes first')
  assert.equal(parseNetstat(text, 57091), 11111)
  assert.equal(parseNetstat(text, 57099), 0, 'a port nobody listens on')
  assert.equal(parseNetstat('', 57090), 0)
})

test('parseLsof takes the first pid and ignores anything that is not one', () => {
  assert.equal(parseLsof('48812\n'), 48812)
  assert.equal(parseLsof('48812\n48813\n'), 48812)
  assert.equal(parseLsof(''), 0)
  // runShell merges stderr into out, so a warning must not be mistaken for a pid.
  assert.equal(parseLsof('lsof: WARNING: can not access /proc\n48812\n'), 48812)
  assert.equal(parseLsof('lsof: command not found\n'), 0)
})

test('isAlive sees a live process and a reaped one', async () => {
  assert.equal(isAlive(process.pid), true, 'we are alive')
  assert.equal(isAlive(0), false)
  assert.equal(isAlive(undefined), false)
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise((resolve) => child.on('close', resolve))
  assert.equal(isAlive(pid), false, 'a reaped child is not alive')
})

test('listenerPid names the owner of a listening port, and nobody for a closed one', async (t) => {
  if (!listenerPidSupported()) {
    t.skip(`no port-owner tool on ${process.platform}`)
    return
  }
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    assert.equal(listenerPid(port), process.pid, 'the listening process is us')
    assert.equal(listenerPid(1), 0, 'port 1 is not a listener here')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  // The socket is released synchronously, but give the tool a moment to agree.
  for (let i = 0; i < 20 && listenerPid(port); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(listenerPid(port), 0, 'a closed port has no owner')
})
