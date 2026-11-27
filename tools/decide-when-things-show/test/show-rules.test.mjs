// The rows of decide-when-things-show over a made-up show-rules record handed in as `records`, run by
// test-helpers/run-a-row.mjs, which checks each row's rights (none: a row reads nothing but its input). Made-up rows only;
// nothing here names a person, and the subject, effect and starting rule are read from show-rules.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf, rightsOf } from '../../../test-helpers/run-a-row.mjs';
import data from '../../set-up-my-account/read-data/show-rules.json' with { type: 'json' };
import shippedDefaults from '../../starting-set/shipped-defaults.json' with { type: 'json' };
import { profileRules, ruleProblem } from '../../set-up-my-account/read-data/show-rules.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const ROWS = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const row = slug => rowOf(ROWS, `tool:${slug}`);
const NOW = '2026-01-10T12:00:00.000Z';
// A subject, an effect and a starting rule a person may keep or switch, found by the moved rule check, never named.
const [SUBJECT, EFFECT] = Object.keys(data.subjects).flatMap(subject => data.effects.map(effect => [subject, effect.id]))
  .find(([subject, effect]) => ruleProblem(data, { id: 'x', label: 'x', subject, when: null, effect }, 'personal') === null);
const STARTING = data.starting_rules.find(one => ruleProblem(data, one, 'personal') === null).id;
const rule = (id, extra = {}) => ({ id, label: `Sample ${id}`, subject: SUBJECT, when: null, effect: EFFECT, on: true, ...extra });
const type = (id, rules = [], inherits = []) => ({ id, label: `Sample ${id}`, inherits, rules });
// The shipped show-rules default (tools/starting-set/shipped-defaults.json), laid under every record the rows read.
const SHIPPED = shippedDefaults.records.map(one => one.payload).find(one => one.record === data.record);
const SHIPPED_TYPES = SHIPPED.value.types.map(one => one.id);
const SHIPPED_ON = SHIPPED.value.in_use;
const RECORD = {
  rules: [rule('own-1')],
  types: [type('base', [rule('quiet')]), type('child', [rule('loud', { on: false })], ['base'])],
};
const run = (slug, input, record = RECORD) =>
  answerOf(row(slug), { now: NOW, records: record === null ? {} : { [data.record]: record }, ...input }, {});
const kept = result => {
  assert.equal(result.keep.length, 1);
  assert.equal(result.keep[0].label, data.record);
  return result.keep[0];
};

test('every action is one row, and no row reaches a door: the caller hands in the records it reads', () => {
  const ids = ROWS.records.map(one => one.payload.id);
  assert.deepEqual(ids, ['see-when-things-show', 'keep-a-show-rule', 'take-a-show-rule-away', 'keep-a-show-type', 'take-a-show-type-away',
    'switch-a-kept-show-type', 'share-a-kept-show-type', 'stop-sharing-a-show-type'].map(slug => `tool:${slug}`));
  for (const one of ROWS.records.map(record => record.payload)) {
    assert.equal(one.stored, undefined, `${one.id} declares no stored rights`);
    assert.deepEqual(rightsOf(one), [], `${one.id} reaches no door`);
    assert.ok(one.input_schema.properties.records, `${one.id} takes the records it reads as input`);
  }
});

test('read: the starting rules, the person\'s own, and the rules of switched-on types only', async () => {
  const off = await run('see-when-things-show', {});
  assert.equal(off.status, 0);
  assert.ok(off.result.rules.some(one => one.id === STARTING && one.starting));
  assert.ok(off.result.rules.some(one => one.id === 'own-1'));
  assert.ok(!off.result.rules.some(one => /^type:(base|child):/.test(String(one.id))), 'a kept type applies only while it is on');
  assert.deepEqual(off.result.types.map(one => one.id), [...SHIPPED_TYPES, 'base', 'child']);
  assert.deepEqual(off.result.in_use, SHIPPED_ON, 'the shipped types are on until the person switches them off');
  const on = await run('see-when-things-show', {}, { ...RECORD, in_use: ['child'] });
  assert.ok(on.result.rules.some(one => one.id === 'type:base:quiet'), 'a type takes the rules of the types it inherits');
  assert.deepEqual(on.result.in_use, [...SHIPPED_ON, 'child']);
});

test('read with no record: the starting rules and the shipped types, on', async () => {
  const { status, result } = await run('see-when-things-show', {}, null);
  assert.equal(status, 0);
  assert.deepEqual(result.types.map(one => [one.id, one.shipped]), SHIPPED_TYPES.map(id => [id, true]));
  assert.deepEqual(result.in_use, SHIPPED_ON);
  assert.ok(result.rules.every(one => one.starting || SHIPPED_TYPES.some(id => String(one.id).startsWith(`type:${id}:`))));
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
  assert.deepEqual(on.result.in_use, [...SHIPPED_ON, 'child']);
  assert.deepEqual(kept(on.result).value.in_use, ['child'], 'the shipped switch is not written into the record');
  assert.equal(on.result.said, 'Switched on Sample child.');
  const off = await run('switch-a-kept-show-type', { use: { type: 'child', on: false } }, { ...RECORD, in_use: ['child'] });
  assert.deepEqual(off.result.in_use, SHIPPED_ON);
  assert.match((await run('switch-a-kept-show-type', { use: { type: 'nobody', on: true } })).error, /^No profile nobody is kept here/);
});

