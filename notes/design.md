# Whiteboard — design notes

Target: DeepSeek Harness **0.2.1-rc.3** (Web/Desktop client). Plugin id `whiteboard`,
package `dsh-plugin-whiteboard`.

The plugin puts an **AI drawing surface** in the right sidebar, and that surface belongs to the
conversation rather than to a chat of its own: the three board tools are the **main agent's**
tools, the board document is keyed by the **main Session**, and the sidebar tab is a view of
that one board. So "draw how this works" works in the middle of a task, from the ordinary
composer, with no second chat to keep in sync.

```
 user message ──► main agent (this conversation)
                     │  whiteboard_draw / whiteboard_3d / whiteboard_read
                     ▼
         Host board store ──► <dsh home>/storages/whiteboard/<mainSessionId>.json
                     │  GET /api/whiteboard.state?sessionId=  (rev-gated poll)
                     ▼
         sidebar tab: <Canvas2D> or <three.js scene>, plus one input that sends
         into this same conversation (POST /api/whiteboard.say → sessionController.prompt)
```

## Why the board is Host state, not a session projection

The first implementation put the board on a hidden whiteboard Session's log as `plugin:`
records and served it through a `whiteboard` session projection (the `dsh-tool-todo` pattern).
That cannot work out of tree, and the dev Host proved it end to end:

1. An event type outside the shipped `SessionEventMap` is only safe in a log when the event
   carries the envelope's `ignorable` marker — the persistence read path refuses to interpret an
   unknown type without it (`KNOWN_SESSION_EVENT_TYPES` in `@deepseek-ai/dsh-session`), which
   would make the session unreadable after a restart.
