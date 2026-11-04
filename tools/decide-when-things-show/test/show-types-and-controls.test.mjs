// What a person may see, by one primitive (src/workspace/show-rules.mjs over show-rules.json), decided by the real
// formula engine: a type (a preset) given to an account through its cohorts, with the types it inherits; a rule aimed by
// an audience over account facts; the Simple workspace preset's controls and screens; a shown rule that ends and lets the
// hidden control return; a control nobody named obeying a broad rule; the owner alone giving types; and the shipped types
// naming only controls the parts declare (part.json `controls`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import operators from '../parts/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../parts/formula-engine/rules/filter-rows-by-rules.mjs';
import data from '../src/workspace/show-rules.json' with { type: 'json' };
import simpleWorkspace from './fixtures/simple-workspace-profile.json' with { type: 'json' };
import accountFactsData from '../src/work-for-ais.json' with { type: 'json' };
import openChoices from '../parts/ui/show/placeable-surface-intent/open-choices.json' with { type: 'json' };
import trayData from '../src/workspace/tray.json' with { type: 'json' };
import paletteData from '../src/workspace/command-palette.json' with { type: 'json' };
import { readdirSync } from 'node:fs';
import { accountFacts } from '../src/work-for-ais.mjs';
import { changedRecord, givenEditRules, givenRules, heldTypes, showDecision, typesOf, withChanges } from '../src/workspace/show-rules.mjs';
import { givenAccountFields, makeShowRules } from '../src/show-rules-store.mjs';
import { DECLARED_CONTROLS } from '../parts/ui/show/show-rules/declared-controls.mjs';

