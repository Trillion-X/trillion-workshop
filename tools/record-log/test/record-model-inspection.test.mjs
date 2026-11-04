// The optional inspection projection reads the existing EEAF owner. The fake
// persistence boundary below exposes only that owner's reads; the production
// model still extracts the facts, roles, ordinals and interaction sets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { factsOf, partsOf, setsOf, recordModel, declarationIndexesOf } from '../do-work/record-model.mjs';
import { handleModelRequest, inspectionRecordId, readRecordModel, recordModelLabels } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-model-tools.mjs';
import modelData from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-model.json' with { type: 'json' };

const ROOT = 'record:specimens:one';
const DECLARATION = 'list:field-notebook';
const FILE = `1f:${'a'.repeat(64)}`;
const FIELDS = [
  { id: 'specimen', label: 'Specimen name', kind: 'text' },
  { id: 'comparisons', label: 'Compared with', kind: 'link', links_to: 'field-notebook' },
  { id: 'checked', label: 'Observation checked', kind: 'checkbox' },
];
const KIND = { type: 'record:specimens', declared_by: DECLARATION,
  parts: [{ role: 'comparisons', path: ['comparisons'] }] };

function fixture({ many = 0, complete = true } = {}) {
  const calls = [];
  const values = new Map([
    [DECLARATION, { type: 'list', value: { label: 'Field notebook', row_type: 'specimens', title_field: 'specimen', fields: FIELDS } }],
    [ROOT, { type: KIND.type, value: { specimen: 'Current observation', checked: false, observations: [{ accepted: false, why: 'Review pending' }], comparisons: [FILE, 'record:specimens:two', 'record:specimens:three'] } }],
    ['record:specimens:two', { type: KIND.type, value: { specimen: 'Second observation' } }],
    ['record:specimens:three', { type: KIND.type, value: { specimen: 'Third observation' } }],
    [FILE, { type: 'file', value: { identity: FILE } }],
  ]);
  for (let index = 0; index < many; index += 1) values.set(`holder:${index}`, { type: 'execution', value: { operation: `Observed ${index}` } });
  const incoming = Array.from({ length: many }, (_, ordinal) => ({ id: `holder:${ordinal}`, type: 'execution', role: 'used', ordinal }));
  const records = {
    read(id) { calls.push(['read', id]); return values.get(id)?.value ?? null; },
    typeOf(id) { calls.push(['typeOf', id]); return values.get(id)?.type ?? null; },
    model(input = {}) {
      calls.push(['model', input]);
      return { kinds: input.type === KIND.type ? [KIND] : [], complete };
    },
    factsOf(id) { calls.push(['factsOf', id]); const row = values.get(id); return row ? { id, type: row.type, facts: factsOf(row.value) } : null; },
    partsOf(id) { calls.push(['partsOf', id]); return { id, parts: partsOf(KIND, values.get(id)?.value) }; },
    setsOf(id) { calls.push(['setsOf', id]); return { id, sets: setsOf(partsOf(KIND, values.get(id)?.value), text => createHash('sha256').update(text).digest('hex')) }; },
    holdersOf(id, input) {
      calls.push(['holdersOf', id, input]);
      const start = input.after ? incoming.findIndex(row => row.id === input.after) + 1 : 0;
      const held = input.role && input.role !== 'used' ? [] : incoming.slice(start, start + input.limit);
      return { holders: held, complete, next: start + held.length < incoming.length ? held.at(-1)?.id ?? null : null };
    },
    recordAt(id, input) {
      calls.push(['recordAt', id, input]);
      return { id, type: KIND.type, value: { specimen: 'Earlier observation' }, facts: [{ path: ['specimen'], value: 'Earlier observation', value_kind: 'text', valid_time: '2026-10-01T00:00:00Z', system_time: '2026-10-02T00:00:00Z' }] };
    },
  };
  return { records, values, calls };
}

