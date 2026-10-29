# Host face — decisions and verification

> **Historical: this file records the 0.2.0 Host face.** It was written when the
> board tools were three and the routes four, and its budget table pins the
> 8,460-character face. The current face is **seven tools and seven routes** with
> a tab-only capture channel and a frame store: read `notes/design.md` (v3 / P3 /
> P4) and `notes/harness.md` (0.4.0 release) for the architecture and the release
> records. The delta is appended below as **§8 Since 0.2.0 (through 0.4.0)**. The
> decision record itself is kept as written; only a number that would mislead a
> current reader is corrected in place, marked "(0.4.0: …)".

Scope: `src/index.ts`, `src/agent.ts`, `src/tools.ts`, `src/board-store.ts`,
`src/migrate.ts`. Contract files (`src/scene.ts`, `src/shared.ts`), the build
script, the tests and `package.json` are Lead-owned.

## 1. Architecture: the board is a canvas of the main conversation

A board is keyed by the **main Session id**. There is no whiteboard child session,
no seed, no fork, no `subagent/descriptor` and no `whiteboard` provider string any
more: the board tools (three at 0.2.0, **seven since 0.4.0** — §8) and the drawing
policy are contributions **of the main agent itself**, and the sidebar tab is a
view of that one board. This is what makes "draw it, then implement it" work —
the board sees the whole conversation and the conversation's agent can draw.

The Host face owns three things:

1. **The board store** (`./board-store.ts`): durable document state beside the
   session, one JSON document per main Session.
2. **The model-facing face** (`./agent.ts`): tools plus the policy section,
   registered into each main agent's own scope.
3. **Seven routes** (`./index.ts`): `state`, `clear`, `undo`, `say` — plus
   `capture` (the panel's long poll), `capture.frame` (the panel's answer) and
   `theme` (0.4.0: 0.2.0 had four; the three capture/theme routes arrived in
   0.3.0 — §8).

### 1.1 Per-agent registration (probe result)

`agent/created` + `agent.ctx` is the documented extension point, and it is the
only way we register the board face:

- The payload is `{ agent, source: 'startup' | 'resume' | 'clear' | 'compact',
  signal? }`. Creation is **one rollback-covered transaction** that enters both
  registries, announces `session/created`, then `await`s every serial
  `agent/created` listener **before releasing queued input**, so what a listener
  installs is present in the agent's first request. Main agents created by the
  session controller go through the same `ctx.agents.create` / `resume` path, and
  a resume re-fires the event with `source: 'resume'`, so a cold-resumed
  conversation re-registers.
- The `dsh-agent` README states the intended use: "an `agent/created` listener
  must not await `agent.whenIdle()` … **Return only after required asynchronous
  tool and prompt installation completes.**"
- `Agent.ctx` is the agent-scoped context "whose contributions are agent-local
  [and] unwind on disposal, and reject registration afterward".
- Scoping is real, not nominal. `ToolRuntime.register()` runs
  `this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition))`,
  and cordis binds `this.ctx` to the *accessing* context (its service shadow
  rebinds the `ctx` property per call), so `agent.ctx.tools.register()` lands in
  that agent's own toolbar layer. `ToolRuntime.view(scope)` = global + ancestor
  layers filtered by guards, plus the scope's OWN layer, and the per-request list
  comes from `ctx.systemPrompt.tools((ctx) => wireSchemas(ctx.scope))`. A sibling
  agent therefore never sees these definitions. Prompt sections work the same way
  ("scoped sections shadow globals for one agent").
- Registering the same definitions **globally** would tax every agent in the
  process (subagents, side chats) with declarations they must never call; that is
  why it is not done.
- `header.origin === 'subagent'` agents are skipped, and at plugin activation
  `ctx.agents.list()` is wired too, so an HMR reload or a late mount does not
  leave already-live conversations without the board.
- Adding a tool to an **already live, mid-session** agent via
  `agent.ctx.tools.register()` also works: `register()` is an ordinary fiber
  effect owned by that agent (it only rejects after disposal), the tool list is
  recomputed at every step from `systemPrompt.tools(wireSchemas(scope))`, and a
  visible tool-schema change is absorbed by prompt admission (forcing prompt
  consolidation only on routes without `toolUpdate`). This is the escape hatch if
  always-on registration ever becomes too expensive: register on first board open.

### 1.2 `deferLoading` — deliberately not used

