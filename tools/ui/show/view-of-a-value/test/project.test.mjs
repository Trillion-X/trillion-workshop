// Any value is drawn as a parts screen the parts screen itself accepts, chosen by the rows of view-of-a-value.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectValue, factsOf, holds, lensFor } from '../project.mjs';
import { checkSpec } from '../../../../build-a-screen-from-patches/read-data/screen-spec.mjs';
import rows from '../view-of-a-value.json' with { type: 'json' };

/** The spec, checked by the renderer's own check: no problem, no fix. */
function accepted(value, options) {
  const { spec, rules, requests } = projectValue(value, options);
  const checked = checkSpec(spec, { requests });
  assert.deepEqual(checked.problems, [], JSON.stringify(spec));
  assert.deepEqual(checked.fixes, [], JSON.stringify(spec));
  return { spec, rules, requests, texts: Object.values(spec.elements).map(element => element.props.text).filter(Boolean) };
}

test('three records with titles are three choices, each with its fields', () => {
  const dinners = [
    { name: 'Lentil soup', minutes: 30, uses: ['lentils', 'carrots'] },
    { name: 'Salmon and rice', minutes: 25, uses: ['salmon', 'rice'] },
    { name: 'Omelette', minutes: 10, uses: ['eggs'] },
  ];
  const { rules, texts, spec } = accepted(dinners);
  assert.equal(rules[0], 'a-few-things-to-choose-from');
  for (const name of ['Lentil soup', 'Salmon and rice', 'Omelette', 'Minutes', 'Uses', 'lentils', '25']) assert.ok(texts.includes(name), name);
  assert.equal(spec.elements[spec.root].children.length, 3);
});

test('a long list of records is a list, and what is left out is said', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ title: `Task ${index}` }));
  const { rules, texts } = accepted(many);
  assert.equal(rules[0], 'a-list-of-records');
  assert.ok(texts.includes('Task 0') && !texts.includes('Task 55'));
  assert.ok(texts.includes(rows.words.more.replace('{count}', '10')));
});

test('one record is its fields, nested values drawn by the same rows', () => {
  const { rules, texts } = accepted({ title: 'Trip', where: { city: 'Lisbon', nights: 3 }, done: false, tags: [] });
  assert.equal(rules[0], 'a-record');
  assert.ok(rules.includes('yes-or-no') && rules.includes('nothing'));
  for (const said of ['Where', 'City', 'Lisbon', '3', rows.words.no, rows.words.empty]) assert.ok(texts.includes(said), said);
});

test('a number with a range in its schema is a ring; without one it is words', () => {
  const ranged = projectValue(7, { schema: { type: 'number', minimum: 0, maximum: 10 } });
  assert.equal(ranged.rules[0], 'a-number-in-a-range');
  assert.equal(ranged.spec.elements[ranged.spec.root].props.max, 10);
  assert.deepEqual(checkSpec(ranged.spec).problems, []);
  assert.equal(accepted(7).rules[0], 'words');
});

test('an answer that refused says so in its own words', () => {
  const { rules, texts } = accepted({ code: 'current_workspace_rights_refused', cause: 'x', outcome: 'not_started' });
  assert.equal(rules[0], 'an-error');
  assert.ok(texts.includes(rows.words.error) && texts.includes('current_workspace_rights_refused'));
});

test('every kind of value is drawn and accepted: nothing, words, numbers, lists of words, deep nesting', () => {
  let deep = { leaf: 'end' };
  for (let level = 0; level < 20; level += 1) deep = { [`level${level}`]: deep };
  for (const value of [null, '', 'hello', 0, -3.5, true, [], {}, ['a', 1, null], [[1, 2], [3]], deep, { list: [{ a: 1 }, { b: 2 }] }]) accepted(value);
});

