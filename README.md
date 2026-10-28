# dsh-plugin-whiteboard

[中文](./README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) Web/Desktop plugin: an
**AI whiteboard** in the right sidebar. It belongs to the conversation you are having — you say what
you want in the chat, the model draws it on the board (2D canvas, or a three.js scene), and the drawing
appears stroke by stroke while the answer is still streaming.

## Where it lives

The board is not a second chat. It is the canvas **of this conversation**:

- The three board tools belong to the **main agent**, so "draw a three-step sign-in flow" works from
  the ordinary composer — no panel to open first.
- The right-sidebar tab (`Ctrl+Shift+B` → new tab → **Whiteboard**) is a view of that board. Opening it
  creates no Session and starts no second context.
- The tab only grows an input of its own when the panel is put **fullscreen** — that is the one case
  where the conversation's composer is covered. Docked beside the conversation there is no second
  input: one conversation, one input, one draft.

## Using it

1. Just ask: "draw a troubleshooting decision tree", "build a small desk lamp in 3D", "turn this
   conversation into a timeline".
2. Open the tab to watch it: shapes arrive in layers, not all at the end.
3. Keep talking to revise: "make the third box red", "add another branch on the right". The model
   updates existing shapes by id instead of repainting the board.

The bar above the board is one line: `2D` / `3D`, the shape or object count, **Undo**, **Export**,
**Clear**.

- **Follow**: the board shows whichever surface the model last drew on. Click the active mode to pin
  the view; click it again to follow again.
- **Undo**: step back one batch, from the bar or with `Ctrl+Z` (when the caret is not in a text field).
  A **Clear** can be undone too.
- **Clear**: two clicks to confirm; it clears the current surface only.
- **Export**: saves the current surface (the 2D canvas, or one frame of the 3D scene) as a PNG.

The plugin adds no other buttons: the sidebar tab is the only entry point.

## Behaviour

- **It is part of the conversation.** The board document is Host state keyed by the Session id, and the
  drawing tools are the main agent's own tools — so drawing shows up in the transcript like any other
  tool call, and needs no explanation of "which chat knows what".
- **Live.** Every tool call writes the board document; the browser polls it while the tab is visible
  (tighter, about 350 ms, while the model is answering), so the drawing appears in layers.
- **Durable.** Boards live in `<dsh home>/storages/whiteboard/<sessionId>.json` and survive reloads and
  Host restarts. The 2D canvas and the 3D scene are stored side by side.
- **Upgrades keep your drawings.** Boards from 0.1.x (the version that shipped its own chat) are
  migrated once onto the conversation they belonged to. A conversation that already has a board is
  never overwritten, and the old files are kept.
- **Subagents do not draw.** A delegated subagent never sees the three board tools; it has work to do.

## What it costs

Two fixed costs, stated plainly:

| | |
|---|---|
| **Context tax** | The three tool declarations plus the drawing policy are resident in **every** main-session request: **8,460 characters** (5,461 of tool declarations + 2,999 of policy), about 2.3k tokens, whether you draw or not. The declarations started at 10,088 characters and are cut to 5,461; `scripts/face-budget.test.mjs` pins the ceiling so they cannot creep back. The stable prefix stays cacheable, so the practical cost is below the literal size. |
| **One timeline** | Drawing runs on the same agent and the same timeline as everything else. Asking for a drawing occupies the model for that turn; it does not happen in parallel with the task. |

## Board tools

| Tool | Purpose |
|---|---|
| `whiteboard_draw` | append 2D ops (`add` / `update` / `remove` / `clear`) |
| `whiteboard_3d` | append 3D object ops plus an optional view (camera, background, grid, auto-rotate) |
| `whiteboard_read` | report the current shape / object ids and camera so the model can revise by id |

2D lives in a fixed logical `0..1000` square (origin top-left, y down) letterboxed into the panel; 3D
is world units, y up, ground at `y = 0`. Seven 2D primitives (rect, ellipse, line, arrow, polyline, SVG
path, text) and six 3D primitives (box, sphere, cylinder, cone, torus, plane). Colours prefer palette
tokens that resolve against the theme (`blue`, `amber`, `ink`, `muted`, …), so the board works in light
and dark.

## Install

The package ships its built `lib/`:

```sh
dsh plugin --profile desktop add github:kurerere/dsh-plugin-whiteboard
```

Restart DeepSeek Harness to load it. For a Web profile, use `--profile web` and start
`dsh --profile web`. Uninstall with
`dsh plugin --profile desktop remove dsh-plugin-whiteboard`.

## Development

```sh
pnpm install
pnpm run check        # typecheck + build lib/ + emit types + verify artifacts & wire contract + model/budget tests
```

Isolated development and verification (does not touch your desktop profile):

```sh
node scripts/dev.mjs setup     # create an isolated DSH_HOME (.wbdev) and link this repository
node scripts/dev.mjs start     # boot a separate Host (57090 by default, no browser window)
node scripts/e2e.mjs           # Playwright smoke: draw from the main composer → tab shows it → undo/export/clear
node scripts/dev.mjs stop
```

Design notes, including the evidence for why the board is not a session projection, are in
[notes/design.md](notes/design.md).

## Compatibility

| | |
|---|---|
| Tested against | dsh **0.2.1-rc.3**, Web client, Chromium |
| Declared range | `engines.dsh: >=0.2.1-rc.3 <0.3.0` |
| Clients | Web / Desktop only (no TUI view) |
| Dependencies | three.js is bundled into the browser face; the Host face imports only the installation's `@deepseek-ai/dsh-tools` at runtime |

## Known limitations

- Boards live in the Host's storage directory, not in the session log, so they do not follow a fork: a
  forked conversation starts with an empty board.
- Undo history is in Host memory (the last 12 batches per board). After a Host restart you can only
  undo changes made after it; the board itself is intact.
- **Export** saves the current surface (the 2D canvas, or one 3D frame), not both surfaces together.
- Shape caps apply (300 2D shapes, 120 3D objects). A batch that would exceed them is rejected with a
  message rather than silently dropping the oldest shapes.
- Text is rendered with the system font stack; no rich text, images or embedded content.
- In the light theme, small **green/amber text** is low-contrast: those are dsh's own static accent colours, and the board does not recolour them or it would disagree with the app's badges. Ask for `ink` / `muted` when contrast matters (`muted` is raised to AA on light).
- The browser polls the board a few times a second while the tab is visible. That is a loopback request;
  it costs no model tokens.
- The board belongs to the **main** conversation. A subagent has no board tools, so it cannot draw one.

## License

[MIT](./LICENSE) © yy wan