const wasm = () => readFileSync(new URL('../parts/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const filter = makeRowFilter({ operators, wasm });
await filter.load();
const now = filter.filterRowsByRulesNow;
const NOW = Date.parse('2026-10-12T16:00:00Z');
const matches = (tree, row) => now({ tree, fields: accountFactsData.facts, rows: [row] }).matches.length === 1;
const within = control => control.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.'));
const shown = (given, control, record = null, at = NOW) => !showDecision({ data, record, given, subject: 'control', thing: { control, within: within(control) }, now: at, filterRows: now }).hidden;
const facts = cohorts => accountFacts({ accountId: 'account-a', context: { cohorts } });
// No type ships in show-rules.json: the preset is a type the giver keeps in their own record.
const presetGiver = { types: [simpleWorkspace] };
const simple = await givenRules({ data, giver: presetGiver, facts: facts(['simple-workspace']), matches });

test('the Simple workspace preset keeps collapse and resize and hides every other workspace control', () => {
  for (const control of ['sidebar.collapse', 'sidebar.resize', 'arrangement.header']) assert.equal(shown(simple, control), true, `${control} stays`);
  for (const control of ['sidebar.position', 'sidebar.undock', 'sidebar.hide', 'sidebar.row-preview', 'arrangement.header.nav', 'arrangement.header.tabs',
    'arrangement.header.tabs.row-preview', 'arrangement.header.tabs.position', 'arrangement.header.actions', 'arrangement.header.actions.split-horizontal',
    'arrangement.header.actions.maximize', 'arrangement.header.actions.overlay', 'arrangement.header.new-tab', 'arrangement.split',
    'open.open-beside', 'open.open-as-window', 'selection.responses', 'selection.tray']) assert.equal(shown(simple, control), false, `${control} is hidden`);
  // Someone who does not hold the type sees everything.
  assert.equal(shown([], 'arrangement.header.tabs'), true);
});

test('the Simple workspace preset lists only the everyday screens, Settings as one place, and keeps every pursuit and its parts', () => {
  const changed = row => withChanges(row, showDecision({ data, given: simple, subject: 'screen', thing: row, now: NOW, filterRows: now }).changes);
  const listed = row => changed(row).listed !== false;
  assert.equal(listed({ id: 'trillion.messages', label: 'Messages', sidebar_collection: 'talk-to-and-see-trillion' }), true);
  assert.equal(listed({ id: 'trillion.files', label: 'Files', sidebar_collection: 'information-being-acted-on' }), true);
  assert.equal(listed({ id: 'trillion.lists', label: 'Lists', sidebar_collection: 'information-being-acted-on' }), true);
  assert.equal(listed({ id: 'trillion.settings', label: 'Settings', sidebar_collection: 'settings' }), true);
  assert.equal(changed({ id: 'trillion.files', label: 'Files', sidebar_collection: 'information-being-acted-on' }).sidebar_collection, 'everyday', 'the everyday destinations sit together');
  assert.equal(listed({ id: 'pursuit:a', label: 'Popcorn', sidebar_collection: 'pursuits', source: { kind: 'pursuit-navigation' } }), true);
  assert.equal(listed({ id: 'pursuit:a:part:board', label: 'Board', source: { kind: 'pursuit-navigation', part_of_pursuit: true } }), true);
  assert.equal(listed({ id: 'trillion.workshop', label: 'Runs', sidebar_collection: 'things-trillion-uses' }), false);
  assert.equal(listed({ id: 'trillion.account', label: 'Account & security', sidebar_collection: 'settings' }), false, 'each setting is reached inside Settings');
  assert.equal(listed({ id: 'trillion.spend', label: 'Spend', sidebar_collection: 'settings' }), false, 'each setting is reached inside Settings');
  // A Marketplace tool added tomorrow, in no list of its own, is not listed: no code names it.
  assert.equal(listed({ id: 'tool:anything-new', label: 'Anything new', source: { kind: 'tool' } }), false);
});

test('Simple keeps record previews and a temporary preview rule changes only that control', () => {
  assert.equal(shown(simple, 'record.preview'), true);
  const record = changedRecord(data, null, { save: {
    id: 'pause-record-previews', subject: 'control', effect: 'hide',
    until: new Date(NOW + 3_600_000).toISOString(),
    when: { kind: 'group', combinator: 'and', negate: false, rules: [
      { kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['record.preview'] } },
    ] },
  } }, NOW);
  assert.equal(shown(simple, 'record.preview', record), false);
  assert.equal(shown(simple, 'record.action', record), true);
  assert.equal(shown(simple, 'record.preview', record, NOW + 3_600_001), true);
});

test('a type takes the rules of every type it inherits, at any depth, and never inherits itself', () => {
  const giver = { types: [
    { id: 'viewer', label: 'Viewer', inherits: [], rules: [{ id: 'no-tray', subject: 'control', effect: 'hide', when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['selection.tray'] } }] } }] },
    { id: 'parent', label: 'Parent', inherits: ['viewer'], rules: [] },
    { id: 'grandparent', label: 'Grandparent', inherits: ['parent', 'simple-workspace'], rules: [] },
    simpleWorkspace,
  ] };
  assert.deepEqual(heldTypes(typesOf(giver), ['grandparent']).sort(), ['grandparent', 'parent', 'simple-workspace', 'viewer']);
  assert.throws(() => changedRecord(data, giver, { type: { id: 'viewer', label: 'Viewer', inherits: ['grandparent'], rules: [] } }, NOW), /cannot inherit itself/);
  assert.throws(() => changedRecord(data, giver, { type: { id: 'x', inherits: ['nobody'], rules: [] } }, NOW), /inherits names types that exist/);
  const kept = changedRecord(data, presetGiver, { type: { id: 'cleaner', label: 'Cleaner', inherits: ['simple-workspace'], rules: [] } }, NOW);
  assert.deepEqual(kept.types.map(type => type.id), ['simple-workspace', 'cleaner']);
  assert.deepEqual(changedRecord(data, kept, { remove_type: 'cleaner' }, NOW).types, [simpleWorkspace]);
});

test('removing a parent cannot silently break inheritance', () => {
  const parent = { id: 'parent', label: 'Parent', inherits: [], rules: [] };
  const child = { id: 'child', label: 'Child', inherits: ['parent'], rules: [] };
  const record = { types: [parent, child] };
  assert.throws(() => changedRecord(data, record, { remove_type: 'parent' }, NOW), /Cannot remove parent: Child would be invalid/);
  assert.deepEqual(changedRecord(data, record, { remove_type: 'child' }, NOW).types, [parent]);
});

