// Tests for the stack a toolkit row carries (do-work/toolkit-stack.mjs) and the cart first setup fills from it. The pointers are
// made-up addresses: what a test checks is the reader, the order of use, the swap and its inverse, and the default cart.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseToolkit, fillCart, offeredToolkits } from '../do-work/choose-toolkit.mjs';
import { setupSteps } from '../do-work/setup-steps-from-a-cart.mjs';
import { readStack } from '../do-work/toolkit-stack.mjs';
import { readPointer, readToolkitStack } from '../do-work/toolkit-stack.mjs';
import { walkAPersonThroughFirstSetup } from '../do-work/walk-a-new-person-through-first-setup.mjs';
import { rows as shippedRows } from '../../../test-helpers/tool-rows.mjs';

const ORIGIN = 'https://app.example.test';
const notStarted = { workflow: { exists: false, state: 'not_started' } };
const one = { id: 'sample-file', door: 'file:sample.db', speaks: 'sql' };
const two = { id: 'sample-server', door: 'sample://127.0.0.1:1234/x', speaks: 'sql', credential: 'sample-password' };
const three = { id: 'sample-third', door: '@sample-door', speaks: 'tools:run', label: 'tool:sample-draft' };
const withStack = () => ({ title: 'Sample', tools: ['tool:sample-draft'], stack: { data: [one, two, three], pages: [{ ...one, id: 'sample-pages' }] } });
const row = (id, value) => ({ id, type: 'record:toolkit', value });

test('a row of tools only reads as before, with no stack', () => {
  assert.equal(readToolkitStack({ tools: ['tool:sample-draft'] }), null);
  const [offered] = offeredToolkits([row('toolkit:a', { tools: ['tool:sample-draft'] })]);
  assert.equal(offered.stack, undefined);
});

test('a stack is read slot by slot, each slot an ordered list of pointers', () => {
  const stack = readToolkitStack(withStack());
  assert.deepEqual(stack.data.map(pointer => pointer.id), ['sample-file', 'sample-server', 'sample-third']);
  assert.throws(() => readToolkitStack({ stack: { data: [] } }), /at least one pointer/);
  assert.throws(() => readToolkitStack({ stack: { data: [one, one] } }), /repeats the pointer id/);
  assert.throws(() => readToolkitStack({ stack: { 'Bad Slot': [one] } }), /slot name/);
});

test('a pointer holding a key value is refused, in a field of its own, in its credential or in its address', () => {
  assert.throws(() => readPointer({ ...one, key: 'abc' }, 'p'), /holds key/);
  assert.throws(() => readPointer({ ...one, password: 'abc' }, 'p'), /holds password/);
  assert.throws(() => readPointer({ ...two, credential: 'sk_live_Abc123def456' }, 'p'), /credential is not written/);
  assert.throws(() => readPointer({ ...two, credential: 'Abc123def456ghi789' }, 'p'), /credential is not written/);
  assert.throws(() => readPointer({ ...two, door: 'sample://user:pass@127.0.0.1/x' }, 'p'), /door is not written/);
  assert.throws(() => readPointer({ ...two, door: 'sample://127.0.0.1/x?key=abc' }, 'p'), /door is not written/);
  assert.throws(() => readPointer({ id: 'x', speaks: 'sql' }, 'p'), /needs its door/);
  assert.throws(() => readToolkitStack({ stack: { data: [{ ...one, key: 'abc' }] } }), /holds key/);
});

test('a person who picks nothing gets the toolkit marked default as it stands', () => {
  const toolkits = [row('toolkit:a', { tools: ['tool:sample-cut'] }), row('toolkit:b', { ...withStack(), default: true })];
  const cart = fillCart({ toolkits });
  assert.equal(cart.toolkit, 'toolkit:b');
  assert.equal(cart.picked, false);
  assert.deepEqual(cart.tools, ['tool:sample-draft']);
  assert.deepEqual(Object.keys(cart.stack), ['data', 'pages']);
  assert.throws(() => fillCart({ toolkits: [row('toolkit:a', { tools: ['tool:sample-cut'] })] }), /no offered toolkit is marked default/);
  assert.throws(() => offeredToolkits([row('toolkit:a', { ...withStack(), default: true }), row('toolkit:b', { ...withStack(), default: true })]), /one toolkit is the default/);
});

