# Dev harness — how the whiteboard plugin is run and verified

The desktop app that hosts the maintainer's own session loads plugins at startup, so
restarting it would kill that session. Everything here therefore drives a **second,
throwaway Host** on its own port, its own `DSH_HOME`, and its own profile. Nothing in
this document touches `C:\Users\Administrator\.dsh\profiles\desktop`.

Scripts (all plain Node, no dependencies, no build step):

| script | purpose |
|---|---|
| `scripts/dev.mjs` | setup / start / stop / status / logs / url / rebuild / verify the dev Host |
| `scripts/e2e.mjs` | Playwright smoke test: guide entries, whiteboard tab, prompt → reply → Host board state |
| `scripts/theme.mjs` | switch the Host's colour scheme through the app's Settings UI |
| `scripts/explore.mjs` | DOM reconnaissance (guide entries, buttons, class tokens, screenshots) |
| `scripts/pw.mjs` | where the harness finds the pinned Playwright |

---

## Quick start

```powershell
cd H:\dsh-plugins\dsh-plugin-whiteboard

node scripts/dev.mjs setup       # create/refresh .wbdev, link the plugins, write the overlay
node scripts/dev.mjs start       # boot the Host detached, wait for HTTP readiness
node scripts/dev.mjs url --show-token   # the exact URL, token included
node scripts/e2e.mjs             # full smoke test (screenshots + report)
node scripts/dev.mjs rebuild     # pnpm run build, then restart the Host
node scripts/dev.mjs verify      # rebuild + e2e in one command
node scripts/dev.mjs logs --tail 60
node scripts/dev.mjs stop
```

`node scripts/dev.mjs start` prints a masked URL. The real one is

```
http://127.0.0.1:57090/?token=<43 chars>
```

and it is also the first log line of every boot (`dsh web: http://…?token=…`) and the
`url` field of `.wbdev/host.json`.

### The URL token (why a bare `/` is not enough)

- `GET /` without the token → **401**.
- `GET /?token=…` → **303** to `./` with `Set-Cookie: dsh-auth-<hash>=…` (30 days).
  Every later request in that browser carries the cookie.
- `dev.mjs start` polls the tokenized URL until it answers 200/303 and never opens a
  browser window (`--no-open`).
- The token is a bearer secret. `status`/`start` mask it; `url --show-token` prints it.
  The harness keeps it in `.wbdev/host.json` (a throwaway directory).
- A Host restart mints a new token, so an already-open tab must reload through the
  tokenized URL (`.wbdev/host.json` / a redirector that reads it).

### Ports

Default `57090` (`--port N` to change). `start` refuses to boot if something else holds
the port, and `stop` kills whatever is left listening **on the port that home's
`host.json` records** — never on the default port, so `stop --home .wbdev-light` cannot
kill the main dev Host.

---

## What lives in `.wbdev` (the throwaway `DSH_HOME`)

```
.wbdev/
  .env                     copied once from the real home — MAGPIE_GATEWAY_KEY
  .credentials.yaml        copied once (local secret store)
  .anonymous-user-id       copied once
  config.patch.yml         HARNESS config overlay, passed as `dsh --patch` on boot:
                           magpie provider, default model, web search, colour scheme,
                           ui-settings rows that skip onboarding
  host.json                {pid, hostPid, launcherPid, port, url, logFile, build fingerprints}
  logs/host-<stamp>.log    stdout+stderr of the detached Host
  profiles/wb/package.json         bundles: dsh-base, dsh-web-app, side-chat, whiteboard
  profiles/wb/cordis.patch.yml     APP-OWNED (settings provider writes here; see below)
  profiles/wb/node_modules/        pnpm install; the plugins are `link:` symlinks
  shots/                   e2e screenshots + e2e-report.json
  storages/, sessions/     normal Harness data
```

`setup` is idempotent and never overwrites existing config: it copies the home files only
when missing, regenerates the overlay only when it is missing or a stub, and re-links a
plugin only when its dependency spec differs (`--refresh` forces it). `setup --reset`
reinstalls the profile but keeps the overlay. A reinstall therefore never loses the
credentials or the model configuration.

### The overlay is separate from the profile patch on purpose

The app's local settings provider **rewrites** `profiles/<name>/cordis.patch.yml` when any
setting changes (first-run notice dismissal, theme, font size…). We learned this the hard
way: a second home booted with the model config in the profile patch lost it after the
notice was dismissed, fell back to "no provider", and showed the 「开始使用 / 添加 API Key」
dialog — everything looked broken while the real problem was a replaced config file.

So the harness config lives in `$DSH_HOME/config.patch.yml` and every boot passes it as a
launcher flag **before** the app args:

```
dsh --profile wb --patch <home>/config.patch.yml --port 57090 --no-open
```

(`--patch` is a launcher option; put it after `--profile <name>` and before `--port`,
otherwise the app rejects it with `unknown option '--patch'`.) The profile patch is left to
the app and is documented as such in `setup` output.

---

## What we learned about DSH_HOME, profiles and link installs

**`DSH_HOME` is honoured** by `dsh`. Resolution is: explicit config path > `$DSH_HOME` >
`~/.dsh`; an empty value counts as unset. The profile is `$DSH_HOME/profiles/<name>`, so
`DSH_HOME=H:\dsh-plugins\.wbdev dsh --profile wb` uses `.wbdev\profiles\wb` and leaves the
real home alone. A missing profile fails with
`profile "wb" does not exist; create it with 'dsh plugin --profile wb add <package>'`.