test('no type ships in show-rules.json: a type is only ever one a person keeps in their own record', () => {
  assert.equal(data.types, undefined);
  assert.deepEqual(typesOf(null), []);
  assert.throws(() => changedRecord(data, null, { use: { type: 'simple-workspace', on: true } }, NOW), /No profile simple-workspace is kept here/);
  const kept = changedRecord(data, changedRecord(data, null, { type: simpleWorkspace }, NOW), { use: { type: 'simple-workspace', on: true } }, NOW);
  assert.deepEqual(kept.in_use, ['simple-workspace']);
  assert.equal(shown([], 'arrangement.header.tabs', kept), false, 'the kept preset applies to its keeper');
  assert.equal(shown([], 'sidebar.collapse', kept), true);
});

test('the owner\'s rule with an audience reaches only the accounts it holds for', async () => {
  const giver = { rules: [{ id: 'half-without-tabs', label: 'Test without tabs', subject: 'control', effect: 'hide',
    audience: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'cohorts', operator: 'has_any_of', params: { values: ['tabs-test'] } }] },
    when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['arrangement.header.tabs'] } }] } },
  { id: 'owner-own', subject: 'control', effect: 'hide', when: null }] };
  const inGroup = await givenRules({ data, giver, facts: facts(['tabs-test']), matches });
  const outside = await givenRules({ data, giver, facts: facts([]), matches });
  assert.deepEqual(inGroup.map(rule => rule.id), ['given:half-without-tabs'], 'the owner\'s own rule without an audience is never given');
  assert.equal(inGroup[0].audience, undefined, 'the audience stays with the giver');
  assert.deepEqual(outside, []);
  assert.equal(shown(inGroup, 'arrangement.header.tabs'), false);
});

test('a shown rule with an end shows one hidden control for a while, then the type hides it again', () => {
  const record = changedRecord(data, null, { save: { id: 'show-tabs-for-an-hour', label: 'Tabs for an hour', subject: 'control', effect: 'show',
    until: new Date(NOW + 3_600_000).toISOString(),
    when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['arrangement.header.tabs'] } }] } } }, NOW);
  assert.equal(shown(simple, 'arrangement.header.tabs', record), true, 'shown while the rule lasts');
  const decision = showDecision({ data, record, given: simple, subject: 'control', thing: { control: 'arrangement.header.tabs', within: within('arrangement.header.tabs') }, now: NOW, filterRows: now });
  assert.equal(decision.silenced, false);
  assert.equal(decision.next_change_at, NOW + 3_600_000, 'the page asks again when it ends');
  assert.equal(shown(simple, 'arrangement.header.tabs', record, NOW + 3_600_001), false, 'after its end the tabs are hidden again');
  assert.equal(shown(simple, 'sidebar.position', record), false, 'it shows only what it names');
});

test('a control nobody named obeys a broad rule with no code', () => {
  const broad = [{ id: 'no-tool-controls', subject: 'control', effect: 'hide', when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['tools'] } }] } }];
  assert.equal(shown(broad, 'tools.some-tool-added-today.export'), false);
  assert.equal(shown(broad, 'sidebar.collapse'), true);
});

test('only the service\'s owner gives types, and only types that exist', async () => {
  const kept = new Map([['show-rules', presetGiver]]);
  const records = { read: label => kept.get(label) ?? null, write: writes => { for (const write of writes) kept.set(write.address_label, write.payload); },
    update: (label, change) => { kept.set(label, change(kept.get(label) ?? null)); } };
  const owner = makeShowRules({ records, filterRows: async input => now(input), authority: 'operator' });
  const answer = await owner.set({ give: { account_id: 'account-b', add: ['simple-workspace'] } }, { actor: { account_id: 'operator-account' } });
  assert.deepEqual(answer.types, ['simple-workspace']);
  assert.deepEqual(kept.get('setup-context').accounts['account-b'].cohorts, ['simple-workspace']);
  await owner.set({ give: { account_id: 'account-b', remove: ['simple-workspace'] } }, { actor: { account_id: 'operator-account' } });
  assert.deepEqual(kept.get('setup-context').accounts['account-b'].cohorts, []);
  await assert.rejects(owner.set({ give: { account_id: 'account-b', add: ['no-such-type'] } }), /No type no-such-type/);
  const person = makeShowRules({ records, filterRows: async input => now(input), authority: 'personal' });
  await assert.rejects(person.set({ give: { account_id: 'account-b', add: ['simple-workspace'] } }), /Only the owner/);
  assert.ok((await owner.read()).types.some(type => type.id === 'simple-workspace'));
});

