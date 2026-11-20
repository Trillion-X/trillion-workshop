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
