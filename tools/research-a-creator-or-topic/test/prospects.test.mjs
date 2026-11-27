// tool:brief-a-prospect and tool:keep-a-prospect take the held row in the request and answer the row to keep as `keep`,
// with the row as it was handed in as its `expected`. Every prospect, address and word here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { briefAProspect, keepAProspect, readProspectList } from '../do-work/prospects.mjs';

const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const keepRow = rows.find(payload => payload.id === 'tool:keep-a-prospect');
const briefRow = rows.find(payload => payload.id === 'tool:brief-a-prospect');
const list = readProspectList();
const TYPE = list.records.type;
const POST = 'Operations lead wanted. Day to day: chase late deliveries by phone. Quotes are built by hand in a spreadsheet.';

const profile = (changes = {}) => ({
  profile: 'A small delivery firm that fits the criteria: it is hiring for the work it struggles with.',
  problems: [
    { problem: 'Late deliveries are chased by hand', basis: 'stated', evidence: 'chase late deliveries by phone' },
    { problem: 'Pricing is slow', basis: 'inferred', evidence: 'quotes are built by hand, so each one takes a person time' },
  ],
  triggers: [], case_study: '', channels: [], ...changes,
});

test('the brief puts the prospect instruction before the material and names the fields the profile holds', () => {
  const made = briefAProspect({ key: 'cedar-freight.example', name: 'Cedar Freight', criteria: ['10 to 200 people', 'role open for weeks'], material: POST });
  assert.equal(made.row_id, 'record:prospects:cedar-freight.example');
  assert.equal(made.profile_ref, 'prospect:cedar-freight.example');
  assert.deepEqual(Object.keys(made.profile_shape), ['profile', 'problems', 'triggers', 'case_study', 'channels']);
  const text = made.requests[0].instruction_text;
  assert.match(text, /^Write a research profile of the prospect Cedar Freight \(cedar-freight\.example\)/);
  assert.match(text, /10 to 200 people; role open for weeks/);
  assert.match(text, /Never invent a customer/);
  assert.ok(text.endsWith(`Material:\n${POST}`));
  assert.equal(made.requests[0].output_kind, 'prospect-profile');
});