test('assignment and inherited profile changes notify the exact assigned accounts after their current data is kept', async () => {
  const kept = new Map([['show-rules', presetGiver]]);
  const actor = { account_id: 'operator-account' };
  const notified = [];
  const records = { read: label => kept.get(label) ?? null, write: writes => { for (const write of writes) kept.set(write.address_label, write.payload); },
    update: (label, change) => kept.set(label, change(kept.get(label) ?? null)) };
  const owner = makeShowRules({ records, filterRows: now, authority: 'operator', changedForAccount: async accountId => {
    assert.ok(kept.get('setup-context').accounts[accountId], 'notification follows the account-context write');
    notified.push(accountId);
  } });
  await owner.set({ give: { account_id: 'account-b', add: ['simple-workspace'] } }, { actor });
  assert.deepEqual(notified, ['account-b']);
  notified.length = 0;
  await owner.set({ type: { id: 'simple-workspace', label: 'Simple workspace', inherits: [], rules: [] } }, { actor });
  assert.deepEqual(notified, ['account-b'], 'changing the inherited definition wakes existing holders');
  notified.length = 0;
  await owner.set({ rule: { id: 'aimed', subject: 'control', effect: 'hide', audience: { kind: 'group', combinator: 'and', rules: [] }, when: null } }, { actor });
  assert.deepEqual(notified, ['account-b']);
  notified.length = 0;
  await owner.remove({ id: 'aimed' }, { actor });
  assert.deepEqual(notified, ['account-b'], 'removing an aimed rule also refreshes the assigned account');
  await assert.rejects(owner.set({ give: { account_id: 'account-b', add: 'simple-workspace' } }), /lists of type ids/);
});

test('a failed live refresh reports the exact pending account without undoing its saved assignment', async () => {
  const kept = new Map([['show-rules', presetGiver]]);
  const records = { read: label => kept.get(label) ?? null, write: writes => { for (const write of writes) kept.set(write.address_label, write.payload); },
    update: (label, change) => kept.set(label, change(kept.get(label) ?? null)) };
  const owner = makeShowRules({ records, filterRows: now, authority: 'operator', changedForAccount: async () => { throw new Error('Disconnected'); } });
  const answer = await owner.set({ give: { account_id: 'account-b', add: ['simple-workspace'] } }, { actor: { account_id: 'operator-account' } });
  assert.deepEqual(answer.refresh_pending, ['account-b']);
  assert.deepEqual(kept.get('setup-context').accounts['account-b'].cohorts, ['simple-workspace']);
});

test('cohort and experiment assignment shares the atomic account context without replacing other setup facts', async () => {
  const actor = { account_id: 'operator-account' };
  const kept = new Map([['show-rules', presetGiver], ['setup-context', { accounts: { a: { cohorts: ['existing'], experiments: ['old'], required_devices: { computer: true } } } }]]);
  const records = { read: label => kept.get(label) ?? null, write: writes => { for (const write of writes) kept.set(write.address_label, write.payload); },
    update: (label, change) => kept.set(label, change(kept.get(label) ?? null)) };
  const owner = makeShowRules({ records, filterRows: now, authority: 'operator' });
  const answer = await owner.set({ give: { account_id: 'a', add: ['simple-workspace'], cohorts: { add: ['company-pilot'] }, experiments: { add: ['tour-b'], remove: ['old'] } } }, { actor });
  assert.deepEqual(answer.audience, { cohorts: ['existing', 'company-pilot', 'simple-workspace'], experiments: ['tour-b'] });
  assert.deepEqual(kept.get('setup-context').accounts.a.required_devices, { computer: true });
  const before = structuredClone(kept.get('setup-context'));
  await assert.rejects(owner.set({ give: { account_id: 'a', experiments: { add: 'bad' } } }, { actor }), /experiments is/);
  assert.deepEqual(kept.get('setup-context'), before);
  const personal = makeShowRules({ records, filterRows: now });
  await assert.rejects(personal.set({ give: { account_id: 'a', experiments: { add: ['tour-a'] } } }), /Only the owner/);
});

