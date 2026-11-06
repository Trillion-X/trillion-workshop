// test/read-new-photos.test.mjs
//
// PURPOSE
// Each photo in Photos on this Mac reaches the person's Trillion within minutes as its own item, with the words in it and
// what it shows read on this Mac, a capped JPEG copy kept in their files, and its past read newest first, paced, as
// history that hands nothing on (computer/read-new-items.mjs, the `photos` row of computer/computer-sources.json).
// A fixture Photos.sqlite stands in for the real library; the words in the fixture picture are read by Apple Vision
// for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {readNewItems, READERS} from '../computer/read-new-items.mjs';
import {observeVisual} from '../../run-on-a-persons-computer/observe-visual.mjs';
import {broughtIn} from '../../notice-what-needs-attention/src/brought-in.mjs';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const PICTURE = path.join(HERE, 'fixtures', 'photo-with-text.png');
const EPOCH = 978307200;
const appleTime = iso => Date.parse(iso) / 1000 - EPOCH;
const rows = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'computer', 'computer-sources.json'), 'utf8'));
const photosRow = rows.sources.find(source => source.id === 'photos').read;
const T0 = '2026-10-08T12:00:00Z';
const later = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
// The picture is resized and measured by /usr/bin/sips and its words read by Apple Vision, which only a Mac has: on any
// other computer these tests are skipped and say so, rather than pass on a stand-in.
const MAC_ONLY = process.platform === 'darwin' && fs.existsSync('/usr/bin/sips') ? false : 'needs a Mac: /usr/bin/sips and Apple Vision read and resize the picture';
const sizeOf = file => Object.fromEntries(execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString().split('\n').map(line => line.trim().match(/^(pixel\w+): (\d+)/)).filter(Boolean).map(match => [match[1], Number(match[2])]));

// assets: [{uuid, added, taken?, kind?, subtype?, files: ['original' | 'large' | 'small']}]
function library(dir, assets) {
  const root = path.join(dir, 'Photos Library.photoslibrary');
  fs.mkdirSync(path.join(root, 'database'), {recursive: true});
  const db = new DatabaseSync(path.join(root, 'database', 'Photos.sqlite'));
  db.exec(`CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZADDEDDATE REAL, ZDATECREATED REAL, ZFILENAME TEXT, ZDIRECTORY TEXT, ZKIND INTEGER, ZKINDSUBTYPE INTEGER,
    ZLATITUDE REAL, ZLONGITUDE REAL, ZTRASHEDSTATE INTEGER, ZHIDDEN INTEGER)`);
  for (const asset of assets) {
    db.prepare('INSERT INTO ZASSET (ZUUID, ZADDEDDATE, ZDATECREATED, ZFILENAME, ZDIRECTORY, ZKIND, ZKINDSUBTYPE, ZLATITUDE, ZLONGITUDE, ZTRASHEDSTATE, ZHIDDEN) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)')
      .run(asset.uuid, appleTime(asset.added), appleTime(asset.taken ?? asset.added), `${asset.uuid}.png`, asset.uuid[0], asset.kind ?? 0, asset.subtype ?? 0, 0, 0);
    const places = {original: `originals/${asset.uuid[0]}/${asset.uuid}.png`, large: `resources/derivatives/${asset.uuid[0]}/${asset.uuid}_1_201_a.jpeg`, small: `resources/derivatives/${asset.uuid[0]}/${asset.uuid}_1_105_c.jpeg`};
    for (const which of asset.files ?? ['original']) {
      const file = path.join(root, places[which]);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      if (which === 'small') execFileSync('/usr/bin/sips', ['-Z', '320', '-s', 'format', 'jpeg', PICTURE, '--out', file], {stdio: 'ignore'});
      else fs.copyFileSync(PICTURE, file);
    }
  }
  db.close();
  return {root, store: path.join(root, 'database', 'Photos.sqlite')};
}

