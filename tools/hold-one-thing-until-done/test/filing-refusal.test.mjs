// Outcome tests for the filing refusal (read-data/filing-refusal.mjs), on a small config of the same shape as the
// Waiting on you DATA. The config is a fixture: the owner's real DATA is read by the owner, not copied here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowControlRefusal } from '../read-data/filing-refusal.mjs';

const config = {
  list: { id: 'waiting-on-you', title_field: 'what' },
  sources: {
    work: {
      done_sets: { list: 'waiting-on-you', values: { state: 'done' } },
      card: { title: [['values', 'what']], does_in: [['values', 'where']], finish: [['values', 'choice']] },
    },
  },
  sections: [{ id: 'work', read: { from: 'work' } }],
  finishes: [{ choice: 'sign-in', press: 'Sign in' }],
  hold: {
    no_control: {
      refused: '"{title}" was not filed: it gives the person nothing to press or do.',
      whole_screen: '"{title}" opens {address}, a whole screen: name the row it shows (show_row).',
      not_a_screen: '"{title}" names {address}, which is not a the app screen.',
    },
  },
};
const screens = new Set(['/connections', '/sign-in']);
const opensScreen = address => screens.has(address.split(/[?#]/)[0]);
const opensWhole = address => address.split(/[?#]/)[0] === '/connections' && !address.includes('show_row');

test('a row that is marked done is never refused', () => {
  assert.equal(rowControlRefusal(config, { what: 'Sign in', state: 'done' }), null);
});

test('a row with a press on its finish is kept', () => {
  assert.equal(rowControlRefusal(config, { what: 'Sign in', choice: 'sign-in' }), null);
});

test('a row whose finish has no press and no place is refused, in the DATA words (a row with no finish opens its own place, so it is kept)', () => {
  assert.equal(rowControlRefusal(config, { what: 'Allow the app', choice: 'unfinished' }), '"Allow the app" was not filed: it gives the person nothing to press or do.');
});

test('a row that names a place which is not a screen is refused as not a screen', () => {
  assert.equal(rowControlRefusal(config, { what: 'Open the bank', where: '/bank', choice: 'unfinished' }, opensScreen, opensWhole), '"Open the bank" names /bank, which is not a the app screen.');
});

test('a row that names a whole screen with no row to show is refused as a whole screen', () => {
  assert.equal(rowControlRefusal(config, { what: 'Add a service', where: '/connections' }, opensScreen, opensWhole), '"Add a service" opens /connections, a whole screen: name the row it shows (show_row).');
});

test('a row that names a whole screen with the row it shows is kept (it has a place to do it)', () => {
  assert.equal(rowControlRefusal(config, { what: 'Add a service', where: '/connections?show_row=gmail' }, opensScreen, opensWhole), null);
});

test('a row with no place of its own but a place it opens is kept', () => {
  assert.equal(rowControlRefusal(config, { what: 'Pick a voice', where: '/sign-in' }, opensScreen, opensWhole), null);
});

test('a config with no source for the list refuses nothing', () => {
  assert.equal(rowControlRefusal({ ...config, sources: {} }, { what: 'x' }), null);
});