test('an audience-selected profile inherits its parents for current offers and withdraws when the offer ends', async () => {
  const audience = { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'offers', operator: 'has_any_of', params: { values: ['negotiated-contract-offer'] } }] };
  const giver = changedRecord(data, presetGiver, { type: { id: 'contract-workspace', label: 'Contract workspace', inherits: ['simple-workspace'], rules: [], audience } }, NOW, 'operator');
  assert.deepEqual(giver.types.find(type => type.id === 'contract-workspace').audience, audience, 'the profile selection survives storage');
  const selected = await givenRules({ data, giver, facts: accountFacts({ accountId: 'a', offers: ['negotiated-contract-offer'] }), matches });
  assert.equal(shown(selected, 'sidebar.hide'), false, 'the selected child receives its parent restrictions');
  const expired = await givenRules({ data, giver, facts: accountFacts({ accountId: 'a', offers: [] }), matches });
  assert.equal(shown(expired, 'sidebar.hide'), true, 'the current offer owner ending access withdraws the automatic profile');
  assert.throws(() => changedRecord(data, giver, { type: { id: 'bad-audience', rules: [], audience: { kind: 'rule' } } }, NOW), /type audience is a rule tree/);
});

test('ordinary assignments need no payment read; nested active audiences declare the account facts they need', () => {
  assert.deepEqual([...givenAccountFields(null)], []);
  const nested = { kind: 'group', rules: [{ kind: 'group', rules: [{ kind: 'rule', field: 'offers' }] }] };
  assert.deepEqual([...givenAccountFields({ types: [{ id: 'paid', rules: [], audience: nested }],
    rules: [{ on: false, audience: { kind: 'group', rules: [{ kind: 'rule', field: 'capabilities' }] } }] })], ['offers']);
});

test('type assignment cannot exceed the cohort bound or partially change audience facts', async () => {
  const before = { accounts: { a: { cohorts: Array.from({ length: 100 }, (_, index) => `cohort-${index}`), experiments: ['retained'] } } };
  const kept = new Map([['show-rules', presetGiver], ['setup-context', structuredClone(before)]]);
  const records = { read: label => kept.get(label) ?? null, write: () => {}, update: (label, change) => kept.set(label, change(kept.get(label))) };
  const owner = makeShowRules({ records, filterRows: now, authority: 'operator' });
  await assert.rejects(owner.set({ give: { account_id: 'a', add: ['simple-workspace'], experiments: { add: ['new'] } } }), /at most 100 cohorts/);
  assert.deepEqual(kept.get('setup-context'), before);
});

// Structural: every control a part draws is declared by that part as DATA and asks the one primitive.
const ROOT = new URL('..', import.meta.url).pathname;
const read = path => readFileSync(join(ROOT, path), 'utf8');
const json = path => JSON.parse(read(path));
// Every part's manifest, so a control a new part declares is known with no list here.
const manifests = readdirSync(join(ROOT, 'parts'), { withFileTypes: true }).filter(entry => entry.isDirectory())
  .map(entry => `parts/${entry.name}/part.json`).filter(path => { try { read(path); return true; } catch { return false; } });
const declaredRows = manifests.flatMap(path => json(path).controls ?? []);
const declared = new Set([
  ...declaredRows.map(row => row.id),
  ...openChoices.choices.map(choice => `open.${choice.id}`),
]);
// A control drawn for each row of DATA (`record.action.<id>`, `palette.action.<id>`) is declared by its parent path.
const declaredOrWithin = control => within(control).some(path => declared.has(path));

test('the tray, every Find anything row and every action are declared where every control is listed', () => {
  assert.equal(typeof trayData.control, 'string', 'the tray names its control; its words live in the declaration');
  assert.ok(declared.has(trayData.control), `${trayData.control} is declared in a part.json`);
  assert.ok(declaredRows.find(row => row.id === trayData.control)?.label, 'the tray control has words a person can pick');
  for (const source of paletteData.sources) assert.ok(declaredOrWithin(`palette.source.${source.id}`), `palette.source.${source.id}`);
  for (const action of paletteData.actions) assert.ok(declaredOrWithin(`palette.action.${action.id}`), `palette.action.${action.id}`);
  for (const id of new Set(declaredRows.map(row => row.id))) assert.equal(declaredRows.filter(row => row.id === id).length, 1, `${id} is declared once`);
});

