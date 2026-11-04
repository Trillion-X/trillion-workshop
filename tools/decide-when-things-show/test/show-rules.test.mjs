// The rows of decide-when-things-show over a made-up show-rules record, against the records door stand-in
// (tools/records-door/test/fake-door.mjs), which checks the rows' rights the way the engine does. Made-up rows only;
// nothing here names a person, and the subject, effect and starting rule are read from show-rules.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow, rowOf } from '../../records-door/test/run-row.mjs';
import data from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import causes from '../../workflows/recipe-wake-causes.json' with { type: 'json' };
import { profileRules, ruleProblem } from '../../set-up-my-account/read-data/show-rules.mjs';
import { USE_ASKED } from '../do-work/show-rules.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const row = slug => rowOf(ROWS, `tool:${slug}`);
const NOW = '2026-01-10T12:00:00.000Z';
// A subject, an effect and a starting rule a person may keep or switch, found by the moved rule check, never named.
const [SUBJECT, EFFECT] = Object.keys(data.subjects).flatMap(subject => data.effects.map(effect => [subject, effect.id]))
  .find(([subject, effect]) => ruleProblem(data, { id: 'x', label: 'x', subject, when: null, effect }, 'personal') === null);
const STARTING = data.starting_rules.find(one => ruleProblem(data, one, 'personal') === null).id;
const rule = (id, extra = {}) => ({ id, label: `Sample ${id}`, subject: SUBJECT, when: null, effect: EFFECT, on: true, ...extra });
const type = (id, rules = [], inherits = []) => ({ id, label: `Sample ${id}`, inherits, rules });
const RECORD = {
  rules: [rule('own-1')],
  types: [type('base', [rule('quiet')]), type('child', [rule('loud', { on: false })], ['base'])],
};
const run = (slug, input, record = RECORD, records = []) =>
  runRow(row(slug), { now: NOW, ...input }, { records, doorOptions: { workspaceRecords: record === null ? {} : { [data.record]: record } } });
const kept = result => {
  assert.equal(result.keep.length, 1);
  assert.equal(result.keep[0].label, data.record);
  return result.keep[0];
};

test('every action is one row, and every row reads only the show-rules record or the grant it is asked about', () => {
  const ids = ROWS.records.map(one => one.payload.id);
  assert.deepEqual(ids, ['see-when-things-show', 'keep-a-show-rule', 'take-a-show-rule-away', 'keep-a-show-type', 'take-a-show-type-away',
    'switch-a-kept-show-type', 'share-a-kept-show-type', 'stop-sharing-a-show-type'].map(slug => `tool:${slug}`));
  for (const one of ROWS.records.map(record => record.payload)) {
    for (const right of one.invoke.records?.rights ?? []) {
      if (right.kind === '@own-records') {
        assert.deepEqual(right.operations, ['workspace:read'], `${one.id} only reads`);
        assert.ok(right.id === data.record || right.id?.fill?.field === 'grant', `${one.id} reads its record or the grant named`);
      }
      assert.ok(!right.operations.includes('workspace:write'), `${one.id} claims no workspace write`);
    }
  }
});

test('read: the starting rules, the person\'s own, and the rules of switched-on types only', async () => {
  const off = await run('see-when-things-show', {});
  assert.equal(off.status, 0);
  assert.ok(off.result.rules.some(one => one.id === STARTING && one.starting));
  assert.ok(off.result.rules.some(one => one.id === 'own-1'));
  assert.ok(!off.result.rules.some(one => String(one.id).startsWith('type:')), 'a kept type applies only while it is on');
  assert.deepEqual(off.result.types.map(one => one.id), ['base', 'child']);
  const on = await run('see-when-things-show', {}, { ...RECORD, in_use: ['child'] });
  assert.ok(on.result.rules.some(one => one.id === 'type:base:quiet'), 'a type takes the rules of the types it inherits');
  assert.deepEqual(on.result.in_use, ['child']);
});

test('read with no record: everything shows but the starting rules', async () => {
  const { status, result } = await run('see-when-things-show', {}, null);
  assert.equal(status, 0);
  assert.deepEqual(result.types, []);
  assert.ok(result.rules.every(one => one.starting));
});

test('type precedence: a child\'s version of an inherited rule replaces it, switched off or not', () => {
  const record = { types: [type('base', [rule('same')]), type('child', [rule('same', { on: false })], ['base'])], in_use: ['child'] };
  assert.deepEqual(profileRules(data, record).map(one => one.id), [], 'the child switched it off');
  record.types[1].rules[0].on = true;
  assert.deepEqual(profileRules(data, record).map(one => [one.id, one.given]), [['type:child:same', 'Sample child']]);
});

