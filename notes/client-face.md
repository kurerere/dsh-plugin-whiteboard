# Whiteboard — client face notes

Decisions and hard-won details of the browser face. Files are all under
`src/client/`; `artwork.tsx` is the Lead's guide artwork (imported, not edited).

## One board, one conversation

The board belongs to the **main** Session: the three board tools belong to the
main agent, the Host keys its board document by the main Session id, and the
right-sidebar tab is only a view of that document. The tab therefore creates
nothing and retains nothing — no `SessionProvider`, no `ctx.sessions.retain`, no
child Session id anywhere in the client. `sidebar.right.pane.tab` is declared
`scope: 'session'`, so the body's `sessionId` and `useSession` are already the
main Session; that is what the board polls and what the input sends into.

## Transport

The Host owns the board document and the browser polls it:
`useBoard(sessionId, running)` in `poll.ts` is the whole client transport.

- `GET /api/whiteboard.state?sessionId=<main id>` → `{ rev, board, canUndo }`;
  initial fetch, then 350 ms while the main agent runs and 1500 ms when idle.
- Suspended while `document.visibilityState === 'hidden'`, resumed with an
  immediate fetch; one `AbortController` per request; every timer released.
- Also suspended while the sidebar says this tab is not on screen
  (`useBoard(…, active)`): the sidebar keeps bodies mounted for background
  Sessions and collapsed columns, and a hidden tab should cost nothing. Coming
  back into view fetches at once. `active` is `visible !== false`, so a body that
  cannot read `tab.visible` still polls.
- Two revision refs, which is the subtle part: `applied` is the revision of the
  document **in React state**, `gate` is "drop responses older than this" and a
  wake may raise it out of band. Equality is tested against `applied`, never
  against `gate` — testing it against a pre-raised gate stranded the board on the
  previous revision after 「清空」 (a real bug caught in live QA).
- `wakeBoard(sessionId, { rev, cleared, canUndo })` is the immediate-refresh
  channel: a clear folds the cleared surface in locally with the Host's own
  reducer (`applyClear`) so the board empties in the same frame, and carries
  `canUndo` because its confirmation poll lands on a revision the board has
  already applied. An undo only raises the gate: the reverted document is
  Host-owned and unknown locally, so the fetch is what draws it.
- A malformed or unreachable answer never blanks the board: the last good document
  stays and the bar shows a quiet 「未同步」 chip.
- `mode` leniency: `isBoardState` requires `board.mode`, and a document migrated
  from the retired per-board store may not carry one. `poll.ts` fills it from the
  content before validating (3D objects → `3d`, otherwise `2d`), because a
  migrated board must not read as 「未同步」 and empty. The Host should still write
  `mode` itself.

## Sending

The tab has its own single-line input and **never mounts the shipped composer**:
the conversation already has one mounted in the main view, and two composers over
one draft and one submit path is a conflict, not a feature.

The send path is the documented client service the shipped composer uses:

1. `ctx.sessions.binding(sessionId)` — the borrowed, non-retaining read of a live
   generation. It is typed by casting `ctx.sessions` to `ISessions`, because the
   plugin type-checks the Host face in the same program and there `Context.sessions`
   is the Host `SessionStore`.
2. `binding.session.beginSubmission({ mode: 'queue', text, attachments: [] })`
   registers the local submission echo (the conversation shows the message on this
   frame) and yields the `requestId`.
3. `binding.session.prompt([{ type: 'text', text }], 'queue', undefined, requestId)`
   sends it. `'queue'` always: this input never interrupts the main agent's turn.
4. On `!result.ok` the echo is abandoned and the Host's message becomes the error
   line; on success the board is woken immediately.
5. `POST /api/whiteboard.say` is the fallback for a client generation that has no
   retained binding for the Session — the situation that route exists for. It is
   not reached in normal use (the tab only becomes visible inside the session the
   shell has retained for the main chat view), and a *rejected* prompt never falls
   back, so a message cannot be sent twice.

## Keyboard

`Ctrl/Cmd+Z` undoes the last batch. The listener is on `document`, but the sidebar
keeps bodies mounted for background Sessions and collapsed columns, so the handler
proves the tab is on screen before acting: the sidebar's own `tab.visible` (from
the slot's declared `useTabInfo` hook) plus the DOM check the shipped sidebar
itself uses — no boxes (`getClientRects().length === 0`) or an ancestor with
`[hidden]`/`aria-hidden="true"` means "not the tab the user is looking at". The
caret-in-a-text-field guard stays, so the tab's own input keeps native undo.

## Rendering

