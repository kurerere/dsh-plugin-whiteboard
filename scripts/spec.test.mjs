// Contract tests for the declarative board spec and the `whiteboard_api` payload.
//
// Node strips the TypeScript types, so the spec and manifest are imported
// straight from src/ — the same modules the Host bundle will run. The point of
// these tests is not to restate the spec, but to catch the three ways this layer
// can silently rot:
//
// 1. an incomplete field/kind spec (a missing doc, an unbounded number without a
//    stated bound, an enum that quietly empties);
// 2. a generated tool schema that drifts from the hand-written declaration in
//    tools.ts (or from the limits that module enforces);
// 3. a manifest that stops being a complete, JSON-serialisable, secret-free
//    description of the board.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  API_VERSION,
  DEFAULT_ENVIRONMENT,
  DEFAULT_SHADOW,
  DESIGN_SPEC,
  EXAMPLES,
  FIELD_SCOPES,
  FIELD_SPECS,
  HINTS,
  LIMITS,
  OBJECT_KINDS,
  OBJECT_SPECS,
  OP_VERBS,
  SHAPE_KINDS,
  SHAPE_SPECS,
  TOOL_NAMES,
  TOOL_SPECS,
  VIEW_SPEC,
  buildDrawParameters,
  buildSceneParameters,
  defaultsFor,
  environmentDefaults,
  fieldSpecById,
  kindDefaults,
} from '../src/spec.ts'
import { buildManifest } from '../src/manifest.ts'
import {
  DEFAULT_CAMERA, DEFAULT_LIGHTS, MAX_LIGHTS, MAX_OBJECTS, MAX_SHAPES,
  applyDraw, applyScene3D, emptyBoard,
} from '../src/scene.ts'
import { createBoardTools } from '../src/tools.ts'
import { DRAW_TOOL, LOOK_TOOL, READ_TOOL, SCENE_TOOL } from '../src/shared.ts'

const FIELD_TYPES = new Set(['number', 'integer', 'string', 'boolean', 'array', 'object'])
const CLIENT_FACES = new Set(['both', 'host'])
const SCOPES = new Set(FIELD_SCOPES)

/** True when a wire name is documented for a kind (through the kind or its surface scope). */
function documentedFor(kind, name, surfaceScope) {
  return Object.values(FIELD_SPECS).some(spec => spec.name === name
    && (spec.appliesTo.includes(kind) || spec.appliesTo.includes(surfaceScope)))
}

/** A store good enough to build the tool declarations; nothing is executed. */
const store = {
  read: () => ({ rev: 0, board: { mode: '2d', canvas: { shapes: [] }, scene: { objects: [], lights: [] } } }),
  mutate: async () => ({}),
  canUndo: () => false,
}

test('every field spec is complete and JSON-serialisable', () => {
  for (const [id, spec] of Object.entries(FIELD_SPECS)) {
    assert.equal(typeof spec.name, 'string', `${id}: name`)
    assert.match(spec.name, /^[A-Za-z][A-Za-z0-9]*$/, `${id}: wire name shape`)
    assert.equal(spec.name.includes(' '), false, `${id}: wire name has a space`)
    assert.ok(FIELD_TYPES.has(spec.type), `${id}: unknown type ${spec.type}`)
    assert.ok(CLIENT_FACES.has(spec.client), `${id}: unknown client face ${spec.client}`)
    assert.equal(typeof spec.doc, 'string', `${id}: doc`)
    assert.ok(spec.doc.length >= 12, `${id}: doc is too short to stand alone`)
    assert.ok(Array.isArray(spec.appliesTo) && spec.appliesTo.length > 0, `${id}: appliesTo`)
    for (const scope of spec.appliesTo) assert.ok(SCOPES.has(scope), `${id}: unknown scope ${scope}`)
    assert.notEqual(spec.accepted, true, `${id}: accepted is a negative marker only`)
    // Numeric fields must state both bounds, or say explicitly that they are unbounded.
    if (spec.type === 'number' || spec.type === 'integer') {
      const bounded = spec.min !== undefined && spec.max !== undefined
      assert.ok(bounded || spec.unbounded === true, `${id}: numeric field has no min/max or unbounded marker`)
      if (bounded) assert.ok(spec.min < spec.max, `${id}: min must be < max`)
    }
    if (spec.enum !== undefined) {
      assert.ok(spec.enum.length > 0, `${id}: empty enum`)
      assert.equal(new Set(spec.enum).size, spec.enum.length, `${id}: duplicate enum value`)
    }
    if (spec.nullable === true) {
      assert.ok(spec.type === 'string' || spec.type === 'array', `${id}: only paints and dash may be nullable`)
    }
    if (spec.type === 'array') assert.ok(spec.items !== undefined, `${id}: array without items`)
    if (spec.type === 'object') assert.ok(spec.children !== undefined, `${id}: object without children`)
    if (spec.maxLength !== undefined) assert.ok(spec.maxLength > 0, `${id}: maxLength`)
    if (spec.minItems !== undefined || spec.maxItems !== undefined) {
      assert.ok(spec.type === 'array', `${id}: item bounds on a non-array`)
      if (spec.minItems !== undefined && spec.maxItems !== undefined) {
        assert.ok(spec.minItems <= spec.maxItems, `${id}: minItems > maxItems`)
      }
    }
    if (spec.default !== undefined) assert.doesNotThrow(() => JSON.stringify(spec.default), `${id}: default`)
    if (spec.example !== undefined) assert.doesNotThrow(() => JSON.stringify(spec.example), `${id}: example`)
  }
})