`defineTool` would copy `deferLoading: true` into the model-facing schema, but
`dsh-llm.projectToolUpdates` only honours it on routes that declare a
`toolUpdate` mode. With no such mode the flag is **stripped** and every
declaration is still sent (no saving); with `addition-only` / `in-history` a
`deferLoading` baseline tool is omitted from the initial declaration list
(`offered = history.tools.filter(t => !t.deferLoading)`) and only becomes
available after a retained `tool-addition` record — which never happens for tools
registered at creation, so the model could not see them. The tax is paid by
trimming words instead.

## 2. The store (`src/board-store.ts`)

Location: `<dsh home>/storages/whiteboard/<sessionId>.json`, where the dsh home is
`process.env.DSH_HOME?.trim() || ~/.dsh`. Document shape:
`{ version: 1, rev, board: BoardState }` (a bare `BoardState` is also accepted on
read, so an older or hand-edited file still loads).

| Operation | Behaviour |
|---|---|
| `read(sessionId)` | **Synchronous, memory-only after the first touch.** The file is read once per board (lazily) and served from a `Map` thereafter, because the browser polls the state route a few times a second. A Session with no document reads as an empty board; **no file is created** until the first mutation. |
| `mutate(sessionId, reduce)` | Serialised per board, folded by `applyDraw`/`applyScene3D`/`applyClear` from `scene.ts`, written atomically (temp file + `rename`), and the in-memory snapshot advances **only after the write succeeded**. A failed write throws an actionable error and leaves memory at the last durable state. |
| `clear(sessionId, mode)` | `mutate` with `applyClear`, so the clear button and the model share one reducer. |
| `undo(sessionId)` | Pops the newest undo step and publishes the restored board under a **new** revision (`current.rev + 1`, never an old one), so the client's applied-revision guard and poll gate stay monotone. `undefined` when there is nothing to step back; nothing is written then. |
| `canUndo(sessionId)` | Memory-only query for the state route. |
| `dispose()` | Drops every in-memory document, the write chains and the undo history (the durable documents stay). |

`rev` is the board's own revision: the reducer bumps it on every accepted
mutation, so a poll can be ordered against a clear and a stale in-flight response
cannot resurrect cleared shapes. Concurrent tool calls and route mutations cannot
interleave because every write for one board goes through the same promise chain,
and the reducer runs *inside* that chain — so an `update`/`remove` batch is
validated against the newest board and applies atomically (or not at all).

**Undo history is memory-only.** Each board keeps a bounded stack (last 12) of
whole pre-mutation documents, tagged `draw` or `clear`: `mutate()` pushes `draw`,
`clear()` pushes `clear`, `dispose()` drops it. It is deliberately not persisted —
each entry is a whole board document, so twelve copies on disk would bloat the
sidecar for a convenience feature, and a Host restart is exactly when the user
should see the durable board rather than a pre-restart step. An entry is pushed
only on the success path **after** the durable write succeeded, so a failed write
leaves both memory and history untouched.

A missing document is an empty board. A corrupt one (bad JSON, not a board
skeleton, or a `rev` that is not a non-negative integer) is logged once and
treated as `rev: 0`, empty; the next mutation rewrites the file. A browser that
cannot render a corrupt board would be worse than losing that board — the
conversation itself is a session log and is never touched.

## 3. Migration (`src/migrate.ts`)

The retired design keyed a board by a hidden child Session
(`session-whiteboard-<uuid>`); the user has real drawings in those files.

At plugin activation, once per mount: scan `storages/whiteboard/*.json`, and for
each key starting with `session-whiteboard-` read that Session's header through
`ctx.sessionQuery.observeSession` to get `parentSession` (and `createdAt`). Skip a
board whose child Session or whose **parent** Session no longer exists. When
several legacy boards share one parent, the newest (`createdAt`, falling back to
the file mtime) wins and the older ones are reported as skipped. Copy the winner
to `<parentSessionId>.json` **only if that parent has no document yet** — nothing
is ever overwritten — log one line per adopted board, and leave the legacy files
in place. The migration is idempotent: a second mount finds the parents already
have boards and does nothing.

Every board entry point (`state`, `clear`, `undo` and the tools) awaits the
migration promise, so a poll cannot observe a pre-migration empty board.

Dev-home evidence (the four legacy documents that existed there, verified by
comparing SHA-256 of the copies to the originals):

| legacy board | adopted as | result |
|---|---|---|
| `session-whiteboard-3293b9ed-…` | `session-cc9e3208-…` | byte-identical (rev 26, 20 shapes + 11 objects) |
| `session-whiteboard-61465a35-…` | `session-67029bbc-…` | byte-identical (rev 0, empty) |
| `session-whiteboard-6ed0e670-…` | `session-3cf262c3-…` | byte-identical (rev 11, 4 objects) |
| `session-whiteboard-867e00c6-…` | — | left alone: an older board for a parent that already had one |