test('any declared row kind gets its own title field, field labels and exact list owner without listing all records', () => {
  const { records, calls } = fixture();
  const answer = readRecordModel(records, { id: ROOT, inspect: true });
  assert.equal(answer.labels[ROOT].label, 'Current observation');
  assert.deepEqual(answer.fields, FIELDS);
  assert.deepEqual(answer.labels[ROOT].open, { href: '/lists/field-notebook?row=one', screen: 'trillion.list', input: { id: 'field-notebook', row: 'one' } });
  assert.deepEqual(answer.facts.find(fact => fact.path.join('.') === 'observations.0.accepted'), { path: ['observations', 0, 'accepted'], value: false, value_kind: 'boolean' });
  assert.equal(answer.facts.find(fact => fact.path[0] === 'checked').value, false);
  assert.ok(calls.filter(([name]) => name === 'model').every(([, input]) => typeof input.type === 'string'
    && input.declaration_only === true && Object.keys(input).sort().join(',') === 'declaration_only,model_budget,type'));
  assert.ok(calls.filter(([name]) => name === 'read').every(([, id]) => id !== 'list:specimens'), 'the row type is not guessed to be the list slug');
});

test('sharing addresses use the exact list declaration and file sharing addresses use the same file identity', () => {
  const { records } = fixture();
  const requested = 'list:field-notebook:rows:one';
  const answer = readRecordModel(records, { id: requested, inspect: true });
  assert.equal(answer.id, ROOT);
  assert.equal(answer.requested_id, requested);
  assert.equal(answer.labels[requested].id, ROOT);
  assert.equal(answer.labels[ROOT].label, 'Current observation');
  assert.deepEqual(inspectionRecordId(records, `file:${FILE}`), { id: FILE, requested_id: `file:${FILE}` });
  assert.equal(readRecordModel(records, { id: `file:${FILE}`, inspect: true }).labels[FILE].open.screen, 'trillion.file');
});

test('an unknown sharing list stays unresolved and does not synthesize a row in a guessed type', () => {
  const { records, calls } = fixture();
  const answer = readRecordModel(records, { id: 'list:missing:rows:one', inspect: true });
  assert.equal(answer.complete, false);
  assert.equal(answer.unresolved.code, 'list_declaration_missing');
  assert.equal(answer.facts, null);
  assert.equal(answer.next, null);
  assert.deepEqual(calls, [['read', 'list:missing']]);
});

test('outgoing parts and incoming holders both page without repeating completed sides or losing their ordinals', () => {
  const { records, calls } = fixture({ many: 5 });
  const pages = [];
  let after;
  do {
    const answer = readRecordModel(records, { id: ROOT, inspect: true, limit: 2, after });
    pages.push(answer);
    assert.ok(pages.length < 5);
    after = answer.next;
  } while (after);
  assert.deepEqual(pages.flatMap(page => page.parts).map(part => [part.id, part.ordinal]), [[FILE, 0], ['record:specimens:two', 1], ['record:specimens:three', 2]]);
  assert.deepEqual(pages.flatMap(page => page.holders).map(holder => holder.id), ['holder:0', 'holder:1', 'holder:2', 'holder:3', 'holder:4']);
  assert.deepEqual(pages.map(page => page.complete), [false, false, true]);
  assert.ok(calls.filter(([name]) => name === 'holdersOf').every(([, , input]) => input.limit === 2));
});

test('a page of outgoing parts can continue after all incoming holders have finished', () => {
  const { records, calls } = fixture({ many: 1 });
  const first = readRecordModel(records, { id: ROOT, inspect: true, limit: 1 });
  const second = readRecordModel(records, { id: ROOT, inspect: true, limit: 1, after: first.next });
  const third = readRecordModel(records, { id: ROOT, inspect: true, limit: 1, after: second.next });
  assert.deepEqual([first.holders.length, second.holders.length, third.holders.length], [1, 0, 0]);
  assert.equal(calls.filter(([name]) => name === 'holdersOf').length, 1);
  assert.equal(third.complete, true);
  assert.equal(third.next, null);
});

