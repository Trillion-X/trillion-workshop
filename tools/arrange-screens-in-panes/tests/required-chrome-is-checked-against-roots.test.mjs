// packages/screen-arrangement/tests/required-chrome-is-checked-against-roots.test.mjs
//
// The same two assertions as the vitest cases in read-data/application-composition.test.ts,
// written for node:test so they can actually be EXECUTED here. Only `node` is a declared
// runtime in this environment: npx, pnpm and vitest are refused, so a .test.ts asserting
// this invariant is a claim nobody in this seat can check. This file is the runnable half.
//
// The invariant: a scene declaring `required_chrome` must have roots that project every
// component it names. `required_chrome` was decoded and emitted as a scene fact while
// nothing compared it to the roots, which is how a scene can promise the command palette
// and ship without it.
import assert from 'node:assert/strict';
import test from 'node:test';

const composition = () => ({
  schema: 'bitfield.application-composition/ordered-scene-owner-contributions',
  kind: 'application-composition',
  id: 'example-product',
  revision: 1,
  scene: { id: 'scene:example-product' },
  roots: [{
    id: 'scene-root:example-product',
    order_key: '000000010:root',
    state_epoch: 1,
    material_ref: { component_ref: 'component:example' },
  }],
  contributions: [],
});

const projectorTemplate = {
  type: 'record',
  address: 'edge::render-roots-to-scene',
  address_mode: 'identity_text',
  path: ['edge-config'],
  payload: {
    id: 'render-roots-to-scene',
    paths: ['prop:scene:roots'],
    sink: 'scene',
    source: 'replaced-by-application-composition',
    transform: 'projector',
  },
  remove: false,
};

const load = async () => import('../read-data/application-composition.ts');

test('a scene whose roots omit required chrome is refused', async () => {
  const { compileApplicationComposition, decodeApplicationComposition } = await load();
  const value = composition();
  value.scene = {
    id: 'scene:example-product',
    required_chrome: ['component:example', 'component:command-palette'],
  };
  assert.throws(
    () => compileApplicationComposition(decodeApplicationComposition(value), projectorTemplate),
    /component:command-palette/,
    'the missing component must be named, so the failure says what to add',
  );
});

test('a scene whose roots project every required component compiles', async () => {
  const { compileApplicationComposition, decodeApplicationComposition } = await load();
  const value = composition();
  value.scene = { id: 'scene:example-product', required_chrome: ['component:example'] };
  const compiled = compileApplicationComposition(decodeApplicationComposition(value), projectorTemplate);
  assert.ok(
    compiled.find((thing) => (
      thing.address === 'attribute_fact|scene:example-product|prop:scene:required-chrome|type:scene'
    )),
    'the requirement is still emitted as a scene fact when it is satisfied',
  );
});