**Profile creation.** `dsh plugin --profile wb add link:<dir>` initializes a base-backed
profile: `package.json` with `dsh.profile.bundles = ["@deepseek-ai/dsh-base", <package>]`,
a stub `cordis.patch.yml` (`[]`), `pnpm-workspace.yaml`, and the package installed. It also
appends the package to `dsh.profile.bundles`, but it does **not** add
`@deepseek-ai/dsh-web-app` — `setup` merges the bundle list to
`[dsh-base, dsh-web-app, side-chat, whiteboard]`. Without `dsh-web-app` nothing serves HTTP.

**`link:` installs.** The dependency stays `link:H:/dsh-plugins/<repo>`, so
`profiles/wb/node_modules/<pkg>` is a symlink to the workspace checkout; the Host imports
`lib/index.js` from the repo and the browser bundle is read from `lib/client.js`. pnpm warns
that a linked package's peers are not resolved from the target's `node_modules` — harmless
here, because Node resolves from the symlink's realpath and the plugin's own `node_modules`
(installed by its own `pnpm install`) supplies `@deepseek-ai/cordis` and `dsh-scope`.

**A bundle whose `lib/` does not exist yet is safe to wire in.** With the row present and no
build output, boot prints

```
dsh: warning: 1 entry did not activate
whiteboard (dsh-plugin-whiteboard): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find module …\lib\index.js
```

and the rest of the app boots; the client boot manifest simply has no
`dsh-plugin-whiteboard` entry. That is why the bundle stays wired in from day one, and why
`dev.mjs start` prints the build fingerprints it booted with.

