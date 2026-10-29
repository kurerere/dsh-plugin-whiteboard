// Face tests for the model-facing tools.
//
// The old numeric budgets were a cost guard for a fixed-size prompt. The 2.x
// direction replaces that fixed prompt with a self-describing API
// (`whiteboard_api`), so size is no longer the contract: the tool set and the
// load-bearing behavioural rules are. When the prompt is moved into the
// manifest, this file keeps the tool inventory and the "draw only when asked"
// safety rules pinned.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOARD_POLICY_TEXT } from '../src/agent.ts'
import { createBoardTools } from '../src/tools.ts'

/** The store the tools are built against; measuring never executes a tool. */
const store = {
  read: () => ({ rev: 0, board: { mode: '2d', canvas: { shapes: [] }, scene: { objects: [] } } }),
  mutate: async () => ({}),
  canUndo: () => false,
}

const definitions = createBoardTools(store, Promise.resolve())

test('the seven board tools are the whole model-facing surface', () => {
  assert.deepEqual(
    definitions.map(definition => definition.name),
    [
      'whiteboard_draw', 'whiteboard_3d', 'whiteboard_read', 'whiteboard_look',
      'whiteboard_api', 'whiteboard_history', 'whiteboard_undo',
    ],
  )
})

test('the policy still states the safety rules that make the board usable', () => {
  // The bootstrap no longer carries numeric presets; it carries intent and the
  // two hard safety rules: draw only when asked, and never open the token-fenced
  // GUI in a browser. Discovery itself lives in whiteboard_api.
  for (const rule of ['DRAW ONLY WHEN ASKED', 'whiteboard_api', 'whiteboard_look', 'Revise by id', 'Never open the GUI']) {
    assert.ok(BOARD_POLICY_TEXT.includes(rule), `the policy section no longer states "${rule}"`)
  }
})
