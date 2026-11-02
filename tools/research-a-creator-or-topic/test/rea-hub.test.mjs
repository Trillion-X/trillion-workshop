// tool:keep-a-reverse-engineered-thing against the stand-in records door, with exactly the rights of the row.
// Every thing, handle and address here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { exampleProblems, keepAReverseEngineeredThing as keep, readReaHub, readReaHubExamples } from '../do-work/rea-hub.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const row = rows.find(payload => payload.id === 'tool:keep-a-reverse-engineered-thing');
const hub = readReaHub();
const examples = readReaHubExamples();
const NOW = '2026-11-02T10:30:00Z';

const withDoor = async (records, body) => {
  const door = await startFakeDoor({ rights: row.invoke.records.rights, mostWrites: row.invoke.records.most_writes, records });
  try { return await body(door, { door: openRecordsDoor({ descriptor: door.descriptor }) }); } finally { await door.close(); }
};
const submission = (changes = {}) => ({
  thing: 'Checkout of a made-up bike shop', kind: 'site', notes: 'Seen: one page, card first, address after. Inferred: the order cuts drop-off.',
  urls: ['https://bike-shop.example/checkout'], artifacts: [{ label: 'Flow', url: 'https://rea-hub.example/artifacts/bike-checkout' }],
  licence: 'CC-BY-4.0', submitted_by: 'sample-maker-9', ...changes,
});

test('the row and the definition agree: its rights are the hub\'s record type, and it packs the files the module reads', () => {
  assert.deepEqual(row.invoke.records.rights.map(right => [right.kind, right.prefix]), [[hub.records.type, hub.records.id_start]]);
  assert.equal(row.invoke.records.most_writes, hub.records.writes_at_most);
  assert.deepEqual(row.input_schema.properties.action.enum, ['fields', 'create', 'read', 'edit', 'delete', 'seed']);
  const packed = row.invoke.files.package_files.find(spec => spec.package === 'research-a-creator-or-topic').paths;
  for (const file of ['do-work/rea-hub.mjs', 'do-work/rea-hub.json', 'do-work/rea-hub-examples.json']) assert.ok(packed.includes(file), file);
  for (const id of hub.filter_by) assert.ok(hub.fields.some(field => field.id === id), `filter_by ${id} is a field`);
});

test('the seed rows are synthetic and valid: reserved .example addresses and made-up handles only', () => {
  assert.deepEqual(exampleProblems(), []);
  assert.ok(examples.rows.length >= 3);
  for (const example of examples.rows) {
    const addresses = [...example.urls, ...(example.artifacts ?? []).map(artifact => artifact.url)];
    for (const address of addresses) assert.match(new URL(address).hostname, /\.example$/, `${example.key}: ${address}`);
    assert.match(example.submitted_by, /^sample-/);
  }
});

test('create, read, edit and delete one submission, with the hub\'s own stamps', async () => {
  await withDoor([], async (_door, context) => {
    const made = await keep({ action: 'create', fields: submission(), now: NOW }, context);
    assert.equal(made.key, 'checkout-of-a-made-up-bike-shop');
    assert.equal(made.row_id, 'record:rea-hub:checkout-of-a-made-up-bike-shop');
    assert.equal(made.row.status, 'submitted');
    assert.equal(made.row.submitted_at, NOW);
    await assert.rejects(keep({ action: 'create', fields: submission() }, context), /already kept under checkout-of-a-made-up-bike-shop/);

    const read = await keep({ action: 'read', key: made.key }, context);
    assert.equal(read.found, true);
    assert.equal(read.row.thing, 'Checkout of a made-up bike shop');

    const later = '2026-11-02T12:00:00Z';
    const edited = await keep({ action: 'edit', key: made.key, fields: { status: 'published', tags: ['checkout'], artifacts: null }, now: later }, context);
    assert.deepEqual(edited.changed, ['status', 'tags', 'artifacts']);
    const held = (await keep({ action: 'read', key: made.key }, context)).row;
    assert.equal(held.status, 'published');
    assert.deepEqual(held.tags, ['checkout']);
    assert.ok(!('artifacts' in held), 'null removes an optional field');
    assert.equal(held.submitted_at, NOW);
    assert.equal(held.updated_at, later);

    assert.deepEqual(await keep({ action: 'delete', key: made.key }, context), { action: 'delete', key: made.key, row_id: made.row_id, deleted: true });
    assert.equal((await keep({ action: 'read', key: made.key }, context)).found, false);
    assert.equal((await keep({ action: 'delete', key: made.key }, context)).deleted, false);
  });
});

