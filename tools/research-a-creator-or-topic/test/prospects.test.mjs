// tool:brief-a-prospect and tool:keep-a-prospect against the stand-in records door, with exactly the rights of the row.
// Every prospect, address and word here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { briefAProspect, keepAProspect, readProspectList } from '../do-work/prospects.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const keepRow = rows.find(payload => payload.id === 'tool:keep-a-prospect');
const briefRow = rows.find(payload => payload.id === 'tool:brief-a-prospect');
const list = readProspectList();
const TYPE = list.records.type;
const POST = 'Operations lead wanted. Day to day: chase late deliveries by phone. Quotes are built by hand in a spreadsheet.';

const withDoor = async (records, body) => {
  const door = await startFakeDoor({ rights: keepRow.invoke.records.rights, mostWrites: keepRow.invoke.records.most_writes, records });
  try { return await body(door, { door: openRecordsDoor({ descriptor: door.descriptor }) }); } finally { await door.close(); }
};
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

test('keep writes a found prospect, then the research over the same row, leaving the fields kept by hand', async () => {
  await withDoor([], async (door, context) => {
    const found = { name: 'Cedar Freight', url: 'https://cedar-freight.example', place: 'Springfield', source: 'open-job-posts', size: 40, score: 6, signals: [{ id: 'open-21-days', says: 'The role has been open for 24 days' }] };
    assert.deepEqual(await keepAProspect({ key: 'cedar-freight.example', found }, context), { action: 'keep', key: 'cedar-freight.example', row_id: 'record:prospects:cedar-freight.example', written: 1, created: true });
    assert.equal(door.kept.get('record:prospects:cedar-freight.example').value.status, 'found');
    await keepAProspect({ action: 'mark', key: 'cedar-freight.example', notes: 'met at a trade fair' }, context);
    const second = await keepAProspect({ key: 'cedar-freight.example', profile: profile(), material: POST, now: '2026-11-01' }, context);
    assert.equal(second.created, false);
    const kept = door.kept.get('record:prospects:cedar-freight.example').value;
    assert.equal(kept.name, 'Cedar Freight');
    assert.equal(kept.notes, 'met at a trade fair');
    assert.equal(kept.status, 'researched');
    assert.equal(kept.researched_at, '2026-11-01');
    assert.equal(kept.problems.length, 2);
    assert.equal(kept.size, 40);
  });
});

test('keep leaves a later status alone and the first research of a new prospect starts at researched', async () => {
  await withDoor([{ id: 'record:prospects:held.example', type: TYPE, value: { status: 'contacted', name: 'Held' } }], async (door, context) => {
    await keepAProspect({ key: 'held.example', profile: profile(), now: '2026-11-01' }, context);
    assert.equal(door.kept.get('record:prospects:held.example').value.status, 'contacted');
    await keepAProspect({ key: 'fresh.example', profile: profile(), now: '2026-11-01' }, context);
    assert.equal(door.kept.get('record:prospects:fresh.example').value.status, 'researched');
  });
});

test('keep refuses what the list definition does not allow, each problem named', async () => {
  await withDoor([], async (door, context) => {
    const refuses = (input, words) => assert.rejects(keepAProspect({ key: 'k.example', ...input }, context), words);
    await refuses({}, /nothing to keep/);
    await refuses({ profile: { ...profile(), problems: [] } }, /problems holds 1 to 3 entries, not 0/);
    await refuses({ profile: { ...profile(), problems: Array(4).fill({ problem: 'x', basis: 'inferred', evidence: 'y' }) } }, /not 4/);
    await refuses({ profile: { ...profile(), problems: [{ problem: 'x', basis: 'guess', evidence: 'y' }] } }, /basis is "stated" or "inferred"/);
    await refuses({ profile: { ...profile(), problems: [{ problem: 'x', basis: 'stated' }] } }, /needs evidence/);
    await refuses({ profile: { profile: 'only words' } }, /profile needs problems/);
    await refuses({ profile: { ...profile(), status: 'won' } }, /profile\.status is not a field a research fills/);
    await refuses({ found: { notes: 'x' } }, /found\.notes is not a field a finder fills/);
    await refuses({ found: { size: 'big' } }, /found\.size is a number/);
    await refuses({ profile: { ...profile(), problems: 'late' } }, /problems is a list of objects/);
    assert.equal(door.kept.size, 0);
  });
});