test('incoming index uncertainty is retained across outgoing-only continuation pages', () => {
  const { records } = fixture();
  records.holdersOf = () => ({ holders: [], complete: false, next: null });
  let after;
  for (let page = 0; page < 3; page += 1) {
    const answer = readRecordModel(records, { id: ROOT, inspect: true, limit: 1, after });
    assert.equal(answer.complete, false);
    assert.equal(answer.coverage.holders.complete, false);
    after = answer.next;
  }
  assert.equal(after, null);
});

test('shipped message naming and inspection never request a model inventory', () => {
  const { records, values } = fixture();
  const id = 'message:one';
  values.set(id, { type: 'message', value: { text: 'A real note about the selected record', at: '2026-10-11T21:32:20Z' } });
  records.model = () => { throw new Error('A shipped name does not need the model inventory'); };
  records.partsOf = () => ({ parts: [] });
  records.setsOf = () => ({ sets: [] });
  const named = recordModelLabels(records, [id]);
  assert.equal(named[id].title, 'A real note about the selected record');
  assert.equal(named[id].unavailable, undefined);
  assert.equal(readRecordModel(records, { id, inspect: true }).labels[id].title, named[id].title);
});

test('one label page bounds aggregate hydrated values and marks remaining records unavailable', () => {
  const { records, values, calls } = fixture();
  for (let index = 0; index < 5; index += 1) values.set(`message:${index}`, { type: 'message', value: { text: 'x'.repeat(64) } });
  records.sizeOf = () => ({ bytes: 80 });
  const named = recordModelLabels(records, Array.from({ length: 5 }, (_, index) => `message:${index}`),
    { modelBudget: { reads: 128, bytes: 170 } });
  assert.equal(named['message:0'].missing, false);
  assert.equal(named['message:1'].missing, false);
  for (const id of ['message:2', 'message:3', 'message:4']) {
    assert.equal(named[id].missing, null);
    assert.equal(named[id].unavailable, true);
    assert.equal(named[id].error.code, 'inspection_label_budget');
  }
  assert.equal(calls.filter(([kind]) => kind === 'read').length, 2);
});

test('a shared value expansion is charged by returned bytes, not only its small stored reference', () => {
  const { records, values, calls } = fixture();
  values.set('message:wide', { type: 'message', value: { text: 'x'.repeat(512) } });
  values.set('message:later', { type: 'message', value: { text: 'Later' } });
  records.sizeOf = () => ({ bytes: 8 });
  const named = recordModelLabels(records, ['message:wide', 'message:later'], { modelBudget: { reads: 128, bytes: 256 } });
  assert.equal(named['message:wide'].unavailable, true);
  assert.equal(named['message:later'].unavailable, true);
  assert.equal(calls.filter(([kind]) => kind === 'read').length, 1);
});

test('direct list-sharing labels retain the exact declaring owner while an index is incomplete', () => {
  const { records } = fixture({ complete: false });
  records.model = () => { throw new Error('The explicit sharing address already names its list'); };
  const id = 'list:field-notebook:rows:one';
  const named = recordModelLabels(records, [id]);
  assert.equal(named[id].label, 'Current observation');
  assert.equal(named[id].open.input.id, 'field-notebook');
  assert.equal(named[id].unresolved, undefined);
});

test('continuations cannot be reused for a different record or relationship role', () => {
  const { records } = fixture({ many: 2 });
  const first = readRecordModel(records, { id: ROOT, inspect: true, limit: 1 });
  for (const change of [{ id: 'record:specimens:two' }, { role: 'made' }]) {
    assert.throws(() => readRecordModel(records, { id: ROOT, inspect: true, after: first.next, ...change }), error => error.code === 'inspection_cursor_invalid');
  }
  assert.throws(() => readRecordModel(records, { id: ROOT, inspect: true, after: 'inspect:broken' }), error => error.code === 'inspection_cursor_invalid');
});