test('seed writes the examples once, and a page of rows can be narrowed by a filter field', async () => {
  await withDoor([], async (_door, context) => {
    const first = await keep({ action: 'seed', now: NOW }, context);
    assert.equal(first.written, examples.rows.length);
    const again = await keep({ action: 'seed', now: NOW }, context);
    assert.equal(again.written, 0);
    assert.equal(again.already_held.length, examples.rows.length);
    const all = await keep({ action: 'read' }, context);
    assert.equal(all.count, examples.rows.length);
    const launches = await keep({ action: 'read', where: { kind: 'launch' } }, context);
    assert.deepEqual(launches.rows.map(found => found.key), examples.rows.filter(example => example.kind === 'launch').map(example => example.key));
    assert.equal((await keep({ action: 'read', limit: 2 }, context)).count, 2);
    await assert.rejects(keep({ action: 'read', where: { notes: 'x' } }, context), /narrowed only by kind, licence, status, found_by/);
  });
});

test('refusals name every problem and what to send', async () => {
  await withDoor([], async (_door, context) => {
    await assert.rejects(keep({ action: 'create', fields: { thing: 'x' } }, context), /Send kind, notes, urls, licence, submitted_by/);
    await assert.rejects(keep({ action: 'create', fields: submission({ kind: 'spaceship', licence: 'mine', urls: ['ftp://x.example'] }) }, context),
      error => /kind is one of product/.test(error.message) && /licence is one of CC0-1.0/.test(error.message) && /urls\[0\] is not an http or https address/.test(error.message));
    await assert.rejects(keep({ action: 'create', fields: submission({ artifacts: [{ label: 'a' }] }) }, context), /artifacts\[0\] needs url/);
    await assert.rejects(keep({ action: 'create', fields: submission({ submitted_at: NOW }) }, context), /written by the hub on create/);
    await assert.rejects(keep({ action: 'create', fields: submission({ colour: 'red' }) }, context), /colour is not a field of the hub/);
    await assert.rejects(keep({ action: 'edit', key: 'nope', fields: { notes: 'n' } }, context), /No row is kept under nope/);
    await assert.rejects(keep({ action: 'edit', key: 'nope', fields: { notes: null } }, context), /notes is required and cannot be removed/);
    await assert.rejects(keep({ action: 'edit', fields: { notes: 'n' } }, context), /Send key/);
    await assert.rejects(keep({ action: 'launch' }, context), /action is fields, create, read, edit, delete or seed/);
  });
});

test('the hub is data: a field, a kind or a licence added only in a copy of the definition is accepted', async () => {
  const changed = structuredClone(hub);
  changed.kinds.push('browser-extension');
  changed.licences.push('MPL-2.0');
  changed.fields.push({ id: 'effort_hours', label: 'Hours spent', kind: 'words', least: 0, most: 1 });
  const described = await keep({ action: 'fields' }, { door: null }, changed);
  assert.ok(described.fields.find(field => field.id === 'kind').choices.includes('browser-extension'));
  await withDoor([], async (_door, context) => {
    const made = await keep({ action: 'create', key: 'ext', fields: submission({ kind: 'browser-extension', licence: 'MPL-2.0', effort_hours: ['3'] }), now: NOW }, context, changed);
    assert.equal(made.row.kind, 'browser-extension');
    await assert.rejects(keep({ action: 'create', key: 'ext2', fields: submission({ kind: 'browser-extension' }) }, context), /kind is one of/);
  });
});
