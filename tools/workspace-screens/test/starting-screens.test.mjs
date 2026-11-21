// The workspace never opens an empty panel: the starting screens the DATA names are opened only when this person is
// offered them, else the first row offered and listed; a row a show rule hides is never the one opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startingScreenIds } from '../web/src/workspace/starting-screens.mjs';

const rows = [{ id: 'screen.a' }, { id: 'screen.b' }, { id: 'screen.c' }];

test('the starting screen the DATA names opens when this person is offered it', () => {
  assert.deepEqual(startingScreenIds(['screen.b'], rows), ['screen.b']);
});

test('a starting screen this person is not offered falls back to the first screen offered, never nothing', () => {
  assert.deepEqual(startingScreenIds(['screen.gone'], rows), ['screen.a']);
  assert.deepEqual(startingScreenIds([], rows), ['screen.a']);
});

test('a screen a show rule hides is never opened, even when the DATA names it', () => {
  const hidden = [{ id: 'screen.home', listed: false }, { id: 'screen.a' }];
  assert.deepEqual(startingScreenIds(['screen.home'], hidden), ['screen.a']);
});

test('with no screen offered at all, nothing opens and nothing is invented', () => {
  assert.deepEqual(startingScreenIds(['screen.a'], []), []);
});