test('historical facts retain their times while relationships, names and descriptors are explicitly current', () => {
  const { records, calls } = fixture({ many: 1 });
  const valid = '2026-10-03T00:00:00Z', known = '2026-10-04T00:00:00Z';
  const answer = readRecordModel(records, { id: ROOT, inspect: true, valid, known });
  assert.equal(answer.facts[0].value, 'Earlier observation');
  assert.equal(answer.facts[0].valid_time, '2026-10-01T00:00:00Z');
  assert.equal(answer.facts[0].system_time, '2026-10-02T00:00:00Z');
  assert.equal(answer.labels[ROOT].label, 'Current observation');
  assert.deepEqual(answer.fields, FIELDS);
  assert.equal(answer.parts.length, 3);
  assert.equal(answer.holders.length, 1);
  assert.deepEqual(answer.version, { mode: 'historical', valid, known, facts: 'selected_version', labels: 'current', fields: 'current', relations: 'current' });
  assert.equal(answer.coverage.relations, 'current_only');
  assert.deepEqual(calls.find(([name]) => name === 'recordAt'), ['recordAt', ROOT, { valid, known }]);
});

test('no fact at a selected time is shown as missing at that version, with current relationships separately identified', () => {
  const { records } = fixture();
  records.recordAt = () => null;
  const answer = readRecordModel(records, { id: ROOT, inspect: true, valid: '2020-01-01T00:00:00Z' });
  assert.equal(answer.facts, null);
  assert.equal(answer.value, null);
  assert.equal(answer.coverage.facts, 'not_found_at_version');
  assert.equal(answer.coverage.relations, 'current_only');
  assert.equal(answer.labels[ROOT].missing, false);
});

test('missing metadata, a failed related read, and an incomplete index stay distinguishable', () => {
  const { records } = fixture({ complete: false });
  const read = records.read;
  records.read = id => { if (id === FILE) throw Object.assign(new Error('over the allowed read size'), { code: 'record_too_large' }); return read(id); };
  const answer = readRecordModel(records, { id: ROOT, inspect: true });
  assert.equal(answer.complete, false);
  assert.equal(answer.coverage.labels.complete, false);
  assert.equal(answer.labels[FILE].unavailable, true);
  assert.equal(answer.labels[FILE].missing, null);
  assert.deepEqual(answer.labels[FILE].error, { code: 'record_too_large' });
  const missing = recordModelLabels(records, ['record:specimens:missing'])['record:specimens:missing'];
  assert.equal(missing.missing, true);
  assert.equal(missing.unavailable, undefined);
  assert.ok(answer.facts.length > 0, 'one unavailable related record does not hide the inspected facts');
});

test('existing callers still receive the original current and historical model shapes unless they request inspection', () => {
  const { records, calls } = fixture({ many: 1 });
  const current = readRecordModel(records, { id: ROOT });
  assert.deepEqual(Object.keys(current).sort(), ['complete', 'facts', 'holders', 'id', 'next', 'parts', 'sets', 'type']);
  assert.equal(calls.some(([name]) => name === 'read'), false);
  const before = calls.length;
  const historical = readRecordModel(records, { id: ROOT, valid: '2026-10-03T00:00:00Z' });
  assert.deepEqual(Object.keys(historical).sort(), ['facts', 'id', 'type', 'value']);
  assert.equal(calls.length, before + 1);
});

test('the existing HTTP owner enforces its path, read method, bounded limit and explicit error state', async () => {
  const { records, calls } = fixture();
  assert.equal(handleModelRequest(records, new Request('https://example.test/records/model', { method: 'POST' })), null);
  assert.equal(handleModelRequest(records, new Request('https://example.test/elsewhere')), null);
  const response = handleModelRequest(records, new Request(`https://example.test/records/model?id=${ROOT}&inspect=true&limit=999999`));
  assert.equal(response.status, 200);
  assert.equal(calls.find(([name]) => name === 'holdersOf')[2].limit, 1000);
  const invalid = handleModelRequest(records, new Request(`https://example.test/records/model?id=${ROOT}&inspect=true&known=nonsense`));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'inspection_time_invalid');
  records.factsOf = () => { throw Object.assign(new Error('record read is too large'), { code: 'record_too_large' }); };
  const tooLarge = handleModelRequest(records, new Request(`https://example.test/records/model?id=${ROOT}&inspect=true`));
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, 'record_too_large');
});