function setup(assets, {row = {}, clock = T0, see = null, keepSeen = null, copy = null, spent = null, held = null} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-'));
  if (held) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(held));
  const {root, store} = library(dir, assets);
  const state = {clock, sent: [], kept: [], seen: []};
  const carrier = {...photosRow, store, files_from: root, ...row};
  const account = async (route, {body}) => {
    state.sent.push(body);
    return body.items ? {status: 200, body: {items: body.items.map((_, index) => ({message_id: `m_${state.sent.length}_${index}`}))}} : {status: 200, body: {message_id: `m_${state.sent.length}`, arrival_id: `a_${state.sent.length}`}};
  };
  const keep = async file => {
    const copy = path.join(dir, `kept-${state.kept.length}.jpg`);
    fs.copyFileSync(file.path, copy);
    state.kept.push({...file, copy});
    return {id: `file:${state.kept.length}`, name: file.name};
  };
  const reading = readNewItems({carriers: [carrier], account, keep, stateFile: path.join(dir, 'state.json'), now: () => new Date(state.clock),
    readers: {sqlite: async (c, s) => READERS.sqlite(c, s)}, see, keepSeen, ...(copy ? {copy} : {}), ...(spent ? {spent} : {})});
  return {...state, state, reading, dir, root, at: iso => { state.clock = iso; }, items: () => state.sent.flatMap(body => body.items ?? [body])};
}

test('each new photo is its own item within minutes, a screenshot is called one, and a picture of text carries its words', {skip: MAC_ONLY}, async () => {
  const seen = [];
  const world = setup([
    {uuid: 'A1000000-0000-0000-0000-000000000001', added: later(T0, 1), taken: later(T0, 0), files: ['original']},
    {uuid: 'B2000000-0000-0000-0000-000000000002', added: later(T0, 1.2), subtype: 10, files: ['original']},
    {uuid: 'C3000000-0000-0000-0000-000000000003', added: later(T0, -60)},
  ], {see: async (file, type) => { seen.push(file); return observeVisual(file, type, {captionAlways: true, frame: async () => Buffer.from('x'), caption: async () => ({title: 'Sign - a yard sale notice', confidence: 'vision-caption'})}); }});
  await world.reading.tick();
  assert.deepEqual(world.items().map(item => item.source_id[0]), ['C'], 'the first look sends only the one that predates the reader, as the past; the others are still settling');
  world.state.sent.length = 0;
  world.at(later(T0, 3));
  await world.reading.tick();
  const items = world.items();
  assert.equal(items.length, 2, 'one item per photo, no hourly window');
  const [photo, screenshot] = items.sort((left, right) => left.at.localeCompare(right.at));
  assert.match(photo.text, /^A photo taken /);
  assert.match(screenshot.text, /^A screenshot taken /);
  for (const item of items) {
    assert.match(item.text, /Text in it: .*GARAGE/i, 'Apple Vision read the words in the picture');
    assert.match(item.text, /It shows: Sign - a yard sale notice/);
    assert.equal(item.files.length, 1);
    assert.equal(item.route, 'Photos');
  }
  assert.equal(seen.length, 3, 'each picture is read once: the two new ones and the one from the past');
});

test('the picture is kept as a JPEG whose long edge is capped, in the month\'s folder, and what was seen is kept beside it', {skip: MAC_ONLY}, async () => {
  const results = [];
  const world = setup([{uuid: 'A1000000-0000-0000-0000-000000000001', added: later(T0, 1), taken: '2026-09-14T08:30:05Z', files: ['original']}], {
    see: async () => ({frames: [{lines: [{text: 'GARAGE SALE'}]}], text: 'GARAGE SALE', confidence: 'ocr-heading', title: 'GARAGE SALE'}),
    keepSeen: async (identity, observation) => results.push([identity, observation.text]),
  });
  await world.reading.tick();
  world.at(later(T0, 3));
  await world.reading.tick();
  assert.equal(world.state.kept.length, 1);
  const [file] = world.state.kept;
  assert.match(file.folder, /^\/Photos\/2026-09$/, 'the folder comes from the row, by the month the photo was taken');
  assert.match(file.name, /^2026-09-\d\d \d\d-\d\d-\d\d A1000000\.jpg$/);
  assert.equal(file.media_type, 'image/jpeg');
  const {pixelWidth, pixelHeight} = sizeOf(file.copy);
  assert.equal(Math.max(pixelWidth, pixelHeight), photosRow.file.long_edge, '3000 px original is cut down to the cap');
  assert.equal(execFileSync('/usr/bin/file', ['-b', '--mime-type', file.copy]).toString().trim(), 'image/jpeg');
  assert.deepEqual(results, [['file:1', 'GARAGE SALE']]);
  assert.ok(!fs.readdirSync(path.join(world.dir, 'written-elsewhere-previews')).some(name => name.endsWith('.jpg')), 'the made copy is removed once kept');
  assert.equal(world.items()[0].files[0].id, 'file:1');
});

