// test/read-new-photos-video.test.mjs
//
// PURPOSE
// A video in Photos on this Mac reaches the person's files as the whole original movie (the `photos` row's
// `file.video`), so its sound can be heard and transcribed where it arrives; it is never sent to picture reading; and a
// video whose original is only in iCloud keeps its still and says so (computer/read-new-items.mjs fileOf).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {readNewItems, READERS} from '../computer/read-new-items.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PICTURE = path.join(HERE, 'fixtures', 'photo-with-text.png');
const EPOCH = 978307200;
const appleTime = iso => Date.parse(iso) / 1000 - EPOCH;
const photosRow = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'computer', 'computer-sources.json'), 'utf8')).sources.find(source => source.id === 'photos').read;
const T0 = '2026-10-08T12:00:00Z';
const later = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

function setup(assets, {held = null} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-video-'));
  if (held) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(held));
  const root = path.join(dir, 'Photos Library.photoslibrary');
  fs.mkdirSync(path.join(root, 'database'), {recursive: true});
  const store = path.join(root, 'database', 'Photos.sqlite');
  const db = new DatabaseSync(store);
  db.exec(`CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZADDEDDATE REAL, ZDATECREATED REAL, ZFILENAME TEXT, ZDIRECTORY TEXT, ZKIND INTEGER, ZKINDSUBTYPE INTEGER,
    ZLATITUDE REAL, ZLONGITUDE REAL, ZTRASHEDSTATE INTEGER, ZHIDDEN INTEGER)`);
  for (const asset of assets) {
    db.prepare('INSERT INTO ZASSET (ZUUID, ZADDEDDATE, ZDATECREATED, ZFILENAME, ZDIRECTORY, ZKIND, ZKINDSUBTYPE, ZLATITUDE, ZLONGITUDE, ZTRASHEDSTATE, ZHIDDEN) VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)')
      .run(asset.uuid, appleTime(asset.added), appleTime(asset.added), `${asset.uuid}.mov`, asset.uuid[0]);
    if (asset.original) {
      const movie = path.join(root, 'originals', asset.uuid[0], `${asset.uuid}.mov`);
      fs.mkdirSync(path.dirname(movie), {recursive: true});
      fs.writeFileSync(movie, Buffer.from('fixture movie bytes'));
    }
    if (asset.still) {
      const still = path.join(root, 'resources', 'derivatives', asset.uuid[0], `${asset.uuid}_1_105_c.jpeg`);
      fs.mkdirSync(path.dirname(still), {recursive: true});
      fs.copyFileSync(PICTURE, still);
    }
  }
  db.close();
  const state = {clock: T0, sent: [], kept: [], seen: []};
  const account = async (route, {body}) => {
    state.sent.push(body);
    return body.items ? {status: 200, body: {items: body.items.map((_, index) => ({message_id: `m_${state.sent.length}_${index}`}))}} : {status: 200, body: {message_id: `m_${state.sent.length}`}};
  };
  const keep = async file => { state.kept.push(file); return {id: `file:${state.kept.length}`, name: file.name}; };
  const see = async (file, type) => { state.seen.push([file, type]); return {text: '', confidence: 'none'}; };
  const reading = readNewItems({carriers: [{...photosRow, store, files_from: root}], account, keep, see, stateFile: path.join(dir, 'state.json'), now: () => new Date(state.clock),
    readers: {sqlite: async (c, s) => READERS.sqlite(c, s)}});
  return {state, reading, dir, at: iso => { state.clock = iso; }, items: () => state.sent.flatMap(body => body.items ?? [body])};
}

test('a video on this Mac is kept whole as its movie, in the month folder, and is never read as a picture', async () => {
  const world = setup([{uuid: 'V1000000-0000-0000-0000-000000000001', added: later(T0, 1), original: true, still: true}]);
  await world.reading.tick();
  world.at(later(T0, 3));
  await world.reading.tick();
  assert.equal(world.state.kept.length, 1);
  const [file] = world.state.kept;
  assert.equal(file.media_type, 'video/quicktime');
  assert.match(file.name, /^2026-10-\d\d \d\d-\d\d-\d\d V1000000\.mov$/);
  assert.match(file.folder, /^\/Photos\/2026-10$/);
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'fixture movie bytes', 'the original movie itself, not a still');
  assert.equal(file.long_edge, undefined, 'a movie is never resized as a picture');
  assert.ok(!world.state.seen.some(([seen]) => String(seen).endsWith('.mov')), 'the movie bytes never go to picture reading');
  const [item] = world.items();
  assert.match(item.text, /^A video taken /);
  assert.doesNotMatch(item.text, /not on this Mac/);
});

test('a video only in iCloud keeps its still and says the video itself is not on this Mac', async () => {
  const world = setup([{uuid: 'W2000000-0000-0000-0000-000000000002', added: later(T0, 1), original: false, still: true}]);
  await world.reading.tick();
  world.at(later(T0, 3));
  await world.reading.tick();
  assert.equal(world.state.kept.length, 1);
  assert.equal(world.state.kept[0].media_type, 'image/jpeg');
  assert.match(world.items()[0].text, /The video itself is not on this Mac/);
});

test('the original-video catch-up revisits a previously sent still beyond the live cursor once', async () => {
  const oldRound = '2026-10-09 read again what went as hourly lines';
  assert.notEqual(photosRow.backfill.round, oldRound, 'a video reader upgrade must reopen the existing catch-up window');
  const previous = {
    Photos: {
      since: later(T0, -60), first_since: later(T0, -7 * 1440), sent: {},
      backfill_round: oldRound, backfill_before: later(T0, -30 * 1440),
      backfill_done: true, backfill_count: 1,
    },
  };
  const world = setup([{uuid: 'R3000000-0000-0000-0000-000000000003', added: later(T0, -4 * 1440), original: true, still: true}], {held: previous});
  await world.reading.tick();
  assert.equal(world.state.kept.length, 1);
  assert.equal(world.state.kept[0].media_type, 'video/quicktime', 'the old still is revisited as its original movie');
  assert.equal(fs.readFileSync(world.state.kept[0].path, 'utf8'), 'fixture movie bytes');
  assert.ok(!world.state.seen.some(([seen]) => String(seen).endsWith('.mov')));
  world.at(later(T0, 3));
  await world.reading.tick();
  const held = JSON.parse(fs.readFileSync(path.join(world.dir, 'state.json'), 'utf8')).Photos;
  assert.equal(world.state.kept.length, 1, 'the next look does not keep this original again');
  assert.equal(held.backfill_round, photosRow.backfill.round);
  assert.equal(held.backfill_before, previous.Photos.backfill_before, 'the older completed scan resumes where it stopped');
  assert.equal(held.backfill_done, true);
  assert.equal(held.backfill_count, 2);
});