test('each list or record action is its own control: one can be hidden alone, or every one by their parent', () => {
  const hideDelete = [{ id: 'no-delete', subject: 'control', effect: 'hide', when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['record.action.delete'] } }] } }];
  assert.equal(shown(hideDelete, 'record.action.delete'), false);
  assert.equal(shown(hideDelete, 'record.action.rename'), true);
  assert.equal(shown(hideDelete, 'record.action.delete-forever'), true, 'a path is matched whole, never by its first letters');
  const hideAll = [{ id: 'no-actions', subject: 'control', effect: 'hide', when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['record.action'] } }] } }];
  for (const action of ['delete', 'rename', 'run-now', 'an-action-added-tomorrow']) assert.equal(shown(hideAll, `record.action.${action}`), false, action);
});

test('the Simple workspace sidebar and screen rules each fall on a declared control', () => {
  // Sidebar: collapse and resize only, left only (its position control hidden), no hide, pin or dock, no hover cards.
  const keeps = ['sidebar.collapse', 'sidebar.resize'];
  const hides = {
    'sidebar.position': 'left only', 'arrangement.header.nav': 'no tab history arrows', 'sidebar.hide': 'no hide', 'sidebar.undock': 'no pin or dock', 'sidebar.row-preview': 'no hover card on rows',
    'arrangement.header.tabs.row-preview': 'no hover card on tabs', 'arrangement.header.tabs': 'no tab bar', 'arrangement.header.actions': 'no ⋯ menu',
    'arrangement.header.new-tab': 'no new tab', 'arrangement.split': 'no split by dropping', 'arrangement.header.actions.split-horizontal': 'no split',
    'arrangement.header.actions.split-vertical': 'no split', 'arrangement.header.actions.maximize': 'no focus mode',
    'arrangement.header.actions.overlay': 'no picture in picture', 'open.open-as-window': 'no picture in picture', 'open.open-beside': 'no second pane',
    'selection.tray': 'no selection popover', 'selection.responses': 'no selection popover', 'comments': 'no comments',
  };
  for (const control of [...keeps, ...Object.keys(hides)]) assert.ok(declared.has(control), `${control} is declared`);
  for (const control of keeps) assert.equal(shown(simple, control), true, `${control} stays`);
  for (const [control, why] of Object.entries(hides)) assert.equal(shown(simple, control), false, `${control}: ${why}`);
  assert.equal(shown(simple, 'sharing'), true, 'sharing stays');
});

test('an empty pane and Find anything are decided by the same rules, part by part', () => {
  const hiding = values => [{ id: 'x', subject: 'control', effect: 'hide', when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values } }] } }];
  for (const part of ['search', 'layouts', 'folders', 'folders.create', 'everything', 'kept', 'start']) assert.ok(declared.has(`arrangement.empty.${part}`), part);
  assert.equal(shown(hiding(['arrangement.empty']), 'arrangement.empty.folders.create'), false);
  assert.equal(shown(hiding(['arrangement.empty.folders']), 'arrangement.empty.search'), true);
  assert.equal(shown(hiding(['arrangement.empty.open-as']), 'arrangement.empty.open-as.side-by-side'), false);
  assert.equal(shown(hiding(['palette.action']), 'palette.action.ask'), false);
  assert.equal(shown(hiding(['palette.action']), 'palette.source.screens'), true);
  assert.equal(shown(hiding(['ai']), 'ai.automation-edit'), false);
  assert.equal(shown(hiding(['automations']), 'automations.run'), false);
});
test('the Simple workspace preset names only declared controls and known screens', () => {
  const screens = new Set(json('records/workshop-screen-tool-records.json').records.flatMap(row => [...JSON.stringify(row).matchAll(/"id": ?"(trillion\.[a-z0-9.-]+)"/g)].map(match => match[1])));
  const values = node => (node?.kind === 'group' ? node.rules.flatMap(values) : [{ field: node.field, values: node.params?.values ?? [] }]);
  for (const type of [simpleWorkspace]) for (const rule of type.rules) for (const { field, values: named } of rule.when ? values(rule.when) : []) {
    if (field === 'within') for (const control of named) assert.ok(declared.has(control), `${type.id} names ${control}`);
    if (field === 'screen') for (const screen of named) assert.ok(screens.has(screen), `${type.id} names ${screen}`);
  }
});