test('keep a rule: the record to keep, with the record read as expected', async () => {
  const { status, result } = await run('keep-a-show-rule', { rule: { label: 'Sample new', subject: SUBJECT, when: null, effect: EFFECT } });
  assert.equal(status, 0);
  const keep = kept(result);
  assert.deepEqual(keep.expected, RECORD);
  assert.equal(keep.value.rules.length, 2);
  assert.equal(result.rule.label, 'Sample new');
  assert.equal(result.said, 'Kept: Sample new.');
  const changed = await run('keep-a-show-rule', { rule: { ...rule('own-1'), label: 'Renamed' } });
  assert.deepEqual(kept(changed.result).value.rules.map(one => one.label), ['Renamed'], 'the same id changes the rule');
});

test('keep a rule refuses a rule with a problem in its words, and nothing to keep', async () => {
  const { status, error } = await run('keep-a-show-rule', { rule: { label: 'x', subject: SUBJECT, when: null, effect: 'no-such-effect' } });
  assert.notEqual(status, 0);
  assert.ok(error.length > 0);
  const empty = await run('keep-a-show-rule', {});
  assert.match(empty.error, /rule is/);
});

test('a starting rule is switched off and back on', async () => {
  const off = await run('keep-a-show-rule', { starting: { id: STARTING, on: false } });
  assert.deepEqual(kept(off.result).value.starting[STARTING], { on: false });
  const away = await run('take-a-show-rule-away', { id: STARTING });
  assert.deepEqual(kept(away.result).value.starting[STARTING], { on: false }, 'taking a starting rule away switches it off');
});

test('take a rule away, and refuse one nobody keeps in the old words', async () => {
  const { result } = await run('take-a-show-rule-away', { id: 'own-1' });
  assert.deepEqual(kept(result).value.rules, []);
  assert.equal(result.said, 'Taken away.');
  assert.match((await run('take-a-show-rule-away', { id: 'nobody' })).error, /^No rule nobody\.$/);
  assert.match((await run('take-a-show-rule-away', {})).error, /id is a rule id from read_show_rules/);
});

test('keep a type, and refuse one that inherits itself or a type nobody keeps', async () => {
  const { result } = await run('keep-a-show-type', { type: type('third', [], ['child']) });
  assert.deepEqual(kept(result).value.types.map(one => one.id), ['base', 'child', 'third']);
  assert.equal(result.said, 'Kept the type Sample third.');
  assert.match((await run('keep-a-show-type', { type: type('base', [], ['child']) })).error, /cannot inherit itself/);
  assert.match((await run('keep-a-show-type', { type: type('lone', [], ['missing']) })).error, /inherits names types that exist/);
});

test('take a type away: a parent another type inherits is refused; a leaf is taken and switched off', async () => {
  assert.match((await run('take-a-show-type-away', { remove_type: 'base' })).error, /^Cannot remove base/);
  const { result } = await run('take-a-show-type-away', { remove_type: 'child' }, { ...RECORD, in_use: ['child'] });
  const keep = kept(result);
  assert.deepEqual(keep.value.types.map(one => one.id), ['base']);
  assert.equal(keep.value.in_use, undefined);
});

test('switch a kept type on and off; a type nobody keeps is refused', async () => {
  const on = await run('switch-a-kept-show-type', { use: { type: 'child', on: true } });
  assert.deepEqual(on.result.in_use, ['child']);
  assert.equal(on.result.said, 'Switched on Sample child.');
  const off = await run('switch-a-kept-show-type', { use: { type: 'child', on: false } }, { ...RECORD, in_use: ['child'] });
  assert.deepEqual(off.result.in_use, []);
  assert.match((await run('switch-a-kept-show-type', { use: { type: 'nobody', on: true } })).error, /^No profile nobody is kept here/);
});

test('a wake: a record of the declared kind written switches the type it names', async () => {
  const wake = row('switch-a-kept-show-type').wakes[0];
  assert.deepEqual(wake.on, { record: { resource: causes.resources[0], kind: USE_ASKED } });
  assert.ok(wake.budget.steps >= causes.least_budget.steps && wake.budget.wall_ms >= causes.least_budget.wall_ms);
  // The woken run has no `use`: it reads what the written records ask for.
  const asked = [{ id: `${USE_ASKED}:child`, type: USE_ASKED, value: { type: 'child', on: true } }];
  const { status, result } = await run('switch-a-kept-show-type', {}, RECORD, asked);
  assert.equal(status, 0);
  assert.deepEqual(result.in_use, ['child']);
  assert.deepEqual(kept(result).value.in_use, ['child']);
  const none = await run('switch-a-kept-show-type', {}, RECORD, []);
  assert.match(none.error, new RegExp(USE_ASKED));
});