test('a lens narrows: hidden fields, title fields, fewer items, a rule put first', () => {
  const people = [{ id: 'p1', full: 'Ada', email: 'a@example.com' }, { id: 'p2', full: 'Lin', email: 'l@example.com' }];
  const plain = accepted(people);
  assert.ok(plain.texts.includes('p1'), 'with no lens the id is the title');
  const lensed = accepted(people, { lens: { title_fields: ['full'], hidden_fields: ['email', 'id'], items: 1, rules_first: ['a-list-of-records'] } });
  assert.equal(lensed.rules[0], 'a-list-of-records');
  assert.ok(lensed.texts.includes('Ada') && !lensed.texts.includes('Lin') && !lensed.texts.includes('a@example.com'));
});

test('the same value always gives the same spec', () => {
  const value = { title: 'Same', items: [{ name: 'x' }] };
  assert.deepEqual(projectValue(value), projectValue(value));
});

test('every rule row names only declared parts and the last one holds for every value', () => {
  const last = rows.rules.at(-1);
  for (const value of [null, 1, 'a', [], {}, true]) assert.ok(holds(last.when, factsOf(value)));
  assert.equal(new Set(rows.rules.map(rule => rule.id)).size, rows.rules.length);
});

// The engine's tools:list {tool} answer (trillion-rust 154f14c85), as the door gave it for tool:add-a-customer on Nov 18.
const addACustomer = {
  id: 'tool:add-a-customer', key: 'workshop/tool:add-a-customer', label: 'Add a customer',
  job: 'Add a customer or contact to my customer list, with their name, how to reach them and where they came from',
  input_schema: { type: 'object', additionalProperties: false, required: ['name'], properties: {
    name: { type: 'string', minLength: 1, description: "The customer's name" },
    reach_them_by: { type: 'string', description: 'Optional: how you reach them, like Email or Instagram' },
  } },
  run: { address: '@tools', method: 'tools:run', input: { tool: 'workshop/tool:add-a-customer' }, fill: '/input' },
};

test('an answer that says how to run something is a form of its inputs and a button that runs it', () => {
  const { spec, rules, requests, texts } = accepted(addACustomer);
  assert.equal(rules[0], 'a-thing-to-run');
  assert.deepEqual(requests, { run: addACustomer.run });
  assert.ok(texts.includes('Add a customer'));
  const inputs = Object.values(spec.elements).filter(element => element.type === 'Input');
  assert.deepEqual(inputs.map(input => input.props.value), [{ $bindState: '/input/name' }, { $bindState: '/input/reach_them_by' }]);
  assert.deepEqual(inputs.map(input => input.props.label), ['Name', 'Reach them by']);
  const button = Object.values(spec.elements).find(element => element.type === 'Button');
  assert.deepEqual(button.on, { press: [{ action: 'run', params: { input: { $state: '/input' } } }] });
});

test('each kind of input gets its own control, and a default is the starting state', () => {
  const tool = { ...addACustomer, input_schema: { type: 'object', properties: {
    mood: { type: 'string', enum: ['calm', 'bright'] },
    loud: { type: 'boolean', default: true },
    warmth: { type: 'number', minimum: 0, maximum: 100, default: 40 },
    count: { type: 'integer' },
    story: { type: 'string', maxLength: 5000 },
    'a/b': { type: 'string' },
  } } };
  const { spec, rules } = accepted(tool);
  assert.deepEqual(rules.filter(rule => rule.startsWith('input:')), ['input:choose-one', 'input:on-or-off', 'input:a-number-in-a-range', 'input:a-number', 'input:long-words', 'input:words']);
  assert.deepEqual(spec.state, { input: { loud: true, warmth: 40 } });
  const slider = Object.values(spec.elements).find(element => element.type === 'Slider');
  assert.deepEqual([slider.props.min, slider.props.max], [0, 100]);
  const tiles = Object.values(spec.elements).find(element => element.type === 'ChoiceTiles');
  assert.deepEqual(tiles.props.tiles, [{ id: 'calm', label: 'Calm' }, { id: 'bright', label: 'Bright' }]);
  assert.ok(Object.values(spec.elements).some(element => element.props?.value?.$bindState === '/input/a~1b'), 'a key with a slash is one pointer step');
});