test('the rules screen and an AI are offered every declared control, as the tree its paths make', async () => {
  // Every manifest that declares controls is read by the one list, so a new part's controls reach the picker.
  const listing = read('parts/ui/show/show-rules/declared-controls.mjs');
  for (const path of manifests.filter(path => (json(path).controls ?? []).length)) {
    const relative = path === 'parts/ui/part.json' ? '../../part.json' : `../../../${path.slice('parts/'.length)}`;
    assert.ok(listing.includes(`'${relative}'`), `${path} is read by declared-controls.mjs`);
  }
  assert.deepEqual(new Set(DECLARED_CONTROLS.map(row => row.id)), declared, 'the list is exactly the declarations');
  const byId = new Map(DECLARED_CONTROLS.map(row => [row.id, row]));
  assert.equal(byId.get('record.action').parent, undefined, 'record is not declared, so record.action sits at the top');
  assert.equal(byId.get('arrangement.header.actions.maximize').parent, 'arrangement.header.actions');
  assert.equal(byId.get('open.open-as-window').parent, 'open');
  assert.equal(byId.get('selection.tray').label, 'Add selected things to your tray');
  for (const fact of data.subjects.control.facts.filter(fact => fact.kind !== 'text')) assert.deepEqual(fact.values_from?.list, ['controls'], `${fact.id} offers the declared controls`);
  const records = { read: () => null, write: () => {}, update: () => {} };
  const answer = await makeShowRules({ records, filterRows: now }).read();
  assert.equal(answer.controls, DECLARED_CONTROLS, 'read_show_rules hands the same list to an AI');
});


test('space-scoped inherited visibility and edit policies stay inside their Space', async () => {
  const rule = { id: 'scoped-hide', subject: 'control', effect: 'hide', when: null };
  const edit = { id: 'scoped-deny', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_rule'] };
  const giver = { types: [{ id: 'scoped-parent', scope: { space_id: 'space-a' }, rules: [rule], edit_rules: [edit] },
    { id: 'scoped-child', scope: { space_id: 'space-a' }, inherits: ['scoped-parent'], rules: [] }] };
  const input = { data, giver, facts: facts(['scoped-child']), matches };
  for (const space_id of [null, 'space-b']) {
    assert.deepEqual(await givenRules({ ...input, space_id }), []);
    assert.deepEqual(await givenEditRules({ ...input, space_id }), [], 'Space edit policy cannot affect account-wide edits or another Space');
  }
  assert.deepEqual((await givenRules({ ...input, space_id: 'space-a' })).map(rule => rule.id), ['type:scoped-parent:scoped-hide']);
  assert.deepEqual((await givenEditRules({ ...input, space_id: 'space-a' })).map(rule => rule.id), ['type:scoped-parent:scoped-deny']);
  const member = { data, giver: null, facts: facts(['member']), matches, spaceTypes: [{ id: 'member', scope: { space_id: 'space-a' }, rules: [rule], edit_rules: [edit] }] };
  assert.deepEqual(await givenRules(member), []);
  assert.equal((await givenRules({ ...member, space_id: 'space-a' })).length, 1);
  assert.equal((await givenEditRules({ ...member, space_id: 'space-a' })).length, 1);
  const kept = changedRecord(data, null, { type: { id: 'scoped', scope: { space_id: 'space-a' }, rules: [] } }, NOW);
  assert.deepEqual(kept.types[0].scope, { space_id: 'space-a' });
  assert.throws(() => changedRecord(data, null, { type: { id: 'scoped', scope: {}, rules: [] } }, NOW), /type scope/);
  const records = { read: () => null, write: () => {}, update: () => {} };
  const owner = makeShowRules({ records, filterRows: now, givenSource: async () => ({ giver, facts: input.facts, matches }) });
  assert.equal((await owner.decide({ subject: 'control', space_id: 'space-a' })).hidden, true);
  assert.equal((await owner.decide({ subject: 'control', space_id: 'space-b' })).hidden, false);
});