2. The only API that sets that marker is `appendPluginRecord()`, and it commits through a
   module-private hook that brand-checks its receiver
   (`commitPluginRecord = (session, type, data) => session.#appendRecord(...)`). An out-of-tree
   plugin resolves its **own** copy of `@deepseek-ai/dsh-session` from its own `node_modules`,
   while the live `agent.session` belongs to the Host's copy, so the call throws `Receiver must
   be an instance of class Session`.
3. A projection unit is driven by committed events only, and the board's clear button has no
   event to commit — there is no public way to publish a projection value on demand.

The conclusion survives the redesign: **the board document is Host-owned application state**.
It survives reloads and restarts, it costs the session log nothing, and it does not need a
session to exist at all. The browser keeps a live copy by polling
`GET /api/whiteboard.state?sessionId=<mainSessionId>`; the poll is local, cheap, `rev`-gated,
and paused while the tab is hidden, and drawing arrives in tool-sized batches, so a few hundred
milliseconds is indistinguishable from a push.

- Storage: one JSON document per board (`<dsh home>/storages/whiteboard/<sessionId>.json`),
  written atomically (tmp + rename) on every mutation, loaded on first touch.
- Revision: a monotone `rev` per board; the client re-renders only when `rev` moves, and a clear
  or an undo returns the new `rev` so a stale in-flight poll cannot resurrect the old document.
- Mutations: the drawing tools and `POST /api/whiteboard.clear` / `.undo`. The reducer in
  `src/scene.ts` is shared by both faces and by the store, so validation can never disagree with
  state.

## Where the board's model-facing face lives

`tools` and `systemPrompt` are global registries, and the naive wiring — register the three
board tools once, globally — taxes **every** agent in the process, including subagents, whose
requests never draw anything. Since the tools are ~5 KB of schema per request, that tax is real
and permanent. So the face is registered per agent, from `agent/created`, into `agent.ctx`:

- **Timing.** `agent/created` is a serial creation listener: creation awaits its listeners before
  releasing queued input, and the agent README requires a listener to "return only after required
  asynchronous tool and prompt installation completes". A listener that registers synchronously is
  therefore installed for the agent's **first** request. Resume rebuilds the agent on the persisted
  session and fires the same event, so the wiring re-lands with the fresh scope.
- **Scope.** `agent.ctx` is the agent-scoped context; registrations through it land in that
  agent's toolbar layer and prompt layer and unwind on disposal. Sibling agents — and every
  subagent — never see either. Subagent sessions are additionally skipped by
  `header.origin === 'subagent'`, because a delegated child does not own the conversation's board.
- **Already-live agents.** Activation also wires everything in `ctx.agents.list()`, so an HMR
  reload or a late mount does not leave open conversations board-less until their next resume.
- **Why not `deferLoading`.** It looks like the answer — advertise the tools but do not send the
  schema until needed — but on routes without `toolUpdate` the flag is stripped (zero saving), and
  with `addition-only` the tool stays hidden until a `tool-addition` record appears, which a
  creation-time registration never produces. Rejected on evidence.

The prompt section is the other half: `agent.ctx.systemPrompt.section(...)`, ordered just after
`PLAN_POLICY` through `getSectionOrder('PLAN_POLICY')` (falling back to a fixed order when the
composition has no allocation table). Coordinate spaces, palette tokens, layering, id discipline
and the "draw only when asked" rule live there **once**; the tool declarations point at the
section instead of repeating it, because duplicated guidance is paid twice.

## Keying, and the one-time migration

The board is keyed by the main Session id, and the routes refuse any other key
(`validSessionId` rejects the retired `session-whiteboard-` prefix), so a stale browser tab
cannot resurrect the old keying.

The previous architecture left real drawings behind in
`<dsh home>/storages/whiteboard/session-whiteboard-<uuid>.json`. On activation, `src/migrate.ts`
scans that directory, resolves each legacy Session's `parentSession` through
`ctx.sessionQuery.observeSession()` (released immediately — an `SessionObservation` is
`Disposable`), and copies the file to `<parent>.json` **only when the parent has no board yet**.
Nothing is overwritten; when several legacy boards share a parent, the newest wins; files that
cannot resolve a parent are left exactly where they are and reported at `info`. Every board entry
point awaits the migration, so a poll cannot observe a pre-migration empty board. The legacy files
are kept: migration copies, it never moves or deletes.

## Tools (model-facing, snake_case)

| Tool | Purpose |
|---|---|
| `whiteboard_draw` | append 2D ops (add / update / remove / clear) |
| `whiteboard_3d` | append 3D ops plus an optional view (camera, background, grid, autoRotate) |
| `whiteboard_read` | report the current board so the model can revise its own drawing |

Two edges were traded for the budget: the model no longer sets the 2D canvas background/grid or the 3D
lights — both stay in the document model for the client, and their defaults (theme-following background,
first-party lighting) are what the board should use anyway.

Argument shapes are **flat** (`op`, `id`, `kind`, geometry scalars, style scalars) because the
schema DSL is easiest to satisfy with one object spec and a flat list is what a model gets right.
The tool normalises into the canonical `Shape2D` / `Object3D` model in `src/scene.ts`, allocates
ids (`rect-k3f9`), enforces `MAX_SHAPES` / `MAX_OBJECTS`, then appends **one** batch and returns a
compact result (counts + the ids it touched) so the model can update or remove what it drew.

Coordinates: 2D lives in a fixed logical `0..1000` square (origin top-left, y down) letterboxed
into the panel; 3D is world units, y up, ground at `y = 0`, default camera `(6.4, 4.6, 8.2)`.

## Client

- Right-sidebar tab kind `whiteboard`, id `dsh-plugin-whiteboard`, with a `guide` artwork entry
  next to the side chat's. The tab body slot is session-scoped, so its `sessionId` **is** the main
  Session: the tab retains nothing and creates nothing.
- Tab body: the board viewport (flex 1) and — **only while the panel is presented fullscreen** — a
  single-line input at the bottom. There is no embedded conversation and no composer takeover. The
  gate is `tabInfo.sidebar.fullscreen`: docked beside the conversation the shipped composer is on
  screen and is the only input, so a second one would be a strictly weaker duplicate (no
  attachments, no `@` references, no stop, no queue/steer choice) and, worse, a second draft — text
  typed there is invisible in the main composer and vice versa. Fullscreen is the one presentation
  where that composer is covered, which is exactly when the tab needs its own. The input calls the
  same client path the main composer uses (`ISession.beginSubmission` + `ISession.prompt`, for the
  local echo), falling back to `POST /api/whiteboard.say` when this client holds no binding for the
  Session; the Host route goes through `sessionController.prompt`, the composer's own admission
  path, so a cold Session is resumed with its own preset and a duplicate `requestId` folds into the
  first send. The empty-state copy follows the same gate: docked it points at the conversation, and
  the example chips (which only fill the input) exist only when there is an input to fill.
- View follow: when both surfaces have content the board shows whichever the model last touched, and the
  `2D`/`3D` switch exists to change that. **With one surface there is nothing to choose**, so the switch is
  not rendered at all and the board shows the surface that has content — which also fixed a real wart: a
  cleared 3D scene used to leave a board full of 2D shapes looking empty, because the document's "last
  touched" surface was the empty one. The model rarely uses both surfaces in one answer, so the common
  case is now zero chrome instead of a question the model already answered.
- Reveal: the board lives in the sidebar, so a drawing produced by an ordinary message is invisible until
  somebody opens the tab. `./reveal.ts` watches the on-screen conversation's board and opens the tab the
  **first** time that board's revision grows — once per conversation per page lifetime. The first
  observation of a conversation only records its revision, so switching to a conversation that already has
  a drawing never pops the panel; and once the tab is the active one the watcher stops, so an open board is
  not polled twice. Verified live: the tab appeared **511 ms** after the turn started, with nobody clicking.
- 2D renderer: one `<canvas>`, devicePixelRatio-aware, `Path2D` for `path` shapes, palette tokens
  resolved against the dsh theme, rAF only while dirty.
- 3D renderer: three.js bundled into `lib/client.js`, custom orbit/zoom controller, PMREM
  environment, contact shadows, `preserveDrawingBuffer: true` so export is not blank.
- Undo: per-board stack of the last 12 pre-mutation documents, memory-only, pushed after the
  durable write; `Ctrl+Z` outside a text field, plus the bar's button which follows the Host's
  `canUndo` (only the Host knows the stack depth).
- Styling: everything prefixed `dshwb-`, dsh CSS variables only, so light and dark themes both work.

## Verification loop

The desktop app that hosts the Lead's session loads plugins at startup, so development runs
against a **separate Host**:

- `.wbdev` (an isolated `DSH_HOME`) with profile `wb`, the plugins linked from this workspace,
  and the model config injected as a patch (`dsh --patch`), because the app's settings provider
  rewrites `profiles/wb/cordis.patch.yml`.
- `dsh --profile wb --port 57090 --no-open`, driven by Playwright through `scripts/dev.mjs`
  (`setup|start|stop|restart|status|logs|url|rebuild|verify`) and `scripts/e2e.mjs`.
- Final install in the real desktop profile happens only after the user confirms the icon preview
  (workspace AGENTS.md rule).

## History and verification record

### v1 — the board as a hidden child conversation

Built and verified first: 20/20 Playwright assertions, first shapes 367 ms after the prompt,
26–40 shapes per turn, 3D scenes with 11 objects, 0 console errors. Two defects were found by
driving the real UI and fixed before that record: **the board never appeared** (the session-log
transport cannot work out of tree — see above), and **clear could not repaint** (one revision
counter doing both "drop late frames" and "already applied"; now `applied` and `gate` are
separate).

A second pass fixed the three gaps an hour of real use surfaced: **undo** (12 memory-only
snapshots per board, republished under a *new greater* `rev` so the gate stays monotonic, clear
included), **export PNG** (no Host route, `preserveDrawingBuffer` for the 3D frame), and **3D
background follows the theme** (the prompt now leaves `view.background` unset unless asked).

### v2 — the board as the conversation's canvas

v1 worked, but it was a **separate chat**: drawings did not follow the conversation, the model
that drew knew only a seed of it, and the user had to remember which of the two chats knew what.
This pass removes the second chat entirely. What it costs, stated plainly:

- Drawing is no longer parallel to the main task: it happens on the same timeline, in the same
  transcript, one step after the other.
- Board tool declarations are resident in **every** main-session request (~a few thousand
  characters of schema, trimmed from the first draft), whether you draw or not. An unchanged
  system prompt keeps the prefix cacheable, so the practical cost is well below the literal size.
- The "does not touch the main conversation" promise of v1 is gone by design — that was the
  point of the redesign.

### v2 verification record

Frozen artifacts (a rebuild is byte-identical, so what was tested is what ships):
`lib/index.js` 65,860 B `75078FD6…`, `lib/client.js` 541,223 B `B7AF3F7B…`, both version 0.2.0.

`pnpm run check` at that tree: green — typecheck, both bundles, declaration emit,
`verify-artifacts.mjs` (4 routes, no retired route, the three tools present, the legacy prefix only for
migration, entry exports exactly `apply, inject, name`), and 23 unit tests (14 board-model, 6
face-budget pinning 3,000 / 2,600 / 300 per tool and 5,600 / 3,100 / 8,700 for tools, policy and total,
3 store-retry tests).

Host probes, re-run against this bundle: store **46/46**, api **37/37** — migration rules (newest-wins,
never overwrite, missing parent skipped, byte preservation), per-agent wiring (main vs subagent vs
already-live-at-activation), section order, `state` rev 0 without a file, `clear` → `undo` → no-op,
undo-after-a-failed-write leaving no history, and `say` delegation with its 400/404/500/503 paths.

Playwright against the dev Host — **authoritative artifact `.wbdev/shots/e2e-c-final3.json`,
`node scripts/e2e.mjs --phase all`, exit 0: 71 PASS, 0 FAIL, 1 SKIP**, 0 console errors, 0 page errors,
0 failed requests, 0 HTTP errors, `restartDetected: false` (Host pid 48812 and boot time identical at
start and end, so the memory-only undo stack was never reset mid-run), and a served-bundle byte compare
against `lib/client.js` (file + the module loader's 78-byte tail) proving the page ran the built artifact.

| phase | what it proved |
|---|---|
| load | app boots clean; the 画板 tab is keyed by the **main** Session; a fresh conversation has **no board document** and shows 「画板还是空的」; opening the tab leaves the Session count and the board documents unchanged (measured twice around the click); an adopted board renders and the state route agrees with its file; no 开始画板 CTA, no 正在绘制 pill, no drawer, no shipped composer inside the tab; no legacy id in the DOM; the legacy documents untouched |
| headline | with the tab **closed**, a main-composer request wrote the board file (cold **3,722 ms**, warm **2,189 ms**), the tab stayed closed throughout, no Session was created, the state route rev equalled the file rev, and opening the tab showed **66 shapes == 66** in the document |
| say | text typed into the tab's own input echoed into the main transcript in **175 ms** and became an ordinary turn of the same conversation (host record #123 of 129); the path was client submission (`beginSubmission` + `prompt`) with **0** calls to the `say` route, as designed |
| regress | undo button rev 18 → 19; **`Ctrl+Z` rev 19 → 20**; clear arms then empties (rev 20 → 21, 0 shapes); undo restores **65 shapes**; 2D ↔ 3D; PNG export **209,493 B** (2D) and **335,589 B** (3D); the 3D screenshot is taken after `turn/end` (11 objects, 0 open turns); reload keeps the board (rev 29 → 29, document hash `49d86d621f3c` unchanged across the reload, first paint already showing the disk content); 0 console errors |
| tools | from decoded `request/header` records: **14 main sessions are offered 34 tools including all three board tools**; every current subagent is offered 31 and none of them; only the retired whiteboard child sessions ever carried them; the behavioural probe answered `NO_WHITEBOARD_TOOLS`, its own schema was 31 tools / 0 board tools, and its log called nothing but `send_message` |

Concurrency, because undo is a user button that can now be pressed while the model is writing:
**896 mutations (672 undo, 224 clear) plus 224 state polls in 25 s, in 112 batches overlapping a live
drawing turn that was writing the same document — 0 non-2xx**. That is the integration-level closure of
the EPERM finding below, on top of its deterministic unit test.

The one SKIP is honest: `.wbdev/logs/host-*.log` only contains the wrapper's four boot lines, so the
plugin's own `adopted board …` log line cannot be read from there. Adoption is instead evidenced by the
parent document, the state route agreeing with it, and the untouched legacy files.

Migration, on the dev home and independently by both of us: `3293b9ed → cc9e3208`, `61465a35 →
67029bbc`, `6ed0e670 → 3cf262c3`, each byte-identical; `867e00c6` left alone as an older board for a
parent that already had one; every legacy file untouched. The same code ran in the real desktop home
and adopted the user's own v1 board (rev 6, 28 shapes) onto its conversation.

Latency has to be quoted with its conditions, because provider time dominates: the release run measured
**3.7 s** cold and **2.2 s** warm, while other runs saw 20.9 s cold and 50–100 s when the first request
hit a retry. None of that is board cost — the document is written synchronously at the tool call.

**The one real defect the harness caught, and what fixed it.** Two `POST /api/whiteboard.undo` calls
answered 500 in a browser run with `restartDetected: false`. It did not reproduce against sequential or
moderately concurrent traffic (40 sequential undos during a live drawing turn, 24 clear+undo cycles, 12
concurrent mixed requests — all 200), and the reason the first explanation was wrong is worth recording:
the harness captures response bodies, and the body said

```
whiteboard: could not save the board to …\storages\whiteboard\<sid>.json
(EPERM: operation not permitted, rename '…json.<rand>.tmp' -> '…json')
```

So the atomic replace itself lost, not the store teardown: on Windows, `rename` over a document that
another handle holds open (a scanner, an editor, a test reading it) fails for a few milliseconds and then
succeeds. The store now retries `EPERM`/`EACCES`/`EBUSY` six times with a linear backoff (~225 ms) and
still fails cleanly, without touching the document, when the file is genuinely stuck. The fix is proven
rather than hoped for by `scripts/store-retry.test.mjs`: a second process holds the document with
`FileShare.None`, the save rides it out, and with the retry count forced to one the test fails
deterministically.

A separate, deterministic case is a request that lands while the plugin is being disposed (Host restart
or plugin reload): it answers 500 `the board store is disposed`, which only happens while the connection
is dying anyway.

**Light theme.** The board resolves every colour against the panel, so the light pass was measured on
`#fff`, not eyeballed: `ink` 18.9:1, `label-secondary` 5.8:1, `label-tertiary` (the pre-fix `muted`
mapping) **3.71:1**, `green` 2.28:1, `amber` 2.15:1, tinted 0.12 fills carrying ink text 16.5–17.2:1.
Two conclusions:

