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

// The rules below are the held file's other five, on fixtures of the config's shape.
import { loginNamedIn, loginUnquoted, rowOpenAppRefusal, rowUntriedRefusal, beforeAskingCheck, rowArrivalsRefusal, uncheckedWaitingRows } from '../read-data/filing-refusal.mjs';

const login = {
  ...config,
  sources: {
    work: { ...config.sources.work, card: { ...config.sources.work.card, uses_login: [['values', 'login']] } },
  },
};
test('a row whose words quote a saved login title is linked to it (the longest quoted title wins)', () => {
  assert.deepEqual(loginNamedIn(login, { what: 'Open the camera page, then use "Camera receiver" ', login: '' }, ['Camera', 'Camera receiver']), { field: 'login', title: 'Camera receiver' });
});
test('a row that already links a login keeps its own', () => {
  assert.equal(loginNamedIn(login, { what: 'Use "Camera"', login: 'Camera' }, ['Camera']), null);
});
test('a title that is not quoted whole is not linked', () => {
  assert.equal(loginNamedIn(login, { what: 'The camera login', login: '' }, ['Camera']), null);
});
test('a quoted login the row links is unquoted to the saved login\'s own spelling', () => {
  assert.deepEqual(loginUnquoted(login, { what: 'x', login: '"google gmail"' }, ['Google Gmail']), { field: 'login', title: 'Google Gmail' });
  assert.equal(loginUnquoted(login, { what: 'x', login: 'Google Gmail' }, []), null);
});

const openApp = {
  ...config,
  hold: { ...config.hold, open_an_app: { ask: 'open|launch|start', about: 'app|computer|mac', except: 'the app itself', does_in: 'does_in', refused: '"{title}" asks you to open an app on your computer; the app opens it itself.' } },
};
test('a row whose only ask is to open an app on the computer is refused', () => {
  assert.equal(rowOpenAppRefusal(openApp, { what: 'Open Photos on your Mac', choice: 'unfinished' }), '"Open Photos on your Mac" asks you to open an app on your computer; the app opens it itself.');
});
test('a row about the app itself, or with a place to do it, is not refused for opening an app', () => {
  assert.equal(rowOpenAppRefusal(openApp, { what: 'Open the app itself on your Mac', choice: 'unfinished' }), null);
  assert.equal(rowOpenAppRefusal(openApp, { what: 'Open Photos on your Mac', where: '/sign-in', choice: 'unfinished' }), null);
});

const untried = { ...config, hold: { ...config.hold, only_you_untried: { field: 'claim', tried_field: 'tried', refused: '"{title}" says only you can do it, with nothing tried.' } } };
test('a filing that says only the person can do it, with nothing tried, is refused', () => {
  assert.equal(rowUntriedRefusal(untried, { claim: 'only you can do it' }, { what: 'Token' }), '"Token" says only you can do it, with nothing tried.');
});
test('a filing that says what was tried is kept', () => {
  assert.equal(rowUntriedRefusal(untried, { claim: 'only you can do it' }, { what: 'Token', tried: 'the automated browser was refused' }), null);
});
test('marking a row done is never refused as untried', () => {
  assert.equal(rowUntriedRefusal(untried, { claim: 'only you' }, { what: 'Token', state: 'done' }), null);
});

const asking = {
  ...config,
  before_asking: {
    asks: 'say what|tell me',
    ask_fields: ['what'],
    from_field: 'from',
    until_field: 'until',
    default_hours: 24,
    routes: ['photos', 'voice'],
    rule: { route_field: 'route', time_field: 'at', source: 'arrived' },
    read_field: 'read',
    list_most: 2,
    words: {
      arrival: '{route} at {at}{files}',
      more: ' and {rest} more',
      refused: '"{title}" waits: {count} arrivals from {from} to {until} ({places}): {arrivals}{more}. Read them, then say what they showed in {read_field}.',
    },
  },
};
const NOW = Date.parse('2026-11-20T12:00:00Z');
test('a row that asks for facts gets a check over the arrivals of its window (default 24 hours)', () => {
  const check = beforeAskingCheck(asking, { what: 'Say what happened today' }, NOW);
  assert.equal(check.until, NOW);
  assert.equal(check.from, NOW - 24 * 3600000);
  assert.equal(check.rule.tree.combinator, 'and');
});
test('a row that does not ask for facts, or is marked done, gets no check', () => {
  assert.equal(beforeAskingCheck(asking, { what: 'Pay the bill' }, NOW), null);
  assert.equal(beforeAskingCheck(asking, { what: 'Say what happened', state: 'done' }, NOW), null);
});
test('a row that asks for facts is refused while arrivals cover its window, and kept once it reads one of them', () => {
  const window = { from: NOW - 3600000, until: NOW };
  const found = [{ route: 'photos', at: NOW - 1000, files: 'IMG_1.jpg' }, { route: 'voice', at: NOW - 2000, files: '' }, { route: 'photos', at: NOW - 3000, files: 'IMG_2.jpg' }];
  const refused = rowArrivalsRefusal(asking, { what: 'Say what happened' }, found, window);
  assert.match(refused, /^"Say what happened" waits: 3 arrivals/);
  assert.match(refused, /and 1 more/);
  assert.equal(rowArrivalsRefusal(asking, { what: 'Say what happened', read: 'I read IMG_2.jpg and it shows the shelf' }, found, window), null);
  assert.equal(rowArrivalsRefusal(asking, { what: 'Say what happened' }, [], window), null);
});

const unchecked = {
  ...config,
  list: { ...config.list, fields: [{ id: 'rule', kind: 'rule' }, { id: 'state', kind: 'choice', settles: ['done'] }] },
  unchecked: { words_field: 'done', rule_kind: 'rule', said: '"{title}" is said done in words only ("{done_when}"); the app can check: {sources}' },
};
test('a kept row whose done is said in words with no rule is named back to the AI, not refused', () => {
  const kept = [{ id: 'r1', values: { what: 'Certificate', done: 'the file is in Downloads' } }];
  const out = uncheckedWaitingRows(unchecked, kept, { sources: { files: { label: 'files in a folder' } } });
  assert.deepEqual(out, [{ row_id: 'r1', said: '"Certificate" is said done in words only ("the file is in Downloads"); the app can check: files (files in a folder)' }]);
});
test('a row with a rule, or already settled, is not named back', () => {
  assert.deepEqual(uncheckedWaitingRows(unchecked, [{ id: 'r2', values: { what: 'A', done: 'x', rule: 'files' } }], { sources: {} }), []);
  assert.deepEqual(uncheckedWaitingRows(unchecked, [{ id: 'r3', values: { what: 'A', done: 'x', state: 'done' } }], { sources: {} }), []);
});