test('a pick fills the cart from the picked toolkit with its stack', () => {
  const toolkits = [row('toolkit:a', { ...withStack(), default: true }), row('toolkit:b', { tools: ['tool:sample-cut'], stack: { data: [two, one] } })];
  const cart = fillCart({ toolkits, choice: { toolkit: 'toolkit:b' } });
  assert.equal(cart.toolkit, 'toolkit:b');
  assert.equal(cart.picked, true);
  assert.deepEqual(cart.stack.data.map(pointer => pointer.id), ['sample-server', 'sample-file']);
});

test('first setup carries the cart in the plan, and the tools-only plan carries none', () => {
  const toolkits = [row('toolkit:a', { ...withStack(), default: true })];
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits });
  assert.equal(plan.toolkits.cart.toolkit, 'toolkit:a');
  assert.equal(plan.toolkits.choice, undefined);
  const plain = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits: [row('toolkit:a', { tools: ['tool:sample-cut'] })] });
  assert.equal(plain.toolkits.cart, undefined);
});

const shipped = shippedRows().filter(({ payload }) => payload.kind === 'toolkit').map(({ payload }) => ({ id: payload.id, type: 'record:toolkit', value: payload }));
const toolIds = new Set(shippedRows().filter(({ payload }) => payload.kind === 'ai-tool-descriptor').map(({ payload }) => payload.id));

test('every starter toolkit carries a stack whose pointers are valid, and exactly one is the default', () => {
  const offered = offeredToolkits(shipped);
  assert.equal(offered.length, 3);
  assert.deepEqual(offered.filter(toolkit => toolkit.default).map(toolkit => toolkit.id), [offered[0].id]);
  for (const toolkit of offered) {
    assert.deepEqual(Object.keys(toolkit.stack), ['database', 'files', 'screens', 'hosting', 'sign-in', 'payments'], `${toolkit.id} fills every slot`);
  }
});

test('a pointer of a starter stack that names a Workshop tool names one the Workshop offers', () => {
  const named = offeredToolkits(shipped).flatMap(toolkit => Object.values(toolkit.stack).flat()).filter(pointer => pointer.label?.startsWith('tool:'));
  assert.ok(named.length > 0);
  assert.deepEqual(named.filter(pointer => !toolIds.has(pointer.label)).map(pointer => pointer.label), []);
});

test('picking nothing fills the cart from the first starter row, whose database slot answers a file store first', () => {
  const cart = fillCart({ toolkits: shipped });
  assert.equal(cart.toolkit, 'toolkit:answer-your-audience');
  assert.equal(cart.stack.database[0].id, 'sqlite-file');
  assert.ok(cart.stack.database.length >= 2, 'a second pointer to fall back to or swap in');
});

const swaps = shippedRows().filter(({ payload }) => payload.kind === 'toolkit-swap').map(({ payload }) => payload);

test('every starter swap goes into every starter toolkit, and the cart renders a step for each part from tools the Workshop ships', () => {
  assert.ok(swaps.length > 0, 'the swap rows are listed by source:starter-toolkit-swaps');
  const available = [...toolIds];
  for (const swap of swaps) {
    assert.match(swap.id, /^toolkit-swap:[a-z0-9-]+$/);
    readStack(swap.swap, swap.id);
    const labels = Object.values(swap.swap).flat().map(pointer => pointer.label).filter(label => label?.startsWith('tool:'));
    assert.deepEqual(labels.filter(label => !toolIds.has(label)), [], `${swap.id} names only shipped tools`);
    for (const toolkit of offeredToolkits(shipped)) {
      const cart = chooseToolkit({ toolkits: shipped, choice: { toolkit: toolkit.id, swap: swap.swap } });
      assert.deepEqual(cart.swapped, Object.keys(swap.swap));
      for (const [slot, pointers] of Object.entries(swap.swap)) assert.deepEqual(cart.stack[slot], pointers, `${swap.id} in ${toolkit.id}: ${slot} is the swap's`);
      for (const [slot, pointers] of Object.entries(toolkit.stack)) if (!(slot in swap.swap)) assert.deepEqual(cart.stack[slot], pointers, `${slot} stays the toolkit's`);
      const steps = setupSteps(cart, { available });
      assert.equal(steps.filter(step => step.kind === 'part').length, Object.keys(cart.stack).length);
      assert.deepEqual(steps.filter(step => step.status === 'unavailable').map(step => step.id), [], `${swap.id} in ${toolkit.id}`);
      for (const step of steps.filter(step => step.kind === 'part' && step.credential)) assert.equal(step.status, 'needs_credential');
    }
  }
});