## 4. Routes (`ctx.connection.fetch`, all `no-store` JSON)

A board's `sessionId` is any **main** Session id (the session-id regex; retired
`session-whiteboard-` ids are rejected with 400 so a stale tab cannot resurrect the
old keying).

| Route | Method | Body / query | Effect |
|---|---|---|---|
| `/api/whiteboard.state` | GET | `?sessionId=` | whole current board → `{ rev, board, canUndo }`; empty board rev 0 for a Session with no document; memory-only after first touch |
| `/api/whiteboard.clear` | POST | `{ sessionId, mode }` | clears the surface through the store → `{ accepted, rev, canUndo }` |
| `/api/whiteboard.undo` | POST | `{ sessionId }` | steps one mutation back → `{ accepted, rev, canUndo, reverted }`; nothing to undo answers 200 with `reverted: 'none'`, `accepted: true` and the current rev |
| `/api/whiteboard.say` | POST | `{ sessionId, text, requestId? }` | appends the text as a **user turn** of that conversation → `{ accepted: true }`; 400 bad body, 404 unknown Session, 503 without a controller, 500 otherwise |

`say` does not reimplement admission. It calls the **session controller's**
`prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] })`
— the same RPC the main composer uses — looked up lazily by service name (never
imported, so a deployment without the controller still loads). That path resumes a
cold Session with its **own preset composition**, dedupes a repeated `requestId`
into the first send (a double Enter cannot double-send), and records the message
as an ordinary user turn. The route exists for the tab only; the model never calls
it.

## 5. The model-facing face and its budget

At 0.2.0 the face was three tools; since 0.4.0 it is seven (`whiteboard_look` and
`whiteboard_api` arrived in 0.3.0, `whiteboard_history` / `whiteboard_undo` in
0.4.0 — §8). The two authoring tools below kept their shape:

`whiteboard_draw` / `whiteboard_3d` take a flat `ops` array — one object with
`op: add|update|remove|clear` plus that kind's scalars and shared style/geometry
fields — because a flat list is what a model gets right and one object spec is what
the schema DSL is easiest to satisfy with. Each call resolves the board key from
`exec.agent.id` (the main Session id), normalises ops into canonical `Shape2D` /
`Object3D` (ids named by the model when free and well formed, otherwise
`<kind>-<4 base36>`), folds the batch through `store.mutate` with the caps enforced
before anything is written, and returns `{ tool, added, updated, removed, counts,
summary }`. Unknown ids reject the whole batch and list the ids that exist;
validation errors name the op index, the kind and what was expected.

At 0.2.0 the registrations were a **permanent, per-request tax**, so the text was
budgeted and pinned by `scripts/face-budget.test.mjs`:

| piece (0.2.0) | size |
|---|---|
| `whiteboard_draw` declaration | 2,853 chars (description 144 + parameters 2,652) |
| `whiteboard_3d` declaration | 2,413 chars (description 134 + parameters 2,224) |
| `whiteboard_read` declaration | 195 chars (description 105 + parameters 33) |
| tools together | **5,461** (was 10,088; ceiling 5,600) |
| drawing policy section | **2,999** (ceiling 3,100) |
| whole per-request tax | **8,460** ≈ 2.3–2.4k tokens (ceiling 8,700) |

