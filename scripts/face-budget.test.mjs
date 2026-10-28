// Budget tests for the model-facing face.
//
// The board tools and the drawing-policy section are resident in **every** main
// conversation request — they are paid whether the user draws or not. That makes
// their size a product constraint, not an implementation detail: an edit that
// makes the schema 20 % bigger quietly taxes every request of every conversation
// in the process, and nothing else in `pnpm run check` would notice.
//
// So the budget is pinned here. When you need more room, cut words instead of
// raising these numbers, and if you must raise one, say why in the same commit.
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

/**
 * Characters one model-facing tool declaration costs.
 *
 * Measured as the wire form — `{"name":…,"description":…,"parameters":…}` —
 * because that envelope is what actually rides in the request, not just the sum
 * of the three fields (the JSON overhead is ~42 characters per tool).
 */
function costOf(definition) {
  return JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }).length
}

/** Current cost, per tool. Raised numbers are a decision, not a refresh. */
const BUDGET = {
  whiteboard_draw: 3_000,
  whiteboard_3d: 2_600,
  whiteboard_read: 300,
}

test('the three board tools are the whole model-facing surface', () => {
  assert.deepEqual(definitions.map(definition => definition.name), ['whiteboard_draw', 'whiteboard_3d', 'whiteboard_read'])
})

test('every tool stays inside its declaration budget', () => {
  for (const definition of definitions) {
    const budget = BUDGET[definition.name]
    assert.equal(typeof budget, 'number', `no budget declared for ${definition.name}`)
    assert.ok(costOf(definition) <= budget, `${definition.name} costs ${costOf(definition)} characters, budget ${budget}`)
  }
})

test('the tool set stays inside its total budget', () => {
  const total = definitions.reduce((sum, definition) => sum + costOf(definition), 0)
  // 2,853 + 2,413 + 195 = 5,461 characters at the time of writing.
  assert.ok(total <= 5_600, `tools cost ${total} characters in total, ceiling 5,600`)
})

test('the drawing policy stays inside its section budget', () => {
  // 2,999 characters at the time of writing.
  assert.ok(BOARD_POLICY_TEXT.length <= 3_100, `policy section is ${BOARD_POLICY_TEXT.length} characters, ceiling 3,100`)
})

test('the whole per-request tax stays inside its budget', () => {
  const total = definitions.reduce((sum, definition) => sum + costOf(definition), 0) + BOARD_POLICY_TEXT.length
  // 5,461 + 2,999 = 8,460 characters at the time of writing (about 2.3k tokens of ASCII/JSON).
  assert.ok(total <= 8_700, `tools plus policy cost ${total} characters, ceiling 8,700`)
})

test('the policy still states the rules that make the board usable', () => {
  // These four are load-bearing: without them the model either draws unasked,
  // dumps one giant batch (so the board looks frozen), or repaints instead of
  // revising by id. Losing one is a regression even if the size budget passes.
  for (const rule of ['DRAW ONLY WHEN ASKED', 'TWO SURFACES', 'DRAW IN SMALL LAYERS', 'IDS', 'CONTINUITY AND UNDO']) {
    assert.ok(BOARD_POLICY_TEXT.includes(rule), `the policy section no longer states "${rule}"`)
  }
  // Both coordinate spaces and the palette-token advice are the other half of it.
  assert.ok(BOARD_POLICY_TEXT.includes('0..1000'), 'the 2D coordinate space is no longer explained')
  assert.ok(BOARD_POLICY_TEXT.includes('y UP'), 'the 3D coordinate convention is no longer explained')
  assert.ok(BOARD_POLICY_TEXT.includes('palette tokens'), 'the palette-token advice is gone')
})