test('a native owner supplies exact facts while the existing EEAF index supplies incoming relationships', () => {
  const { records, calls } = fixture({ many: 1 });
  const id = 'run:experiment_17', requested_id = `workflow-run:${id}`;
  const value = { observations: [{ checked: false, evidence: { record: FILE, part: { kind: 'moment', start_ms: 1250, end_ms: 3000 } } }] };
  const native = { id, requested_id, type: 'workflow-run', value, facts: factsOf(value), parts: [], sets: [],
    open_href: '/workflows/' + encodeURIComponent(id),
    source: { kind: 'native_owner', reader: 'declared-reader', record: requested_id, seq: 7 },
    coverage: { facts: 'current', history: 'unsupported' }, complete: true };
  const answer = readRecordModel(records, { id: requested_id, inspect: true, limit: 2 }, { native });
  assert.equal(answer.id, id);
  assert.equal(answer.requested_id, requested_id);
  assert.deepEqual(answer.facts, native.facts);
  assert.equal(answer.facts.find(fact => fact.path.at(-1) === 'checked').value, false);
  assert.deepEqual(answer.source, native.source);
  assert.equal(answer.labels[id].missing, false);
  assert.equal(answer.labels[requested_id].id, id);
  assert.equal(answer.labels[id].open_href, native.open_href);
  assert.equal(answer.labels[requested_id].open_href, native.open_href, 'the native owner address survives exact alias projection');
  assert.equal(answer.holders.length, 1);
  assert.equal(answer.coverage.history, 'unsupported');
  const [, heldId, heldOptions] = calls.find(([name]) => name === 'holdersOf');
  assert.equal(heldId, id);
  assert.equal(heldOptions.limit, 2);
  assert.ok(heldOptions.model_budget.reads <= 128 && heldOptions.model_budget.bytes <= 8 * 1024 * 1024);
  assert.equal(heldOptions.narrow_model, true);
  assert.deepEqual(Object.keys(heldOptions).sort(), ['limit', 'model_budget', 'narrow_model']);
  assert.ok(!calls.some(([name, key]) => ['read', 'factsOf', 'partsOf', 'setsOf'].includes(name) && [id, requested_id].includes(key)), 'native facts are not read or copied through another persistence owner');
});

test('a native read for another record is rejected before its values or references are projected', () => {
  const { records, calls } = fixture();
  assert.throws(() => readRecordModel(records, { id: 'run:first', inspect: true }, { native: {
    id: 'run:other', requested_id: 'run:other', type: 'workflow-run', value: { secret: 'must not appear' },
    facts: [], coverage: { facts: 'current' },
  } }), error => error.code === 'inspection_native_mismatch');
  assert.deepEqual(calls, []);
});

test('native history never substitutes current values or asks the unrelated EEAF history owner', () => {
  const { records, calls } = fixture();
  records.recordAt = () => { throw new Error('wrong history owner'); };
  const id = 'run:experiment_17';
  const native = { id, requested_id: id, type: 'workflow-run', value: null, facts: null,
    coverage: { facts: 'historical_unsupported', history: 'unsupported' }, complete: false,
    error: { code: 'native_history_unsupported' }, source: { kind: 'native_owner' } };
  const answer = readRecordModel(records, { id, inspect: true, valid: '2026-10-01T00:00:00Z' }, { native });
  assert.equal(answer.facts, null);
  assert.equal(answer.value, null);
  assert.equal(answer.complete, false);
  assert.equal(answer.version.facts, 'historical_unsupported');
  assert.equal(answer.coverage.facts, 'historical_unsupported');
  assert.equal(answer.labels[id].missing, null);
  assert.ok(!calls.some(([name]) => name === 'recordAt'));
});

