// Tests for the stack a toolkit row carries (do-work/toolkit-stack.mjs) and the cart first setup fills from it. The pointers are
// made-up addresses: what a test checks is the reader, the order of use, the swap and its inverse, and the default cart.

import assert from 'node:assert/strict';
import test from 'node:test';

import { fillCart, offeredToolkits } from '../do-work/choose-toolkit.mjs';
import { readPointer, readToolkitStack } from '../do-work/toolkit-stack.mjs';
import { walkAPersonThroughFirstSetup } from '../do-work/walk-a-new-person-through-first-setup.mjs';

const ORIGIN = 'https://app.example.test';
const notStarted = { workflow: { exists: false, state: 'not_started' } };
const one = { id: 'sample-file', door: 'file:sample.db', speaks: 'sql' };
const two = { id: 'sample-server', door: 'sample://127.0.0.1:1234/x', speaks: 'sql', credential: 'sample-password' };
const three = { id: 'sample-third', door: '@sample-door', speaks: 'tools:run', label: 'tool:sample-draft' };
const withStack = () => ({ title: 'Sample', items: ['tool:sample-draft'], stack: { data: [one, two, three], pages: [{ ...one, id: 'sample-pages' }] } });
const row = (id, value) => ({ id, type: 'record:toolkit', value });

test('a row of tools only reads as before, with no stack', () => {
  assert.equal(readToolkitStack({ items: ['tool:sample-draft'] }), null);
  const [offered] = offeredToolkits([row('toolkit:a', { items: ['tool:sample-draft'] })]);
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
  const toolkits = [row('toolkit:a', { items: ['tool:sample-cut'] }), row('toolkit:b', { ...withStack(), default: true })];
  const cart = fillCart({ toolkits });
  assert.equal(cart.toolkit, 'toolkit:b');
  assert.equal(cart.picked, false);
  assert.deepEqual(cart.tools, ['tool:sample-draft']);
  assert.deepEqual(Object.keys(cart.stack), ['data', 'pages']);
  assert.throws(() => fillCart({ toolkits: [row('toolkit:a', { items: ['tool:sample-cut'] })] }), /no offered toolkit is marked default/);
  assert.throws(() => offeredToolkits([row('toolkit:a', { ...withStack(), default: true }), row('toolkit:b', { ...withStack(), default: true })]), /one toolkit is the default/);
});

test('a pick fills the cart from the picked toolkit with its stack', () => {
  const toolkits = [row('toolkit:a', { ...withStack(), default: true }), row('toolkit:b', { items: ['tool:sample-cut'], stack: { data: [two, one] } })];
  const cart = fillCart({ toolkits, choice: { toolkit: 'toolkit:b' } });
  assert.equal(cart.toolkit, 'toolkit:b');
  assert.equal(cart.picked, true);
  assert.deepEqual(cart.stack.data.map(pointer => pointer.id), ['sample-server', 'sample-file']);
});

test('first setup carries the cart in the plan; with no row marked default and nothing picked, there is no cart', () => {
  const toolkits = [row('toolkit:a', { ...withStack(), default: true })];
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits });
  assert.equal(plan.toolkits.cart.toolkit, 'toolkit:a');
  assert.equal(plan.toolkits.choice, undefined);
  const plain = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits: [row('toolkit:a', { items: ['tool:sample-cut'] })] });
  assert.equal(plain.toolkits.cart, undefined);
});

test('a row marked every_account is in every cart, after the picked toolkit\'s tools, and is never picked or the default', () => {
  const always = row('toolkit:always', { items: ['tool:sample-cut', 'tool:sample-keep'], every_account: true });
  const toolkits = [row('toolkit:a', { items: ['tool:sample-draft', 'tool:sample-cut'], default: true }), row('toolkit:b', { items: ['tool:sample-edit'] }), always];
  const standing = fillCart({ toolkits });
  assert.deepEqual(standing.tools, ['tool:sample-draft', 'tool:sample-cut', 'tool:sample-keep']);
  assert.deepEqual(standing.every_account, ['tool:sample-keep']);
  const picked = fillCart({ toolkits, choice: { toolkit: 'toolkit:b', drop: ['tool:sample-edit'] } });
  assert.deepEqual(picked.tools, ['tool:sample-cut', 'tool:sample-keep']);
  assert.deepEqual(offeredToolkits(toolkits).filter(toolkit => toolkit.every_account).map(toolkit => toolkit.id), ['toolkit:always']);
  assert.throws(() => fillCart({ toolkits, choice: { toolkit: 'toolkit:always' } }), /in every cart already/);
  assert.throws(() => offeredToolkits([row('toolkit:x', { items: [], every_account: true, default: true })]), /not the default one/);
  assert.throws(() => offeredToolkits([row('toolkit:x', { items: [], every_account: 'yes' })]), /every_account is true or left out/);
});

test('a toolkit lists any marketplace items in order, the services to connect by vault name, and the facts to fill', () => {
  const always = row('toolkit:always', { items: ['tool:sample-keep', 'workflow:sample-tidy'], every_account: true, connections: [{ service: 'Sample mail', credential: 'sample-mail-key', why: 'To send mail.' }] });
  const kit = row('toolkit:a', {
    items: ['tool:sample-draft', 'workflow:sample-make-a-table', 'workflow:sample-read-the-table', 'look:sample-calm'], default: true,
    connections: [{ service: 'Sample social', credential: 'sample-social-token', why: 'To read your messages.' }, { service: 'Sample mail', credential: 'sample-mail-key', why: 'To send mail.' }],
    facts: [{ id: 'business.name', question: 'What is your business called?', from: 'your site' }],
  });
  const [offered] = offeredToolkits([kit]);
  assert.deepEqual(offered.tools, ['tool:sample-draft']);
  assert.deepEqual(offered.items, ['tool:sample-draft', 'workflow:sample-make-a-table', 'workflow:sample-read-the-table', 'look:sample-calm']);
  const cart = fillCart({ toolkits: [kit, always], choice: { toolkit: 'toolkit:a', add: ['tool:sample-cut'] } });
  assert.deepEqual(cart.items, ['tool:sample-draft', 'workflow:sample-make-a-table', 'workflow:sample-read-the-table', 'look:sample-calm', 'tool:sample-cut', 'tool:sample-keep', 'workflow:sample-tidy']);
  assert.deepEqual(cart.tools, ['tool:sample-draft', 'tool:sample-cut', 'tool:sample-keep']);
  assert.deepEqual(cart.connections.map(entry => entry.credential), ['sample-social-token', 'sample-mail-key']);
  assert.deepEqual(cart.facts, [{ id: 'business.name', question: 'What is your business called?', from: 'your site' }]);
  const refuse = value => () => offeredToolkits([row('toolkit:x', { items: [], ...value })]);
  assert.throws(refuse({ connections: [{ service: 'X', credential: 'sk_live_abc', why: 'x' }] }), /vault name/);
  assert.throws(refuse({ connections: [{ service: 'X', credential: 'x-key', why: 'x', key: 'abc' }] }), /a key is never in a row/);
  assert.throws(refuse({ facts: [{ id: 'Bad Id', question: 'x' }] }), /needs an id/);
  assert.throws(refuse({ items: ['workflow'] }), /marketplace item ids/);
});