test('a switch is the request\'s own use: no wake, no record read, and the answer holds the record to write', async () => {
  const one = row('switch-a-kept-show-type');
  assert.equal(one.wakes, undefined);
  assert.deepEqual(one.input_schema.required, ['use']);
  const { status, result } = await run('switch-a-kept-show-type', { use: { type: 'child', on: true } });
  assert.equal(status, 0);
  assert.deepEqual(result.in_use, [...SHIPPED_ON, 'child']);
  assert.deepEqual(kept(result).value.in_use, ['child'], 'the answer holds the record');
  const none = await run('switch-a-kept-show-type', {});
  assert.match(none.error, /use names type/);
});

test('the shipped types: switched off and on as the person\'s starting switch, never written into the record', async () => {
  const [id] = SHIPPED_ON;
  const off = await run('switch-a-kept-show-type', { use: { type: id, on: false } });
  assert.equal(off.status, 0);
  assert.ok(!off.result.in_use.includes(id));
  const record = kept(off.result);
  assert.deepEqual(record.expected, RECORD, 'the record as read');
  assert.deepEqual(record.value.starting[id], { on: false }, 'switched off where the reader looks (merge.switched off_in)');
  assert.deepEqual(record.value.types.map(one => one.id), ['base', 'child'], 'no shipped type is written');
  assert.equal(record.value.in_use, undefined);
  const back = await run('switch-a-kept-show-type', { use: { type: id, on: true } }, record.value);
  assert.equal(back.error, undefined);
  assert.ok(back.result.in_use.includes(id));
  assert.equal(kept(back.result).value.starting[id], undefined, 'switched back on by leaving the default to say');
});

test('a shipped type is not taken away; a person\'s own copy of one is, and the shipped one comes back as switched', async () => {
  const [id] = SHIPPED_ON;
  const refused = await run('take-a-show-type-away', { remove_type: id });
  assert.match(refused.error, new RegExp(`^${id} ships with Trillion for every account`));
  const mine = { ...SHIPPED.value.types.find(one => one.id === id), label: 'My own copy' };
  const changed = await run('keep-a-show-type', { type: mine });
  assert.equal(changed.status, 0);
  const own = kept(changed.result).value;
  assert.deepEqual(own.types.map(one => [one.id, one.label]), [[id, 'My own copy'], ['base', 'Sample base'], ['child', 'Sample child']], 'a changed shipped type becomes the person\'s own');
  assert.deepEqual(own.in_use, [id], 'and its switch is theirs');
  const read = await run('see-when-things-show', {}, own);
  assert.equal(read.result.types.find(one => one.id === id).shipped, undefined);
  const taken = await run('take-a-show-type-away', { remove_type: id }, own);
  assert.equal(taken.status, 0);
  const after = kept(taken.result).value;
  assert.ok(!after.types.some(one => one.id === id));
  assert.equal(after.starting?.[id], undefined, 'it was on, so the shipped one comes back on');
  const unchanged = await run('keep-a-show-type', { type: SHIPPED.value.types.find(one => one.id === id) });
  assert.deepEqual(kept(unchanged.result).value.types.map(one => one.id), ['base', 'child'], 'keeping the shipped type unchanged writes no copy');
});

test('a shipped type can be shared like a kept one', async () => {
  const [id] = SHIPPED_TYPES;
  const { status, result } = await share({ type: id, principal: 'sample-account' });
  assert.equal(status, 0);
  assert.deepEqual(result.keep[0].value.types.map(one => one.id), [id]);
});

const GRANT = id => `sharing:${data.sharing.record_prefix}${id}`;
const share = (input, records = { [GRANT(input.type)]: null }) => answerOf(row('share-a-kept-show-type'),
  { now: NOW, grant: GRANT(input.type), records: { [data.record]: RECORD, ...records }, ...input }, {});

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
  const left = await share({ type: 'child', principal: 'sample-other' }, {});
  assert.match(left.error, /must be handed in as records/, 'a grant left out is refused, never read as nobody sharing');
});

test('stop sharing takes the person out of the grant and leaves the others', async () => {
  const people = [{ principal: 'sample-account', key_blake3: 'a'.repeat(64) }, { principal: 'sample-other', key_blake3: 'b'.repeat(64) }];
  const grant = { record: `${data.sharing.record_prefix}child`, people, changed_at: NOW };
  const { status, result } = await answerOf(row('stop-sharing-a-show-type'),
    { type: 'child', principal: 'sample-account', grant: GRANT('child'), now: NOW, records: { [GRANT('child')]: grant } }, {});
  assert.equal(status, 0);
  assert.deepEqual(result.keep, [{ label: GRANT('child'), value: { ...grant, people: [people[1]] }, expected: grant }]);
  const none = await answerOf(row('stop-sharing-a-show-type'), { type: 'child', principal: 'sample-account', grant: GRANT('child'), records: { [GRANT('child')]: null } });
  assert.match(none.error, /not shared with sample-account/);
  const left = await answerOf(row('stop-sharing-a-show-type'), { type: 'child', principal: 'sample-account', grant: GRANT('child'), records: {} });
  assert.match(left.error, /must be handed in as records/, 'a grant left out is refused, never read as nobody sharing');
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
