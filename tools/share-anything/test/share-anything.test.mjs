// tools/share-anything/test/share-anything.test.mjs
//
// The one sharing tool over a stand-in records door (tools/records-door/test/fake-door.mjs) that holds exactly the rights the row
// grants: a list shared read-only with a named person and an AI by a key each, the link, a text, a collection, who has access, and
// stop. Every record is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { shareAnything } from '../do-work/share-anything.mjs';
import { grantOf, labelOf } from '../read-data/share-label.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const digest = key => makeHashCodeHexFromBytes(new TextEncoder().encode(key)).slice(3);
const list = { label: 'Sample list', row_type: 'sample-row', fields: [{ id: 'title', label: 'Title' }] };

// The run's rights as the row declares them, with the one label the caller names filled in.
const rightsFor = grant => rows.records[0].payload.invoke.records.rights.map(right => ({
  ...right, ...(right.id && typeof right.id === 'object' ? { id: grant } : {}),
}));

async function run(grant, records = [], workspaceRecords = {}) {
  const door = await startFakeDoor({ rights: rightsFor(grant), records, workspaceRecords });
  const records_door = openRecordsDoor({ descriptor: door.descriptor });
  return { door, records_door, workspaceRecords };
}

test('a list is shared read-only with a person and an AI, each with a key of its own that only its BLAKE3 is kept for', async () => {
  const thing = { list: 'sample' };
  const grant = grantOf(thing);
  assert.equal(grant, 'sharing:list:sample');
  const { door, records_door, workspaceRecords } = await run(grant, [{ id: 'list:sample', type: 'list', value: list }]);
  try {
    const answer = await shareAnything({ op: 'share', grant, thing, with: ['sample-person', { principal: 'sample-ai' }], link: true, origin: 'https://example.invalid/', until: '2999-01-01T00:00:00.000Z' }, { door: records_door });
    assert.deepEqual(answer.reach, [{ type: 'list', id: 'list:sample' }, { type: 'record:sample-row' }]);
    assert.equal(answer.title, 'Sample list');
    assert.deepEqual(answer.people.map(person => person.principal), ['sample-person', 'sample-ai']);
    const keys = [...answer.people.map(person => person.key), answer.link.key];
    assert.equal(new Set(keys).size, 3);
    for (const key of keys) assert.match(key, /^shr_[A-Za-z0-9_-]{43}$/);
    assert.equal(answer.people[0].url, `https://example.invalid/share/${answer.people[0].key}`);
    const kept = workspaceRecords[grant];
    assert.deepEqual(kept.people.map(person => person.key_blake3).sort(), keys.map(digest).sort());
    assert.deepEqual(kept.can, ['view']);
    assert.equal(kept.expires_at, '2999-01-01T00:00:00.000Z');
    assert.equal(JSON.stringify(kept).includes('shr_'), false, 'no key is in the record');
    assert.equal(JSON.stringify(answer.said).includes('shr_'), false, 'no key is in the said words');
    // Who has access: people and the link, never a key.
    const seen = await shareAnything({ op: 'access', grant }, { door: records_door });
    assert.equal(seen.state, 'open');
    assert.deepEqual(seen.people.map(person => person.principal), ['sample-person', 'sample-ai']);
    assert.deepEqual(seen.link.on, true);
    assert.equal(JSON.stringify(seen).includes('shr_'), false);
  } finally { await door.close(); }
});

test('sharing again with someone it is already shared with is refused, and a different person is added beside them', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:one' };
  const grant = grantOf(thing);
  const { door, records_door, workspaceRecords } = await run(grant);
  try {
    await shareAnything({ op: 'share', grant, thing, with: ['first'] }, { door: records_door });
    await assert.rejects(() => shareAnything({ op: 'share', grant, thing, with: ['first'] }, { door: records_door }), /already shared with first/);
    await shareAnything({ op: 'share', grant, thing, with: ['second'] }, { door: records_door });
    assert.deepEqual(workspaceRecords[grant].people.map(person => person.principal), ['first', 'second']);
    assert.deepEqual(workspaceRecords[grant].reach, [{ type: 'sample-note', id: 'sample-note:one' }]);
  } finally { await door.close(); }
});

test('stopping one person leaves the others and stopping everyone empties the share and marks it stopped', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:two' };
  const grant = grantOf(thing);
  const { door, records_door, workspaceRecords } = await run(grant);
  try {
    await shareAnything({ op: 'share', grant, thing, with: ['first', 'second'], link: true }, { door: records_door, now: undefined });
    const one = await shareAnything({ op: 'stop', grant, principal: 'first' }, { door: records_door });
    assert.deepEqual(one.removed, ['first']);
    assert.deepEqual(workspaceRecords[grant].people.map(person => person.principal), ['second', 'link']);
    await assert.rejects(() => shareAnything({ op: 'stop', grant, principal: 'first' }, { door: records_door }), /not shared with first/);
    const link = await shareAnything({ op: 'stop', grant, principal: 'link' }, { door: records_door });
    assert.match(link.said, /the link/);
    const all = await shareAnything({ op: 'stop', grant, now: '2026-01-01T00:00:00.000Z' }, { door: records_door });
    assert.deepEqual(all.removed, ['second']);
    assert.deepEqual(workspaceRecords[grant].people, []);
    assert.equal(workspaceRecords[grant].revoked_at, '2026-01-01T00:00:00.000Z');
    const seen = await shareAnything({ op: 'access', grant }, { door: records_door });
    assert.equal(seen.state, 'stopped');
    // Sharing again opens it again, with a new key.
    await shareAnything({ op: 'share', grant, thing, with: ['first'] }, { door: records_door });
    assert.equal(workspaceRecords[grant].revoked_at, null);
    assert.deepEqual(workspaceRecords[grant].people.map(person => person.principal), ['first']);
  } finally { await door.close(); }
});