**Environment leakage.** The desktop app exports `DSH_HOME`, `DSH_PROFILE`,
`DSH_PROFILE_DIR`, `DSH_SESSION_ID`, `DSH_SHELL` and `DSH_WEB_URL` into its terminals. Every
child process goes through `hostEnv()`, which strips all `DSH_*` and sets only
`DSH_HOME=<.wbdev>`; without that the CLI would target the desktop profile. `.env` layering
is per invocation (the invocation directory's `.env` outranks the Harness-home one), so the
Host runs with `cwd` = the plugin repo (no `.env` there) and `.wbdev/.env` supplies
`MAGPIE_GATEWAY_KEY`.

**Restarts vs HMR.** A rebuilt `lib/index.js` needs a restart (`dev.mjs rebuild`, ~4 s). A
rebuilt `lib/client.js` is re-read by the running Host: the `rev` in `__DSH_BOOT__` changed
between page loads (`1df833ebebcd` → `f278f50549cd`) and the served bytes always equalled
the current workspace file, so a fresh page load gets the newest client without a restart.
Whether an already-open tab hot-swaps was not proven; reload to be sure.

---

## How the client bundle is served

The Host composes the browser's module list into the index HTML as
`globalThis.__DSH_BOOT__`. For every client plugin it contains

```json
{ "id": "dsh-plugin-whiteboard",
  "url": "plugins/??dsh-plugin-whiteboard/client.js&rev=<12 hex>",
  "rev": "<12 hex>", "inject": [ … ] }
```

- The URL **requires** the `rev` query; without it the same path is a 404.
- The URL form is `plugins/??<pkg>/client.js&rev=<rev>` — the `??` marks a module-group URL.
- The response is the workspace file **plus** a trailing
  `//# sourceMappingURL=??<pkg>/client.js.map&rev=<rev>` line (+78 bytes). `e2e.mjs`
  fetches it in the page, compares it with `lib/client.js`, and reports
  `servedFromWorkspace: true/false` — proof the browser runs the workspace build.
- The `__DSH_BOOT__` entry is also the earliest evidence that the Host face activated.

---

## Playwright pin

The machine already has a pinned Playwright; the harness never downloads one.

| piece | value |
|---|---|
| package | `playwright-core@1.63.0` |
| location | `H:\tauri\tauri_sylixos_monitor\node_modules\.pnpm\playwright-core@1.63.0\node_modules\playwright-core` |
| browsers | `PLAYWRIGHT_BROWSERS_PATH=D:\Caches\playwright`, `chromium-1243` (mirrored in `%LOCALAPPDATA%\ms-playwright`) |
| why it matches | 1.63.0's `browsers.json` pins chromium revision 1243, exactly what is installed |

`scripts/pw.mjs` resolves the package in order: `WBDEV_PLAYWRIGHT_DIR`, the workspace
`node_modules`, npm `_npx` caches, then the original Windows store. `e2e.mjs` prefers a
system Chrome (`WBDEV_CHROME_PATH`; macOS defaults to
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`) so an npx package needs no
browser download; otherwise Playwright's own browser is used. `e2e.mjs` runs headless by
default (`--headed` to watch) at 1500×950 with `deviceScaleFactor: 2`, so every screenshot
is 2× (icon review needs it).

---

## `scripts/e2e.mjs` — what it checks

1. **App loads**, theme detected; `继续` dismissed if the preview notice appears.
2. **Fresh main session** (`新建会话`) so the whiteboard tab starts predictably.
3. **Right sidebar → guide entries** — opens the sidebar (and the add-tab control if the
   pane has no guide) and enumerates the guide cards: title, description, DOM classes,
   `data-*` attributes, HTML excerpt. A missing tab type is therefore named, not guessed.
   Saves `e2e-03-guide-list-2x-<theme>.png` and
   `e2e-03-guide-whiteboard-card-2x-<theme>.png` (2× crops of all cards / the 画板 card).
4. **Client bundle provenance** — `__DSH_BOOT__` URL + rev + workspace-byte comparison for
   the whiteboard and the side-chat control.
5. **Whiteboard tab** — clicks the 画板 card, waits for `.dshwb-root`, records the empty
   state (「开始画板」) or the persisted board, the canvas, the `dshwb-*` node count, and the
   child session id from the DOM's `data-whiteboard*` attribute (falling back to a
   `sessionId=` query seen on a whiteboard request).
6. **Prompt → reply → Host board state** — types into the tab's own composer, presses
   Enter, then polls every 700 ms for up to 3 minutes (`--timeout`):
   - `GET /api/whiteboard.state?sessionId=<session-whiteboard-…>` →
     `{ rev, board: { rev, mode, canvas: { shapes }, scene: { objects } } }`, its
     shape/object count, first `rev > 0`, first shape, timeline (the 3D face is
     `board.scene`, **not** `scene3d` — a first version of this script under-counted 3D
     because of that);
   - the page's stop-generating button for "is the turn still running";
   - a 32×32 downscale hash of the board `<canvas>` for "did the board change";
   - `updatedWhileStreaming` = a canvas change while the stop button was visible;
   - at ≥6 shapes it captures `e2e-05-board-six-shapes.png` plus a board-only 2× crop;
   - stores the first non-empty board JSON and the final state (arrays capped at 12 with
     `shapesTotal`/`objectsTotal` so counts stay exact).
7. **Host log tail** — fails if the boot log mentions `whiteboard` in a warning/error line.
8. **Report** — `.wbdev/shots/e2e-report.json`: every step, console errors/warnings, page
   errors, failed requests, HTTP ≥ 400, poll samples, board JSON. On a failed step it also
   dumps an ARIA snapshot (`aria-<step>.txt`).

Flags: `--headed`, `--guide-only` (stop after the guide screenshots), `--side-chat-only`,
`--prompt "…"`, `--timeout <ms>`, `--url <url>`.

### The UI language and its selectors

The Host inherits the machine locale, so the UI is **Chinese**. Selectors prefer
`aria-label`/roles; class tokens are CSS-module hashes pinned to 0.2.1-rc.3 and are only a
fallback.

| element | selector used |
|---|---|
| open right sidebar | `role=button` name `/打开右侧边栏\|open right sidebar/` |
| new session | `role=button` name `/^新建会话$\|^new session$/i` |
| add-tab (opens the guide) | `role=button` name `/新标签页\|new tab/` |
| guide cards | `[class*="entry"]` inside the sidebar panel; titles from `entryTitle`; the card button is `p2k40q_entry` with `data-sidebar-right-guide-entry="<kind>"` |
| whiteboard empty state | `role=button` name `/开始画板/` |
| theme cubes | `[class*="themeCube"]` (浅色 / 深色 / 跟随系统) |
| send / stop | `发送消息` / `停止` aria labels |

---

## Light-theme runs (icon preview pair, disposable second home)

The theme is per home: the app persists the durable choice in that home's profile patch, so
the cheapest light/dark pair is two homes rather than flipping the shared one.

```powershell
# light, on its own port, never touching the main host
$env:WBDEV_HOME='H:\dsh-plugins\.wbdev-light'
node scripts/dev.mjs setup --home H:\dsh-plugins\.wbdev-light --profile wb-light --theme light
node scripts/dev.mjs start --home H:\dsh-plugins\.wbdev-light --profile wb-light --port 57092
node scripts/e2e.mjs --guide-only            # -> e2e-03-guide-*-light.png
node scripts/dev.mjs stop  --home H:\dsh-plugins\.wbdev-light --profile wb-light
$env:WBDEV_HOME=$null
```

`scripts/theme.mjs dark|light|system` instead flips the *shared* host through its Settings
UI (a useful alternative, but every attached browser changes with it).

---

## Troubleshooting

| symptom | cause / fix |
|---|---|
| `missing harness overlay …` on start | `node scripts/dev.mjs setup` (the overlay is not the app's patch file) |
| `unknown option '--patch'` | launcher flag order: `dsh --profile wb --patch <file> --port N --no-open` |
| 「开始使用 / 添加 API Key」 dialog | the model config was lost — check `config.patch.yml` exists and `MAGPIE_GATEWAY_KEY` is in `.env` |
| `dev: port N is already used by pid M` | another Host holds it: `node scripts/dev.mjs stop` (`--home` aware) or use `--port` |
| `host.json` alive but HTTP fails | killed from outside: `stop && start` |
| plugin row missing from the app | `did not activate` in the log; `dev.mjs rebuild` |
| browser shows 401 | tokenized URL (`dev.mjs url --show-token`), or reload after a restart |
| e2e cannot find the guide | re-run; check `e2e-01-app.png` (a leftover dialog would be visible) |
| `playwright-core 1.63.0 not found` | set `WBDEV_PLAYWRIGHT_DIR`, make a `playwright`/`playwright-core` available in the workspace `node_modules`, or let the npx-cache scan find one |

---

## Verification record

**2026-10-27 21:29 (Asia/Singapore)** — first end-to-end pass on the new Host-state
transport (`GET /api/whiteboard.state`), after the client/host faces were reworked.

Build under test: `lib/index.js` 117,535 B (sha 86d2440d, mtime 21:22), `lib/client.js`
545,479 B (sha 9c2c7748, mtime 21:28). Host booted 21:23 with the 543,876 B client and
served the 545,479 B one after the 21:28 rebuild without a restart (rev `f278f50549cd`,
served 545,557 B = workspace + 78).

`node scripts/e2e.mjs` → **18 PASS, 2 SKIP, 0 FAIL, exit 0**, 0 console errors, 0 page
errors, 0 failed requests, no `whiteboard:` lines in the Host log.

| evidence | value |
|---|---|
| guide entries | 工作区文件 · 新建终端 · 侧边聊天 · **画板** · 更多工具 |
| 画板 card | `data-sidebar-right-guide-entry="whiteboard"`, icon = 26×26 blue board artwork |
| tab mount | `.dshwb-root`, canvas 1, 18 `dshwb-*` nodes |
| empty state | 「开始画板」 present on a fresh home/session and clicked (first run) |
| session id | `session-whiteboard-3293b9ed-dc8f-488f-9961-6d493e0c696d` (from `data-whiteboard*`) |
| composer | textarea inside the tab body (`inRightPanel=true inTab=true`) |
| reply | streamed, +281 chars, stop button observed |
| board | `rev` > 0 at **362 ms** after Enter; first shapes at **362 ms**; 29 shapes final |
| board while running | canvas pixels changed while the stop button was visible |
| state JSON | `{ rev, board: { rev, mode, canvas: { shapesTotal: 29 }, scene: { objects } } }` — full sample in `e2e-report.json` |
| 3D prompt | 「用 3D 搭一个小台灯」 → 11 objects in `board.scene`, 3D surface captured (`e2e-06-board-3d*`), all PASS |

Screenshots (`.wbdev/shots/`, 2×): `e2e-01-app`, `e2e-03-guide`,
`e2e-03-guide-list-2x-dark`, `e2e-03-guide-whiteboard-card-2x-dark`,
`e2e-04-whiteboard-tab`, `e2e-05-board-six-shapes`,
`e2e-05-board-six-shapes-canvas-2x-dark`, `e2e-05-after-prompt`,
`e2e-05-board-canvas-2x-dark`, plus the light pair
`e2e-03-guide-list-2x-light` / `e2e-03-guide-whiteboard-card-2x-light`.

---

# Model C (v0.2.0): the tab is a view of the conversation's board

The whiteboard is no longer a second conversation. The right-sidebar tab is a **view of
the main Session's board**, its input sends into that conversation, and the board tools
belong to the main agent only.

| contract | value |
|---|---|
| board document | `<dsh home>/storages/whiteboard/<mainSessionId>.json`, shape `{ version: 1, rev, board }` where `board` is `{ rev, mode, canvas: { shapes[] }, scene: { objects[] } }` |
| state | `GET /api/whiteboard.state?sessionId=` → `{ rev, board, canUndo }` |
| mutations | `POST /api/whiteboard.clear { sessionId, mode? }`, `POST /api/whiteboard.undo { sessionId }` → `{ accepted, rev, canUndo, reverted }` |
| say (fallback) | `POST /api/whiteboard.say { sessionId, text, requestId }` — the tab's composer normally uses the client path `ISession.beginSubmission` + `ISession.prompt`, so this route is not called |
| tab DOM | `.dshwb-root[data-whiteboard=<mainSessionId>]`, `.dshwb-board[data-view=2d\|3d]`, `.dshwb-meta[data-tone=count\|status\|error]` (「N 个图形」/「N 个物体」), `input.dshwb-input`, bar buttons by aria: 撤销 / 导出 / 清空→确认清空 |
| migration | at activation, `session-whiteboard-*.json` whose child session names a **live** parent is copied to `<parent>.json` (byte copy, only when absent; newest child wins per parent; unreachable parents and orphans are left alone) |
| tools | `whiteboard_draw` / `whiteboard_3d` / `whiteboard_read` / `whiteboard_look` / `whiteboard_api` / `whiteboard_history` / `whiteboard_undo` are registered per **main** agent on `agent/created`; `header.origin === 'subagent'` is skipped |

## Harness changes that model C forced

- `scripts/e2e.mjs` is phase-based: `--phase load|headline|say|regress|tools|look|deep|dryrun|all`,
  one JSON per run (`--out` defaults to a timestamped name in `.wbdev/shots/`).
- **Host-side witnesses** now sit next to every browser claim: the board document on
  disk, the state route, and the session log. `sessions/…/session.v4.jsonl.zstd` is a
  **concatenation of zstd frames** (one frame per flush); `zstdDecompressSync` decodes a
  single frame, so the reader scans for the frame magic and decodes each frame
  separately. Records of interest: `user/message`, `assistant/message`, `tool/call`,
  `tool/result`, `turn/start`, `turn/end`, `agent/inbox/spliced`, `request/header`.
- **Tool visibility** is read from `request/header.data.header.tools[]` — the exact tool
  list a model request was offered. This is the authoritative check: main agents get 34
  tools including the three board tools, current subagents get 31 without them, and only
  the legacy `session-whiteboard-*` children (v1 whiteboard agents) ever carried them.
- Mutations are **gated on an idle conversation** (`turn/start` vs `turn/end`) and on a
  settled document, because a drawing turn writes one revision per tool batch; a
  mutation fired into a live turn is a race the assertions should not be measuring.
- The tab's count line trails the document by one poll (350 ms running / 1.5 s idle):
  compare only after `waitTabCount` / `tabMatchesDocument`.
- The shipped composer is driven by a **coordinate click re-derived from the live DOM**
  on every attempt. Never rely on an injected attribute (`data-…`): a page reload or a
  React re-render removes it and the locator then waits forever.
- **Do not assert on Host log lines.** `.wbdev/logs/host-*.log` only holds this harness's
  own four boot lines; the plugin's `ctx.logger.info` output is not captured there.
- `scripts/migrate-probe.mjs` exercises the migration rules on a **second, isolated
  home** (`node scripts/dev.mjs setup --home .wbdev2 --port 57091`, then
  `node scripts/migrate-probe.mjs`). It copies real legacy sessions, their parents and
  their board documents in, boots that home, asserts adopt / no-overwrite / newest-wins /
  unreachable-parent / orphan from **file outcomes only**, and stops it again. Port 57090
  is never touched.

## Release run on the frozen tree (authoritative artifact)

`lib/index.js` 65,291 B sha `b211289dc637176c`, `lib/client.js` 540,475 B sha
`ceddb6948fa6a5f8`, served bundle rev `740bc4175de7` (540,553 B = file + 78). Host
pid 10020, booted 12:06:42, `restartDetected: false` (pid and boot time identical at the
start and the end of the run).

`node scripts/e2e.mjs --phase all --out .wbdev/shots/e2e-c-final.json` →
**69 PASS, 0 FAIL, 1 SKIP, exit 0**, 0 console errors, 0 page errors, 0 HTTP errors, 0
failed requests. The single SKIP is the adoption *log* line, which is unreadable by
design (see above).

| evidence | value |
|---|---|
| tab | keyed by the main Session; 画板 title; own input; no 开始画板 / 正在绘制 / drawer / 发送消息 mount; 1 canvas |
| fresh conversation | no board document, 「画板还是空的」, count 0; opening the tab: sessions 26 → 26, board documents 15 → 15 |
| migrated parent | `cc9e3208` rev 31 / 33 shapes / 11 objects; state route 200 rev 31 == file |
| headline (tab closed) | cold **20,983 ms** (first request of the conversation, board rev 0) vs warm **2,207 ms** (second request, same conversation), both from Enter to the first document mutation incl. provider round trip |
| tab after opening | 54 个图形 == file 54 shapes rev 10 |
| say | tab input → main conversation; DOM echo 187 ms; session log `user/message` #88 of 94; assistant/message 13 → 14; client submission path (0 `whiteboard.say` calls) |
| undo / Ctrl+Z | rev 11→12, then 12→13 (focus = the tab pane, not an input) |
| clear / undo-clear | rev 13→14 with shapes 0, then 53 shapes restored |
| 3D | seed built 4 objects in 49.4 s; 2D↔3D toggles; 3D canvas rendered |
| exports | 2D **191,650 B**, 3D **251,009 B** (`whiteboard-a482df41-…png`) |
| reload | rev 17→18 monotonic, 53 shapes preserved (objects 9→13 because the 3D turn was still flushing into the window), file hash `896aeace85af`→`f091245f065d`, tab first paint 13 个物体 == disk |
| tools | 13 main sessions 34 tools incl. the three; 5 current subagents 31 tools with none; probe subagent replied `NO_WHITEBOARD_TOOLS`, parent = the main session |

Migration probe (`scripts/migrate-probe.mjs`, `.wbdev2`, port 57091): **ALL PASS** —
adopt byte-identical (`sha 4ab231facda46d88`), idempotent second boot, existing board kept
(`rev 7`, marker intact), newest-wins (`7d7cff94@1793108353146` beat
`fc94e2cf@1793107443669`), orphan untouched, missing parent created nothing, legacy
documents left in place.

## Known transients (not defects)

- **`POST /api/whiteboard.undo` → 500 is a Windows `rename` EPERM, and the response body
  says so.** Captured from the light run (`.wbdev-light/shots/e2e-c-light-3d.json`,
  `routes[]`):

  ```
  Error: whiteboard: could not save the board to …\storages\whiteboard\<sid>.json
  (Error: EPERM: operation not permitted, rename '…json.<rand>.tmp' -> '…json').
  The board was not changed; the workspace must allow writing under the dsh home, then retry.
  ```

  Two saves of the same document can collide in the atomic temp→rename write (rapid undo
  bursts, or a drawing tool batch landing next to a user mutation); the losing rename
  raises `EPERM` on Windows and surfaces as 500. State is safe ("the board was not
  changed"), the next request succeeds. **Host-face fix idea:** retry the rename a few
  times with a short backoff on `EPERM`/`EBUSY`. It is *not* a restart/teardown artefact:
  the failing runs have `restartDetected: false` and the body names the filesystem.
  Sequential (40), clear+undo (24) and concurrent (12) probes all returned 200, so it
  needs a genuinely overlapping write to reproduce.
- Headless Chromium logs `GL Driver Message … GPU stall due to ReadPixels` warnings when
  the 3D surface renders through SwiftShader. They are warnings, not errors.

## Light-theme pass (same frozen build, disposable `.wbdev-light` home, port 57092)

`WBDEV_HOME=.wbdev-light node scripts/e2e.mjs --phase all` → 61 PASS, 2 FAIL (both
harness: a fresh home has no subagent yet, and the post-reload composer lookup);
`--phase regress` re-run after the post-turn 3D gate → 19 PASS, 1 FAIL (the EPERM 500
above). Artifacts `.wbdev-light/shots/e2e-c-light.json` / `e2e-c-light-3d.json`, build
`client ceddb6948fa6a5f8` / `index b211289dc637176c` (identical bytes to the dark run).

- 2D board in light: `c-02-headline-board.png` (57 shapes) — tinted columns with solid
  strokes, dashed placeholders, legible cards.
- Empty state in light: `c-00-empty-board.png` — 「画板还是空的」 hint + example chips.
- 3D scene in light: `c-06-3d.png` captured **after `turn/end`** (`phases.scene3d`:
  `objectsAtShot 9`, `tabMetaAtShot "9 个物体"`, `openTurnsAtShot 0`). The stage takes
  `surfacePaint()` = `--dsw-alias-bg-layer-1`, measured `#fff` in light, and the 3D export
  PNG (`export-3d-…-1310.png`, 319,711 B) has a white background — no dark rectangle, the
  v1 defect class mirrored.
- Measured contrast on `#fff`: `ink` 18.9:1, `label-secondary` 5.8:1, **`muted`
  (`--dsw-alias-label-tertiary` #81858c) 3.71:1** (count line, composer hint, board
  `muted` text — below AA for normal text), **`green` #22c55e 2.28:1 / `amber` #f59e0b
  2.15:1** (weakest as small text — the 「审批通过」 note and column titles), `blue` 3.68:1,
  `red` 3.76:1, tinted fills at 0.12 carry ink text at 16.5–17.2:1, grid ink@0.15 1.38:1
  (decorative). Palette values live in `src/client/palette.ts` (Lead-owned) and were not
  changed.

## 0.2.0 release (final bytes)

Two Lead-owned fixes landed after the light pass:

1. `src/board-store.ts` — the atomic replace retries `EPERM`/`EACCES`/`EBUSY` six times
   (linear 15…75 ms) before failing. Proven by `scripts/store-retry.test.mjs` with a second
   process holding the file `FileShare.None` (and shown to have teeth with
   `RENAME_ATTEMPTS = 1`).
2. `src/client/palette.ts` + `src/client/styles.css` — light `muted` resolves to
   `--dsw-alias-label-secondary`, and the tab chrome uses one variable
   `--dshwb-quiet` (tertiary by default, secondary under `body:not([data-ds-dark-theme])`).

Final build: `lib/index.js` 65,860 B sha `75078fd6c9861995`, `lib/client.js` 541,223 B sha
`b7af3f7ba1af3814`, served bundle rev `1c922750570a` (541,301 B = file + 78). Host pid
48812, booted 05:46:03Z, `restartDetected: false`.

**Release artifact `.wbdev/shots/e2e-c-final3.json` → 71 PASS, 0 FAIL, 1 SKIP, exit 0**
(0 console/page/HTTP errors, 0 failed requests). Highlights: cold 3,722 ms vs warm
2,189 ms; tab 66 个图形 == file 66 shapes rev 17; say echo 175 ms with the client
submission path; undo 18→19, Ctrl+Z 19→20, clear 20→21 → undo restores 65 shapes; 3D
post-`turn/end` with `objectsAtShot 11`, `openTurnsAtShot 0`; exports 209,493 B (2D) /
335,589 B (3D); reload rev 29→29 with the document hash unchanged and first paint
11 个物体.

**Concurrency stress (integration proof for fix 1):** `.wbdev/logs/stress-undo3.json` —
896 mutations + 224 polls in 25,011 ms (112 batches while a drawing turn wrote the same
document), **0 non-2xx**: 672 undo / 224 clear / 224 state, all 200; `reverted` draw 7,
clear 224, none 441 (clear responses carry no `reverted` field).

**Quiet labels, measured per theme** (`.wbdev/probe-quiet.mjs`, one home per theme):

| | light (`.wbdev-light`, 57093) | dark (`.wbdev`, 57090) |
|---|---|---|
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` |
| `--dshwb-quiet` on `.dshwb-root` | **`#61666b`** | **`#adb2b8`** |
| 「N 个图形」 count line | **rgb(97,102,107)** | **rgb(173,178,184)** |
| composer hint / input placeholder | rgb(97,102,107) | rgb(173,178,184) |
| canvas `muted` text | 2,379 px within ±10 of `#61666b` | base map untouched (tertiary) |

Screenshots: `.wbdev-light/shots/light-quiet-labels.png`,
`.wbdev/shots/dark-quiet-labels.png`. The canvas pixel count is only meaningful in light
(there the token values are far apart); in dark the aliases are `#cfd3d6`/`#adb2b8`, so
the decisive dark evidence is the computed colour of the quiet elements.

## 0.3.0 release (final bytes)

v3 reached `main` still carrying `0.2.2`, and tag `v0.2.2` is the commit *before* it — so
`dsh plugin add github:kurerere/dsh-plugin-whiteboard`, which installs the default branch, was
handing out the five-tool capture build under the previous release's version number. 0.3.0 is the
release that names that feature set: three tools became five (`whiteboard_look`, `whiteboard_api`),
the route table grew to seven, and the preset became a queryable manifest.

Final build: `lib/index.js` 139,767 B sha `7fb9bacd6b83b82b`, `lib/client.js` 550,511 B sha
`ce141c3f7644f9d2`, both version 0.3.0.

The bytes are the tested bytes. Rebuilding the parent commit reproduced its committed `lib/`
blob-for-blob — `git hash-object` equal on `lib/index.js`, `lib/client.js` and every
`lib/types/*.d.ts` — so this release differs from the v3 tree by **exactly two banner lines and the
`package.json` version**, and the code the v3 run in `design.md` exercised is unchanged.

Gate at this tree: `pnpm run check` green — typecheck, both bundles, declaration emit, artifact/wire
contract (7 routes, 5 tools), **42/42 tests, 0 failed, 0 skipped**.

Live evidence for this feature set is the v3 run recorded in `design.md` (isolated dev Host, port
57091, throwaway `DSH_HOME`): the capture round trip, `whiteboard_look` for the lit frame and again
for `debug: 'shadow-only'`, and a second conversation confirming `theme: "dark"` and
`castShadow.accepted: true`. It was not re-run for the version bump, which changes no code.

## Cross-platform harness (2026-10-29, macOS)

The original sections above describe the maintainer's Windows workstation. The harness now runs
on a standalone checkout without the sibling `dsh-plugin-side-chat`:

- `scripts/dev.mjs` links only directories that actually carry a `package.json`; profile
  initialization seeds the whiteboard plugin, and `side-chat` is optional. Use an out-of-tree
  home when the workspace is sandboxed:
  `WBDEV_HOME=/tmp/wbdev2 node scripts/dev.mjs setup && WBDEV_HOME=/tmp/wbdev2 node scripts/dev.mjs start`.
- `scripts/pw.mjs` discovers a `playwright`/`playwright-core` package from `WBDEV_PLAYWRIGHT_DIR`,
  the workspace `node_modules`, or the npm `_npx` cache; `scripts/e2e.mjs` drives the machine's
  Chrome (`WBDEV_CHROME_PATH`; macOS default) and passes
  `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` so the 3D phase has WebGL
  in headless Chrome.
- `--phase look` is new: it opens the 画板 tab, has the model draw a 3D ball and call
  `whiteboard_look`, then asserts (a) a `whiteboard_look` `tool/call` in the main session log,
  (b) a new PNG under `storages/whiteboard/frames/`, and (c) a valid PNG header with dimensions.
  Auto-frames can also add PNGs; the tool-call assertion is the authoritative one.

Six phases on macOS (system Chrome, `WBDEV_HOME=/tmp/wbdev2`): `load` 29 PASS, `headline` 12,
`say` 6, `regress` 20, `tools` 7, `look` 5 — **79 PASS, 0 FAIL**, 0 console/page/http errors.
`regress` records one `net::ERR_ABORTED` state poll; that is the board's own `AbortController`
cancelling an in-flight poll, not a product failure. The `tools` phase now asserts all seven board
tools on the main agent and none on the subagent.

## Deep look + dry run (v4): protocol, storage and two more phases

### What crosses the wire

The panel owns pixels, so a deep capture is still one request/one answer; the additions are optional
fields on the existing routes.

| direction | field | meaning |
|---|---|---|
| request | `baseline?: CaptureBaseline` | what to compare against. `{kind:'document', rev, label, board}` is re-rendered by the panel with the **current** camera; `{kind:'image', rev, label, png, width, height, mode, camera?}` is a stored frame to compare pixel-for-pixel. |
| request | `preview?: BoardState` | the uncommitted document a dry run wants rendered. The answer reports the *preview document's* own size/mode, not the live surface. |
| request | `options.debug: 'per-light'` / `options.angles: 'turntable'` | contact-sheet requests; `sanitizeOptions` keeps them instead of dropping an unknown enum. |
| answer | `diff?: CaptureDiff` | `kind`, `label`, `rev`, `changedPixels`, `changedRatio` (0..1), optional `bounds` in **new-frame** pixels, `comparable`, `note`. `png` is then the 3-panel sheet, not a plain frame. |
| answer | `tiles?: string[]` | captions of a contact sheet (`#2 directional 1.6`, `0°`, …); at most 8 survive validation. |
| answer | `preview?: true` | the frame renders an uncommitted dry-run document. |

`POST /api/whiteboard.capture.frame` parses these three answer fields behind the existing 8 MB PNG and
size checks; a malformed optional field is **dropped, not a frame rejection**, so a panel bug cannot
cost a good picture. Nothing new is trusted from the client.

### The frame index on disk

`<dsh home>/storages/whiteboard/frames/<session>/`

- `<hash>.png` — unchanged content-addressed frames (`sha256` prefix 16 hex; identical pixels reuse one
  file).
- `index.json` — newest-first records, at most 64: `hash`, `path`, `bytes`, ISO `at`, `width`, `height`,
  `mode`, `rev`, `source` (`look` / `auto` / `preview` / `diff`), optional `camera`, optional `options`.
  Written atomically (temp + rename, `0600`) and serialised per session; a failed index write is logged
  and does not fail the save. The `save` that evicts a record also deletes its PNG.

The index is the e2e witness: a `look` sheet, a `diff` sheet and a `preview` frame can be told apart from
disk alone, and `whiteboard_look({diffAgainst: '<6–16 hex prefix>'})` resolves through `byHash`
(case-insensitive, `list` is newest first, `prune(keep)` reports how many records it dropped).

### The hidden preview stage

- `src/client/mounts.tsx` mounts a fixed 960×600, off-screen, `visibility:hidden`,
  `pointer-events:none` 3D stage (`.dshwb-previewStage`) with its own `captureRef` whenever the tab can
  answer a capture (`stageReady && visible !== false`), whether the visible surface is 2D or 3D. It
  renders a 3D `preview` document and a 3D diff baseline; the visible stage's orbit, scroll and pixels
  are never touched. The hidden engine is created once per mounted tab and disposed with it, so a
  background or collapsed tab body holds no extra WebGL context.
- A 2D preview goes through the static painter `renderBoardFrame(canvas, options, size?)` in
  `render2d.tsx` (no appear animation), which is also the 2D document baseline. A 3D preview passes the
  panel's CSS size / dpr to `renderDocument`, so its output follows the panel aspect rather than the
  hidden 960×600 box; the answer still omits `viewport`, so a preview cannot overwrite the real panel
  size reported by `whiteboard_read`.
- **Surface pinning is refused, not degraded.** `src/client/mounts.tsx` throws when `debug:'per-light'`
  or `angles:'turntable'` is requested while the displayed surface is 2D, and `src/client/capture.ts`
  throws when a diff baseline's surface differs from the captured frame. The Host repeats the check on
  the answer (`answer.mode`, plus `tiles` / `diff` presence) before `frames.save`, so an older panel that
  ignores the options cannot persist a plain frame labelled as a sheet. Unit tests pin both refusals; the
  live harness does not pin the panel because that needs both surfaces seeded, which the deep phase does
  not do.
- `src/client/diff.ts` decodes both PNGs, scales the before frame to the after size, compares RGB with a
  per-channel delta ≤ 8 to absorb antialiasing, and composes a **3-column** sheet: `before`, `after`,
  `changed` (dimmed after + red changed pixels + bounding box + `N% changed`). Sheet output respects
  `maxWidth` as the **total** width for contact sheets; a diff sheet is three columns between 720 and
  1800 px wide, so each panel keeps the captured frame's aspect. `overlay:'ids'` applies inside each
  contact-sheet tile and in a diff pair (a viewport hint makes the re-rendered baseline use the live
  label scale), and a contact sheet is 2 columns (4 turntable views → 2×2; one per-light tile per light).

### `--phase deep`

```sh
node scripts/dev.mjs start
node scripts/e2e.mjs --phase deep --headed      # add --deep-prompt "…" to replace the prompt
```

Prompt (a single line; `--deep-prompt` overrides it):

```
在画板上画一个简单的 3D 场景：一个球和一块地面（画板 tab 已经打开）。画完后依次调用三次 whiteboard_look：第一次 debug 用 per-light，第二次 angles 用 turntable，第三次 diffAgainst 用 previous。三次都要看结果，最后用一句话总结三种视角分别看到了什么。
```

PASS conditions (all host-side; the phase never trusts the reply alone):

1. `whiteboard_look` `tool/call`s with `debug:'per-light'`, `angles:'turntable'` and a non-empty
   `diffAgainst` — the arguments are read from the session log, not the transcript.
2. The tool-result text names the modes: `per-light sheet`, `turntable sheet (4 views)`,
   `diff against …` with `% changed`, and the `Diff:` note line.
3. The frame index has this session's `source:'look'` records (the contact sheets) and a `source:'diff'`
   record, all newer than the pre-turn snapshot, and the look records carry `options.debug ===
   'per-light'` / `options.angles === 'turntable'` — the index says which sheet is which.
4. The new PNGs are valid, and the dimensions match the geometry: the per-light sheet (one tile per
   caster; the default rig has one) and the 3-column diff sheet are wider than tall because `maxWidth`
   is the **total** width. A 2×2 turntable grid can be taller than wide in a portrait panel, so only
   its existence and its `options` are asserted, not its aspect.
5. The model answered the turn (`assistant/message` grew).

Screenshot: `.wbdev/shots/c-10-deep.png`; the JSON report lands under `phases.deep`.

### `--phase dryrun`

```sh
node scripts/dev.mjs start
node scripts/e2e.mjs --phase dryrun --headed    # add --dryrun-prompt "…" to replace the prompt
```

Prompt (a single line; `--dryrun-prompt` overrides it):

```
用 whiteboard_draw 在画板上画三个并排的矩形标签（画板 tab 已经打开）：先做一次 dryRun 预览，不要提交；看过预览确认位置没问题后，再用不带 dryRun 的 whiteboard_draw 真正画一次。最后用一句话说明预览和正式绘制的区别。
```

PASS conditions:

1. A `whiteboard_draw` `tool/call` with `dryRun:true` **and** a later one without it (the committed
   draw), both from the session log.
2. The tool-result text says `(dry run)`, `would add …` and `nothing was committed`, and prints a
   `Preview: …png` path.
3. The frame index has a `source:'preview'` record whose PNG exists and is a valid PNG.
4. The board document holds **only** the committed shapes: `shapes == shapes_before + Σ add ops of the
   committed calls`. A dry run that mutated would leave the prototype shapes twice, so this is the
   decisive witness; the tab's count must agree with the document afterwards.

Screenshot: `.wbdev/shots/c-11-dryrun.png`; the JSON report lands under `phases.dryrun`.

That makes eight phases. The six-phase macOS run recorded above predates `deep` and `dryrun`; both must
be run once on the tagged build (and their PASS counts recorded here) before the slice's release gate can
cite them. `--phase all` now includes them, so the next full run measures all eight.