- **2D** (`render2d.tsx`): one `<canvas>` inside a DOM artboard, so the sheet's
  radius/hairline/elevation come from CSS tokens instead of canvas work. The
  canvas fills the square exactly → a single uniform transform
  (`deviceWidth / BOARD_EXTENT`); letterboxing is pure layout. All seven kinds,
  every style channel, palette-token paints resolved through a probe element
  (so `var()` chains and `color-mix` both collapse to `rgb()`), dot grid as one
  cached `Path2D`, rAF loop that only paints when dirty or animating. The canvas
  paints its own surface (`--dsw-alias-bg-layer-1`) when the model set no
  background, which is what makes an exported PNG opaque.
- **3D** (`render3d.tsx`): three.js bundled, custom orbit/pan/dolly pointer
  controller (no addons), shadow-casting directional lights over a
  `ShadowMaterial` catcher, procedural equirect studio through `PMREMGenerator` so
  `metalness` materials have something to reflect (without it they render black),
  autoRotate + per-object spin, incremental reconcile by object id, full dispose,
  `preserveDrawingBuffer: true` for the PNG export.
- Appear animation: new ids fade+grow (180 ms 2D, 420 ms 3D); the first board after
  mount is primed so a reload does not animate the whole drawing.
- Theme flipping is a live path: palette resolutions are cached per theme revision,
  the 2D canvas marks itself dirty, and the 3D engine rebuilds its grid and PMREM
  studio **and** re-resolves every material and light from the last applied
  document.

## The bar

`2D / 3D` chips, one status slot, three icon actions (撤销 / 导出 / 清空), 51 px
high. The status slot carries, in priority order: the last action error, the armed
clear confirmation, the transient status (「已撤销上一批」/「已恢复清空前的画板」,
4 s; errors 6 s), otherwise the shape/object count. Nothing is added to or removed
from the row, so no state can make it wrap, and the count returning shifts only the
slack between the slot and the actions.

- `[role='tablist'] { flex: none }` keeps the mode chips at their measured width
  when a long error is on screen (they used to shrink 100 → 66 px).
- Icon actions are 26 px `Button size="sm"` with tooltips and `aria-label`s.
- The clear confirmation is armed **per surface**: `armed` holds the `BoardMode` it
  was armed for, and it is cleared whenever the shown surface changes, so arming
  2D and switching to 3D cannot clear 3D on the second click.
- Undo follows the Host's `canUndo` only (no local guess); a clear can be undone,
  so the button lights up on the clear answer.
- 导出 copies the stage canvas onto an opaque surface and downloads
  `whiteboard-<session short>-<yyyyMMdd-HHmm>.png`.

Measured with `.scratch/client-face/preview/tab.html` (real shipped
`Button.module.css` / `Pill.module.css` / `SegmentedTabs.module.css` + this
stylesheet, at 380 px): bar 51 px and one row with `overflow: 0`, stage 520 px,
input row 69 px, empty hint fits. Screenshots: `shots/tab-light.png`,
`shots/tab-dark.png`.

## Copy

- Guide description: 「这块画板属于当前对话，AI 直接画在上面」.
- Empty board: 「画板还是空的」 + 「直接在下面的输入框说想画什么，AI 会画在这块画板上。」
  + four example chips that only **fill the input** (never send) + the input hint
  「按 Enter 发送，直接说想画什么就行」.
- No copy mentions starting/creating a board — that concept is gone with the child
  Sessions, and the running state adds no copy at all: the board updating is the
  only "the model is drawing" signal now (a 「正在绘制…」 pill would claim the model
  is drawing whenever the main agent does anything).

## Verification

- `npx tsc -p tsconfig.json --noEmit` — clean (whole program).
- `pnpm run check` — typecheck + build + declaration emit + artifact verification +
  20 unit tests, green.
- `pnpm run build` — `lib/client.js` ≈ 540 KiB, runtime requires only `react`,
  `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives` (all shell platform
  modules). One three.js copy in the bundle, so the "Multiple instances of
  Three.js" warning comes from the module loader evaluating the bundle twice in one
  page, not from duplicate imports.
- **Model contract**: `.scratch/client-face/model-test.mjs` (built from
  `model-test.ts`) bundles the real `WhiteboardModel` for Node with a stubbed
  `fetch` and asserts the clear/undo POST bodies, the returned undo answer,
  `reverted: 'none'` being a normal answer, a refusal surfacing the Host message,
  and the draft store's per-Session observability and focus revision. 10 checks.
- **Export**: `.scratch/client-face/download-test.mjs` drives a real Chromium over
  CDP, clicks the same temporary `<a download>` with a `data:` URL the button uses,
  and asserts a valid PNG lands on disk with the exact file name.