- `muted` paints text that still has to be read — the shape count, the composer hint, the empty-state
  body, card sub-labels — so in light it resolves to the secondary label (5.8:1) while dark keeps
  tertiary. That had to be fixed **twice**: the canvas resolves tokens in `palette.ts`, but the tab's
  chrome is CSS, so `styles.css` now carries one quiet-label variable that is tertiary by default and
  secondary under `body:not([data-ds-dark-theme])`, used by the seven quiet surfaces. The harness caught
  the half-fix by reading the *resolved* colour instead of looking at a screenshot — the lesson is in the
  method, not the colour.
- `green` and `amber` are the platform's own static accents and stay as they are; darkening them would
  make a board disagree with the app's own badges, so small green/amber *text* on a light board is a
  documented contrast limit (README) rather than something the plugin recolours behind the model's back.

The 3D stage and its export take the panel surface (`--dsw-alias-bg-layer-1`, `#fff` in light), verified by
decoding the exported PNG, so the v1 "bright rectangle in a dark UI" class stays fixed in both
directions.

### v3 — the model gets eyes, and the preset becomes a contract

The first 3D drawing exposed the real gap: the board could describe its ids but not its picture. A user
said 「影子不对」 and the model's only way to look was to drive a browser at the GUI — which is token-fenced
and answered 401. The redesign closes that loop instead of adding more prose.