test('a value offers no request unless it says how to run something', () => {
  for (const value of [{ run: 'x', input_schema: {} }, { run: { address: '@tools', method: 'tools:run' } }, [addACustomer], { name: 'x' }]) {
    const { requests } = projectValue(value);
    assert.deepEqual(requests, {}, JSON.stringify(value));
  }
});

test('lens rows: the person beats a learned rule beats an AI beats the default, field by field', () => {
  const dinners = [{ name: 'Soup', minutes: 30, notes: 'x' }, { name: 'Tacos', minutes: 20, notes: 'y' }];
  const rows = [
    { set_by: 'default', when: {}, lens: { items: 10, hidden_fields: ['id'] } },
    { set_by: 'ai', when: { fields_all: ['name'] }, lens: { items: 3, title: 'Dinners' } },
    { set_by: 'rule', when: { fields_all: ['name', 'minutes'] }, lens: { hidden_fields: ['notes'] } },
    { set_by: 'person', when: { fields_all: ['name', 'minutes'] }, lens: { items: 2 } },
    { set_by: 'person', when: { fields_all: ['calories'] }, lens: { items: 1 } },
    { set_by: 'stranger', when: {}, lens: { items: 99 } },
    { set_by: 'person', when: {}, lens: { widen: true } },
  ];
  assert.deepEqual(lensFor(dinners, rows), { items: 2, hidden_fields: ['notes'], title: 'Dinners' });
  const { spec } = accepted(dinners, { lens: lensFor(dinners, rows) });
  assert.ok(!JSON.stringify(spec).includes('"Notes"'), 'the hidden field is not drawn');
  assert.deepEqual(lensFor(dinners, []), {});
  assert.deepEqual(lensFor('words', rows), { items: 10, hidden_fields: ['id'] }, 'only rows that need no field hold for an answer with none');
});

// The answer tools:run gave through the door for tool:add-a-customer on Nov 18 (5:15 AM CST).
const finishedRun = { exit_code: 0, replayed: false, tool: 'tool:add-a-customer', result: { contact_id: 'contact:7a21a378-b639-4655-91b5-99fe6f86b2ab',
  contact_record: { channelLabel: 'Email', contactId: 'contact:7a21a378-b639-4655-91b5-99fe6f86b2ab', displayName: 'Ada Lovelace', kind: 'customer-contact' } } };

test('a finished run leads with its outcome and its result, never its own plumbing', () => {
  const { spec, rules, texts } = accepted(finishedRun);
  assert.equal(rules[0], 'a-finished-run');
  assert.ok(Object.values(spec.elements).some(element => element.type === 'Badge' && element.props.text === 'Done'));
  assert.ok(texts.includes('Ada Lovelace'), 'the record leads with its display name');
  for (const plumbing of ['Exit code', 'Replayed', 'Tool']) assert.ok(!texts.includes(plumbing), plumbing);
  const ids = Object.values(spec.elements).filter(element => element.props.text === 'contact:7a21a378-b639-4655-91b5-99fe6f86b2ab');
  assert.ok(ids.length && ids.every(element => element.props.variant === 'caption' && element.props.color === 'muted'), 'an identifier is drawn quietly');
  assert.ok(texts.includes('Channel label') && texts.includes('Contact id'), 'labels are sentence case');
  assert.equal(ids.length, 1, 'the id the record repeats is said once, inside the record');
});

test('dates are drawn in words, their time with the offset written', () => {
  const { texts, rules } = accepted({ subject: 'Call the bank', due: '2026-11-20', at: '2026-11-18T05:40:00-06:00', sent: '2026-11-18T11:40:00Z', code: '2026-13-45x' });
  assert.ok(texts.includes('Nov 20, 2026'));
  assert.ok(texts.includes('Nov 18, 2026, 05:40 -06:00'));
  assert.ok(texts.includes('Nov 18, 2026, 11:40 UTC'));
  assert.ok(texts.includes('2026-13-45x'), 'not a date: drawn as written');
  assert.equal(rules.filter(rule => rule === 'a-date').length, 3);
});