test('a stated quotation that is not in the material is refused, an inferred one is not', async () => {
  await withDoor([], async (door, context) => {
    const invented = profile({ problems: [{ problem: 'Staff turnover', basis: 'stated', evidence: 'we lose a driver every month' }] });
    await assert.rejects(keepAProspect({ key: 'k.example', profile: invented, material: POST }, context), /stated but its evidence is not in the material/);
    const spaced = profile({ problems: [{ problem: 'Hand quotes', basis: 'stated', evidence: 'Quotes are built   BY HAND in a spreadsheet' }] });
    await keepAProspect({ key: 'k.example', profile: spaced, material: POST }, context);
    assert.equal(door.kept.size, 1);
  });
});

test('mark sets a listed status and notes, and refuses an unknown status or a prospect that is not kept', async () => {
  await withDoor([{ id: 'record:prospects:m.example', type: TYPE, value: { name: 'M', status: 'found' } }], async (door, context) => {
    await keepAProspect({ action: 'mark', key: 'm.example', status: 'drafted' }, context);
    assert.equal(door.kept.get('record:prospects:m.example').value.status, 'drafted');
    assert.equal(door.kept.get('record:prospects:m.example').value.name, 'M');
    await assert.rejects(keepAProspect({ action: 'mark', key: 'm.example', status: 'maybe' }, context), /status is one of found, researched/);
    await assert.rejects(keepAProspect({ action: 'mark', key: 'gone.example', status: 'lost' }, context), /No prospect is kept under gone\.example/);
    await assert.rejects(keepAProspect({ action: 'mark', key: 'm.example' }, context), /Send status or notes/);
  });
});

test('read answers one row by key, or a page of rows of one status', async () => {
  const held = [
    { id: 'record:prospects:a.example', type: TYPE, value: { name: 'A', status: 'found' } },
    { id: 'record:prospects:b.example', type: TYPE, value: { name: 'B', status: 'contacted' } },
    { id: 'record:prospects:c.example', type: TYPE, value: { name: 'C', status: 'found' } },
  ];
  await withDoor(held, async (door, context) => {
    assert.deepEqual(await keepAProspect({ action: 'read', key: 'b.example' }, context), { action: 'read', key: 'b.example', row: { name: 'B', status: 'contacted' }, found: true });
    assert.deepEqual(await keepAProspect({ action: 'read', key: 'nobody.example' }, context), { action: 'read', key: 'nobody.example', row: null, found: false });
    const all = await keepAProspect({ action: 'read' }, context);
    assert.deepEqual(all.rows.map(row => row.key).sort(), ['a.example', 'b.example', 'c.example']);
    const found = await keepAProspect({ action: 'read', status: 'found' }, context);
    assert.deepEqual(found.rows.map(row => row.key).sort(), ['a.example', 'c.example']);
    assert.equal((await keepAProspect({ action: 'read', limit: 1 }, context)).count, 1);
    await assert.rejects(keepAProspect({ action: 'read', status: 'maybe' }, context), /status is one of/);
  });
});

test('remove deletes one row and says when there was nothing to remove', async () => {
  await withDoor([{ id: 'record:prospects:r.example', type: TYPE, value: { name: 'R' } }], async (door, context) => {
    assert.equal((await keepAProspect({ action: 'remove', key: 'r.example' }, context)).removed, true);
    assert.equal(door.kept.has('record:prospects:r.example'), false);
    assert.equal((await keepAProspect({ action: 'remove', key: 'r.example' }, context)).removed, false);
  });
});

test('an unknown action is refused, and the row grants the door only the prospect list', async () => {
  await withDoor([], async (door, context) => {
    await assert.rejects(keepAProspect({ action: 'send', key: 'k' }, context), /action is keep, mark, read or remove/);
  });
  assert.deepEqual(keepRow.invoke.records.rights.map(right => right.prefix), [list.records.id_start]);
  assert.equal(keepRow.invoke.records.most_writes, list.records.writes_at_most);
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