test('an unavailable native value retains bounded incoming relationships without becoming an empty successful read', () => {
  const { records } = fixture({ many: 3 });
  const id = 'workflow-output:run:experiment_17:inspect';
  const native = { id, requested_id: id, type: 'workflow-output', value: null, facts: null,
    coverage: { facts: 'unavailable', history: 'unsupported' }, complete: false,
    error: { code: 'native_record_changed' }, source: { kind: 'native_owner', record: id } };
  const answer = readRecordModel(records, { id, inspect: true, limit: 1 }, { native });
  assert.equal(answer.facts, null);
  assert.equal(answer.complete, false);
  assert.equal(answer.error.code, 'native_record_changed');
  assert.equal(answer.coverage.facts, 'unavailable');
  assert.equal(answer.labels[id].missing, null);
  assert.equal(answer.labels[id].unavailable, true);
  assert.equal(answer.holders.length, 1);
  assert.ok(answer.next);
});

test('the actual message declaration keeps arbitrary about identities and roles as ordinary participation', () => {
  const kind = modelData.kinds.find(row => row.type === 'message');
  const output = 'workflow-output:run:experiment_17:inspect';
  const value = { about: [{ kind: 'file', id: FILE }, { kind: 'record', id: ROOT }, { kind: 'workflow-output', id: output }] };
  assert.deepEqual(partsOf(kind, value).map(({ id, role, ordinal }) => ({ id, role, ordinal })), [
    { id: FILE, role: 'file', ordinal: 0 }, { id: ROOT, role: 'record', ordinal: 1 }, { id: output, role: 'workflow-output', ordinal: 2 },
  ]);
});

test('declared row qualification uses exact neighbor declarations and suppresses unresolved local addresses', () => {
  const data = { kinds: [], declared_by: [{ type: 'catalogue', kind: { path: ['holds'], prefix: 'row:' },
    properties: { path: ['fields'], name: ['name'], kind: ['shape'] }, kind_values: { pointer: 'ids', file: 'id' },
    parts_when: ['ids', 'id'], part_references: { pointer: { path: ['target'], prefix: 'catalogue:', absolute_prefix: 'row:' } } }] };
  assert.deepEqual(declarationIndexesOf(data), [{ type: 'catalogue', name: '__model_declaration', paths: [['holds']], backfill: '__model_declaration' }]);
  const model = recordModel(data);
  model.declare('catalogue', 'catalogue:source', { holds: 'samples', fields: [
    { name: 'known', shape: 'pointer', target: 'other-name' }, { name: 'unknown', shape: 'pointer', target: 'absent' }, { name: 'media', shape: 'file' },
  ] });
  model.declare('catalogue', 'catalogue:other-name', { holds: 'different-row-type', fields: [] });
  const kind = model.kindOf('row:samples', { resolved_only: true });
  assert.deepEqual(kind.unresolved_declarations, ['catalogue:absent']);
  assert.deepEqual(partsOf(kind, { known: ['local'], unknown: ['local'], media: FILE }).map(part => [part.role, part.id]),
    [['known', 'row:different-row-type:local'], ['media', FILE]]);
  assert.ok(!partsOf(kind, { unknown: ['local'] }).some(part => part.id === 'local'));
  assert.deepEqual(partsOf(kind, { unknown: ['local', 'row:retained:one', 'local2', 'row:retained:one'] }), [
    { role: 'unknown', id: 'row:retained:one', ordinal: 1 },
    { role: 'unknown', id: 'row:retained:one', ordinal: 3 },
  ], 'an unavailable target declaration does not erase already absolute addresses or their occurrences');
});

test('unresolved caller additions cannot hide a shipped participation role', () => {
  const model = recordModel({ kinds: [{ type: 'row:samples', parts: [{ role: 'known', path: ['absolute'] }] }],
    declared_by: [{ type: 'catalogue', kind: { path: ['holds'], prefix: 'row:' },
      properties: { path: ['fields'], name: ['name'], kind: ['shape'] }, parts_when: ['ids'],
      part_references: { ids: { path: ['target'], prefix: 'catalogue:' } } }] });
  model.declare('catalogue', 'catalogue:source', { holds: 'samples', fields: [{ name: 'known', shape: 'ids', target: 'missing' }] });
  const kind = model.kindOf('row:samples', { resolved_only: true });
  assert.equal(kind.unresolved_declarations, undefined);
  assert.deepEqual(partsOf(kind, { absolute: ['row:actual:one'], known: ['unresolved'] }).map(part => part.id), ['row:actual:one']);
});