test('the brief refuses a request with no key, no criteria or nothing to profile, and says what to send', () => {
  assert.throws(() => briefAProspect({ criteria: 'x', material: POST }), /Send key/);
  assert.throws(() => briefAProspect({ key: 'a/b', criteria: 'x', material: POST }), /may not hold a \//);
  assert.throws(() => briefAProspect({ key: 'a', material: POST }), /Send criteria/);
  assert.throws(() => briefAProspect({ key: 'a', criteria: ['  '], material: POST }), /Send criteria/);
  assert.throws(() => briefAProspect({ key: 'a', criteria: 'x' }), /nothing to profile/);
});

test('the instruction is data: a changed instruction row changes the brief with no code change', () => {
  const changed = { ...list, instruction: ['Only look for {criteria} at {name} ({address}). Fields: {fields}.', 'Material:', ''] };
  const text = briefAProspect({ key: 'k', criteria: 'big budgets', material: 'words' }, changed).requests[0].instruction_text;
  assert.match(text, /^Only look for big budgets at k \(k\)\. Fields: profile \(text:/);
});

test('keep answers a found prospect, then the research over the same row, leaving the fields kept by hand', () => {
  const found = { name: 'Cedar Freight', url: 'https://cedar-freight.example', place: 'Springfield', source: 'open-job-posts', size: 40, score: 6, signals: [{ id: 'open-21-days', says: 'The role has been open for 24 days' }] };
  const first = keepAProspect({ key: 'cedar-freight.example', found });
  assert.deepEqual([first.action, first.key, first.row_id, first.created], ['keep', 'cedar-freight.example', 'record:prospects:cedar-freight.example', true]);
  assert.deepEqual([first.keep[0].id, first.keep[0].type, first.keep[0].value.status], ['record:prospects:cedar-freight.example', TYPE, 'found']);
  assert.equal(first.keep[0].expected, null, 'a new prospect expects no row');
  const marked = keepAProspect({ action: 'mark', key: 'cedar-freight.example', notes: 'met at a trade fair', held: first.keep[0].value });
  const second = keepAProspect({ key: 'cedar-freight.example', profile: profile(), material: POST, now: '2026-11-01', held: marked.keep[0].value });
  assert.equal(second.created, false);
  assert.deepEqual(second.keep[0].expected, { type: TYPE, value: marked.keep[0].value }, 'the keep expects the row as it was handed in');
  const kept = second.keep[0].value;
  assert.equal(kept.name, 'Cedar Freight');
  assert.equal(kept.notes, 'met at a trade fair');
  assert.equal(kept.status, 'researched');
  assert.equal(kept.researched_at, '2026-11-01');
  assert.equal(kept.problems.length, 2);
  assert.equal(kept.size, 40);
  assert.equal(second.written, undefined, 'nothing is written');
});

test('keep leaves a later status alone and the first research of a new prospect starts at researched', () => {
  assert.equal(keepAProspect({ key: 'held.example', profile: profile(), now: '2026-11-01', held: { status: 'contacted', name: 'Held' } }).keep[0].value.status, 'contacted');
  assert.equal(keepAProspect({ key: 'fresh.example', profile: profile(), now: '2026-11-01' }).keep[0].value.status, 'researched');
});

test('keep refuses what the list definition does not allow, each problem named', () => {
  const refuses = (input, words) => assert.throws(() => keepAProspect({ key: 'k.example', ...input }), words);
  refuses({}, /nothing to keep/);
  refuses({ profile: { ...profile(), problems: [] } }, /problems holds 1 to 3 entries, not 0/);
  refuses({ profile: { ...profile(), problems: Array(4).fill({ problem: 'x', basis: 'inferred', evidence: 'y' }) } }, /not 4/);
  refuses({ profile: { ...profile(), problems: [{ problem: 'x', basis: 'guess', evidence: 'y' }] } }, /basis is "stated" or "inferred"/);
  refuses({ profile: { ...profile(), problems: [{ problem: 'x', basis: 'stated' }] } }, /needs evidence/);
  refuses({ profile: { profile: 'only words' } }, /profile needs problems/);
  refuses({ profile: { ...profile(), status: 'won' } }, /profile\.status is not a field a research fills/);
  refuses({ found: { notes: 'x' } }, /found\.notes is not a field a finder fills/);
  refuses({ found: { size: 'big' } }, /found\.size is a number/);
  refuses({ profile: { ...profile(), problems: 'late' } }, /problems is a list of objects/);
  refuses({ found: { name: 'x' }, held: 'nope' }, /held is the prospect row you already hold/);
});

test('a stated quotation that is not in the material is refused, an inferred one is not', () => {
  const invented = profile({ problems: [{ problem: 'Staff turnover', basis: 'stated', evidence: 'we lose a driver every month' }] });
  assert.throws(() => keepAProspect({ key: 'k.example', profile: invented, material: POST }), /stated but its evidence is not in the material/);
  const spaced = profile({ problems: [{ problem: 'Hand quotes', basis: 'stated', evidence: 'Quotes are built   BY HAND in a spreadsheet' }] });
  assert.equal(keepAProspect({ key: 'k.example', profile: spaced, material: POST }).keep[0].value.problems.length, 1);
});

test('mark answers a listed status and notes over the held row, and refuses an unknown status or a prospect not held', () => {
  const held = { name: 'M', status: 'found' };
  const marked = keepAProspect({ action: 'mark', key: 'm.example', status: 'drafted', held });
  assert.deepEqual(marked.keep, [{ id: 'record:prospects:m.example', type: TYPE, value: { name: 'M', status: 'drafted' }, expected: { type: TYPE, value: held } }]);
  assert.throws(() => keepAProspect({ action: 'mark', key: 'm.example', status: 'maybe', held }), /status is one of found, researched/);
  assert.throws(() => keepAProspect({ action: 'mark', key: 'gone.example', status: 'lost' }), /No prospect is held under gone\.example/);
  assert.throws(() => keepAProspect({ action: 'mark', key: 'm.example', held }), /Send status or notes/);
});

test('read and remove are not the tool\'s: a store\'s own tools read and remove rows', () => {
  assert.throws(() => keepAProspect({ action: 'read', key: 'b.example' }), /action is keep or mark/);
  assert.throws(() => keepAProspect({ action: 'remove', key: 'b.example' }), /action is keep or mark/);
});

test('the row runs the function runner, mounts no records door and answers the row to keep', () => {
  assert.equal(keepRow.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.ok(!JSON.stringify(keepRow).includes('records-door'));
  assert.deepEqual(keepRow.input_schema.properties.action.enum, ['keep', 'mark']);
  assert.ok(keepRow.output_schema.required.includes('keep'));
});

test('the list definition agrees with itself: every research field the brief asks for is a field, entries name their keys', () => {
  const ids = new Set(list.fields.map(field => field.id));
  assert.equal(ids.size, list.fields.length);
  for (const field of list.fields) {
    assert.ok(['finder', 'research', 'person'].includes(field.filled_by), field.id);
    if (field.kind === 'entries') assert.ok(field.entry_keys.length > 0, field.id);
    if (field.filled_by === 'research' && field.id !== 'researched_at') assert.ok(field.says, `${field.id} says what it holds`);
  }
  assert.ok(list.statuses.includes('found') && list.statuses.includes('researched'));
  assert.equal(briefRow.verify[0].contains.split('\n')[0], 'Material:');
});