**Capture is tab-only, by decision.** There is no headless renderer: a frame exists only while the 画板
panel is on screen, because that is the picture the user can check and the camera is the one they actually
see. The panel polls `GET /api/whiteboard.capture?sessionId=` (250 ms, only while visible), captures the
displayed surface, and answers `POST /api/whiteboard.capture.frame`. The Host broker (`src/capture.ts`)
correlates the answer with the waiting tool call, times out with a readable error, and persists the PNG
under `<dsh home>/storages/whiteboard/frames/<session>/<hash>.png`. When the deployment mounts the
attachment service, the same bytes become an `image` content block; the path remains the `read_image`
fallback.

**`whiteboard_look` is the verification tool.** It returns the frame (inline image plus a text digest),
element-id labels optional, and `debug: 'shadow-only'` for the 3D shadow pass. `whiteboard_read` now
returns the whole state — geometry, materials, lights, camera, bounds and diagnostics — instead of an id
list. Mutations ask the panel for a small frame when it is on screen and report its path; a closed panel
never turns a successful drawing into a timeout.

**The preset became a manifest.** `src/spec.ts` declares the fields, kinds, view, lights, limits and
examples once; `src/manifest.ts` turns it into the `whiteboard_api` payload (build, theme, viewport, live
camera/lights, defaults, palette, design scales, examples). The prompt section shrank to intent and two
safety rules: draw when asked, and never use a browser as the board's view. The technical numbers are
queryable and overridable, so they cannot go stale in a prompt.

