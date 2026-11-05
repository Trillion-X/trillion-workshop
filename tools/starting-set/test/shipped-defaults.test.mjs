// tools/starting-set/test/shipped-defaults.test.mjs
//
// The defaults every account reads as its own (shipped-defaults.json), checked the way trillion-local reads them
// (trillion-rust src/runtime/workshop/shipped_defaults.rs and src/records/shipped_defaults.rs): one `shipped-default`
// payload per record; the show-rules default ships the Simple workspace type byte for byte, switched on by `in_use`;
// the type is one the show-rules store itself accepts and that decides what it says when given; nothing in it names a
// person; and, with a trillion-rust checkout beside this one, it is the row that reader's tests read.
// Ported from Trillion-X/trillion test/marketplace-starting-defaults.test.mjs (the starting set ships as data and is
// read, never written) for the rows deleted by 4ffa1dc4a2.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import data from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import accountFactsData from '../../decide-when-things-show/read-data/work-for-ais.json' with { type: 'json' };
import { accountFacts } from '../../decide-when-things-show/read-data/account-facts.mjs';
import { changedRecord, givenRules, showDecision } from '../../set-up-my-account/read-data/show-rules.mjs';

const FILE = new URL('../shipped-defaults.json', import.meta.url);
const text = readFileSync(FILE, 'utf8');
const shipped = JSON.parse(text);
const payloads = shipped.records.map(row => row.payload);
const showRules = payloads.find(payload => payload.record === 'show-rules');

// The type as the checklist gives it, byte for byte (the one the default publisher ships for everyone).
const SIMPLE_WORKSPACE = '{"id":"simple-workspace","label":"Simple workspace","inherits":[],"rules":[{"id":"only-the-everyday-controls","label":"Only collapse and resize the sidebar; one screen with no tab bar, back and forward, folders, pins, docking, compass, move handle, notifications, focus mode, picture in picture, ⋯ menus, hover cards, comments, selection popover, empty-pane launcher or zooming the panes in and out; sharing stays","subject":"control","effect":"hide","when":{"kind":"group","combinator":"and","negate":false,"rules":[{"kind":"rule","field":"within","operator":"has_any_of","params":{"values":["arrangement.empty","arrangement.focus","arrangement.header.actions","arrangement.header.nav","arrangement.header.new-tab","arrangement.header.tabs","arrangement.layouts","arrangement.navigation","arrangement.split","arrangement.zoom","cards.hover.automations","cards.hover.palette","cards.hover.panels","cards.hover.sidebar","cards.hover.tabs","comments","devices.active","open.open-as-window","open.open-beside","open.picture-in-picture","screens.ai","screens.always-recording","screens.draw","screens.formats","screens.get-started","screens.home","screens.message-box","screens.notifications","screens.progress","screens.record-video","screens.tours","screens.tray","screens.waiting","screens.write","selection.responses","selection.tray","sidebar.content","sidebar.folders","sidebar.hide","sidebar.list.add","sidebar.list.auto-hide","sidebar.list.create","sidebar.list.pin","sidebar.list.unpin","sidebar.move","sidebar.position","sidebar.row-preview","sidebar.row.actions","sidebar.row.move","sidebar.undock"]}}]}},{"id":"only-the-everyday-screens","label":"Messages, calendar, files, media, lists, voice recording (Record) and settings stay in reach","subject":"screen","effect":"change","when":{"kind":"group","combinator":"and","negate":false,"rules":[{"kind":"rule","field":"screen","operator":"is_none_of","params":{"values":["trillion.messages","trillion.calendar","trillion.files","trillion.media","trillion.lists","trillion.record","trillion.settings"]}},{"kind":"group","combinator":"or","negate":true,"rules":[{"kind":"rule","field":"list","operator":"is_any_of","params":{"values":["pursuits"]}},{"kind":"rule","field":"from","operator":"is_any_of","params":{"values":["pursuit-navigation"]}}]}]},"set":[{"path":["listed"],"value":false}]},{"id":"everyday-destinations-together","label":"Keep the everyday destinations together","subject":"screen","effect":"change","when":{"kind":"group","combinator":"and","negate":false,"rules":[{"kind":"rule","field":"screen","operator":"is_any_of","params":{"values":["trillion.messages","trillion.calendar","trillion.files","trillion.media","trillion.lists","trillion.record","trillion.settings"]}}]},"set":[{"path":["sidebar_collection"],"value":"everyday"}]},{"id":"one-container-one-tab","label":"One container and one tab in the permitted tiled presentation","subject":"arrangement","effect":"change","when":null,"set":[{"path":["constraints"],"value":{"max_containers":1,"max_tabs":1,"allowed_surfaces":["tiled"]}}]},{"id":"sidebar-on-the-left","label":"The sidebar stays on the left","subject":"sidebar","effect":"change","when":null,"set":[{"path":["position_choices"],"value":["left"]}]}]}';

test('each shipped default is one payload of its kind for one record, with the fields the reader lays under', () => {
  assert.ok(payloads.length > 0, 'shipped-defaults.json ships at least one default');
  const records = new Set();
  for (const payload of payloads) {
    assert.equal(payload.kind, 'shipped-default', `${payload.id} is a shipped default`);
    assert.equal(typeof payload.id, 'string');
    assert.equal(typeof payload.record, 'string', `${payload.id} names the record it is laid under`);
    assert.ok(!records.has(payload.record), `one default for ${payload.record}: two would refuse both`);
    records.add(payload.record);
    assert.ok(payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value), `${payload.id} ships an object`);
    for (const field of payload.merge?.by_id ?? []) assert.ok(Array.isArray(payload.value[field]), `${payload.id}: by_id ${field} is a list`);
    for (const { field, off_in } of payload.merge?.switched ?? []) {
      assert.ok(Array.isArray(payload.value[field]), `${payload.id}: switched ${field} is a list of ids`);
      assert.equal(typeof off_in, 'string', `${payload.id}: switched ${field} names where a person switches it off`);
    }
  }
});