test('a share past its end reads as ended, and an end in the past is refused', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:three' };
  const grant = grantOf(thing);
  const { door, records_door } = await run(grant);
  try {
    await assert.rejects(() => shareAnything({ op: 'share', grant, thing, with: ['first'], until: '2000-01-01T00:00:00.000Z' }, { door: records_door }), /future time/);
    await shareAnything({ op: 'share', grant, thing, with: ['first'], until: '2999-01-01T00:00:00.000Z' }, { door: records_door });
    const seen = await shareAnything({ op: 'access', grant, now: '3000-01-01T00:00:00.000Z' }, { door: records_door });
    assert.equal(seen.state, 'ended');
  } finally { await door.close(); }
});

test('a text is kept as its own record before it is shared, and a collection reaches exactly the items it names', async () => {
  const textThing = { text: 'A sample line.\nAnother.', title: 'Sample note' };
  const textGrant = grantOf(textThing);
  assert.match(textGrant, /^sharing:text:[0-9a-f]{24}$/);
  const { door, records_door, workspaceRecords } = await run(textGrant);
  try {
    const answer = await shareAnything({ op: 'share', grant: textGrant, thing: textThing, link: true }, { door: records_door });
    assert.equal(answer.reach.length, 1);
    assert.equal(answer.reach[0].type, 'shared-text');
    assert.match(answer.reach[0].id, /^shared-text:/);
    assert.equal(answer.title, 'Sample note');
    const kept = door.kept.get(answer.reach[0].id);
    assert.equal(kept.type, 'shared-text');
    assert.deepEqual(kept.value, { title: 'Sample note', text: 'A sample line.\nAnother.' });
    assert.equal(workspaceRecords[textGrant].people[0].principal, 'link');
  } finally { await door.close(); }
  const items = { title: 'Sample Set!', items: [{ type: 'sample-a', id: 'a1' }, { type: 'sample-b', prefix: 'b:' }, { type: 'sample-c' }] };
  const grant = grantOf(items);
  assert.match(grant, /^sharing:collection:sample-set-[0-9a-f]{12}$/);
  const second = await run(grant);
  try {
    const answer = await shareAnything({ op: 'share', grant, thing: items, with: ['first'] }, { door: second.records_door });
    assert.deepEqual(answer.reach, items.items);
    assert.equal(second.workspaceRecords[grant].title, 'Sample Set!');
  } finally { await second.door.close(); }
});

test('the tool refuses what it should: a wrong grant, a share that is not view only, a bad thing, nobody to share with, a no-such list', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:four' };
  const grant = grantOf(thing);
  const { door, records_door, workspaceRecords } = await run(grant);
  try {
    await assert.rejects(() => shareAnything({ op: 'share', grant: 'sharing:other', thing, with: ['first'] }, { door: records_door }), /grant is where this share is kept: sharing:sample-note:four/);
    await assert.rejects(() => shareAnything({ op: 'share', grant, thing, with: ['first'], can: ['view', 'edit'] }, { door: records_door }), /only lets people view/);
    await assert.rejects(() => shareAnything({ op: 'share', grant, thing, with: [] }, { door: records_door }), /Name who to share with/);
    await assert.rejects(() => shareAnything({ op: 'share', grant, thing: { type: 'x', id: 'a/b' }, with: ['first'] }, { door: records_door }), /thing is one of/);
    await assert.rejects(() => shareAnything({ op: 'share', grant, thing, with: ['link'] }, { door: records_door }), /the name link is the link's/);
    await assert.rejects(() => shareAnything({ op: 'share', grant, thing, with: ['first'], origin: 'http://example.invalid' }, { door: records_door }), /https/);
    await assert.rejects(() => shareAnything({ op: 'nothing' }, { door: records_door }), /op is share, stop or access/);
    await assert.rejects(() => shareAnything({ op: 'stop', grant }, { door: records_door }), /Nothing is shared/);
    assert.deepEqual(workspaceRecords, {});
    const noList = { list: 'missing' };
    const missingGrant = grantOf(noList);
    const another = await run(missingGrant);
    try { await assert.rejects(() => shareAnything({ op: 'share', grant: missingGrant, thing: noList, with: ['first'] }, { door: another.records_door }), /No list missing/); }
    finally { await another.door.close(); }
  } finally { await door.close(); }
});

test('the run is granted exactly one workspace label, and never a record it shares', async () => {
  const thing = { type: 'sample-note', id: 'sample-note:five' };
  const grant = grantOf(thing);
  const { door, records_door } = await run(grant);
  try {
    await assert.rejects(() => records_door.readWorkspace(['sharing:another']), /may not reach/);
    await assert.rejects(() => records_door.read('sample-note', 'sample-note:five'), /may not reach/);
    await assert.rejects(() => records_door.writeWorkspace([{ address_label: 'sharing:another', payload: {} }]), /may not reach/);
  } finally { await door.close(); }
  assert.equal(labelOf({ list: 'list:sample' }), 'list:sample');
});

test('the row declares the rights this tool needs and nothing wider', () => {
  const [row] = rows.records;
  const rights = row.payload.invoke.records.rights;
  assert.deepEqual(rights.map(right => right.kind), ['@own-records', 'list', 'shared-text']);
  assert.deepEqual(rights[0].operations, ['workspace:read', 'workspace:write']);
  assert.deepEqual(rights[0].id, { fill: { from: 'input', field: 'grant' } });
  assert.deepEqual(rights[1], { kind: 'list', prefix: 'list:', operations: ['records:read'] });
  assert.deepEqual(rights[2], { kind: 'shared-text', prefix: 'shared-text:', operations: ['records:write'] });
});
