// tools/notice-when-something-shows-up/tests/kept-places-where.test.mjs
//
// A waiter takes a place only from where it reads (do-work/kept-places.mjs `placeIsFrom`): a place whose last fact names
// another `where` reads as no place, under the shared key or the wake's own, in places_in's database or the kept folder,
// and the run says so (`place_ignored`). Nov 25 2026, 2:04 PM CST: a pursuit's sign-ins database held, under both the
// shared key and its sign-ins copy's own key, a place read in the pursuit's other database at position 1245, while the
// sign-ins change table ends at 28; the copy would have passed over its next 1,217 changes. Made-up places only.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { engineCarrier } from '../do-work/tell-the-engine.mjs';
import { folderPlaces, keptKeyOf, placeIsFrom, placesFor } from '../do-work/kept-places.mjs';

const SIGN_INS = 'p_sign_ins-connection';
const OTHER = 'p_for_who_runs_it-connection';
const KEY = keptKeyOf({ wake: 'keep-noticing-row-changes/sign-ins', waiterRef: 'waiter:row-changes', addressLabel: 'where::something-changed' });
const placeOf = (where, position) => ({ payload: { kind: 'something-changed', where, place: 't', key: `${where}:1:${position}` }, state: { after: { txid: '1', position: String(position) } } });
const clientOf = db => ({ query: (sql, params) => db.query(sql, params), end: async () => {} });

/** The database store of a fresh PGlite with `rows` kept ({kept_as, place}). */
async function database(t, rows) {
  const db = new PGlite();
  t.after(() => db.close());
  const store = await placesFor({ placesIn: SIGN_INS, tool: 'tool:notice', keptOn: 'mac', run: 'mac:1:1', connection: 'postgresql://made-up', connect: async () => clientOf(db) });
  for (const { kept_as, place } of rows) {
    await db.query(`INSERT INTO kept_waiter_places (tool, kept_as, place, version, kept_on, kept_by_run) VALUES ('tool:notice', $1, $2::jsonb, 1, 'mac', 'old')`, [kept_as, JSON.stringify(place)]);
  }
  return store;
}

/** The kept-folder store with `rows` kept. */
async function folder(rows) {
  const store = folderPlaces(tempFolder(path.join(tmpdir(), 'kept-places-where-')));
  for (const { kept_as, place } of rows) await store.write(kept_as, place);
  return store;
}

const reading = (store) => {
  const ignored = [];
  const read = store.read(KEY.as, KEY.carriedFrom, { accepts: place => placeIsFrom(place, SIGN_INS), ignored: seen => ignored.push(seen) });
  return read.then(place => ({ place, ignored }));
};

for (const [name, storeOf] of [['places_in database', database], ['kept folder', (_t, rows) => folder(rows)]]) {
  test(`${name}: a shared-key place read in another database is no place`, async (t) => {
    const store = await storeOf(t, [{ kept_as: KEY.carriedFrom, place: placeOf(OTHER, 1245) }]);
    const { place, ignored } = await reading(store);
    assert.equal(place, null, 'the waiter starts as one with no place');
    assert.deepEqual(ignored.map(seen => [seen.keptAs, seen.place.payload.where]), [[KEY.carriedFrom, OTHER]]);
  });

  test(`${name}: a wake's own place read in another database is no place, and a matching shared one is not taken over it`, async (t) => {
    const store = await storeOf(t, [{ kept_as: KEY.as, place: placeOf(OTHER, 1245) }]);
    const { place, ignored } = await reading(store);
    assert.equal(place, null);
    assert.deepEqual(ignored.map(seen => seen.keptAs), [KEY.as]);
    // Its next write replaces it, and the next read takes that.
    await store.write(KEY.as, placeOf(SIGN_INS, 28));
    const again = await reading(store);
    assert.equal(again.place.state.after.position, '28');
    assert.deepEqual(again.ignored, []);
  });

  test(`${name}: a place read where the waiter reads is taken, as is one that names no where`, async (t) => {
    const store = await storeOf(t, [{ kept_as: KEY.as, place: placeOf(SIGN_INS, 27) }]);
    const { place, ignored } = await reading(store);
    assert.equal(place.state.after.position, '27');
    assert.deepEqual(ignored, []);
    const due = await storeOf(t, [{ kept_as: KEY.carriedFrom, place: { payload: { kind: 'due-time', schedule_id: 's' }, state: { next: 1 } } }]);
    assert.deepEqual((await reading(due)).place.state, { next: 1 }, 'a due time names no where and keeps its place');
  });
}

test('the carrier reads a waiter\'s place only from where it reads, and says the one it passed over', async () => {
  const keep = tempFolder(path.join(tmpdir(), 'kept-places-where-carrier-'));
  const places = folderPlaces(keep);
  const wake = 'keep-noticing-row-changes/sign-ins';
  const shared = keptKeyOf({ wake: null, waiterRef: 'waiter:row-changes', addressLabel: 'where::something-changed' }).as;
  await places.write(shared, placeOf(OTHER, 1245));
  const said = [];
  const carrier = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'c' }, waiters: [], fetchImpl: async () => { throw new Error('no call'); },
    say: line => said.push(JSON.parse(line)), keep, places, wake });
  assert.equal(await carrier.readCurrent('where::something-changed', 'waiter:row-changes', SIGN_INS), null);
  assert.equal(said.length, 1);
  assert.equal(said[0].place_ignored, `${wake}|${shared}`);
  assert.equal(said[0].its_where, OTHER);
  assert.equal(said[0].waiter_where, SIGN_INS);
  // A waiter that names no where takes the place, as before.
  const any = engineCarrier({ door: { url: 'http://door.test/mcp', capability: 'c' }, waiters: [], say: () => {}, keep, places: folderPlaces(keep), wake: 'keep-noticing-row-changes/other' });
  assert.equal((await any.readCurrent('where::something-changed', 'waiter:row-changes')).state.after.position, '1245');
});
