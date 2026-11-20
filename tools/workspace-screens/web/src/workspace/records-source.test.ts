// The records seam, read without the engine: the memory and seeded sources answer with no network, a write is seen by the
// next read, a stale write is refused, the outbox confirms later, and the engine names no server. (The engine itself is
// tested in a browser: test/records-default-worker.test.mjs and the standalone example's check.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from './content-identity.mjs';
import { memoryRecordsSource, remoteRecordsSource, seededRecordsSource, type RecordsReceipt } from './records-source.ts';

const identityOf = (value: unknown) => makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(value)));
const SIDEBAR_LABEL = 'placeable-surface-list::main-workspace';
const LAYOUT_LABEL = 'screen-arrangement-layout-state';
const SEED_ENTRIES = [
  { id: 'courses', label: 'Courses', screen: 'courses' },
  { id: 'community', label: 'Community', screen: 'community' },
  { id: 'refer', label: 'Refer a friend', screen: 'refer-a-friend' },
];

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a memory source answers only the labels it holds, and a write is seen by the next read', async () => {
  const source = memoryRecordsSource();
  assert.deepEqual(await source.read(['a', 'b']), { records: {} });
  assert.deepEqual(await source.write({ writes: [{ address_label: 'a', payload: 1 }] }), { written: 1 });
  assert.deepEqual(await source.read(['a', 'b']), { records: { a: 1 } });
});

test('a seeded source starts from the rows the page gives it and keeps a change in its own memory', async () => {
  const source = seededRecordsSource({ [SIDEBAR_LABEL]: SEED_ENTRIES });
  assert.deepEqual(await source.read([SIDEBAR_LABEL]), { records: { [SIDEBAR_LABEL]: SEED_ENTRIES } });
  await source.write({ writes: [{ address_label: LAYOUT_LABEL, payload: { screen: 'courses' } }] });
  assert.deepEqual(await source.read([LAYOUT_LABEL]), { records: { [LAYOUT_LABEL]: { screen: 'courses' } } });
});

test('a write whose expected identity no longer holds is reported with the value held, and nothing is applied', async () => {
  const source = seededRecordsSource({ x: 'first' });
  const reply = await source.write({ writes: [{ address_label: 'x', payload: 'second', expected_identity: identityOf('stale') }] });
  assert.deepEqual(reply, { written: 0, conflicts: [{ address: 'x', current: { found: true, value: 'first' } }] });
  assert.deepEqual(await source.read(['x']), { records: { x: 'first' } });
});

test('the memory outbox confirms a send in a later turn, to the listener and to a tracked acceptance', async () => {
  const source = seededRecordsSource({});
  const receipts: RecordsReceipt[] = [];
  const stop = source.outbox.onAccepted(writes => { receipts.push(...writes); });
  const tracked = source.outbox.track({ key: 'records:k', path: 'records', body: {} });
  if (!tracked) assert.fail('a memory outbox tracks every write');
  source.outbox.send({ key: 'records:k', path: 'records', body: { writes: [{ address_label: 'k', payload: 'v' }] } });
  assert.equal(source.outbox.isWaiting('records:k'), true);
  await tracked.accepted;
  await settle();
  stop();
  assert.equal(source.outbox.isWaiting('records:k'), false);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].path, 'records');
  assert.equal(receipts[0].generation, 1);
  assert.equal(source.outbox.isCurrent(receipts[0]), true);
  assert.deepEqual(await source.read(['k']), { records: { k: 'v' } });
});

test('the engine names no server, no Worker store module and no socket: a source keeps its own', () => {
  const engine = readFileSync(new URL('./records.ts', import.meta.url), 'utf8');
  for (const forbidden of [/\/work\//, /quiet-writes/, /store-changes/, /live-room/, /from '\.\/api'/]) {
    assert.doesNotMatch(engine, forbidden);
  }
});

test('a remote source sends each batch to its transport in order, confirms it to the listeners, and refuses a batch the transport throws on', async () => {
  const sent: string[] = [];
  let fail = false;
  const source = remoteRecordsSource({
    read: async labels => ({ records: Object.fromEntries(labels.map(label => [label, `held:${label}`])) }),
    write: async body => {
      sent.push(body.writes[0].address_label);
      if (fail) throw new Error('offline');
      return { written: body.writes.length };
    },
  });
  assert.deepEqual(await source.read(['a']), { records: { a: 'held:a' } });
  const accepted: string[] = [];
  const refused: number[] = [];
  source.outbox.onAccepted(writes => accepted.push(writes[0].key));
  source.outbox.onRefusedReceipt((_writes, status) => refused.push(status));
  const write = (key: string) => ({ key, path: 'records', body: { writes: [{ address_label: key, payload: 1 }] } });
  source.outbox.send(write('one'));
  source.outbox.send(write('two'));
  await settle();
  assert.deepEqual(sent, ['one', 'two']);
  assert.deepEqual(accepted, ['one', 'two']);
  fail = true;
  source.outbox.send(write('three'));
  await settle();
  assert.deepEqual(refused, [0]);
  assert.equal(source.outbox.isWaiting('three'), false);
});