test('every account gets the Simple workspace type, byte for byte, and in use', () => {
  assert.ok(showRules, 'a default ships for the show-rules record');
  assert.deepEqual(showRules.merge, { by_id: ['types'], switched: [{ field: 'in_use', off_in: 'starting' }] });
  assert.equal(showRules.value.types.length, 1);
  assert.equal(JSON.stringify(showRules.value.types[0]), SIMPLE_WORKSPACE);
  assert.ok(text.includes(`      ${SIMPLE_WORKSPACE}\n`), 'the type is kept in the file as the checklist writes it');
  assert.deepEqual(showRules.value.in_use, ['simple-workspace']);
  const shippedTypes = new Set(showRules.value.types.map(type => type.id));
  for (const id of showRules.value.in_use) assert.ok(shippedTypes.has(id), `${id} in use is a type shipped beside it`);
});

test('the shipped type is one the show-rules store accepts, and no type ships in show-rules.json itself', () => {
  const kept = changedRecord(data, null, { type: showRules.value.types[0] }, Date.parse('2026-11-03T12:00:00Z'));
  assert.deepEqual(kept.types, showRules.value.types);
  assert.equal(data.types, undefined);
});

test('given to an account, the shipped type keeps collapse and resize and hides the rest of the workspace chrome', async () => {
  const filter = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
  await filter.load();
  const matches = (tree, row) => filter.filterRowsByRulesNow({ tree, fields: accountFactsData.facts, rows: [row] }).matches.length === 1;
  const facts = accountFacts({ accountId: 'account-a', context: { cohorts: ['simple-workspace'] } });
  const rules = await givenRules({ data, giver: { types: showRules.value.types }, facts, matches });
  const within = control => control.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.'));
  const shown = control => !showDecision({ data, record: null, given: rules, subject: 'control', thing: { control, within: within(control) }, now: Date.parse('2026-11-03T12:00:00Z'), filterRows: filter.filterRowsByRulesNow }).hidden;
  for (const control of ['sidebar.collapse', 'sidebar.resize']) assert.equal(shown(control), true, `${control} stays`);
  for (const control of ['arrangement.header.tabs', 'arrangement.header.nav', 'arrangement.split', 'sidebar.position', 'comments', 'selection.tray',
    // The tool rows, pins, docking, compass, notifications, move handle, empty pane and tab bar the account owner named
    // (2026-11-04), each the control its part declares (trillion-apps web/parts/*/controls.json).
    'screens.waiting', 'screens.home', 'screens.tray', 'screens.get-started', 'screens.tours', 'screens.message-box', 'screens.write',
    'screens.record-video', 'screens.always-recording', 'screens.draw', 'screens.progress', 'screens.formats', 'screens.ai',
    'screens.notifications', 'sidebar.undock', 'sidebar.list.pin', 'sidebar.list.unpin', 'sidebar.move', 'sidebar.list.create',
    'sidebar.content.focus-editor', 'arrangement.empty.heading', 'arrangement.empty.search', 'arrangement.header.actions',
    // Zooming the grid of panes in and out, which the account owner turned off for every account (2026-11-04): a
    // pinch or ctrl/cmd with the wheel over the panes, and the wheel over the pane map.
    'arrangement.zoom.pinch', 'arrangement.zoom.map']) {
    assert.equal(shown(control), false, `${control} is hidden`);
  }
  assert.equal(shown('screens.record'), true, 'the one recording row stays');
  // Only the handful stays listed: a screen rule changes `listed` for every other screen.
  const listed = (id, sidebar_collection) => showDecision({ data, record: null, given: rules, subject: 'screen', thing: { id, sidebar_collection }, now: Date.parse('2026-11-03T12:00:00Z'), filterRows: filter.filterRowsByRulesNow })
    .changes.filter(change => change.path.join('.') === 'listed').at(-1)?.value !== false;
  for (const id of ['trillion.messages', 'trillion.calendar', 'trillion.files', 'trillion.media', 'trillion.lists', 'trillion.record', 'trillion.settings']) assert.equal(listed(id, 'information-being-acted-on'), true, `${id} stays listed`);
  for (const id of ['trillion.home', 'trillion.waiting', 'trillion.record-audio', 'trillion.formats', 'trillion.connections']) assert.equal(listed(id, 'start'), false, `${id} is not listed`);
  assert.equal(listed('trillion.space:launch', 'pursuits'), true, 'a pursuit stays listed');
});

test('nothing in the shipped defaults names a person: no address, no audience, no grant', () => {
  assert.doesNotMatch(text, /[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i, 'no email address');
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const key of ['audience', 'grant', 'given_to', 'account', 'user']) assert.ok(!Object.hasOwn(value, key), `no ${key} in a shipped default`);
    Object.values(value).forEach(walk);
  };
  payloads.forEach(payload => walk(payload.value));
});

// With trillion-rust checked out beside this repository, its reader's tests read this same row.
const rustCopy = new URL('../../../../trillion-rust/tests/fixtures/starting-set/tools/starting-set/shipped-defaults.json', import.meta.url);
test('the row trillion-rust\'s defaults reader tests is this one', { skip: !existsSync(rustCopy) && 'no trillion-rust checkout beside this one' }, () => {
  assert.deepEqual(JSON.parse(readFileSync(rustCopy, 'utf8')).records, shipped.records);
});
