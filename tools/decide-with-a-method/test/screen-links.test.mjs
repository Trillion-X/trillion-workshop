// The addresses and actions a decision's screen shows (read-data/screen-links.mjs). The words are made up here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionHref, sourceAction, realActions } from '../read-data/screen-links.mjs';

const words = { page: 'Open the page checked', source: 'Open the source' };

test('a decision links to its own screen by its id, encoded', () => {
  assert.equal(decisionHref('source:a b/c'), '/decisions/source%3Aa%20b%2Fc');
});

test('a web address opens as the source; a page checked keeps its address and drops its time', () => {
  assert.deepEqual(sourceAction('https://example.com/a', words), [{ label: 'Open the source', href: 'https://example.com/a' }]);
  assert.deepEqual(sourceAction('page:https://example.com/b@2026-11-01T10:00:00Z', words), [{ label: 'Open the page checked', href: 'https://example.com/b' }]);
});

test('a reference that is no web address opens nothing', () => {
  assert.deepEqual(sourceAction('plan-w6', words), []);
  assert.deepEqual(sourceAction(null, words), []);
});

test('a section keeps only actions with a real address', () => {
  assert.deepEqual(realActions([{ label: 'Open', href: '/x', extra: 1 }, { label: 'Here', href: '#top' }, { label: 'None' }]), [{ label: 'Open', href: '/x' }]);
  assert.deepEqual(realActions(undefined), []);
});
