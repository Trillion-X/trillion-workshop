// Outcome tests for the pure controls check (do-work/controls-check.mjs). Fixtures only: no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsWithoutControl, opensScreenAt } from '../do-work/controls-check.mjs';

const finishes = [{ choice: 'sign-in', press: 'Sign in' }];
const answer = {
  finishes,
  sections: [
    { id: 'work', cards: [
      { id: 'a', title: 'Sign in to the bank', finish: 'sign-in' },
      { id: 'b', title: 'Allow the camera', finish: 'nothing' },
      { id: 'c', title: 'Pick a voice', does_in: '/voices', finish: 'nothing' },
      { id: 'd', title: 'Walk through the steps', detail: '1. Open the page\n2. Press save', finish: 'nothing' },
      { id: 'check:self', title: 'The check itself', finish: 'nothing' },
    ] },
  ],
};
const screens = new Set(['/voices']);
const opensScreen = address => screens.has(address);

test('a card with a press on its finish has a control and is not broken', () => {
  const out = cardsWithoutControl({ ...answer, sections: [{ id: 'one', cards: [answer.sections[0].cards[0]] }] }, opensScreen);
  assert.equal(out.without_control, 0);
});

test('a card with no press, no place and no steps is broken, with its reason', () => {
  const out = cardsWithoutControl({ ...answer, sections: [{ id: 'one', cards: [answer.sections[0].cards[1]] }] }, opensScreen);
  assert.deepEqual(out.broken, [{ id: 'b', title: 'Allow the camera', why: 'nothing to press, no place in the app, no steps' }]);
});

test('a card whose place opens a screen has a control; one whose place opens nothing is broken with that reason', () => {
  assert.equal(cardsWithoutControl({ sections: [{ id: 'one', cards: [answer.sections[0].cards[2]] }] }, opensScreen).without_control, 0);
  const broken = cardsWithoutControl({ sections: [{ id: 'one', cards: [{ id: 'e', title: 'Open the bank', does_in: '/bank', finish: 'nothing' }] }] }, opensScreen);
  assert.deepEqual(broken.broken, [{ id: 'e', title: 'Open the bank', why: 'does_in /bank opens no screen' }]);
});

test('a card with steps to do by hand has a control', () => {
  assert.equal(cardsWithoutControl({ sections: [{ id: 'one', cards: [answer.sections[0].cards[3]] }] }, opensScreen).without_control, 0);
});

test('the check never counts its own findings', () => {
  const out = cardsWithoutControl({ sections: [{ id: 'one', cards: [answer.sections[0].cards[4]] }] }, opensScreen);
  assert.equal(out.checked, 0);
  assert.equal(out.without_control, 0);
});

test('a screen address is judged by the screens rows, not by a list in this file', () => {
  assert.equal(typeof opensScreenAt('https://example.com')('/work/no-such-screen-here'), 'boolean');
});

const ownPlace = (card, extra = {}) => ({ sections: [{ id: 'stuck', cards: [{ id: 'k', title: 'Stuck', ...card }] }], ...extra });

test('an opens card whose source_reference is a screen the catalog serves has a control', () => {
  assert.equal(cardsWithoutControl(ownPlace({ source_reference: '/voices' }), opensScreen).without_control, 0);
});

test('an opens card whose source_reference resolves to no screen is broken, with that reason', () => {
  const out = cardsWithoutControl(ownPlace({ source_reference: '/no-such-screen' }), opensScreen);
  assert.deepEqual(out.broken, [{ id: 'k', title: 'Stuck', why: 'opens its own place, but source_reference /no-such-screen resolves to no screen' }]);
});

test('an opens card with no source_reference at all is broken', () => {
  const out = cardsWithoutControl(ownPlace({}), opensScreen);
  assert.equal(out.without_control, 1);
  assert.equal(out.broken[0].why, 'opens its own place, but names none (no source_reference)');
});

test('a calendar-task card opens the task page only when the task page tool is served', () => {
  const card = { source_reference: 'record:calendar-task:verify-every-port-x' };
  assert.equal(cardsWithoutControl(ownPlace(card, { served: ['tool:serve-the-task-pages'] }), opensScreen).without_control, 0);
  const unserved = cardsWithoutControl(ownPlace(card, { served: [] }), opensScreen);
  assert.equal(unserved.without_control, 1);
  assert.match(unserved.broken[0].why, /resolves to no screen/);
});

const { countsWithoutControl } = await import('../do-work/controls-check.mjs');
const TOOL = 'tool:serve-the-task-pages';

test('a served page places every waiting thing with a task-record source; none lack a control', () => {
  assert.deepEqual(countsWithoutControl({ database: 'database-a', served: [TOOL], waiting: 366, unplaced: 0, examples: [] }),
    { database: 'database-a', checked: 366, served: true, without_control: 0, examples: [] });
});

test('a served page still leaves a thing with a non-record source without a place, and names it', () => {
  const out = countsWithoutControl({ database: 'database-a', served: [TOOL], waiting: 366, unplaced: 1, examples: ['x1'] });
  assert.equal(out.without_control, 1);
  assert.deepEqual(out.examples, ['x1']);
});

test('a page not served leaves every waiting thing without a place', () => {
  const out = countsWithoutControl({ database: 'database-a', served: [], waiting: 366, unplaced: 0, examples: [] });
  assert.equal(out.served, false);
  assert.equal(out.without_control, 366);
});

test('an empty list is checked as zero and has no control to lack', () => {
  assert.deepEqual(countsWithoutControl({ served: [TOOL], waiting: 0, unplaced: 0 }), { database: null, checked: 0, served: true, without_control: 0, examples: [] });
  assert.equal(countsWithoutControl({ served: [], waiting: 0, unplaced: 0 }).without_control, 0);
});

test('two databases are judged apart: one served, one not', () => {
  const a = countsWithoutControl({ database: 'a', served: [TOOL], waiting: 10, unplaced: 0 });
  const b = countsWithoutControl({ database: 'b', served: [], waiting: 10, unplaced: 0 });
  assert.deepEqual([a.without_control, b.without_control], [0, 10]);
});

test('a very long list is counted in full and names at most five examples', () => {
  const ids = Array.from({ length: 9 }, (_, i) => `record:calendar-task:n${i}`);
  const out = countsWithoutControl({ served: [], waiting: 100000, unplaced: 0, examples: ids });
  assert.equal(out.without_control, 100000);
  assert.equal(out.examples.length, 5);
});

test('counts that arrive as text from the SQL step are read as numbers', () => {
  const out = countsWithoutControl({ database: 'database-a', served: [], waiting: '8', unplaced: '0', examples: [] });
  assert.deepEqual([out.checked, out.without_control], [8, 8]);
});