**0.4.0: the budget is history, the numbers are not.** The seven declarations now
cost **10,212 characters** and the policy **1,423** — **11,635** in total, ≈3.2k
tokens (README "What it costs"; design.md "Where the board's model-facing face
lives"). The policy section shrank from 2,999 to 1,423 when the technical contract
moved into the queryable `whiteboard_api` manifest, while the declarations grew
with the tool set. `scripts/face-budget.test.mjs` no longer pins a character
ceiling at all: it pins the **seven tool names** and the safety rules (`DRAW ONLY
WHEN ASKED`, `whiteboard_api`, `whiteboard_look`, `Revise by id`, `Never open the
GUI`), because the resident size is no longer the contract.

The tool descriptions are one line each and point at the policy section; the
policy owns the single copy of the coordinate spaces, palette, liveness rule, id
discipline and undo, plus one compact 2D example. Two capability edges were traded
for the budget: the model can no longer set a 2D canvas background/grid or 3D
lights (both remain in `View3DPatch`/`Scene3D` for the client; the 3D scene keeps
its default lighting and follows the panel theme). **0.4.0: the lights half is
stale** — the light rig was handed back to the model (`view.lights`, `castShadow`,
shadow-map tuning; design.md "Tools"), so only the 2D canvas background/grid stays
reserved (`view2d.accepted: false` in the manifest), and the policy no longer
carries the technical contract at all: `whiteboard_api` does.

## 6. What was deleted (do not resurrect)

- `src/fork-seed.ts` and the whole whiteboard-agent lifecycle: `agents.create` /
  `resume` with a `setup` composition, seed boundaries, the `subagent/descriptor`
  v3 record, `WHITEBOARD_PROVIDER`, `permissionPresets.set(…, 'read-only')`.
- The scoped and global `tools.guard(boardToolDenial)` fences and the
  `restrict({ allow: … })` mask: with the tools in a main agent's own scope there
  is nothing to fence off — the agent legitimately owns the board, and sibling
  agents never see the tools.
- Routes `create`, `prompt`, `cancel`, `close`, `list`; the `WhiteboardCreated`,
  `WhiteboardAccepted`, `WhiteboardSummary`, `WhiteboardList` types;
  `isWhiteboardId`, `WHITEBOARD_ID_PREFIX`, `READ_ONLY_TOOLS`,
  `MAX_PROMPT_LENGTH`.
- `Config`: the plugin takes no configuration now (`apply(ctx)`), so the package
  exports exactly `apply`, `inject`, `name`.

`lib/index.js` contains exactly one runtime `@deepseek-ai/*` import, `defineTool`
from `dsh-tools` (a pure builder; everything else from dsh is `import type` and
erased — including the `agent/created` typing). The old `session-whiteboard`
string survives only as `LEGACY_WHITEBOARD_ID_PREFIX` for the migration scan.

## 7. Verification performed

- `pnpm run build` green; `node -e "import('lib/index.js')"` prints exactly
  `apply`, `inject`, `name`; built bundle audit: one runtime dsh import, zero
  occurrences of the retired routes/provider/descriptor/fork-seed symbols, one
  occurrence of `session-whiteboard` (the migration constant).
- `node --test scripts/face-budget.test.mjs`: 6/6 pass (per-tool ceilings, tool
  total, section ceiling, combined ceiling, required headings, both coordinate
  spaces and the palette advice).
- `.scratch/host-face/probe-store.ts` (`node .../run-probe.mjs`): the real
  `defineTool` definitions against the real store — layered draw, patch/remove by
  id, 3D batches, all seven shape kinds and six object kinds, view patches,
  geometry-merge on update, read output, board file shape, restart survival,
  corrupt/negative-rev handling, failed-write behaviour, durable clear, and the
  full undo suite (46 assertions, ALL PASS).
- `.scratch/host-face/probe-api.ts` (`node .../run-routes.mjs`): the real
  `apply()` on a fake Cordis context — exports/inject, the four routes and their
  methods, migration (newest wins, never overwrite, missing parent skipped, byte
  and revision preserved, legacy files kept, logs), per-agent wiring (main agent
  gets the three tools and the section at `PLAN_POLICY + 10`, subagent gets
  nothing, a pre-existing live agent is wired at activation), the section's rule
  order and size, state for a Session with no board (rev 0, no file written,
  legacy and malformed ids rejected), clear→undo→no-op undo, and `say`
  (delegation shape, minted requestId, 400/404/500/503 paths) — ALL PASS.

## 8. Since 0.2.0 (through 0.4.0)

Everything above describes the 0.2.0 face. This section is the delta that matters
to the Host, and where each fact is recorded now.

**Tools: three → seven.** 0.2.0 shipped `whiteboard_draw`, `whiteboard_3d` and
`whiteboard_read`. `whiteboard_look` (capture) and `whiteboard_api` (the live
manifest) arrived in 0.3.0 — the wire contract then counted 5 tools — and
`whiteboard_history` / `whiteboard_undo` made it seven in 0.4.0. `BOARD_TOOLS` in
`src/shared.ts` lists all seven (design.md "Tools"; `scripts/face-budget.test.mjs`
pins the exact seven-name list; `scripts/verify-artifacts.mjs` requires every one
of them in `lib/index.js`).

**Routes: four → seven.** `state`, `clear`, `undo` and `say` kept their shape. The
0.3.0 capture channel added two: `GET /api/whiteboard.capture` (the open panel's
long poll for a pending frame request; **204** when there is none) and
`POST /api/whiteboard.capture.frame` (the panel's answer with the PNG). The third
is `POST /api/whiteboard.theme` — the client reports the app palette at activation
and on every flip, so `whiteboard_api` knows the theme before the 画板 tab has ever
been opened. `src/shared.ts` declares exactly seven paths, `src/index.ts` serves
each, and `scripts/verify-artifacts.mjs` fails if the count is not seven or a
retired route survives in either bundle.

**Context tax: 8,460 → 11,635 characters.** The seven declarations measure 10,212
characters and the policy 1,423 — **11,635** in total, about 3.2k tokens (README
"What it costs"; design.md "Where the board's model-facing face lives"). The
policy shrank because its technical contract (coordinate spaces, palette,
defaults, lights, limits, examples) moved into the queryable `whiteboard_api`
manifest. `scripts/face-budget.test.mjs` now pins the seven tool names and the
load-bearing safety rules instead of a character ceiling; its header comment says
why — size is no longer the contract.

**Structured checks.** `whiteboard_read` / `whiteboard_look` carry `checks` —
`bounds.2d`, `shadow.present`, `shadow.single`, `shadow.opaque`, `ground.objects`
and `shadow.fake` — each `{ id, pass, detail }`, and the warning list is the
failed subset (`Checks: 4/6 passed.` in the result line). The checks are pure, so
a dry run reports them for the uncommitted document too (design.md P3;
`boardChecks` / `warningsOf` in `src/tools.ts`).

**History and undo tools.** `whiteboard_history` reports the memory-only stack
(current revision plus the pre-mutation revisions and kinds); `whiteboard_undo`
steps one or more mutations back. Both read the same store stack the bar's button
follows, both stay main-agent only, and `origin === 'subagent'` is still skipped
(design.md P3; `src/tools.ts`).

**Deep look: per-light, turntable, diff.** `whiteboard_look` accepts
`debug: 'per-light'` (a 3D contact sheet, one tile per shadow-casting light),
`angles: 'turntable'` (four yaw views, 2×2) and `diffAgainst` — `previous` /
`rev:<n>` re-render a document from the memory-only undo history with the
**current** camera, while a 6–16 character frame hash compares two stored images
through the frame index. The Host verifies the answer before saving it (`mode`
plus `tiles` / `diff` presence), so a panel that ignored the options cannot
persist a plain frame labelled as a sheet (design.md P4; harness.md "What crosses
the wire").

**Dry runs.** Both draw tools take `dryRun: true`: no store mutation, no undo
entry, no revision bump; the panel renders the hypothetical document offscreen,
the PNG is indexed with `source: 'preview'`, and the result line says `nothing
was committed` and reports the preview's own `checks` / `warnings`. A dry run with
no panel is an error, unlike a normal draw, because a preview nobody can see is
not a preview (design.md P4; `dryRunSummary` / `previewFrame` in `src/tools.ts`).

**The frame store grew an index.** Content-addressed PNGs are unchanged
(`<dsh home>/storages/whiteboard/frames/<session>/<hash>.png`), but each session
also has `frames/<session>/index.json`: newest-first records (max 64) with
`hash`, path, bytes, ISO timestamp, size, `mode`, `rev`, `source` (`look` /
`auto` / `preview` / `diff`), optional camera and capture options. It is written
atomically (`0600`, temp + rename) and serialised per session; a failed index
write is logged and never fails the save, and the save that evicts a record deletes
its PNG. `byHash` resolves a 6+ hex prefix, case-insensitively (design.md P4;
harness.md "The frame index on disk"; `src/frames.ts`).

**Viewport on the state poll.** `GET /api/whiteboard.state` accepts optional
`vw` / `vh` / `dpr`; the Host records them with `captures.noteViewport`, so
`whiteboard_api` can report the stage size before the first frame is captured.
Implausible values are ignored, the DPR is clamped, and a later capture refreshes
the value (design.md v3; `src/index.ts`, `src/client/poll.ts`).

**A late capture answer is 200 with `accepted: false`.** A late or duplicate
`POST /api/whiteboard.capture.frame` used to answer `410 Gone`. Dropping the frame
is the expected outcome, and Chromium logs every non-2xx as a console error, so it
now answers `200 { accepted: false }` (0.4.0, commit `1f7744d`; design.md "Released
as 0.4.0", harness.md "0.4.0 release"; `src/capture.ts`).

**Unchanged.** The store document (`{ version: 1, rev, board }`), keying by the
main Session id, the one-time legacy migration, per-agent registration from
`agent/created`, the memory-only 12-entry undo stack and the `say` delegation are
as described above.