const GRANT = id => `sharing:${data.sharing.record_prefix}${id}`;
const share = (input, records = {}) => runRow(row('share-a-kept-show-type'), { now: NOW, grant: GRANT(input.type), ...input },
  { doorOptions: { workspaceRecords: { [data.record]: RECORD, ...records } } });

test('share a kept type: the copy first, with what it inherits, then the grant, holding only the key\'s BLAKE3 (a2e1365f33)', async () => {
  const { status, result } = await share({ type: 'child', principal: 'sample-account' });
  assert.equal(status, 0);
  const label = `${data.sharing.record_prefix}child`;
  assert.deepEqual(result.keep.map(one => one.label), [label, GRANT('child')], 'the copy is kept before the grant names anyone');
  assert.deepEqual(result.keep[0].value.types.map(one => one.id), ['child', 'base'], 'an inheriting preset carries what it inherits');
  assert.equal(result.keep[0].value.label, 'Sample child');
  assert.match(result.key, /^shr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(result.keep[1].value, { record: label, people: [{ principal: 'sample-account', key_blake3: bytesToHex(blake3(new TextEncoder().encode(result.key))) }], changed_at: NOW });
  assert.equal(result.keep[1].expected, null, 'a grant nobody kept is written only while it is still absent');
  assert.ok(!JSON.stringify(result.keep).includes(result.key), 'no record holds the key');
  assert.equal(result.said, data.sharing.words.added.replace('{principal}', 'sample-account'));
});

test('a share with someone already named is refused in the screen\'s words, with nothing to keep', async () => {
  const grant = { record: `${data.sharing.record_prefix}child`, people: [{ principal: 'sample-account', key_blake3: 'a'.repeat(64) }], changed_at: NOW };
  const again = await share({ type: 'child', principal: 'sample-account' }, { [GRANT('child')]: grant });
  assert.equal(again.error, data.sharing.words.already.replace('{principal}', 'sample-account'));
  const other = await share({ type: 'child', principal: 'sample-other' }, { [GRANT('child')]: grant });
  assert.deepEqual(other.result.people, ['sample-account', 'sample-other']);
  assert.deepEqual(other.result.keep[1].expected, grant);
  assert.match((await share({ type: 'nobody', principal: 'x' })).error, /no preset nobody/);
  assert.match((await share({ type: 'child', principal: 'x', grant: 'sharing:elsewhere' })).error, /grant is where the share of child is kept/);
});

test('stop sharing takes the person out of the grant and leaves the others', async () => {
  const people = [{ principal: 'sample-account', key_blake3: 'a'.repeat(64) }, { principal: 'sample-other', key_blake3: 'b'.repeat(64) }];
  const grant = { record: `${data.sharing.record_prefix}child`, people, changed_at: NOW };
  const { status, result } = await runRow(row('stop-sharing-a-show-type'), { type: 'child', principal: 'sample-account', grant: GRANT('child'), now: NOW },
    { doorOptions: { workspaceRecords: { [GRANT('child')]: grant } } });
  assert.equal(status, 0);
  assert.deepEqual(result.keep, [{ label: GRANT('child'), value: { ...grant, people: [people[1]] }, expected: grant }]);
  const none = await runRow(row('stop-sharing-a-show-type'), { type: 'child', principal: 'sample-account', grant: GRANT('child') });
  assert.match(none.error, /not shared with sample-account/);
});

test('the moved store\'s edit rules decide through a row: an edit rule that denies changing rules refuses it', async () => {
  const actions = data.edit_authority.actions;
  const edit_rules = [{ id: 'owner', effect: 'allow', who: { kind: 'account_owner' }, actions }, { id: 'no-rule-changes', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_rule'] }];
  const { status, error } = await run('keep-a-show-rule', { rule: { label: 'Sample new', subject: SUBJECT, when: null, effect: EFFECT } }, { ...RECORD, edit_rules });
  assert.notEqual(status, 0);
  assert.match(error, /do not let this account actor change rule/);
  const read = await run('see-when-things-show', {}, { ...RECORD, edit_rules });
  assert.deepEqual(read.result.edit_authority.rules.map(one => one.id), ['owner', 'no-rule-changes']);
});
