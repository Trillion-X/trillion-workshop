// A cart's setup steps are rendered from its own parts, and a choice swaps any part, not only tools. The slot names and
// pointers here are made up on purpose (a slot no code knows, a door no code knows): the same code renders every cart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillCart } from '../do-work/choose-toolkit.mjs';
import { setupSteps } from '../do-work/setup-steps-from-a-cart.mjs';

const row = (id, value) => ({ id, type: 'record:toolkit', value });
const toolkits = [row('toolkit:example', {
  default: true,
  items: ['tool:sample-draft', 'tool:sample-send'],
  stack: {
    'place-to-keep': [
      { id: 'a-folder', door: 'file:kept', speaks: 'files' },
      { id: 'a-server', door: 'https://keep.example.com', speaks: 'example-protocol', credential: 'keep-key' },
    ],
    'front-door': [{ id: 'someone-elses', door: 'https://door.example.com', speaks: 'tools:run', label: 'tool:sample-door' }],
  },
})];

test('a cart renders one step per tool and one per slot, its first pointer the part and the rest its alternatives', () => {
  const steps = setupSteps(fillCart({ toolkits }), { available: ['tool:sample-draft', 'tool:sample-door'] });
  assert.deepEqual(steps.map(step => [step.kind, step.slot ?? null, step.id, step.status]), [
    ['tool', null, 'tool:sample-draft', 'ready'],
    ['tool', null, 'tool:sample-send', 'unavailable'],
    ['part', 'place-to-keep', 'a-folder', 'ready'],
    ['part', 'front-door', 'someone-elses', 'ready'],
  ]);
  assert.equal(steps[2].words, 'place-to-keep: use a-folder at file:kept, which speaks files. To use another, swap place-to-keep to one of: a-server.');
  assert.deepEqual(steps[2].alternatives, ['a-server']);
  assert.match(steps[1].words, /not installable here/);
});

test('a choice swaps any part: the slot takes the chosen pointers, a new slot is added, the key is only named', () => {
  const cart = fillCart({ toolkits, choice: { toolkit: 'toolkit:example', swap: {
    'place-to-keep': [{ id: 'a-server', door: 'https://keep.example.com', speaks: 'example-protocol', credential: 'keep-key' }],
    'a-slot-no-code-knows': [{ id: 'anything', door: 'https://any.example.com', speaks: 'any-language' }],
  } } });
  assert.deepEqual(cart.swapped, ['place-to-keep', 'a-slot-no-code-knows']);
  assert.deepEqual(Object.keys(cart.stack), ['place-to-keep', 'front-door', 'a-slot-no-code-knows']);
  const [keep] = setupSteps(cart).filter(step => step.slot === 'place-to-keep');
  assert.equal(keep.status, 'needs_credential');
  assert.equal(keep.words, 'place-to-keep: use a-server at https://keep.example.com, which speaks example-protocol. Keep its key in your vault under the name keep-key; the key is never written in a row.');
  // A part that names a tool not installable here waits; with no list of installable tools nothing is called unavailable.
  assert.equal(setupSteps(cart, { available: [] }).find(step => step.slot === 'front-door').status, 'unavailable');
  assert.ok(setupSteps(cart).every(step => step.status !== 'unavailable'));
});

test('a swap is checked as a stack is: an empty slot or a key written in a pointer is refused', () => {
  assert.throws(() => fillCart({ toolkits, choice: { toolkit: 'toolkit:example', swap: { 'place-to-keep': [] } } }), /at least one pointer/);
  assert.throws(() => fillCart({ toolkits, choice: { toolkit: 'toolkit:example', swap: { 'place-to-keep': [{ id: 'x', door: 'file:x', speaks: 'files', key: 'secret' }] } } }), /never written in a row/);
});