**The shadow bug is fixed at the source, not by another preset.** Lights may now set `castShadow` and
shadow-map tuning; an omitted flag means only the first directional casts. Objects default to casting only
when opaque and non-wireframe, so a glass shell cannot throw a solid shadow. The default rig keeps the
shadow on a dedicated zero-intensity directional, the ShadowMaterial floor went from 0.10 to 0.22, and
`look({debug: 'shadow-only'})` makes a double shadow visible instead of a guess. The model can now set the
same fields (`view.lights`, object `castShadow`/`receiveShadow`) and verify the result.

Verification so far: `pnpm run check` green — typecheck, both bundles, declaration emit, artifact/wire
contract (7 routes, 5 tools), 39 Host tests (3 Windows-only store tests skipped). The capture round trip
was run live on an isolated dev Host (port 57091, throwaway `DSH_HOME`): the model called `whiteboard_api`,
drew a three-layer 3D bulb, called `whiteboard_look` for the lit frame and again for the shadow-only frame,
and reported that the glass shade cast no solid shadow and that the shadow fell right/back from the
zero-intensity shadow light. A second conversation confirmed the manifest reports `theme: "dark"` and
`castShadow.accepted: true`.

**Harness portability: closed.** The gap was that `scripts/dev.mjs` drove `cmd.exe`, `netstat`,
`tasklist` and `taskkill`, so nothing but Windows could run the dev loop. There are exactly five
OS-specific operations, and they now live in `scripts/platform.mjs` with a branch each: `cmd /d /s /c`
vs `/bin/sh -c`, `netstat -ano` vs `lsof -t` for the port's owner, `signal 0` for liveness (no external
tool at all), and `taskkill /T /F` vs a signal to the detached process group. Nothing else in `dev.mjs`
asks which OS it is on, so the platform layer is the whole portability surface — which is what makes it
testable: `scripts/platform.test.mjs` runs a set of hostile arguments through the *real* shell and
back, and covers both parsers, liveness and listener detection; `pnpm run check` includes it.

Both branches were exercised, not assumed: Windows end to end (`setup → start → status → logs → stop`
against a real Host on 57090 — ready in 2.9 s, host pid found through `netstat`, port released on stop
with no strays) and Debian under WSL for the primitive layer (`sh` quoting round-trip, `lsof` naming
the test process as its own listener, `dev.mjs help/status` talking to `lsof`). The POSIX *Host boot*
is the one path that machine cannot prove, because `dsh` is not installed there; CI covers the rest.

What is still machine-specific is finding Playwright, not the OS: `scripts/pw.mjs` prefers
`WBDEV_PLAYWRIGHT_DIR`, so a fresh machine points that at a `playwright-core` instead of the harness
growing a dependency it deliberately does not have.

**Released as 0.3.0.** The v3 work reached `main` still labelled `0.2.2`, so `0.3.0` is the version
that names it: `lib/index.js` 139,767 B `7fb9bacd6b83b82b`, `lib/client.js` 550,511 B
`ce141c3f7644f9d2`. Against the tree the v3 run above exercised, the only difference is the two bundle
banners and the `package.json` version — rebuilding the parent commit reproduced its committed `lib/`
blob for blob, so the release is the tested code.
