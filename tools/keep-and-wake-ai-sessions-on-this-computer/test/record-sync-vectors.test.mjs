// test/record-sync-vectors.test.mjs
// Two stores converge with no leader, each keeping one position per peer, and the traffic between them is the size of
// what changed. The cases are the ones a root-synced engine is held to (two stores that both moved end equal with
// every record on both; one change costs the same however large the store; a peer away for a thousand writes catches
// up in one exchange; a stale peer never beats a store that kept writing; both changing one record converge and keep
// the loser readable; a second fork keeps the first fork's versions; an uncontested record reports no fork; a peer
// holding nothing starts through the same exchange; the same exchange twice changes nothing), run against this engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { takeFromPeer, changesAfter, KEPT_APART } from '../../record-log/do-work/record-sync.mjs';

function store(name) {
  const host = sqliteHost(':memory:');
  return { name, records: recordLogStore(host.sql, { transaction: host.transaction }), seen: new Map() };
}
const write = (side, id, payload) => side.records.write([{ id, type: 'note', value: { payload } }]);
const read = (side, id) => side.records.read(id)?.payload ?? null;
const root = side => side.records.checksum().root;
// One way: `to` takes what `from` wrote since the last of `from`'s rows it read; answers the characters that crossed.
async function syncOneWay(from, to) {
  let chars = 0;
  const peer = { changesAfter: position => {
    const answer = changesAfter(from.records, position);
    chars += JSON.stringify(answer.rows).length;
    return answer;
  } };
  const taken = await takeFromPeer(to.records, peer, to.seen.get(from.name) ?? null, { actor: { by: from.name } });
  to.seen.set(from.name, taken.seen);
  return chars;
}
const forkOf = (side, id) => side.records.read(`${KEPT_APART}:${id}`);

test('two stores that both moved converge on one root with every record on both', async () => {
  const left = store('left');
  const right = store('right');
  write(left, 'shared', 'before');
  assert.ok(await syncOneWay(left, right) > 0, 'the first sync carries the store');
  for (const [side, prefix] of [[left, 'left'], [right, 'right']]) for (const n of ['one', 'two', 'three']) write(side, `${prefix}-${n}`, `${prefix[0].toUpperCase()}${n}`);
  await syncOneWay(left, right);
  await syncOneWay(right, left);
  await syncOneWay(left, right);
  assert.equal(root(left), root(right));
  for (const side of [left, right]) {
    assert.equal(read(side, 'shared'), 'before');
    for (const prefix of ['left', 'right']) for (const n of ['one', 'two', 'three']) assert.equal(read(side, `${prefix}-${n}`), `${prefix[0].toUpperCase()}${n}`);
  }
});

async function wireCostOfOneChange(count) {
  const source = store('source');
  for (let index = 0; index < count; index += 1) write(source, `record-${String(index).padStart(5, '0')}`, 'value');
  const peer = store('peer');
  await syncOneWay(source, peer);
  write(source, 'record-00000', 'changed');
  const chars = await syncOneWay(source, peer);
  assert.equal(read(peer, 'record-00000'), 'changed');
  return chars;
}

test('one changed record costs the same on the wire however large the store', async () => {
  const smaller = await wireCostOfOneChange(500);
  const larger = await wireCostOfOneChange(2000);
  assert.ok(larger < smaller * 2, `500 records cost ${smaller} and 2000 cost ${larger}`);
});

test('a peer away through a thousand writes catches up in one exchange, paying for the records not the writes', async () => {
  const live = store('live');
  const away = store('away');
  write(live, 'record-0000', 'seed');
  await syncOneWay(live, away);
  for (let round = 0; round < 1000; round += 1) write(live, `record-${String(round % 20).padStart(4, '0')}`, `v${round}`);
  const chars = await syncOneWay(live, away);
  assert.equal(root(away), root(live));
  assert.equal(read(away, 'record-0019'), 'v999');
  assert.ok(chars < 20 * 200, `twenty records crossed as ${chars} characters, not a thousand writes`);
});

