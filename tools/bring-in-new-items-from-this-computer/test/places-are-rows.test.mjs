// tools/bring-in-new-items-from-this-computer/test/places-are-rows.test.mjs
//
// Every place is a row of computer-sources.json read by the generic readers, proved on made-up stores only: a notes
// store (sqlite, its bodies gzipped protobuf), a recordings store with its recording files beside it, and a folder of
// pictures. The account is a stand-in that keeps each arrival as one of its own rows, which the test reads back; nothing
// reaches a real account. Each new item arrives once; an item the account turns away waits alone while the others
// still arrive; a recording whose file is not on this computer waits until it is; the past is read newest first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {readNewItems, READERS} from '../computer/read-new-items.mjs';

const rows = JSON.parse(fs.readFileSync(new URL('../computer/computer-sources.json', import.meta.url), 'utf8'));
const placeRead = route => structuredClone(rows.sources.find(row => row.read?.route === route).read);
const SECONDS_TO_2001 = 978307200;
const since2001 = ms => ms / 1000 - SECONDS_TO_2001;

// A notes store in the shape the notes row's query reads: a note's words in a gzipped protobuf at field path 2, 3, 2.
const field = (number, bytes) => Buffer.concat([Buffer.from([(number << 3) | 2]), Buffer.from([bytes.length]), bytes]);
const noteBody = text => gzipSync(field(2, field(3, field(2, Buffer.from(text)))));
function notesStore(dir) {
  const file = path.join(dir, 'notes.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZDATA BLOB);
    CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE2 TEXT, ZMODIFICATIONDATE1 REAL,
      ZISPASSWORDPROTECTED INTEGER, ZMARKEDFORDELETION INTEGER, ZFOLDER INTEGER, ZFOLDERTYPE INTEGER, ZNOTEDATA INTEGER);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE2, ZFOLDERTYPE) VALUES (100, 'Notes', 0), (101, 'Recently Deleted', 1);`);
  db.close();
  let next = 1;
  return {file, write(id, title, text, at, {folder = 100, locked = false} = {}) {
    const db = new DatabaseSync(file);
    const existing = db.prepare('SELECT ZNOTEDATA AS data FROM ZICCLOUDSYNCINGOBJECT WHERE ZIDENTIFIER = ?').get(id);
    if (existing) {
      db.prepare('UPDATE ZICNOTEDATA SET ZDATA = ? WHERE Z_PK = ?').run(noteBody(text), existing.data);
      db.prepare('UPDATE ZICCLOUDSYNCINGOBJECT SET ZMODIFICATIONDATE1 = ?, ZTITLE1 = ? WHERE ZIDENTIFIER = ?').run(since2001(at), title, id);
    } else {
      const data = next++;
      db.prepare('INSERT INTO ZICNOTEDATA VALUES (?, ?)').run(data, noteBody(text));
      db.prepare('INSERT INTO ZICCLOUDSYNCINGOBJECT (ZIDENTIFIER, ZTITLE1, ZMODIFICATIONDATE1, ZISPASSWORDPROTECTED, ZMARKEDFORDELETION, ZFOLDER, ZNOTEDATA) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(id, title, since2001(at), locked ? 1 : 0, folder, data);
    }
    db.close();
  }};
}

// A recordings store and the folder its recordings are kept in, in the shape the recordings row's query reads.
function recordingsStore(dir) {
  const folder = path.join(dir, 'Recordings');
  fs.mkdirSync(folder, {recursive: true});
  const file = path.join(folder, 'recordings.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ZCLOUDRECORDING (Z_PK INTEGER PRIMARY KEY, ZUNIQUEID TEXT, ZENCRYPTEDTITLE TEXT, ZCUSTOMLABEL TEXT, ZDATE REAL, ZDURATION REAL, ZPATH TEXT)');
  db.close();
  return {file, folder, record(id, title, at, seconds, name, {onDisk = true} = {}) {
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO ZCLOUDRECORDING (ZUNIQUEID, ZENCRYPTEDTITLE, ZDATE, ZDURATION, ZPATH) VALUES (?, ?, ?, ?, ?)').run(id, title, since2001(at), seconds, name);
    db.close();
    if (onDisk) fs.writeFileSync(path.join(folder, name), `made-up sound ${id}`);
  }};
}

// The account's door, standing in: each arrival becomes one of its rows (route and source_id), read back by the test.
function standInAccount({turnAway = () => null} = {}) {
  const kept = new Map(), asked = [], files = [];
  const one = body => {
    asked.push(`${body.route}:${body.source_id}`);
    const refusal = turnAway(body);
    if (refusal) return {error: refusal};
    const id = `${body.route}:${body.source_id}`;
    kept.set(id, {...body, arrivals: (kept.get(id)?.arrivals ?? 0) + 1});
    return {message_id: `message:${id}`, arrival_id: `arrival:${id}`, repeated: false};
  };
  return {
    rows: () => Object.fromEntries([...kept].map(([id, row]) => [id, row])),
    asked, files,
    keep: async file => { files.push(file.name); return {id: `file:${files.length}`, name: file.name}; },
    account: async (route, {body}) => {
      if (body.items) return {status: 200, body: {items: body.items.map(one)}};
      const answer = one(body);
      return answer.error ? {status: 422, body: {error: answer.error}} : {status: 200, body: answer};
    },
  };
}

test('new notes, recordings and pictures each arrive once, from their rows, as the account\'s own rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-are-rows-'));
  const notes = notesStore(dir), recordings = recordingsStore(dir);
  const pictures = path.join(dir, 'Pictures');
  fs.mkdirSync(pictures);
  const door = standInAccount();
  const start = Date.now() - 3 * 3_600_000;
  let clock = start;
  const heard = [];
  const carriers = [
    {...placeRead('Apple Notes'), store: notes.file},
    {...placeRead('Voice Memos'), store: recordings.file},
    {...placeRead('Screenshots'), store: pictures},
  ];
  const look = () => readNewItems({carriers, account: door.account, keep: door.keep, stateFile: path.join(dir, 'state.json'), readers: READERS,
    preview: async () => null, hear: async file => { heard.push(path.basename(file)); return {text: 'Bring the long lens.'}; }, keepWords: async () => {},
    now: () => new Date(clock)});

  notes.write('before', 'Before', 'written before the first look', start - 60_000);
  await look().tick();
  assert.deepEqual(door.asked, [], 'the first look only marks where each place starts; what came before is not sent');

  notes.write('n1', 'Shoot list', 'Film the drill at dawn', start + 60_000);
  notes.write('locked', 'Locked', 'never read out', start + 60_000, {locked: true});
  notes.write('gone', 'Gone', 'in the bin', start + 60_000, {folder: 101});
  recordings.record('m1', 'Rehearsal', start + 60_000, 125, 'm1.m4a');
  recordings.record('m2', null, start + 60_000, 7, 'm2.m4a', {onDisk: false});
  fs.writeFileSync(path.join(pictures, 'Screenshot one.png'), 'made-up picture one');
  fs.writeFileSync(path.join(pictures, 'Screenshot two.png'), 'made-up picture two');
  fs.writeFileSync(path.join(pictures, 'holiday.png'), 'not a screenshot');
  clock = Date.now() + 2 * 3_600_000;
  await look().tick();
  await look().tick();

  const kept = door.rows();
  assert.deepEqual(Object.keys(kept).sort(), ['Apple Notes:n1', 'Voice Memos:m1', ...Object.keys(kept).filter(id => id.startsWith('Screenshots:'))].sort());
  assert.equal(Object.keys(kept).filter(id => id.startsWith('Screenshots:')).length, 1, 'the pictures of one hour arrive as one item');
  for (const row of Object.values(kept)) assert.equal(row.arrivals, 1, `${row.route} ${row.source_id} arrives once`);
  assert.equal(kept['Apple Notes:n1'].text, 'Film the drill at dawn');
  assert.equal(kept['Apple Notes:n1'].title, 'Shoot list');
  assert.equal(kept['Voice Memos:m1'].text, 'A voice memo called "Rehearsal", 2:05 long. Its sound is the attached file.\n\nWhat was said:\nBring the long lens.');
  assert.equal(kept['Voice Memos:m1'].files.length, 1);
  assert.match(door.files[0], /^Rehearsal \d{4}-\d\d-\d\d \d\d:\d\d\.m4a$/, 'the recording is kept under its title and time');
  assert.deepEqual(heard, ['m1.m4a'], 'the recording is heard on this computer before it is sent, once');
  const screenshots = Object.values(kept).find(row => row.route === 'Screenshots');
  assert.match(screenshots.text, /Screenshot one\.png/);
  assert.match(screenshots.text, /Screenshot two\.png/);
  assert.doesNotMatch(screenshots.text, /holiday/, 'the row names which files of the folder are its place');

  // The recording whose file was not on this computer waits; once its file is here it arrives, once.
  fs.writeFileSync(path.join(recordings.folder, 'm2.m4a'), 'made-up sound m2');
  await look().tick();
  await look().tick();
  assert.equal(door.rows()['Voice Memos:m2'].text, 'A voice memo, 0:07 long. Its sound is the attached file.\n\nWhat was said:\nBring the long lens.');
  assert.equal(door.rows()['Voice Memos:m2'].arrivals, 1);
  assert.equal(door.asked.filter(id => id === 'Apple Notes:n1').length, 1, 'nothing already kept is asked about again');

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  for (const route of ['Apple Notes', 'Voice Memos', 'Screenshots']) assert.ok(saved[route].first_arrival_at || saved[route].last_sent, `${route} is arrived`);
});

test('an item the account turns away waits alone: the other items and places still arrive, and it is asked again only when it changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-are-rows-'));
  const notes = notesStore(dir), recordings = recordingsStore(dir);
  const door = standInAccount({turnAway: body => (body.source_id === 'too-much' && body.text.includes('every word') ? 'This note is more than the account takes in one item.' : null)});
  const start = Date.now() - 3 * 3_600_000;
  let clock = start;
  const carriers = [{...placeRead('Apple Notes'), store: notes.file, settle_seconds: 0}, {...placeRead('Voice Memos'), store: recordings.file, settle_seconds: 0}];
  const look = () => readNewItems({carriers, account: door.account, keep: door.keep, stateFile: path.join(dir, 'state.json'), readers: READERS,
    turnedAway: rows.turned_away, now: () => new Date(clock)});
  await look().tick();

  notes.write('too-much', 'Everything', 'every word I ever wrote', start + 60_000);
  notes.write('after', 'After it', 'the note after the refused one', start + 61_000);
  recordings.record('m1', 'Take one', start + 62_000, 30, 'm1.m4a');
  clock = start + 10 * 60_000;
  await look().tick();
  assert.deepEqual(Object.keys(door.rows()).sort(), ['Apple Notes:after', 'Voice Memos:m1'], 'the items after the refused one, and the other place, still arrive');

  clock += 5 * 60_000;
  await look().tick();
  assert.equal(door.asked.filter(id => id === 'Apple Notes:too-much').length, 1, 'the refused item is not asked about again while it is unchanged');

  notes.write('too-much', 'Everything, shorter', 'the short version', clock - 1000);
  await look().tick();
  assert.equal(door.rows()['Apple Notes:too-much'].text, 'the short version', 'once it changes it is asked about again and arrives');
  for (const row of Object.values(door.rows())) assert.equal(row.arrivals, 1);
});

test('a place with backfill reads its past newest first, in batches, and stops at its oldest item', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-are-rows-'));
  const file = path.join(dir, 'library.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE pictures (id TEXT, at INTEGER, title TEXT)');
  const start = Date.now() - 3_600_000;
  for (let day = 1; day <= 5; day += 1) db.prepare('INSERT INTO pictures VALUES (?, ?, ?)').run(`p${day}`, Math.floor((start - (6 - day) * 86_400_000) / 1000), `Picture ${day}`);
  db.close();
  // A made-up library place, a row like any other: its query reads :since, :before and :limit.
  const place = {route: 'Library', reader: 'sqlite', store: file, time: 'unix-seconds', settle_seconds: 0,
    query: 'SELECT id AS source_id, at, title, title AS text FROM pictures WHERE at > :since AND at < :before ORDER BY at DESC LIMIT :limit',
    backfill: {per_look: 2, every_seconds: 1, most_per_hour: 100}};
  const door = standInAccount();
  const batches = [];
  let clock = start;
  const account = async (route, request) => { if (request.body.items) batches.push(request.body.items.map(item => item.source_id)); return door.account(route, request); };
  const look = () => readNewItems({carriers: [place], account, keep: door.keep, stateFile: path.join(dir, 'state.json'), readers: READERS, now: () => new Date(clock)});
  for (let round = 0; round < 5; round += 1) { await look().tick(); clock += 2000; }
  assert.deepEqual(batches, [['p5', 'p4'], ['p3', 'p2'], ['p1']], 'newest first, two at a time, down to the oldest');
  assert.deepEqual(Object.keys(door.rows()).sort(), ['Library:p1', 'Library:p2', 'Library:p3', 'Library:p4', 'Library:p5']);
  for (const row of Object.values(door.rows())) assert.equal(row.arrivals, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).Library.backfill_done, true);
});

test('no reader names an app: every place a row reads uses a generic reader', () => {
  const readersUsed = new Set(rows.sources.filter(row => row.read).map(row => row.read.reader));
  assert.deepEqual([...readersUsed].filter(name => !Object.hasOwn(READERS, name)), []);
  assert.deepEqual(Object.keys(READERS).sort(), ['folder', 'incoming', 'sqlite']);
});