test('a smaller picture is not enlarged, an iCloud-only original keeps its largest local copy and says so, and none keeps nothing', {skip: MAC_ONLY}, async () => {
  const world = setup([
    {uuid: 'A1000000-0000-0000-0000-000000000001', added: later(T0, 1), files: ['original']},
    {uuid: 'B2000000-0000-0000-0000-000000000002', added: later(T0, 1.1), files: ['small']},
    {uuid: 'C3000000-0000-0000-0000-000000000003', added: later(T0, 1.2), files: []},
  ], {row: {file: {...photosRow.file, long_edge: 4000}}});
  await world.reading.tick();
  world.at(later(T0, 3));
  await world.reading.tick();
  const byId = Object.fromEntries(world.items().map(item => [item.source_id[0], item]));
  assert.doesNotMatch(byId.A.text, /smaller copy/);
  assert.match(byId.B.text, /Only a smaller copy of it is on this Mac \(the original is in iCloud\)/);
  assert.match(byId.C.text, /not on this Mac \(it is in iCloud\), so no copy of it is kept/);
  assert.equal(byId.C.files, undefined);
  const kept = world.state.kept.map(file => sizeOf(file.copy));
  assert.equal(kept[0].pixelWidth, 3000, 'under the cap the picture keeps its size');
  assert.equal(Math.max(kept[1].pixelWidth, kept[1].pixelHeight), 320, 'the 320 px copy is not blown up to the cap');
});

test('what was read in a picture is kept in the work folder, so a send the account turned away reads nothing twice', {skip: MAC_ONLY}, async () => {
  let reads = 0, answers = [429];
  const world = setup([{uuid: 'A1000000-0000-0000-0000-000000000001', added: later(T0, 1)}], {see: async () => { reads += 1; return {frames: [], text: 'hello', confidence: 'ocr-heading', title: 'hello'}; }});
  const turned = async (route, {body}) => { world.state.sent.push(body); const status = answers.shift() ?? 200; return {status, body: {message_id: 'm'}}; };
  world.reading = readNewItems({carriers: [{...photosRow, store: path.join(world.root, 'database', 'Photos.sqlite'), files_from: world.root}], account: turned, keep: async file => ({id: 'f', name: file.name}),
    stateFile: path.join(world.dir, 'state2.json'), workdir: path.join(world.dir, 'work'), now: () => new Date(world.state.clock), readers: {sqlite: async (c, s) => READERS.sqlite(c, s)}, see: async () => { reads += 1; return {frames: [], text: 'hello', confidence: 'ocr-heading', title: 'hello'}; }});
  await world.reading.tick();
  world.at(later(T0, 3));
  await world.reading.tick();
  world.at(later(T0, 70));
  await world.reading.tick();
  assert.equal(reads, 1, 'read once, though the item was sent twice');
  assert.equal(world.state.sent.length, 2);
  assert.match(world.state.sent[1].text, /Text in it: hello/);
});

test('a look sends at most most_per_look photos and the rest wait for the next', {skip: MAC_ONLY}, async () => {
  const assets = Array.from({length: 5}, (_, index) => ({uuid: `A${index}000000-0000-0000-0000-00000000000${index}`, added: later(T0, 1 + index / 10), files: ['small']}));
  const world = setup(assets, {row: {most_per_look: 2, backfill: undefined}});
  await world.reading.tick();
  world.at(later(T0, 5));
  await world.reading.tick();
  assert.equal(world.items().length, 2);
  await world.reading.tick();
  await world.reading.tick();
  assert.equal(world.items().length, 5);
  assert.equal(new Set(world.items().map(item => item.source_id)).size, 5);
});