test('every kind spec covers its kinds exactly once and names only documented fields', () => {
  assert.deepEqual(Object.keys(SHAPE_SPECS).sort(), [...SHAPE_KINDS].sort(), 'shape kinds')
  assert.deepEqual(Object.keys(OBJECT_SPECS).sort(), [...OBJECT_KINDS].sort(), 'object kinds')
  const seen = new Set()
  for (const [kind, spec] of [...Object.entries(SHAPE_SPECS), ...Object.entries(OBJECT_SPECS)]) {
    assert.equal(seen.has(kind), false, `duplicate kind ${kind}`)
    seen.add(kind)
    assert.equal(spec.kind, kind, `${kind}: kind discriminator`)
    assert.ok(spec.doc.length >= 12, `${kind}: doc`)
    const surfaceScope = kind in SHAPE_SPECS ? 'shape' : 'object'
    for (const name of spec.required) {
      assert.ok(documentedFor(kind, name, surfaceScope), `${kind}: required field ${name} is not documented`)
    }
    for (const [name, value] of Object.entries(spec.defaults ?? {})) {
      assert.ok(documentedFor(kind, name, surfaceScope), `${kind}: default for undocumented field ${name}`)
      assert.doesNotThrow(() => JSON.stringify(value), `${kind}.${name}: default`)
    }
    assert.equal(spec.example.kind, kind, `${kind}: example kind`)
    for (const name of Object.keys(spec.example)) {
      if (name === 'kind') continue
      assert.ok(documentedFor(kind, name, surfaceScope), `${kind}: example uses undocumented field ${name}`)
    }
    if (kind === 'plane') {
      assert.equal(spec.defaults.size.length, 3, 'plane size must be a 3-vector')
      assert.equal(spec.example.size.length, 3, 'plane example size must be a 3-vector')
    }
    const defaults = kindDefaults(kind, spec.defaults)
    assert.equal(typeof defaults, 'object', `${kind}: defaults`)
    assert.doesNotThrow(() => JSON.stringify(defaults), `${kind}: merged defaults`)
  }
  // The declared kind list and the specs cannot disagree.
  assert.deepEqual(SHAPE_KINDS, ['rect', 'ellipse', 'line', 'arrow', 'polyline', 'path', 'text'])
  assert.deepEqual(OBJECT_KINDS, ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane'])
})

test('the 2D parameter schema declares all seven shape kinds and every 2D field', () => {
  const parameters = buildDrawParameters()
  assert.equal(parameters.ops.type, 'array')
  assert.equal(parameters.ops.required, true)
  assert.equal(parameters.ops.items.type, 'object')
  assert.equal(parameters.ops.items.additionalProperties, false)
  const properties = parameters.ops.items.properties
  assert.deepEqual([...properties.kind.enum], [...SHAPE_KINDS])
  assert.equal(properties.kind.required, true, 'kind is required on add')
  assert.equal(properties.op.required, true, 'op is required')
  assert.deepEqual([...properties.op.enum], [...OP_VERBS])
  for (const name of [
    'x', 'y', 'w', 'h', 'radius', 'rotation', 'cx', 'cy', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2',
    'head', 'curve', 'points', 'smooth', 'closed', 'd', 'text', 'size', 'weight', 'align', 'baseline',
    'maxWidth', 'fill', 'stroke', 'strokeWidth', 'opacity', 'dash', 'shadow',
  ]) {
    assert.ok(properties[name] !== undefined, `generated 2D schema lost \`${name}\``)
    assert.ok((properties[name].description ?? '').length > 0, `\`${name}\` has no description`)
  }
  assert.deepEqual(properties.fill.oneOf.map(node => node.type), ['string', 'null'])
  assert.deepEqual(properties.stroke.oneOf.map(node => node.type), ['string', 'null'])
  assert.equal(properties.points.type, 'array')
  assert.equal(properties.points.items.type, 'array')
  assert.equal(properties.points.items.items.type, 'number')
  assert.deepEqual(properties.dash.oneOf.map(node => node.type), ['array', 'null'])
  assert.equal(properties.dash.oneOf[0].items.type, 'number')
  assert.deepEqual([...properties.weight.enum], ['regular', 'medium', 'bold'])
  assert.deepEqual([...properties.align.enum], ['left', 'center', 'right'])
  assert.deepEqual([...properties.baseline.enum], ['top', 'middle', 'bottom'])
  assert.deepEqual([...properties.head.enum], ['end', 'both', 'none'])
  // The 2D surface must not leak 3D fields.
  for (const name of ['position', 'scale', 'metalness', 'segments']) {
    assert.equal(properties[name], undefined, `2D schema leaked 3D field ${name}`)
  }
  // Every documented 2D op field is generated.
  for (const spec of Object.values(FIELD_SPECS)) {
    const onSurface = spec.appliesTo.some(scope => scope === 'draw' || scope === 'shape' || SHAPE_KINDS.includes(scope))
    if (onSurface) assert.ok(properties[spec.name] !== undefined, `2D op field ${spec.name} is missing`)
  }
})

test('the 3D parameter schema declares all six object kinds, the view and the reserved fields', () => {
  const parameters = buildSceneParameters()
  const properties = parameters.ops.items.properties
  assert.deepEqual([...properties.kind.enum], [...OBJECT_KINDS])
  for (const name of [
    'position', 'rotation', 'scale', 'size', 'radius', 'radiusTop', 'radiusBottom', 'height', 'tube',
    'segments', 'color', 'metalness', 'roughness', 'opacity', 'wireframe', 'emissive', 'spin',
    'castShadow', 'receiveShadow',
  ]) {
    assert.ok(properties[name] !== undefined, `generated 3D schema lost \`${name}\``)
    assert.ok((properties[name].description ?? '').length > 0, `\`${name}\` has no description`)
  }
  assert.equal(properties.segments.type, 'integer')
  assert.equal(properties.size.items.type, 'number')
  assert.equal(properties.size.description.includes('[x, y, z]'), true)
  for (const name of ['x', 'w', 'points', 'd', 'text', 'fill', 'stroke']) {
    assert.equal(properties[name], undefined, `3D schema leaked 2D field ${name}`)
  }

  const view = parameters.view
  assert.equal(view.type, 'object')
  assert.equal(view.additionalProperties, false)
  assert.deepEqual(
    Object.keys(view.properties),
    ['camera', 'background', 'grid', 'autoRotate', 'lights', 'shadow', 'environment'],
  )
  assert.deepEqual(Object.keys(view.properties.camera.properties), ['position', 'target', 'fov'])
  assert.deepEqual(view.properties.background.oneOf.map(node => node.type), ['string', 'null'])
  assert.equal(view.properties.grid.type, 'boolean')
  assert.equal(view.properties.autoRotate.type, 'boolean')

  const light = view.properties.lights
  assert.equal(light.type, 'array')
  assert.equal(light.items.type, 'object')
  assert.deepEqual([...light.items.properties.kind.enum], ['ambient', 'directional', 'point'])
  assert.equal(light.items.properties.kind.required, true)
  for (const name of ['color', 'intensity', 'position', 'castShadow', 'shadow']) {
    assert.ok(light.items.properties[name] !== undefined, `light schema lost \`${name}\``)
  }
  assert.deepEqual(Object.keys(light.items.properties.shadow.properties), ['radius', 'mapSize'])
  assert.equal(light.items.properties.shadow.properties.mapSize.type, 'integer')

  assert.deepEqual(Object.keys(view.properties.shadow.properties), ['enabled', 'opacity', 'softness'])
  assert.deepEqual([...view.properties.environment.properties.kind.enum], ['studio', 'none'])
  assert.equal(view.properties.environment.properties.intensity.type, 'number')
  assert.deepEqual(VIEW_SPEC.lights.default, JSON.parse(JSON.stringify(DEFAULT_LIGHTS)))
})

test('the generated schemas stay compatible with the shipped tool declarations', () => {
  const [drawTool, sceneTool] = createBoardTools(store, Promise.resolve())
  assert.equal(drawTool.name, DRAW_TOOL)
  assert.equal(sceneTool.name, SCENE_TOOL)

  // `defineTool` compiles the DSL to raw JSON Schema at definition time, so the
  // shipped declaration is the compiled form, not the authoring object.
  const shippedDraw = drawTool.parameters.properties.ops.items.properties
  assert.deepEqual(drawTool.parameters.required, ['ops'])
  assert.equal(drawTool.parameters.properties.ops.items.required.includes('op'), true)
  const generatedDraw = buildDrawParameters().ops.items.properties
  for (const [name, shipped] of Object.entries(shippedDraw)) {
    const generated = generatedDraw[name]
    assert.ok(generated !== undefined, `the generated 2D schema lost shipped field \`${name}\``)
    if (shipped.type !== undefined) {
      // A nullable paint is a oneOf in the generated schema; the shipped scalar
      // type must still be one of its branches.
      if (generated.type !== undefined) assert.equal(generated.type, shipped.type, `2D \`${name}\` type`)
      else assert.ok(
        generated.oneOf !== undefined && generated.oneOf.some(node => node.type === shipped.type),
        `2D \`${name}\` lost the shipped ${shipped.type} branch`,
      )
    }
    if (shipped.enum !== undefined) {
      assert.deepEqual([...generated.enum], [...shipped.enum], `2D \`${name}\` enum`)
    }
    if (shipped.oneOf !== undefined) {
      assert.deepEqual(
        generated.oneOf.map(node => node.type),
        shipped.oneOf.map(node => node.type),
        `2D \`${name}\` oneOf`,
      )
    }
  }
  // Sampled fields named by the brief: rect w/h, text text, and the enum fields.
  assert.equal(generatedDraw.w.type, 'number')
  assert.equal(generatedDraw.h.type, 'number')
  assert.equal(generatedDraw.text.type, 'string')
  assert.match(generatedDraw.text.description, /280/)
  // The sampled descriptions must still say what the shipped ones say.
  assert.match(generatedDraw.w.description, /width/i)
  assert.match(generatedDraw.h.description, /height/i)
  assert.match(generatedDraw.text.description, /label/i)
  assert.deepEqual([...generatedDraw.weight.enum], [...shippedDraw.weight.enum])
  assert.deepEqual([...generatedDraw.align.enum], [...shippedDraw.align.enum])
  assert.deepEqual(generatedDraw.points.items.type, shippedDraw.points.items.type)

  const shippedScene = sceneTool.parameters.properties.ops.items.properties
  const generatedScene = buildSceneParameters().ops.items.properties
  for (const [name, shipped] of Object.entries(shippedScene)) {
    const generated = generatedScene[name]
    assert.ok(generated !== undefined, `the generated 3D schema lost shipped field \`${name}\``)
    if (shipped.type !== undefined) {
      if (generated.type !== undefined) assert.equal(generated.type, shipped.type, `3D \`${name}\` type`)
      else assert.ok(
        generated.oneOf !== undefined && generated.oneOf.some(node => node.type === shipped.type),
        `3D \`${name}\` lost the shipped ${shipped.type} branch`,
      )
    }
  }
  assert.equal(generatedScene.segments.type, 'integer')
  assert.equal(shippedScene.segments.type, 'integer')
  assert.match(generatedScene.segments.description, /tessellation/i)
  assert.deepEqual([...generatedScene.kind.enum], [...shippedScene.kind.enum])

  // Our view is the shipped view plus the next-step blocks; it must not lose one.
  const shippedView = sceneTool.parameters.properties.view.properties
  const generatedView = buildSceneParameters().view.properties
  for (const name of Object.keys(shippedView)) {
    assert.ok(generatedView[name] !== undefined, `the generated view lost shipped block \`${name}\``)
  }
  assert.deepEqual(
    Object.keys(shippedView.camera.properties),
    Object.keys(generatedView.camera.properties),
  )
})

test('the limits pin the numbers tools.ts actually enforces', () => {
  assert.equal(LIMITS.shapes, MAX_SHAPES)
  assert.equal(LIMITS.objects, MAX_OBJECTS)
  assert.equal(LIMITS.lights, MAX_LIGHTS)
  assert.equal(MAX_SHAPES, 300)
  assert.equal(MAX_OBJECTS, 120)
  assert.equal(MAX_LIGHTS, 4)
  assert.deepEqual(LIMITS, {
    shapes: 300,
    objects: 120,
    opsPerCall: 64,
    lights: 4,
    text: 280,
    path: 4000,
    points: 400,
    coordLimit: 20000,
  })

  // The runtime caps live in tools.ts and are not exported; pin the source so a
  // change on that side fails here instead of drifting from the manifest.
  const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const literals = {
    MAX_BATCH: ['64', LIMITS.opsPerCall],
    MAX_TEXT: ['280', LIMITS.text],
    MAX_PATH: ['4000', LIMITS.path],
    MAX_POINTS: ['400', LIMITS.points],
    COORD_LIMIT: ['20_000', LIMITS.coordLimit],
  }
  for (const [name, [literal, expected]] of Object.entries(literals)) {
    assert.match(source, new RegExp(`const ${name} = ${literal}\\b`), `tools.ts no longer declares ${name} = ${literal}`)
    assert.equal(expected, Number(literal.replaceAll('_', '')), `${name} drifted from LIMITS`)
  }

  // Tool names are part of the contract; shared.ts remains the wire authority.
  assert.equal(TOOL_NAMES.draw, DRAW_TOOL)
  assert.equal(TOOL_NAMES.scene3d, SCENE_TOOL)
  assert.equal(TOOL_NAMES.read, READ_TOOL)
  assert.equal(TOOL_NAMES.look, LOOK_TOOL)
  assert.equal(TOOL_NAMES.api, 'whiteboard_api')
  for (const role of ['draw', 'scene3d', 'read', 'look', 'api']) {
    assert.equal(TOOL_SPECS[role].name, TOOL_NAMES[role])
    assert.ok(TOOL_SPECS[role].purpose.length > 20, `${role}: purpose`)
  }
})

test('the text limit is 280 characters, not the shipped 40-character hint', () => {
  assert.equal(LIMITS.text, 280)
  assert.match(fieldSpecById('shape.text').doc, /280/)
  assert.equal(buildDrawParameters().ops.items.properties.text.description.includes('280'), true)
  const manifest = buildManifest({})
  const text = manifest.ops.draw.fields.find(field => field.name === 'text')
  assert.ok(text !== undefined)
  assert.match(text.doc, /280/)
  assert.equal(text.maxLength, 280)
  // The defect this spec fixes: the hand-written schema says "≤40 chars". Do not
  // let that number reappear in any generated documentation.
  assert.equal(/≤\s*40\s*chars/i.test(JSON.stringify(manifest)), false)
  assert.equal(/≤\s*40\s*chars/i.test(JSON.stringify(buildDrawParameters())), false)
})

test('the manifest is a complete, secret-free contract for an empty board', () => {
  const manifest = buildManifest({})
  assert.equal(manifest.apiVersion, API_VERSION)
  assert.equal(manifest.build, 'dev')
  assert.deepEqual(manifest.limits, LIMITS)
  for (const role of ['draw', 'scene3d', 'read', 'look', 'api']) {
    assert.equal(manifest.tools[role].name, TOOL_NAMES[role])
    assert.ok(manifest.tools[role].purpose.length > 20)
  }

  assert.equal(manifest.surfaces.canvas2d.extent, 1000)
  assert.equal(manifest.surfaces.canvas2d.origin, 'top-left')
  assert.equal(manifest.surfaces.canvas2d.yAxis, 'down')
  assert.equal(manifest.surfaces.scene3d.up, 'y')
  assert.equal(manifest.surfaces.scene3d.groundY, 0)

  assert.equal(manifest.current.theme, 'light')
  assert.equal(manifest.current.viewport, null)
  assert.equal(manifest.current.rev, 0)
  assert.equal(manifest.current.mode, '2d')
  assert.deepEqual(manifest.current.counts, { shapes: 0, objects: 0 })
  assert.deepEqual(manifest.current.camera, DEFAULT_CAMERA)
  assert.deepEqual(manifest.current.lights, DEFAULT_LIGHTS)
  assert.deepEqual(manifest.current.shadow, DEFAULT_SHADOW)
  assert.deepEqual(manifest.current.environment, environmentDefaults('light'))
  assert.deepEqual(DEFAULT_ENVIRONMENT, environmentDefaults('light'))
  assert.deepEqual(manifest.current.grid, { canvas: true, scene: true })
  assert.deepEqual(manifest.current.background, { canvas: null, scene: null })
  assert.equal(manifest.current.autoRotate, false)

  assert.deepEqual(manifest.defaults.camera, DEFAULT_CAMERA)
  assert.deepEqual(manifest.defaults.lights, DEFAULT_LIGHTS)
  assert.equal(manifest.defaults.canvas.grid, true)
  assert.equal(manifest.defaults.canvas.background, null)
  assert.equal(manifest.defaults.scene.grid, true)
  assert.equal(manifest.defaults.scene.autoRotate, false)
  assert.deepEqual(manifest.defaults.shape, defaultsFor('shape'))
  assert.deepEqual(manifest.defaults.text, defaultsFor('text'))
  assert.deepEqual(manifest.defaults.object, defaultsFor('object'))
  assert.deepEqual(manifest.defaults.light, defaultsFor('light'))
  assert.equal(manifest.defaults.shape.strokeWidth, 3)
  assert.equal(manifest.defaults.shape.opacity, 1)
  assert.equal(manifest.defaults.text.size, 22)
  assert.equal(manifest.defaults.text.weight, 'regular')
  assert.equal(manifest.defaults.object.metalness, 0.15)
  assert.equal(manifest.defaults.geometry.segments, 32)

  assert.deepEqual(manifest.design.typeScale, DESIGN_SPEC.typeScale)
  assert.deepEqual(manifest.design.spacing, DESIGN_SPEC.spacing)
  assert.deepEqual(manifest.design.palette.tokens, DESIGN_SPEC.palette.tokens)
  assert.deepEqual(manifest.design.palette.semantics, DESIGN_SPEC.palette.semantics)
  assert.equal(manifest.design.palette.resolved, undefined)
  assert.equal(manifest.design.contrast, undefined)

  assert.deepEqual(manifest.ops.verbs, [...OP_VERBS])
  assert.equal(manifest.ops.draw.kinds.length, 7)
  assert.equal(manifest.ops.scene3d.kinds.length, 6)
  assert.deepEqual(manifest.ops.draw.kinds.map(kind => kind.kind), [...SHAPE_KINDS])
  assert.deepEqual(manifest.ops.scene3d.kinds.map(kind => kind.kind), [...OBJECT_KINDS])
  assert.equal(manifest.ops.draw.view2d.accepted, false)
  for (const name of ['camera', 'background', 'grid', 'autoRotate', 'lights', 'shadow', 'environment']) {
    assert.ok(manifest.ops.scene3d.view[name] !== undefined, `manifest view lost ${name}`)
  }
  assert.equal(manifest.ops.scene3d.view.lights.maxItems, 4)
  const lightFields = manifest.ops.scene3d.view.lights.fields
  const lightShadow = lightFields.find(field => field.name === 'shadow')
  assert.ok(lightShadow !== undefined)
  assert.deepEqual(lightShadow.fields.map(field => field.name), ['radius', 'mapSize'])
  assert.equal(lightShadow.fields[1].type, 'integer')
  assert.deepEqual(
    manifest.ops.scene3d.view.camera.fields.map(field => field.name),
    ['position', 'target', 'fov'],
  )

  assert.ok(HINTS.length >= 5)
  assert.deepEqual(manifest.hints, HINTS)
  assert.deepEqual(manifest.examples, EXAMPLES)
  const knownTools = new Set(Object.values(TOOL_NAMES))
  for (const example of Object.values(manifest.examples)) {
    assert.ok(knownTools.has(example.tool), `example names an unknown tool ${example.tool}`)
    assert.ok(example.note.length > 20)
    assert.ok(Array.isArray(example.args.ops) && example.args.ops.length > 0)
    assert.doesNotThrow(() => JSON.stringify(example.args))
  }
  assert.equal(manifest.examples.fixShadow.accepted, true)
  assert.equal(manifest.examples.fixShadow.args.view.lights[1].castShadow, false)
  assert.equal(manifest.examples.fixShadow.args.view.lights[2].castShadow, true)

  const json = JSON.stringify(manifest)
  assert.deepEqual(JSON.parse(json), manifest, 'the manifest survives a JSON round-trip')
  assert.equal(json.includes('/Users/'), false, 'the manifest leaks a filesystem path')
  assert.equal(/DSH_HOME|process\.env|\.wbdev|storages\/whiteboard/.test(json), false, 'the manifest leaks environment detail')
})

test('the manifest reports a live 3D board and the request context', () => {
  let board = applyDraw(emptyBoard(), {
    ops: [{ op: 'add', shape: { id: 'rect-1', kind: 'rect', x: 10, y: 10, w: 100, h: 50 } }],
  })
  board = applyScene3D(board, {
    ops: [{ op: 'add', object: { id: 'box-1', kind: 'box', position: [1, 2, 3], castShadow: false } }],
    view: {
      camera: { position: [10, 10, 10], target: [0, 1, 0], fov: 60 },
      lights: [{
        kind: 'directional', color: 'teal', intensity: 1.2, position: [3, 4, 5],
        castShadow: true, shadow: { radius: 3, mapSize: 1024 },
      }],
      background: 'black',
      grid: false,
      autoRotate: true,
    },
  })
  const snapshot = JSON.stringify(board)
  const manifest = buildManifest({
    board,
    theme: 'dark',
    viewport: { width: 1200, height: 800, dpr: 2 },
    palette: { ink: '#f9fafb', blue: '#3b82f6' },
    contrast: { ink: 18.9, blue: 4.5 },
    build: 'test-build-1',
  })
  assert.equal(manifest.build, 'test-build-1')
  assert.equal(manifest.current.theme, 'dark')
  assert.deepEqual(manifest.current.viewport, { width: 1200, height: 800, dpr: 2 })
  assert.equal(manifest.current.rev, board.rev)
  assert.equal(manifest.current.mode, '3d')
  assert.deepEqual(manifest.current.counts, { shapes: 1, objects: 1 })
  assert.deepEqual(manifest.current.camera, board.scene.camera)
  assert.deepEqual(manifest.current.lights, board.scene.lights)
  assert.equal(manifest.current.lights[0].castShadow, true)
  assert.deepEqual(manifest.current.lights[0].shadow, { radius: 3, mapSize: 1024 })
  assert.deepEqual(manifest.current.grid, { canvas: true, scene: false })
  assert.deepEqual(manifest.current.background, { canvas: null, scene: 'black' })
  assert.equal(manifest.current.autoRotate, true)
  assert.deepEqual(manifest.current.environment, environmentDefaults('dark'))
  assert.equal(manifest.current.environment.intensity, 0.95)

  assert.deepEqual(manifest.design.palette.resolved, { ink: '#f9fafb', blue: '#3b82f6' })
  assert.deepEqual(manifest.design.contrast, { ink: 18.9, blue: 4.5 })
  assert.equal(JSON.stringify(board), snapshot, 'buildManifest must not mutate the board')
})

test('buildManifest is pure and returns fresh defaults', () => {
  const first = buildManifest({})
  first.current.camera.position[0] = 999
  first.defaults.lights[0].intensity = 9
  first.defaults.shape.strokeWidth = 99
  first.defaults.geometry.segments = 7
  first.current.shadow.opacity = 0
  first.defaults.scene.environment.intensity = 2
  first.design.typeScale.body = 99
  first.ops.draw.kinds[0].defaults.strokeWidth = 42
  first.examples.draw.args.ops[0].x = 999
  first.hints.length = 0
  first.surfaces.canvas2d.extent = -1
  first.tools.draw.name = 'nope'
  first.limits.shapes = 1

  const second = buildManifest({})
  assert.deepEqual(second.current.camera, DEFAULT_CAMERA)
  assert.deepEqual(second.defaults.lights, DEFAULT_LIGHTS)
  assert.equal(second.defaults.shape.strokeWidth, 3)
  assert.equal(second.defaults.geometry.segments, 32)
  assert.equal(second.current.shadow.opacity, 0.32)
  assert.equal(second.defaults.scene.environment.intensity, 0.75)
  assert.equal(second.design.typeScale.body, DESIGN_SPEC.typeScale.body)
  assert.equal(second.ops.draw.kinds[0].defaults.strokeWidth, 3)
  assert.equal(second.examples.draw.args.ops[0].x, 70)
  assert.ok(second.hints.length >= 5)
  assert.equal(second.surfaces.canvas2d.extent, 1000)
  assert.equal(second.tools.draw.name, TOOL_NAMES.draw)
  assert.equal(second.limits.shapes, 300)
})

test('copyable examples only use fields the current tool build accepts', () => {
  for (const [name, example] of Object.entries(EXAMPLES)) {
    if (example.accepted) {
      const json = JSON.stringify(example.args)
      assert.equal(json.includes('"environment"'), false, `${name}: an accepted example uses reserved environment`)
      assert.equal(json.includes('view2d'), false, `${name}: an accepted example uses the reserved 2D view`)
      if (example.args.view !== undefined) {
        assert.equal(
          Object.hasOwn(example.args.view, 'shadow'),
          false,
          `${name}: an accepted example uses reserved view.shadow`,
        )
      }
    } else {
      assert.match(example.note, /reserved|next-step/, `${name}: a non-accepted example must say why`)
    }
  }
  // The shadow example is the accepted, supported way to fix a light rig.
  assert.equal(EXAMPLES.fixShadow.accepted, true)
  assert.equal(EXAMPLES.fixShadow.args.view.lights[1].castShadow, false)
  assert.equal(EXAMPLES.fixShadow.args.view.lights[2].castShadow, true)
  assert.equal(EXAMPLES.scene3d.args.view.lights, undefined)
})

test('generated schemas are fresh JSON on every call', () => {
  const draw = buildDrawParameters()
  draw.ops.items.properties.kind.enum.push('nope')
  draw.ops.items.properties.w.description = 'mutated'
  const scene = buildSceneParameters()
  scene.view.properties.lights.items.properties.kind.enum.length = 0
  scene.view.properties.lights.items.properties.shadow.properties.radius.description = 'mutated'
  scene.ops.items.properties.segments.description = 'mutated'

  const nextDraw = buildDrawParameters()
  assert.deepEqual([...nextDraw.ops.items.properties.kind.enum], [...SHAPE_KINDS])
  assert.equal(nextDraw.ops.items.properties.w.description.includes('mutated'), false)
  assert.ok(SHAPE_KINDS.includes('nope') === false)
  const nextScene = buildSceneParameters()
  assert.deepEqual([...nextScene.view.properties.lights.items.properties.kind.enum], ['ambient', 'directional', 'point'])
  assert.equal(nextScene.view.properties.lights.items.properties.shadow.properties.radius.description.includes('mutated'), false)
  assert.equal(nextScene.ops.items.properties.segments.description.includes('mutated'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(nextScene)), nextScene, 'the schema is JSON data only')
})

test('reserved fields are marked, documented and filterable from a generated schema', () => {
  for (const id of ['view3d.shadow', 'view3d.environment', 'view2d.background', 'view2d.grid']) {
    assert.equal(fieldSpecById(id).accepted, false, `${id} must be marked as not accepted yet`)
  }
  for (const id of ['object.castShadow', 'object.receiveShadow', 'light.castShadow', 'light.shadow']) {
    assert.notEqual(fieldSpecById(id).accepted, false, `${id} is accepted by the current tool build`)
    assert.equal(fieldSpecById(id).client, 'both', `${id} is read by the renderer`)
  }
  const manifest = buildManifest({})
  const castShadow = manifest.ops.scene3d.fields.find(field => field.name === 'castShadow')
  assert.ok(castShadow !== undefined)
  assert.equal(castShadow.accepted, true)
  assert.equal(castShadow.client, 'both')
  assert.ok(manifest.hints.some(hint => hint.includes('reserved')))
  assert.equal(manifest.ops.draw.view2d.accepted, false)

  const full = buildSceneParameters()
  assert.ok(full.ops.items.properties.castShadow !== undefined)
  assert.ok(full.ops.items.properties.receiveShadow !== undefined)
  assert.ok(full.view.properties.shadow !== undefined)
  assert.ok(full.view.properties.environment !== undefined)
  assert.ok(full.view.properties.lights.items.properties.castShadow !== undefined)
  assert.ok(full.view.properties.lights.items.properties.shadow !== undefined)

  const accepted = buildSceneParameters({ includeReserved: false })
  assert.ok(accepted.ops.items.properties.castShadow !== undefined)
  assert.ok(accepted.ops.items.properties.receiveShadow !== undefined)
  assert.equal(accepted.view.properties.shadow, undefined)
  assert.equal(accepted.view.properties.environment, undefined)
  assert.ok(accepted.view.properties.lights.items.properties.castShadow !== undefined)
  assert.ok(accepted.view.properties.lights.items.properties.shadow !== undefined)
  for (const name of ['camera', 'background', 'grid', 'autoRotate', 'lights']) {
    assert.ok(accepted.view.properties[name] !== undefined, `filtering dropped the accepted block ${name}`)
  }
  for (const name of ['op', 'id', 'kind', 'position', 'color', 'segments', 'castShadow', 'receiveShadow']) {
    assert.ok(accepted.ops.items.properties[name] !== undefined, `filtering dropped the accepted field ${name}`)
  }
})