test('a stale peer does not beat a store that kept writing the same record', async () => {
  const live = store('live');
  const away = store('away');
  write(live, 'contested', 'seed');
  await syncOneWay(live, away);
  for (let round = 0; round < 1000; round += 1) write(live, 'contested', `v${round}`);
  await syncOneWay(live, away);
  await syncOneWay(away, live);
  assert.equal(read(away, 'contested'), 'v999');
  assert.equal(read(live, 'contested'), 'v999');
});

test('both sides changing one record converge on one root and keep the loser readable on both', async () => {
  const left = store('left');
  const right = store('right');
  write(left, 'contested', 'base');
  await syncOneWay(left, right);
  write(left, 'contested', 'from-left');
  write(right, 'contested', 'from-right');
  await syncOneWay(left, right);
  await syncOneWay(right, left);
  await syncOneWay(left, right);
  assert.equal(root(left), root(right));
  const settled = read(left, 'contested');
  assert.ok(['from-left', 'from-right'].includes(settled));
  assert.equal(read(right, 'contested'), settled);
  const loser = settled === 'from-left' ? 'from-right' : 'from-left';
  for (const side of [left, right]) {
    const versions = Object.values(forkOf(side, 'contested') ?? {}).map(version => version.value);
    assert.ok(versions.includes(loser), `${side.name} lost the version that lost: ${JSON.stringify(versions)}`);
    assert.ok(versions.includes(settled), `${side.name} lost the version that won`);
    assert.ok(Object.values(forkOf(side, 'contested')).every(version => version.record === 'contested'));
  }
  for (let index = 0; index < 12; index += 1) write(left, `unrelated-${index}`, 'filler');
  left.records.checkpoint();
  await syncOneWay(left, right);
  assert.ok(Object.values(forkOf(left, 'contested')).some(version => version.value === loser), 'the loser survives later writes');
});

test('a second fork on one record does not erase the first', async () => {
  const left = store('left');
  const right = store('right');
  write(left, 'contested', 'base');
  await syncOneWay(left, right);
  for (const round of ['first', 'second']) {
    write(left, 'contested', `${round}-from-left`);
    write(right, 'contested', `${round}-from-right`);
    await syncOneWay(left, right);
    await syncOneWay(right, left);
    await syncOneWay(left, right);
  }
  assert.equal(root(left), root(right));
  for (const side of [left, right]) {
    const versions = Object.values(forkOf(side, 'contested') ?? {}).map(version => version.value);
    for (const written of ['first-from-left', 'first-from-right', 'second-from-left', 'second-from-right']) assert.ok(versions.includes(written), `${side.name} lost ${written}`);
  }
});

test('a record nobody contested reports no fork', async () => {
  const left = store('left');
  const right = store('right');
  write(left, 'quiet', 'one');
  await syncOneWay(left, right);
  assert.equal(forkOf(right, 'quiet'), null);
  assert.equal(forkOf(right, 'never-written'), null);
});

test('a peer holding nothing starts through the same exchange, and the same exchange twice changes nothing', async () => {
  const source = store('source');
  for (let index = 0; index < 40; index += 1) write(source, `record-${String(index).padStart(4, '0')}`, 'value');
  const fresh = store('fresh');
  await syncOneWay(source, fresh);
  assert.equal(root(fresh), root(source));
  assert.equal(read(fresh, 'record-0039'), 'value');
  const before = root(fresh);
  const rows = fresh.records.logAfter(null, { limit: 10000 }).rows.length;
  fresh.seen.delete('source');
  await syncOneWay(source, fresh);
  assert.equal(root(fresh), before, 'taking the same changes again moved the root');
  assert.equal(fresh.records.logAfter(null, { limit: 10000 }).rows.length, rows, 'and wrote nothing');
});

test('a record one side removed and the other changed settles the same on both, with the change kept apart', async () => {
  const left = store('left');
  const right = store('right');
  write(left, 'gone', 'base');
  await syncOneWay(left, right);
  left.records.write([{ id: 'gone', type: 'note', value: null }]);
  write(right, 'gone', 'edited');
  await syncOneWay(left, right);
  await syncOneWay(right, left);
  await syncOneWay(left, right);
  assert.equal(root(left), root(right));
  assert.equal(read(left, 'gone'), read(right, 'gone'));
  for (const side of [left, right]) assert.ok(JSON.stringify(forkOf(side, 'gone')).includes('edited'), `${side.name} dropped the edit`);
});