// The past: ten photos added 3..12 days before the reader first ran, one 2 hours before it.
const past = Array.from({length: 10}, (_, index) => ({uuid: `D${index}000000-0000-0000-0000-00000000000${index}`, added: later(T0, -(3 + index) * 1440), files: ['small']}));

test('the past is read newest first, a few at a time as one batch, paced by the hour, down to the oldest, and then stops', {skip: MAC_ONLY}, async () => {
  const world = setup([...past, {uuid: 'E0000000-0000-0000-0000-000000000000', added: later(T0, -120), files: ['small']}],
    {row: {backfill: {per_look: 4, every_seconds: 120, most_per_hour: 6}}});
  await world.reading.tick();
  world.at(later(T0, 1));
  await world.reading.tick();
  assert.equal(world.state.sent.length, 1, 'one request');
  const first = world.state.sent[0];
  assert.equal(first.items.length, 4);
  assert.deepEqual(first.items.map(item => item.source_id[0]), ['E', 'D', 'D', 'D'], 'newest first, the one from 2 hours before the first run too');
  assert.deepEqual(first.items.map(item => item.source_id.slice(0, 2)), ['E0', 'D0', 'D1', 'D2']);
  assert.ok(first.items.every(item => item.files.length === 1), 'each is kept like a new one');
  await world.reading.tick();
  assert.equal(world.state.sent.length, 1, 'not again before every_seconds');
  world.at(later(T0, 4));
  await world.reading.tick();
  assert.deepEqual(world.state.sent[1].items.map(item => item.source_id.slice(0, 2)), ['D3', 'D4'], 'the hour has room for 6: 2 more');
  world.at(later(T0, 8));
  await world.reading.tick();
  assert.equal(world.state.sent.length, 2, 'six an hour reached');
  world.at(later(T0, 70));
  for (let look = 0; look < 6; look += 1) { await world.reading.tick(); world.at(later(world.state.clock, 3)); }
  const all = world.items().map(item => item.source_id.slice(0, 2));
  assert.deepEqual(all, ['E0', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'].slice(0, all.length), 'oldest last');
  assert.equal(all.length, 11, 'every older photo was read, none twice');
  world.at(later(world.state.clock, 600));
  await world.reading.tick();
  const count = world.state.sent.length;
  await world.reading.tick();
  assert.equal(world.state.sent.length, count, 'at the oldest it stops');
  const held = JSON.parse(fs.readFileSync(path.join(world.dir, 'state.json'), 'utf8')).Photos;
  assert.equal(held.backfill_done, true);
  assert.equal(held.backfill_count, 11);
});

test('what is read from the past arrives as history: old enough that the door brings it in and hands nothing on', {skip: MAC_ONLY}, async () => {
  const world = setup(past, {row: {backfill: {...photosRow.backfill, per_look: 6}}});
  await world.reading.tick();
  world.at(later(T0, 5));
  await world.reading.tick();
  const bodies = world.items();
  assert.ok(bodies.length >= 6);
  const keptAt = world.state.clock;
  for (const body of bodies) assert.equal(broughtIn({at: body.at, recorded_at: keptAt}), true, `${body.source_id} counts as brought in`);
  assert.equal(photosRow.backfill.history_after_minutes, undefined, 'the past does not wait');
  assert.equal(photosRow.backfill.most_per_hour, 240);
  assert.ok(bodies.every(body => body.route === 'Photos' && !('from_person' in body && body.from_person === true)));
});

test('photos added at the same instant are each read once across batches', {skip: MAC_ONLY}, async () => {
  const same = Array.from({length: 7}, (_, index) => ({uuid: `F${index}000000-0000-0000-0000-00000000000${index}`, added: later(T0, -3 * 1440), files: ['small']}));
  const world = setup([...same, {uuid: 'G0000000-0000-0000-0000-000000000000', added: later(T0, -4 * 1440), files: ['small']}], {row: {backfill: {per_look: 3, every_seconds: 1, most_per_hour: 100}}});
  await world.reading.tick();
  world.at(later(T0, 25 * 60));
  for (let look = 0; look < 8; look += 1) { await world.reading.tick(); world.at(later(world.state.clock, 1)); }
  const ids = world.items().map(item => item.source_id);
  assert.equal(new Set(ids).size, ids.length, 'no photo twice');
  assert.equal(ids.length, 8, 'and none missed');
});

test('a struggling account holds the past back and keeps the cursor where it was', {skip: MAC_ONLY}, async () => {
  const world = setup(past, {});
  world.at(later(T0, 25 * 60));
  let busy = true;
  const flaky = readNewItems({carriers: [{...photosRow, store: path.join(world.root, 'database', 'Photos.sqlite'), files_from: world.root}], account: async (route, {body}) => { world.state.sent.push(body); return busy ? {status: 503, body: {error: 'busy'}} : {status: 200, body: {items: body.items.map(() => ({message_id: 'm'}))}}; },
    keep: async file => ({id: 'f', name: file.name}), stateFile: path.join(world.dir, 'state.json'), now: () => new Date(world.state.clock), readers: {sqlite: async (c, s) => READERS.sqlite(c, s)}});
  await flaky.tick();
  const held = () => JSON.parse(fs.readFileSync(path.join(world.dir, 'state.json'), 'utf8')).Photos;
  assert.equal(held().backfill_count, undefined);
  busy = false;
  world.at(later(world.state.clock, 40));
  await flaky.tick();
  assert.equal(world.state.sent.at(-1).items[0].source_id.slice(0, 2), 'D0', 'the same newest batch is sent after');
  assert.equal(held().backfill_count, 4);
});

test('the photos row is data a reader can run: it asks for :since, :before and :limit and orders newest first', () => {
  assert.match(photosRow.query, /ZADDEDDATE > :since AND a\.ZADDEDDATE < :before/);
  assert.match(photosRow.query, /ORDER BY a\.ZADDEDDATE DESC LIMIT :limit/);
  assert.equal(photosRow.group, undefined, 'one item per photo, not an hourly roll-up');
  assert.equal(photosRow.preview_px, undefined, 'the picture itself is kept, not a preview');
  assert.ok(photosRow.settle_seconds <= 60);
  assert.ok(photosRow.backfill.per_look * Math.ceil(3600 / photosRow.backfill.every_seconds) <= 240 && photosRow.backfill.most_per_hour <= 240, 'the past is read at no more than 240 photos an hour');
});

test('a look spends at most its budget reading pictures: later ones go without a caption, and the past waits for the next look', {skip: MAC_ONLY}, async () => {
  assert.ok(photosRow.see.caption_timeout_seconds <= 20 && photosRow.see.look_budget_seconds <= 45, 'the limits are data on the row');
  let clock = 0;
  const calls = [];
  const assets = [...Array.from({length: 4}, (_, index) => ({uuid: `H${index}000000-0000-0000-0000-00000000000${index}`, added: later(T0, 1 + index / 10), files: ['small']})),
    {uuid: 'J0000000-0000-0000-0000-000000000000', added: later(T0, -3 * 1440), files: ['small']},
    {uuid: 'L0000000-0000-0000-0000-000000000000', added: later(T0, -4 * 1440), files: ['small']}];
  const world = setup(assets, {row: {backfill: {per_look: 1, every_seconds: 1, most_per_hour: 240}}, spent: () => clock, see: async (file, type, options) => { calls.push(options); clock += 30_000; return {frames: [], text: 'WORDS', title: 'WORDS', confidence: options.caption ? 'vision-caption' : 'ocr-heading'}; }});
  await world.reading.tick();
  assert.equal(world.items().length, 1, 'the first look reads one of the past');
  calls.length = 0;
  world.at(later(T0, 3));
  await world.reading.tick();
  assert.deepEqual(calls.map(options => options.caption), [true, true, false, false], 'the budget of 45s is spent by the second picture: the rest are read for their words only');
  assert.ok(calls.every(options => options.caption_timeout_seconds === photosRow.see.caption_timeout_seconds));
  assert.equal(world.items().filter(item => item.source_id[0] === 'L').length, 0, 'the past was left for the next look');
  assert.equal(world.items().filter(item => item.source_id[0] === 'H').length, 4, 'every new photo still went');
  world.at(later(T0, 6));
  await world.reading.tick();
  assert.equal(world.items().filter(item => item.source_id[0] === 'L').length, 1, 'the past is read on a look with budget to spare');
});

test('one photo that cannot be made ready is tried twice and then passed over, and the rest of the past goes on', {skip: MAC_ONLY}, async () => {
  const bad = 'K1000000-0000-0000-0000-000000000001';
  const past3 = ['K0', 'K1', 'K2'].map((id, index) => ({uuid: `${id}000000-0000-0000-0000-00000000000${index}`, added: later(T0, -(3 + index) * 1440), files: ['small']}));
  const { makeCopy } = await import('../computer/read-new-items.mjs');
  let tries = 0;
  const world = setup(past3, {row: {backfill: {per_look: 3, every_seconds: 1, most_per_hour: 240}},
    copy: async (picture, edge, dir) => { if (picture.includes(bad)) { tries += 1; throw new Error('cannot be read'); } return makeCopy(picture, edge, dir); }});
  const held = () => JSON.parse(fs.readFileSync(path.join(world.dir, 'state.json'), 'utf8')).Photos;
  await world.reading.tick();
  assert.equal(world.state.sent.length, 0, 'the first failure sends nothing and the cursor stays');
  assert.equal(held().backfill_failures[bad], 1);
  world.at(later(T0, 1));
  await world.reading.tick();
  assert.equal(tries, 2, 'tried twice, no more');
  assert.deepEqual(world.items().map(item => item.source_id.slice(0, 2)), ['K0', 'K2'], 'the others were sent');
  assert.equal(held().failed.source_id, bad, 'recorded the way the live read records one');
  for (let look = 2; look < 6; look += 1) { world.at(later(T0, look)); await world.reading.tick(); }
  assert.equal(tries, 2, 'never tried again');
  assert.equal(held().backfill_done, true, 'the past reached its oldest');
  assert.equal(held().backfill_count, 2);
});

test('a new backfill round reads again what the live read sent before, then goes on below where the past had got to', {skip: MAC_ONLY}, async () => {
  const day = 1440;
  const assets = [
    {uuid: 'S1000000-0000-0000-0000-000000000001', added: later(T0, -2 * day), files: ['small']},
    {uuid: 'S2000000-0000-0000-0000-000000000002', added: later(T0, -3 * day), files: ['small']},
    {uuid: 'R1000000-0000-0000-0000-000000000003', added: later(T0, -6 * day), files: ['small']},
    {uuid: 'U1000000-0000-0000-0000-000000000004', added: later(T0, -9 * day), files: ['small']},
  ];
  // The live read began 4 days ago and sent S1 and S2 as hourly lines; the past already read R1 and stopped at 8 days ago.
  const held = {Photos: {since: later(T0, -1 * day), first_since: later(T0, -4 * day), sent: {}, backfill_before: later(T0, -8 * day), backfill_count: 1}};
  const world = setup(assets, {row: {backfill: {per_look: 1, every_seconds: 60, most_per_hour: 60, round: 'again'}}, held});
  for (let look = 0; look < 8; look += 1) { await world.reading.tick(); world.at(later(world.state.clock, 2)); }
  const read = world.items().map(item => item.source_id.slice(0, 2));
  assert.deepEqual(read, ['S1', 'S2', 'U1'], 'the sent window again, newest first, then on from where the past had got to');
  const after = JSON.parse(fs.readFileSync(path.join(world.dir, 'state.json'), 'utf8')).Photos;
  assert.equal(after.backfill_round, 'again');
  assert.equal(after.backfill_resume, undefined);
});
