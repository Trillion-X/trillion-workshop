import test from 'node:test';
import assert from 'node:assert/strict';
import { at, evaluate, fill, isThere } from '../read-data/pointer.mjs';

const message = { id: '7', chat: { id: -1001, title: '', first_name: 'Ana', last_name: 'Lopez', username: 'ana_l' }, 'a/b': { 'c~d': 1 }, list: ['x', 'y'], nothing: null };

test('a pointer reads nested values, array positions and escaped names, and nothing from a missing path', () => {
  assert.equal(at(message, '/chat/id'), -1001);
  assert.equal(at(message, '/list/1'), 'y');
  assert.equal(at(message, '/a~1b/c~0d'), 1);
  assert.equal(at(message, '/chat/missing/deeper'), undefined);
  assert.equal(at(message, '/nothing/deeper'), undefined);
  assert.equal(at(message, ''), message);
});

test('a value is there unless it is missing, null or only spaces', () => {
  assert.deepEqual([undefined, null, '', '  ', 0, false, 'a'].map(isThere), [false, false, false, false, true, true, true]);
});

test('a template fills the names it is given and leaves nothing for a name that is not bound', () => {
  assert.equal(fill('#{channel} - {server}', { channel: 'orders', server: 'Rolling Pin' }), '#orders - Rolling Pin');
  assert.equal(fill('a{missing}b', {}), 'ab');
  assert.equal(fill('{n}', { n: 0 }), '0');
});

test('expressions give the first usable title: a name, a joined name, a prefixed handle, then the id', () => {
  const title = { first: ['/chat/title', { join: ['/chat/first_name', '/chat/last_name'], sep: ' ' }, { prefix: '@', of: '/chat/username' }, '/chat/id'] };
  assert.equal(evaluate(title, { item: message }), 'Ana Lopez');
  assert.equal(evaluate(title, { item: { chat: { first_name: 'Ana', username: 'x' } } }), 'Ana');
  assert.equal(evaluate(title, { item: { chat: { username: 'ana_l' } } }), '@ana_l');
  assert.equal(evaluate(title, { item: { chat: { id: -5 } } }), '-5');
  assert.equal(evaluate(title, { item: {} }), undefined);
});

test('var, text and template expressions read the values the walk bound', () => {
  assert.equal(evaluate({ var: 'channel' }, { vars: { channel: 'c1' } }), 'c1');
  assert.equal(evaluate({ var: 'channel' }, { vars: {} }), undefined);
  assert.equal(evaluate({ text: 'General' }), 'General');
  assert.equal(evaluate({ template: '#{a}' }, { vars: { a: 'x' } }), '#x');
  assert.equal(evaluate({ prefix: '@', of: '/nope' }, { item: {} }), undefined);
  assert.equal(evaluate(42, { item: {} }), undefined);
});
