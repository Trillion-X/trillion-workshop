// test/read-new-items.test.mjs
//
// PURPOSE
// What the person writes in a note on this Mac reaches their Trillion account's door (computer/read-new-items.mjs): only
// what changed after the carrier started, only once it has settled, once per version, never a locked or deleted
// note or a skipped folder; a store macOS refuses is reported and its Privacy pane opened once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {appleNoteText, readNewItems, READERS, DECODERS, grouped} from '../computer/read-new-items.mjs';

const EPOCH = 978307200;
const appleTime = iso => Date.parse(iso) / 1000 - EPOCH;
const bytesField = (field, bytes) => Buffer.concat([Buffer.from([(field << 3) | 2]), varint(bytes.length), bytes]);
const varint = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const noteBody = text => gzipSync(bytesField(2, Buffer.concat([Buffer.from([0x10, 0x00]), bytesField(3, Buffer.concat([bytesField(2, Buffer.from(text)), bytesField(3, Buffer.from([0x08, 0x01]))]))])));

function noteStore(dir, notes) {
  const file = path.join(dir, 'NoteStore.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZDATA BLOB);
    CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT, ZTITLE1 TEXT, ZTITLE2 TEXT, ZMODIFICATIONDATE1 REAL, ZISPASSWORDPROTECTED INTEGER, ZMARKEDFORDELETION INTEGER, ZFOLDER INTEGER, ZFOLDERTYPE INTEGER, ZNOTEDATA INTEGER);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE2, ZFOLDERTYPE) VALUES (100, 'Notes', 0), (101, 'Private', 0), (102, 'Recently Deleted', 1);`);
  notes.forEach((note, index) => {
    db.prepare('INSERT INTO ZICNOTEDATA VALUES (?, ?)').run(index + 1, noteBody(note.text));
    db.prepare('INSERT INTO ZICCLOUDSYNCINGOBJECT (ZIDENTIFIER, ZTITLE1, ZMODIFICATIONDATE1, ZISPASSWORDPROTECTED, ZMARKEDFORDELETION, ZFOLDER, ZNOTEDATA) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(note.id, note.title, appleTime(note.at), note.locked ? 1 : 0, note.folder ?? 100, index + 1);
  });
  db.close();
  return file;
}

test('the text of a note comes out of its gzipped body exactly', () => {
  assert.equal(appleNoteText(noteBody('Pickles\n\nand lean  beef')), 'Pickles\n\nand lean  beef');
});

test('a note changed after the carrier started is sent once it settles, once per version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  let clock = new Date('2026-09-27T20:00:00Z');
  const store = noteStore(dir, [
    {id: 'old', title: 'Old', text: 'written before', at: '2026-09-27T19:00:00Z'},
    {id: 'new', title: 'Pottery', text: 'Film the backup weapon drill', at: '2026-09-27T20:05:00Z'},
    {id: 'locked', title: 'Locked', text: 'secret', at: '2026-09-27T20:05:00Z', locked: true},
    {id: 'private', title: 'Private', text: 'skip me', at: '2026-09-27T20:05:00Z', folder: 101},
    {id: 'deleted', title: 'Gone', text: 'deleted', at: '2026-09-27T20:05:00Z', folder: 102},
  ]);
  const sent = [];
  const account = async (route, {body}) => { sent.push([route, body]); return {status: 200, body: {message_id: `m_${sent.length}`, arrival_id: `arrival:${sent.length}`, repeated: false}}; };
  const carrier = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store, settle_seconds: 120, skip_folders: ['Private']}], account, keep: async () => assert.fail('no files'), stateFile: path.join(dir, 'state.json'), now: () => clock});
  await carrier.tick();
  assert.deepEqual(sent, [], 'nothing is sent on the first look: the old note predates it and the new one is still changing');
  clock = new Date('2026-09-27T20:06:00Z');
  await carrier.tick();
  assert.deepEqual(carrier.status()[0].waiting, 1);
  assert.deepEqual(sent, []);
  clock = new Date('2026-09-27T20:08:00Z');
  await carrier.tick();
  assert.deepEqual(sent, [['/inbound', {route: 'Apple Notes', source_id: 'new', text: 'Film the backup weapon drill', at: '2026-09-27T20:05:00.000Z', title: 'Pottery'}]]);
  await carrier.tick();
  assert.equal(sent.length, 1, 'the same version is sent once');
  const again = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store, settle_seconds: 120, skip_folders: ['Private']}], account, keep: async () => {}, stateFile: path.join(dir, 'state.json'), now: () => clock});
  await again.tick();
  assert.equal(sent.length, 1, 'the cursor survives a restart');
  assert.equal(again.status()[0].last_sent.arrival_id, 'arrival:1');
  assert.equal(again.status()[0].last_sent.message_id, 'm_1');
});

test('an identity-less 200 is retried at the same cursor until the item has a receipt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const items = [
    {source_id: 'photo-1', title: 'Photo 1', text: 'First item', at: '2026-10-22T17:00:00.000Z'},
    {source_id: 'photo-2', title: 'Photo 2', text: 'Later item', at: '2026-10-22T17:01:00.000Z'},
  ];
  const calls = [];
  const answers = [
    {},
    {arrival_id: 'arrival:photo-1'},
    {},
    {message_id: 'message:photo-2'},
  ];
  const state = {Photos: {since: '2026-10-22T16:00:00.000Z', first_since: '2026-10-22T16:00:00.000Z', sent: {}}};
  fs.writeFileSync(stateFile, JSON.stringify(state));
  let clock = Date.parse('2026-10-22T18:00:00.000Z');
  const reader = readNewItems({carriers: [{route: 'Photos', reader: 'sqlite', store: path.join(dir, 'Photos.sqlite'), settle_seconds: 0,
    cursor: 'moves', reread_minutes: 0}], stateFile,
    readers: {sqlite: async (_carrier, since) => items.filter(item => Date.parse(item.at) > since.getTime())}, keep: async () => {},
    account: async (_route, {body}) => { calls.push(body.source_id); return {status: 200, body: answers.shift()}; },
    now: () => new Date(clock)});
  const resumeAfterWait = () => {
    const due = Date.parse(reader.status()[0].account_waits_until);
    assert.ok(Number.isFinite(due), 'the failed receipt retains its bounded account retry');
    clock = due + 1;
  };

  await reader.tick();

  let saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')).Photos;
  assert.match(reader.status()[0].status, /did not confirm an item receipt/);
  assert.deepEqual(calls, ['photo-1'], 'the later item waits behind the unconfirmed source');
  assert.equal(saved.sent['photo-1'], undefined);
  assert.equal(saved.since, '2026-10-22T16:00:00.000Z', 'the cursor cannot pass an item without a receipt');

  await reader.tick();
  assert.deepEqual(calls, ['photo-1'], 'the account backoff is preserved');
  resumeAfterWait();
  await reader.tick();

  saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')).Photos;
  assert.deepEqual(calls, ['photo-1', 'photo-1', 'photo-2'], 'the same source is retried before the later item');
  assert.deepEqual(Object.keys(saved.sent), ['photo-1'], 'an arrival_id alone acknowledges exactly the first item');
  assert.equal(saved.sent['photo-2'], undefined, 'a second identity-less 200 leaves the later item unsent');
  assert.equal(saved.since, '2026-10-22T16:00:00.000Z', 'the later unconfirmed item still blocks cursor advancement');

  resumeAfterWait();
  await reader.tick();

  saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')).Photos;
  assert.deepEqual(calls, ['photo-1', 'photo-1', 'photo-2', 'photo-2'], 'the acknowledged source is not sent again');
  assert.equal(saved.since, new Date(clock).toISOString(), 'the cursor advances after every item has a receipt');
});

test('a refused answer leaves the note to be sent on a later look', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const store = noteStore(dir, [{id: 'n', title: 'N', text: 'words', at: '2026-09-27T20:05:00Z'}]);
  let answer = {status: 402, body: {error: 'On the free plan nothing is kept.'}};
  const sent = [];
  const carrier = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store}], account: async (route, {body}) => { sent.push(body.source_id); return answer; }, keep: async () => {}, stateFile: path.join(dir, 'state.json'), now: () => new Date('2026-09-27T20:00:00Z')});
  await carrier.tick();
  let clock = '2026-09-27T20:10:00Z';
  const later = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store}], account: async (route, {body}) => { sent.push(body.source_id); return answer; }, keep: async () => {}, stateFile: path.join(dir, 'state.json'), now: () => new Date(clock)});
  await later.tick();
  assert.match(later.status()[0].status, /402: On the free plan/);
  answer = {status: 200, body: {message_id: 'm_x', arrival_id: 'arrival:x', repeated: false}};
  await later.tick();
  assert.deepEqual(sent, ['n'], 'the account is not asked again while it waits');
  assert.equal(later.status()[0].account_waits_until, '2026-09-27T20:11:00.000Z');
  clock = '2026-09-27T20:11:01Z';
  await later.tick();
  assert.deepEqual(sent, ['n', 'n']);
  assert.equal(later.status()[0].arrived, true);
  assert.equal(later.status()[0].status, 'working');
});

test('a recovered item clears its old failure and reports what the reader saw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const item = {source_id: 'n', title: 'N', text: 'words', at: '2026-10-07T10:01:00.000Z'};
  let clock = '2026-10-07T10:00:00.000Z';
  let answer = {status: 400, body: {error: 'temporarily refused'}};
  const reader = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', settle_seconds: 0}], stateFile,
    readers: {'apple-notes': async () => [item]}, keep: async () => {},
    account: async () => answer, now: () => new Date(clock), turnedAway: {ask_again_minutes: 1}});
  await reader.tick();
  clock = '2026-10-07T10:02:00.000Z';
  await reader.tick();
  assert.equal(reader.status()[0].failed.source_id, 'n');
  answer = {status: 200, body: {message_id: 'message:n', arrival_id: 'arrival:n'}};
  clock = '2026-10-07T10:04:00.000Z';
  await reader.tick();
  assert.equal(reader.status()[0].failed, null);
  assert.equal(reader.status()[0].latest_item_at, item.at);
  assert.equal(reader.status()[0].last_read_at, clock);
  assert.equal(reader.status()[0].seen_count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8'))['Apple Notes'].refused, {});
  const legacy = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  legacy['Apple Notes'].failed = {source_id: 'n', error: 'old refusal', at: clock};
  legacy['Apple Notes'].refused = {n: 'old refusal marker'};
  fs.writeFileSync(stateFile, JSON.stringify(legacy));
  const restarted = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', settle_seconds: 0}], stateFile,
    readers: {'apple-notes': async () => [item]}, keep: async () => {}, account: async () => assert.fail('already delivered'), now: () => new Date(clock)});
  await restarted.tick();
  assert.equal(restarted.status()[0].failed, null, 'old failure does not survive a confirmed delivery');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8'))['Apple Notes'].refused, {});
});

// On 2026-10-06 one 388,140-character note was turned away (400) on every look, and each turn-away made every place
// wait, so for five hours no voice memo after Apple Notes was sent.
test('an item the account turns away waits alone until it changes or its hour passes; the items and places after it still go', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  let notes = [{source_id: 'big', title: 'Big', text: 'too much', at: '2026-10-06T10:00:00.000Z'}, {source_id: 'small', title: 'Small', text: 'fits', at: '2026-10-06T10:01:00.000Z'}];
  const memos = [{source_id: 'memo', title: 'Memo', text: 'a memo', at: '2026-10-06T10:02:00.000Z'}];
  const asked = [];
  let clock = '2026-10-06T11:00:00Z';
  const look = () => readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store: dir, settle_seconds: 0}, {route: 'Voice Memos', reader: 'voice-memos', store: dir, settle_seconds: 0}], stateFile, keep: async () => assert.fail('no files'),
    readers: {'apple-notes': async () => notes.map(item => ({...item})), 'voice-memos': async () => memos.map(item => ({...item}))},
    now: () => new Date(clock),
    account: async (route, {body}) => { asked.push(body.source_id); return body.text === 'too much' ? {status: 400, body: {error: 'messages[0].text is 388140 characters; at most 200000.'}} : {status: 200, body: {message_id: 'm', arrival_id: `arrival:${body.source_id}`}}; }});
  await look().tick();
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const route of ['Apple Notes', 'Voice Memos']) state[route].since = '2026-10-06T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const carrier = look();
  await carrier.tick();
  assert.deepEqual(asked, ['big', 'small', 'memo'], 'the turned-away note stops nothing after it');
  const [noteStatus, memoStatus] = carrier.status();
  assert.equal(noteStatus.account_waits_until, null, 'the account itself is not made to wait');
  assert.equal(noteStatus.status, 'working');
  assert.equal(noteStatus.failed.source_id, 'big');
  assert.match(noteStatus.failed.error, /400: messages\[0\]\.text is 388140 characters/);
  assert.equal(memoStatus.last_sent.arrival_id, 'arrival:memo');
  await carrier.tick();
  assert.deepEqual(asked, ['big', 'small', 'memo'], 'the same turned-away version is not asked about again');
  clock = '2026-10-06T12:00:01Z';
  await carrier.tick();
  assert.deepEqual(asked, ['big', 'small', 'memo', 'big'], 'after its hour it is asked again, since the door can change');
  notes = [{...notes[0], text: 'shorter now', at: '2026-10-06T10:30:00.000Z'}, notes[1]];
  await carrier.tick();
  assert.deepEqual(asked, ['big', 'small', 'memo', 'big', 'big'], 'once it changes it is sent again');
});

test('words longer than long_text go whole as a text file beside the item, which carries their opening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const long = `${'a'.repeat(30)}${'b'.repeat(30)}`;
  const kept = [], bodies = [];
  const look = () => readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store: dir, settle_seconds: 0}], stateFile, workdir: path.join(dir, 'work'),
    longText: {characters: 30, file_name: '{title}', rest: '\n\n(the whole {characters} characters are in "{name}")'},
    readers: {'apple-notes': async () => [{source_id: 'n', title: 'Plan: v2', text: long, at: '2026-10-06T10:00:00.000Z'}, {source_id: 's', title: 'Short', text: 'short', at: '2026-10-06T10:01:00.000Z'}]},
    now: () => new Date('2026-10-06T11:00:00Z'),
    keep: async file => { kept.push({name: file.name, media_type: file.media_type, words: fs.readFileSync(file.path, 'utf8')}); return {id: '1f:words', name: file.name}; },
    account: async (route, {body}) => { bodies.push(body); return {status: 200, body: {message_id: 'm', arrival_id: 'arrival:n'}}; }});
  await look().tick();
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state['Apple Notes'].since = '2026-10-06T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await look().tick();
  assert.deepEqual(kept, [{name: 'Plan- v2.txt', media_type: 'text/plain; charset=utf-8', words: long}], 'the whole text is kept, once');
  assert.equal(bodies[0].text, `${'a'.repeat(30)}\n\n(the whole 60 characters are in "Plan- v2.txt")`);
  assert.deepEqual(bodies[0].files, [{id: '1f:words', name: 'Plan- v2.txt'}]);
  assert.equal(bodies[1].text, 'short');
  assert.equal(bodies[1].files, undefined, 'short words go as they are');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), [], 'nothing is left on this Mac');
});

test('a store that reads shows working at once, saved, and one item that cannot be sent does not stop the rest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const items = [
    {source_id: 'gone', title: 'Gone', text: 'memo whose file vanished', at: '2026-09-27T20:01:00.000Z', file: {path: '/nope.m4a', name: 'gone.m4a', media_type: 'audio/mp4'}},
    {source_id: 'kept', title: 'Kept', text: 'memo that opens', at: '2026-09-27T20:02:00.000Z', file: {path: '/yes.m4a', name: 'kept.m4a', media_type: 'audio/mp4'}},
  ];
  const sent = [];
  let statusWhenKeeping = null;
  const carrier = readNewItems({carriers: [{route: 'Voice Memos', reader: 'voice-memos', store: path.join(dir, 'x.db'), settle_seconds: 0}], stateFile,
    readers: {'voice-memos': async () => items.map(item => ({...item}))},
    now: () => new Date('2026-09-27T21:00:00Z'),
    keep: async file => { statusWhenKeeping ??= JSON.parse(fs.readFileSync(stateFile, 'utf8'))['Voice Memos'].status; if (file.path === '/nope.m4a') throw new Error('ENOENT: no such file'); return {id: '1f:ab', name: file.name}; },
    account: async (route, {body}) => { sent.push(body.source_id); return {status: 200, body: {message_id: 'm_1', arrival_id: 'arrival:1', repeated: false}}; }});
  // The first look sets `since`; the memos predate it, so move it back to let them through.
  await carrier.tick();
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state['Voice Memos'].since = '2026-09-27T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const second = readNewItems({carriers: [{route: 'Voice Memos', reader: 'voice-memos', store: path.join(dir, 'x.db'), settle_seconds: 0}], stateFile,
    readers: {'voice-memos': async () => items.map(item => ({...item}))},
    now: () => new Date('2026-09-27T21:00:00Z'),
    keep: async file => { statusWhenKeeping = JSON.parse(fs.readFileSync(stateFile, 'utf8'))['Voice Memos'].status; if (file.path === '/nope.m4a') throw new Error('ENOENT: no such file'); return {id: '1f:ab', name: file.name}; },
    account: async (route, {body}) => { sent.push(body.source_id); return {status: 200, body: {message_id: 'm_1', arrival_id: 'arrival:1', repeated: false}}; }});
  await second.tick();
  assert.equal(statusWhenKeeping, 'working', 'working is saved before any file is sent');
  assert.deepEqual(sent, ['kept'], 'the memo after the bad one still goes');
  const [status] = second.status();
  assert.equal(status.status, 'working');
  assert.equal(status.failed.source_id, 'gone');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))['Voice Memos'];
  assert.ok(saved.sent.kept, 'what was sent is saved');
  assert.equal(saved.sent.gone, undefined, 'what failed is tried again next look');
});

// On 2026-10-04 28 voice memos reached Trillion as a title and a length only: the account was too busy to hear them.
test('a place that hears sends its recording with the words said in it, kept beside the file, heard once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const recording = path.join(dir, 'memo.m4a');
  fs.writeFileSync(recording, 'sound');
  const item = {source_id: 'memo', title: 'Ideas', text: 'A voice memo called "Ideas", 0:12 long. Its sound is the attached file.', at: '2026-10-05T10:00:00.000Z', file: {path: recording, name: 'Ideas.m4a', media_type: 'audio/mp4'}};
  const words = {text: 'Ship the editor this week.', segments: [], heard_whole: true};
  const heard = [], kept = [], bodies = [];
  let answer = 503;
  const look = () => readNewItems({carriers: [{route: 'Voice Memos', reader: 'voice-memos', store: path.join(dir, 'x.db'), settle_seconds: 0, hear: {text: '{text}\n\nWhat was said:\n{words}'}}], stateFile,
    readers: {'voice-memos': async () => [{...item}]},
    now: () => new Date('2026-10-05T11:00:00Z'),
    hear: async file => { heard.push(file); return words; },
    keepWords: async (identity, value) => { kept.push([identity, value.text]); },
    keep: async file => ({id: '1f:memo', name: file.name}),
    account: async (route, {body}) => { bodies.push(body); return {status: answer, body: {arrival_id: 'arrival:1'}}; }}).tick();
  await look();
  assert.equal(bodies.length, 1, 'the busy account turned it away');
  // The account answers again; the memo goes with its words and is not heard a second time.
  const later = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete later.account_quiet_until;
  fs.writeFileSync(stateFile, JSON.stringify(later));
  answer = 200;
  await look();
  assert.deepEqual(heard, [recording], 'heard once, on this computer');
  assert.deepEqual(kept.at(-1), ['1f:memo', 'Ship the editor this week.'], 'the words are kept as the file\'s transcript');
  assert.equal(bodies.at(-1).text, `${item.text}\n\nWhat was said:\nShip the editor this week.`, 'the memo arrives with its words');
  assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8'))['Voice Memos'].sent.memo, 'sent once the account answered');
  // A place without `hear`, or a recording nothing here can hear, goes as before.
  const plain = [];
  const without = readNewItems({carriers: [{route: 'Voice Memos', reader: 'voice-memos', store: path.join(dir, 'x.db'), settle_seconds: 0, hear: {text: '{text} {words}'}}], stateFile: path.join(dir, 'other.json'), workdir: path.join(dir, 'other-work'),
    readers: {'voice-memos': async () => [{...item, source_id: 'other'}]}, now: () => new Date('2026-10-05T11:00:00Z'),
    hear: async () => null, keep: async file => ({id: '1f:memo', name: file.name}),
    account: async (route, {body}) => { plain.push(body.text); return {status: 200, body: {message_id: 'message:voice-memo'}}; }});
  await without.tick();
  const other = JSON.parse(fs.readFileSync(path.join(dir, 'other.json'), 'utf8'));
  other['Voice Memos'].since = '2026-10-05T00:00:00.000Z';
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify(other));
  await without.tick();
  assert.deepEqual(plain, [item.text]);
});

test('each look reads in a fresh child process and a missing store reports the reader\'s own error', async () => {
  const {CHILD_READERS} = await import('../computer/read-new-items.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  await assert.rejects(CHILD_READERS['apple-notes']({store: path.join(dir, 'missing', 'NoteStore.sqlite')}, new Date()), /unable to open database/);
});

test('a store macOS will not open is reported and its Privacy pane opened once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  let opened = 0;
  const carrier = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store: path.join(dir, 'NoteStore.sqlite')}], account: async () => assert.fail(), keep: async () => {}, stateFile: path.join(dir, 'state.json'),
    readers: {'apple-notes': () => { throw new Error('unable to open database file'); }}, openAccessPane: () => { opened += 1; }});
  await carrier.tick();
  await carrier.tick();
  assert.equal(opened, 1);
  assert.equal(carrier.status()[0].status, 'needs access');
});

test('a search finds older notes too, by every word in the title or text, and sends nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const store = noteStore(dir, [
    {id: 'early', title: 'Meaning of life', text: 'Distribution is integral: friends, family, the world.', at: '2025-01-02T10:00:00Z'},
    {id: 'later', title: 'Distribución plan', text: 'Post every day', at: '2026-09-20T10:00:00Z'},
    {id: 'other', title: 'Groceries', text: 'pickles, beef', at: '2026-09-21T10:00:00Z'},
    {id: 'locked', title: 'Distribution secret', text: 'locked away', at: '2026-09-22T10:00:00Z', locked: true},
  ]);
  const carrier = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store}, {route: 'Elsewhere', reader: 'apple-notes', store: path.join(dir, 'missing', 'x.sqlite')}],
    account: async () => assert.fail('a search sends nothing'), keep: async () => assert.fail(), stateFile: path.join(dir, 'state.json'), now: () => new Date('2026-09-28T00:00:00Z')});
  assert.deepEqual((await carrier.search('DISTRIBUCION')).items.map(item => item.source_id), ['later'], 'accents and case are ignored');
  const found = await carrier.search('plan');
  assert.deepEqual(found.items.map(item => item.source_id), ['later'], 'a title word matches');
  const distribution = await carrier.search('distribution');
  assert.deepEqual(distribution.items.map(item => item.source_id), ['early'], 'an older note is found; the locked one is never read out');
  assert.deepEqual(distribution.items[0], {route: 'Apple Notes', source_id: 'early', title: 'Meaning of life', at: '2025-01-02T10:00:00.000Z', text: 'Distribution is integral: friends, family, the world.'});
  assert.deepEqual((await carrier.search('distribution world')).items.map(item => item.source_id), ['early'], 'every word must appear');
  assert.equal(distribution.refused[0].route, 'Elsewhere', 'a store that cannot be read is named, not hidden');
  assert.deepEqual((await carrier.search('pickles', {routes: ['Elsewhere']})).items, []);
  await assert.rejects(carrier.search('  '), /what to look for/);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, 'a search changes no state');
});

test('while the account struggles every place waits, from 1 minute doubling to 30, and a 200 ends the wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const store = noteStore(dir, [{id: 'a', title: 'A', text: 'one', at: '2026-09-27T20:05:00Z'}]);
  let clock = Date.parse('2026-09-27T20:00:00Z'), asked = 0, answer = {status: 503, body: {error: 'busy'}};
  const carrier = readNewItems({carriers: [{route: 'Apple Notes', reader: 'apple-notes', store}, {route: 'Also', reader: 'apple-notes', store}], account: async () => { asked += 1; return answer; }, keep: async () => {}, stateFile: path.join(dir, 'state.json'), readers: READERS, now: () => new Date(clock)});
  await carrier.tick();
  assert.equal(asked, 0, 'the first look only marks where reading starts');
  clock = Date.parse('2026-09-27T20:10:00Z');
  const waits = [];
  for (let round = 0; round < 7; round += 1) {
    await carrier.tick();
    const until = Date.parse(carrier.status()[0].account_waits_until);
    waits.push((until - clock) / 1000);
    clock = until + 1000;
  }
  assert.deepEqual(waits, [60, 120, 240, 480, 960, 1800, 1800]);
  assert.equal(asked, 7, 'one request per wait, and the second place is not asked while the account waits');
  answer = {status: 200, body: {message_id: 'm', arrival_id: 'arrival:a'}};
  await carrier.tick();
  assert.equal(carrier.status()[0].account_waits_until, null);
});

// A Messages-shaped store: the words of newer messages are kept only in an attributed-string archive.
const archived = text => Buffer.concat([Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+', 'latin1'),
  text.length < 0x80 ? Buffer.from([text.length]) : Buffer.from([0x81, text.length & 0xff, text.length >> 8]), Buffer.from(text)]);

test('an archived message body turns back into its words, short or long', () => {
  assert.equal(DECODERS['typedstream-string'](archived('on my way')), 'on my way');
  const long = 'x'.repeat(300);
  assert.equal(DECODERS['typedstream-string'](archived(long)), long);
  assert.equal(DECODERS['typedstream-string'](null), null);
});

test('any SQLite store is read by its row: the query, its time unit, decoded words, and one item per conversation per hour', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const file = path.join(dir, 'chat.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE message (guid TEXT, date INTEGER, chat TEXT, who TEXT, text TEXT, body BLOB)');
  const at = iso => appleTime(iso) * 1e9;
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('old', at('2026-09-27T19:00:00Z'), 'c1', 'Me', 'before the first run', null);
  insert.run('m1', at('2026-09-27T20:05:00Z'), 'c1', 'Me', 'hello', null);
  insert.run('m2', at('2026-09-27T20:20:00Z'), 'c1', 'Sam', null, archived('hi back'));
  insert.run('m3', at('2026-09-27T20:25:00Z'), 'c2', 'Ada', 'other chat', null);
  insert.run('m4', at('2026-09-27T21:10:00Z'), 'c1', 'Sam', 'next hour', null);
  db.close();
  const carrier = {route: 'Messages', reader: 'sqlite', store: file, time: 'apple-seconds', cursor: 'moves', reread_minutes: 0, settle_seconds: 60,
    query: 'SELECT guid AS source_id, date / 1000000000.0 AS at, chat AS conversation, chat AS title, who, text, body FROM message WHERE date > :since * 1000000000',
    decode: [{from: 'body', decoder: 'typedstream-string', into: 'text'}], group: {by: 'conversation', window_minutes: 60, title: 'Messages with {title}', line: '{who}: {text}'}};
  const items = READERS.sqlite(carrier, new Date('2026-09-27T20:00:00Z'));
  assert.deepEqual(items.map(item => item.source_id), ['m1', 'm2', 'm3', 'm4']);
  assert.ok(items.every(item => !('body' in item)), 'raw archives never leave the reader');
  const windows = grouped(items, carrier.group);
  assert.deepEqual(windows.map(item => [item.source_id, item.title, item.text, item.at]), [
    ['c1@2026-09-27T20:00:00.000Z', 'Messages with c1', 'Me: hello\nSam: hi back', '2026-09-27T21:00:00.000Z'],
    ['c2@2026-09-27T20:00:00.000Z', 'Messages with c2', 'Ada: other chat', '2026-09-27T21:00:00.000Z'],
    ['c1@2026-09-27T21:00:00.000Z', 'Messages with c1', 'Sam: next hour', '2026-09-27T22:00:00.000Z']]);

  const sent = [];
  let clock = '2026-09-27T20:00:00Z';
  const carrying = readNewItems({carriers: [carrier], account: async (route, {body}) => { sent.push(body); return {status: 200, body: {message_id: 'm'}}; }, keep: async () => {}, stateFile: path.join(dir, 'state.json'), readers: READERS, now: () => new Date(clock)});
  await carrying.tick();
  clock = '2026-09-27T21:30:00Z';
  await carrying.tick();
  assert.deepEqual(sent.map(body => body.source_id), ['c1@2026-09-27T20:00:00.000Z', 'c2@2026-09-27T20:00:00.000Z'], 'an hour goes once it has closed and settled; the open hour waits');
  const held = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).Messages;
  assert.equal(held.since, '2026-09-27T21:00:00.000Z', 'the next read starts at the oldest window not yet sent');
  assert.deepEqual(Object.keys(held.sent), [], 'what can never be read again is forgotten');
  clock = '2026-09-27T22:02:00Z';
  await carrying.tick();
  assert.equal(sent.at(-1).text, 'Sam: next hour');
  assert.equal(sent.length, 3);
});

test('a store without the query\'s table is passed over, and when every store lacks it the reader says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  new DatabaseSync(path.join(dir, 'Data-local.sqlite')).close();
  const real = new DatabaseSync(path.join(dir, 'Data-1.sqlite'));
  real.exec("CREATE TABLE r (id TEXT, at REAL, title TEXT); INSERT INTO r VALUES ('x', 1000, 'Buy milk')");
  real.close();
  const carrier = {reader: 'sqlite', store: path.join(dir, 'Data-*.sqlite'), time: 'unix-seconds', query: 'SELECT id AS source_id, at, title FROM r WHERE at > :since', text: 'Reminder: {title}'};
  assert.deepEqual(READERS.sqlite(carrier, new Date(0)).map(item => item.text), ['Reminder: Buy milk']);
  assert.throws(() => READERS.sqlite({...carrier, store: path.join(dir, 'Data-local.sqlite')}, new Date(0)), /no such table/);
});

test('a folder gives its new files as words and a small preview, never the file itself', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const folder = path.join(dir, 'Desktop');
  fs.mkdirSync(folder);
  for (const name of ['Screenshot 1.png', 'notes.txt', 'Screenshot 2.png.part']) fs.writeFileSync(path.join(folder, name), 'x');
  const carrier = {route: 'Screenshots', reader: 'folder', store: folder, names_containing: ['Screenshot'], skip_endings: ['.part'], settle_seconds: 0, preview_px: 100, text: 'A screenshot at {path} ({size})'};
  const items = READERS.folder(carrier, new Date(0));
  assert.deepEqual(items.map(item => item.text), [`A screenshot at ${path.join(folder, 'Screenshot 1.png')} (1 B)`]);
  assert.deepEqual(READERS.folder(carrier, new Date(Date.now() + 60_000)), []);
  const kept = [], previewed = [];
  const carrying = readNewItems({carriers: [carrier], account: async () => ({status: 200, body: {message_id: 'message:screenshot'}}), stateFile: path.join(dir, 'state.json'), readers: {folder: () => items},
    keep: async file => { kept.push(file); return {id: 'f', name: file.name}; },
    preview: async (picture, px, workdir) => { previewed.push([picture, px]); fs.mkdirSync(workdir, {recursive: true}); const out = path.join(workdir, 'shot preview.jpg'); fs.writeFileSync(out, 'jpg'); return out; },
    now: () => new Date(Date.now() + 60_000)});
  await carrying.tick();
  assert.deepEqual(previewed, [[path.join(folder, 'Screenshot 1.png'), 100]]);
  assert.deepEqual(kept.map(file => [file.name, file.media_type]), [['shot preview.jpg', 'image/jpeg']]);
  assert.ok(!fs.existsSync(kept[0].path), 'the preview is removed once kept');
});

test('an account that keeps no files still gets the item\'s words, and a struggling account still makes it wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const carrier = {route: 'Screenshots', reader: 'folder', store: dir, settle_seconds: 0, preview_px: 100};
  const item = {source_id: 's1', title: 'Shot', text: 'A screenshot', at: new Date(0).toISOString(), picture: path.join(dir, 'Screenshot 1.png')};
  const sent = [];
  let refusal = new Error('the account answered 402: not the free plan');
  const carrying = readNewItems({carriers: [carrier], stateFile: path.join(dir, 'state.json'), readers: {folder: () => [item]},
    account: async (route, {body}) => { sent.push(body); return {status: 200, body: {message_id: 'm'}}; },
    keep: async () => { throw refusal; },
    preview: async (picture, px, workdir) => { fs.mkdirSync(workdir, {recursive: true}); const out = path.join(workdir, 'p.jpg'); fs.writeFileSync(out, 'jpg'); return out; },
    now: () => new Date(Date.now() + 60_000)});
  await carrying.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].files, undefined);
  assert.equal(carrying.status()[0].arrived, true);
  refusal = new Error('the account answered 503: busy');
  item.source_id = 's2';
  await carrying.tick();
  assert.equal(sent.length, 1, 'a struggling account is not sent to');
  assert.ok(carrying.status()[0].account_waits_until);
});

test('a sent hour of Mail is never sent again as its later half, and arrives as someone else\'s words', async () => {
  // 2026-09-30: the moving cursor slid through 10:00-11:00 of Mail and the same hour went out eight times, each shorter.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const mail = [
    ['1', '2026-09-30T17:15:00Z', 'Pikzels', 'One user did not open Pikzels for a week'],
    ['2', '2026-09-30T17:29:00Z', 'Matt McGarry', 'Crazy idea'],
    ['3', '2026-09-30T17:36:00Z', 'Industrious', 'Make room for what is next'],
    ['4', '2026-09-30T17:50:00Z', 'CodePen', 'Dissolving Pixels'],
  ].map(([source_id, at, sender, title]) => ({source_id, at, sender, title}));
  const carrier = {route: 'Mail', from_person: false, reader: 'sqlite', cursor: 'moves', settle_seconds: 120, text: '{sender}: {title}',
    group: {window_minutes: 60, title: 'Email, {time}', line: '{text}\n'}};
  const reads = [];
  const sent = [];
  let clock = '2026-09-30T17:00:00Z';
  const carrying = readNewItems({carriers: [carrier], stateFile: path.join(dir, 'state.json'), now: () => new Date(clock), keep: async () => {},
    readers: {sqlite: (row, since) => { reads.push(since.toISOString()); return mail.filter(item => Date.parse(item.at) > since.getTime()).map(item => ({...item, text: `${item.sender}: ${item.title}`})); }},
    account: async (route, {body}) => { sent.push(body); return {status: 200, body: {message_id: 'm', arrival_id: `arrival:${sent.length}`}}; }});
  await carrying.tick();
  for (const at of ['2026-09-30T18:02:30Z', '2026-09-30T18:16:00Z', '2026-09-30T18:30:00Z', '2026-09-30T18:37:00Z', '2026-09-30T18:46:00Z', '2026-09-30T18:59:00Z']) {
    clock = at;
    await carrying.tick();
  }
  assert.equal(sent.length, 1, 'the hour goes once, however far the cursor slides into it');
  assert.equal(sent[0].source_id, '@2026-09-30T17:00:00.000Z');
  assert.match(sent[0].text, /^Pikzels: .*\n\nMatt McGarry: .*\n\nIndustrious: .*\n\nCodePen: /);
  assert.equal(sent[0].from_person, false, 'mail was written by someone else, so the door hands it on as information');
  assert.ok(reads.slice(1).every(since => since === '2026-09-30T17:00:00.000Z'), `every read starts at the window's start: ${reads}`);
});

test('a failed grouped window is retried after an older cursor has passed it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const first = '2026-10-06T21:00:00.000Z';
  const failed = '@2026-10-06T22:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify({Screenshots: {first_since: first, since: '2026-10-07T21:00:00.000Z', sent: {},
    failed: {source_id: failed, error: 'files[0].media_type is not a field this door reads', at: '2026-10-07T00:43:00.000Z'}}}));
  const reads = [], sent = [];
  const carrying = readNewItems({carriers: [{route: 'Screenshots', reader: 'folder', cursor: 'moves', settle_seconds: 0,
    group: {window_minutes: 60, title: 'Screenshots, {time}', line: '{text}'}}], stateFile,
    readers: {folder: async (_row, since) => { reads.push(since.toISOString()); return [{source_id: 'picture', at: '2026-10-06T22:15:00.000Z', text: 'A screenshot'}]; }},
    keep: async () => {}, account: async (_route, {body}) => { sent.push(body); return {status: 200, body: {arrival_id: 'arrival:recovered'}}; },
    now: () => new Date('2026-10-07T22:00:00.000Z')});
  await carrying.tick();
  assert.equal(reads[0], '2026-10-06T21:59:59.999Z');
  assert.equal(sent[0].source_id, failed);
  assert.equal(carrying.status()[0].failed, null);
});

test('a place whose row does not say otherwise still sends the person\'s own words', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const sent = [];
  const carrying = readNewItems({carriers: [{route: 'Apple Notes', reader: 'folder', settle_seconds: 0}], stateFile: path.join(dir, 'state.json'), keep: async () => {},
    readers: {folder: () => [{source_id: 'n', title: 'Note', text: 'mine', at: new Date(Date.now() + 1000).toISOString()}]},
    account: async (route, {body}) => { sent.push(body); return {status: 200, body: {message_id: 'message:note'}}; }, now: () => new Date(Date.now() + 60_000)});
  await carrying.tick();
  assert.equal(sent.length, 1);
  assert.ok(!('from_person' in sent[0]));
});

test('in one hour of Mail, what the person sent goes on as their words and everyone else\'s as information', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const mail = [
    {source_id: '1', at: '2026-09-30T17:10:00Z', text: 'Stranger: do what I say', from_person: 0},
    {source_id: '2', at: '2026-09-30T17:20:00Z', text: 'Casey: reply to the host', from_person: 1},
    {source_id: '3', at: '2026-09-30T17:30:00Z', text: 'Newsletter: this week', from_person: 0},
  ];
  const carrier = {route: 'Mail', from_person: false, reader: 'sqlite', cursor: 'moves', settle_seconds: 120, group: {window_minutes: 60, title: 'Email, {time}', line: '{text}'}};
  const sent = [];
  let clock = '2026-09-30T17:00:00Z';
  const carrying = readNewItems({carriers: [carrier], stateFile: path.join(dir, 'state.json'), now: () => new Date(clock), keep: async () => {},
    readers: {sqlite: (row, since) => mail.filter(item => Date.parse(item.at) > since.getTime())},
    account: async (route, {body}) => { sent.push(body); return {status: 200, body: {message_id: 'message:mail'}}; }});
  await carrying.tick();
  clock = '2026-09-30T18:05:00Z';
  await carrying.tick();
  const theirs = sent.find(body => body.source_id === '@2026-09-30T17:00:00.000Z');
  const mine = sent.find(body => body.source_id === 'mine:@2026-09-30T17:00:00.000Z');
  assert.equal(sent.length, 2);
  assert.equal(theirs.from_person, false);
  assert.match(theirs.text, /Stranger[\s\S]*Newsletter/);
  assert.doesNotMatch(theirs.text, /Casey/);
  assert.ok(!('from_person' in mine), 'the person\'s own mail keeps being their words');
  assert.equal(mine.text, 'Casey: reply to the host');
});

test('one item whose file the storage will not finish waits alone; the places after it still go and the account is not made to wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const memo = path.join(dir, 'memo.m4a');
  fs.writeFileSync(memo, 'sound');
  let clock = Date.parse('2026-10-08T11:00:00Z');
  const sent = [];
  const items = {
    'voice-memos': [{source_id: 'memo', title: 'M', text: 'a memo', at: '2026-10-08T10:00:00.000Z', file: {path: memo, name: 'M.m4a', media_type: 'audio/mp4'}}],
    folder: [{source_id: 'photo', title: 'P', text: 'a photo', at: '2026-10-08T10:01:00.000Z'}],
    sqlite: [{source_id: 'text', title: 'T', text: 'a text', at: '2026-10-08T10:02:00.000Z'}],
  };
  const storage = new Error('503: The storage service did not finish this file (Durable Object is overloaded)');
  let keepAttempts = 0;
  const look = () => readNewItems({carriers: [['Voice Memos', 'voice-memos'], ['Photos', 'folder'], ['Messages', 'sqlite']].map(([route, reader]) => ({route, reader, store: dir, settle_seconds: 0})), stateFile,
    readers: Object.fromEntries(Object.entries(items).map(([reader, list]) => [reader, async () => list.map(item => ({...item}))])),
    now: () => new Date(clock), keep: async file => { keepAttempts += 1; if (keepAttempts <= 7) throw storage; return {id: 'kept-memo', name: file.name}; },
    account: async (route, {body}) => { sent.push(body); return {status: 200, body: {message_id: 'm', arrival_id: `arrival:${body.source_id}`}}; }});
  await look().tick();
  const first = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const route of ['Voice Memos', 'Photos', 'Messages']) first[route].since = '2026-10-08T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(first));
  const reader = look();
  await reader.tick();
  assert.deepEqual(sent.map(body => body.source_id), ['photo', 'text'], 'the other places send in the same look');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.account_quiet_until, undefined, 'the account is not made to wait for one file');
  assert.equal(state['Voice Memos'].stuck.memo.tries, 1);
  assert.match(reader.status()[0].failed.error, /did not finish this file/);
  await reader.tick();
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8'))['Voice Memos'].stuck.memo.tries, 1, 'it is not asked again before its time');

  // Each transient storage failure doubles its wait, capped by DATA. More than six failures still keep the item pending.
  const waits = [];
  for (let round = 0; round < 6; round += 1) {
    const held = JSON.parse(fs.readFileSync(stateFile, 'utf8'))['Voice Memos'].stuck.memo;
    waits.push(held.tries);
    clock = Date.parse(held.until) + 1000;
    await reader.tick();
  }
  assert.deepEqual(waits, [1, 2, 3, 4, 5, 6]);
  const final = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(final['Voice Memos'].stuck.memo.tries, 7);
  clock = Date.parse(final['Voice Memos'].stuck.memo.until) + 1000;
  await reader.tick();
  const withFile = sent.find(body => body.source_id === 'memo');
  assert.ok(withFile, 'the item is sent after a later file keep succeeds');
  assert.deepEqual(withFile.files, [{id: 'kept-memo', name: 'M.m4a'}], 'the successful arrival retains the actual file');
  assert.doesNotMatch(withFile.text, /could not be kept/);
  const done = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(done['Voice Memos'].sent.memo);
  assert.equal(done['Voice Memos'].stuck.memo, undefined);
});

test('under an account-wide 503 on the door each look starts at the next place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  let clock = Date.parse('2026-10-08T11:00:00Z');
  const asked = [];
  let live = false;
  const routes = ['One', 'Two', 'Three'], readerOf = {One: 'apple-notes', Two: 'voice-memos', Three: 'folder'};
  const look = () => readNewItems({carriers: routes.map(route => ({route, reader: readerOf[route], store: dir, settle_seconds: 0})), stateFile,
    readers: Object.fromEntries(routes.map(route => [readerOf[route], async () => live ? [{source_id: route, title: route, text: route, at: '2026-10-08T10:00:00.000Z'}] : []])),
    now: () => new Date(clock), keep: async () => assert.fail('no files'),
    account: async (route, {body}) => { asked.push(body.source_id); return {status: 503, body: {error: 'busy'}}; }});
  await look().tick();
  const first = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const route of routes) first[route].since = '2026-10-08T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(first));
  live = true;
  const reader = look();
  for (let round = 0; round < 4; round += 1) {
    await reader.tick();
    clock = Date.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8')).account_quiet_until) + 1000;
  }
  assert.equal(asked.length, 4, 'one request per look while the account waits');
  assert.deepEqual(asked.slice(0, 3).sort(), ['One', 'Three', 'Two'], 'three looks reach three different places');
});

test('after a place sets the account-wide wait, the next look starts at the place behind it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  let clock = Date.parse('2026-10-08T11:00:00Z');
  const asked = [];
  let live = false;
  const routes = ['Quiet', 'Stuck', 'Behind', 'Last'], readerOf = {Quiet: 'apple-notes', Stuck: 'voice-memos', Behind: 'folder', Last: 'wispr-flow'};
  const look = () => readNewItems({carriers: routes.map(route => ({route, reader: readerOf[route], store: dir, settle_seconds: 0})), stateFile,
    readers: Object.fromEntries(routes.map(route => [readerOf[route], async () => live && route !== 'Quiet' ? [{source_id: route, title: route, text: route, at: '2026-10-08T10:00:00.000Z'}] : []])),
    now: () => new Date(clock), keep: async () => assert.fail('no files'),
    account: async (route, {body}) => { asked.push(body.source_id); return body.source_id === 'Stuck' ? {status: 503, body: {error: 'busy'}} : {status: 200, body: {ok: true}}; }});
  await look().tick();
  const first = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const route of routes) first[route].since = '2026-10-08T00:00:00.000Z';
  first.next_place = 0;
  fs.writeFileSync(stateFile, JSON.stringify(first));
  live = true;
  const reader = look();
  await reader.tick();
  assert.deepEqual(asked, ['Stuck'], 'the first look stops at the place the account refused');
  clock = Date.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8')).account_quiet_until) + 1000;
  await reader.tick();
  assert.equal(asked[1], 'Behind', 'the next look starts behind the refused place, not at it');
});

test('a file the account could not be reached for makes every place wait, not item after item', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const picture = path.join(dir, 'p.jpg');
  fs.writeFileSync(picture, 'pixels');
  const clock = Date.parse('2026-10-08T11:00:00Z');
  let kept = 0;
  const items = {folder: ['a', 'b', 'c'].map((id, n) => ({source_id: id, title: id, text: id, at: `2026-10-08T10:0${n}:00.000Z`, file: {path: picture, name: `${id}.jpg`, media_type: 'image/jpeg'}}))};
  const look = () => readNewItems({carriers: [{route: 'Photos', reader: 'folder', store: dir, settle_seconds: 0}], stateFile,
    readers: {folder: async () => items.folder.map(item => ({...item}))},
    now: () => new Date(clock), keep: async () => { kept += 1; throw new Error('the account could not be reached'); },
    account: async () => ({status: 200, body: {message_id: 'm', arrival_id: 'arrival:x'}})});
  await look().tick();
  const first = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  first.Photos.since = '2026-10-08T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(first));
  await look().tick();
  assert.equal(kept, 1, 'one unanswered file stops the look');
  assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).account_quiet_until, 'every place waits for the account');
});

test('history keeps retrying a transient file storage failure past six attempts and sends the file after success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const picture = path.join(dir, 'past.jpg');
  fs.writeFileSync(picture, 'pixels');
  let clock = Date.parse('2026-10-08T11:00:00Z');
  let keepAttempts = 0;
  const storage = new Error('503: The storage service did not finish this file (Durable Object is overloaded)');
  const sent = [];
  const reader = readNewItems({carriers: [{route: 'Photos', reader: 'sqlite', store: dir, settle_seconds: 0,
    backfill: {per_look: 1, every_seconds: 1, most_per_hour: 100}}], stateFile,
    readers: {sqlite: async carrier => carrier.before ? [{source_id: 'past-photo', title: 'Past', text: 'a past photo', at: '2026-10-01T10:00:00.000Z', file: {path: picture, name: 'past.jpg', media_type: 'image/jpeg'}}] : []},
    now: () => new Date(clock), keep: async file => { keepAttempts += 1; if (keepAttempts <= 7) throw storage; return {id: 'kept-past-photo', name: file.name}; },
    account: async (_route, {body}) => { sent.push(body); return {status: 200, body: {items: [{}]}}; }});
  await reader.tick();
  let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (let tries = 1; tries <= 7; tries += 1) {
    assert.equal(state.Photos.backfill_failures['past-photo'], tries);
    assert.equal(state.Photos.backfill_before, state.Photos.first_since, 'the failed item keeps the history cursor pending');
    assert.equal(sent.length, 0, 'a transient file failure never sends metadata-only history');
    clock = Date.parse(state.Photos.backfill_retry_until) + 1;
    await reader.tick();
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  }
  assert.equal(keepAttempts, 8);
  assert.deepEqual(sent[0].items[0].files, [{id: 'kept-past-photo', name: 'past.jpg'}]);
  assert.equal(state.Photos.backfill_count, 1, 'history advances only after the file is kept and the account accepts it');
});

test('history keeps retrying per-item account storage refusals beyond six attempts with its full file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const picture = path.join(dir, 'past.jpg');
  fs.writeFileSync(picture, 'pixels');
  let clock = Date.parse('2026-10-08T11:00:00Z');
  const sent = [];
  const reader = readNewItems({carriers: [{route: 'Photos', reader: 'sqlite', store: dir, settle_seconds: 0,
    backfill: {per_look: 1, every_seconds: 1, most_per_hour: 100}}], stateFile,
    readers: {sqlite: async carrier => carrier.before ? [{source_id: 'past-photo', title: 'Past', text: 'a past photo', at: '2026-10-01T10:00:00.000Z', file: {path: picture, name: 'past.jpg', media_type: 'image/jpeg'}}] : []},
    now: () => new Date(clock), keep: async file => ({id: 'kept-past-photo', name: file.name}),
    account: async (_route, {body}) => {
      sent.push(body.items[0]);
      return sent.length <= 7
        ? {status: 200, body: {items: [{error: 'The storage service did not finish this file (Durable Object overloaded)'}]}}
        : {status: 200, body: {items: [{}]}};
    }});
  await reader.tick();
  let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (let tries = 1; tries <= 6; tries += 1) {
    assert.equal(state.Photos.backfill_item_file_tries?.['past-photo'], tries);
    assert.equal(state.Photos.backfill_before, state.Photos.first_since, 'the rejected item remains pending');
    clock = Date.parse(state.Photos.backfill_retry_until) + 1;
    await reader.tick();
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  }
  assert.equal(sent.length, 7);
  assert.ok(sent.every(item => item.files?.[0]?.id === 'kept-past-photo'), 'every retry retains the full file');
  assert.equal(state.Photos.backfill_item_file_tries['past-photo'], 7);
  assert.equal(state.Photos.backfill_count ?? 0, 0, 'repeated overload has not completed or abandoned the item');
  clock = Date.parse(state.Photos.backfill_retry_until) + 1;
  await reader.tick();
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(sent.length, 8);
  assert.equal(sent[7].source_id, 'past-photo');
  assert.deepEqual(sent[7].files, [{id: 'kept-past-photo', name: 'past.jpg'}]);
  assert.equal(state.Photos.backfill_count, 1);
});

test('history retries transient per-item storage errors without redelivering completed siblings', async () => {
  for (const permanentlyRefused of [false, true]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'written-elsewhere-'));
  const stateFile = path.join(dir, 'state.json');
  const pendingFile = path.join(dir, 'pending.jpg');
  const keptFile = path.join(dir, 'kept.jpg');
  fs.writeFileSync(pendingFile, 'pixels');
  fs.writeFileSync(keptFile, 'pixels');
  let clock = Date.parse('2026-10-08T11:00:00Z');
  const items = [
    {source_id: 'storage-pending', title: 'Pending', text: 'pending file', at: '2026-10-01T10:00:00.000Z', file: {path: pendingFile, name: 'pending.jpg', media_type: 'image/jpeg'}},
    {source_id: 'already-kept', title: 'Kept', text: 'other file', at: '2026-10-01T10:00:00.000Z', file: {path: keptFile, name: 'kept.jpg', media_type: 'image/jpeg'}},
    {source_id: 'same-time-next', title: 'Next', text: 'next file', at: '2026-10-01T10:00:00.000Z', file: {path: keptFile, name: 'next.jpg', media_type: 'image/jpeg'}},
  ];
  const calls = [];
  let failFirst = true;
  const reader = readNewItems({carriers: [{route: 'Photos', reader: 'sqlite', store: dir, settle_seconds: 0,
    backfill: {per_look: 2, every_seconds: 1, most_per_hour: 100}}], stateFile,
    readers: {sqlite: async carrier => carrier.before ? items.map(item => ({...item})) : []},
    now: () => new Date(clock), keep: async file => ({id: file.name, name: file.name}),
    account: async (_route, {body}) => {
      calls.push(body.items.map(item => item.source_id));
      if (failFirst) { failFirst = false; return {status: 200, body: {items: [{error: 'The storage service did not finish this file (Durable Object overloaded)'}, permanentlyRefused ? {error: 'This item is invalid'} : {}]}}; }
      return {status: 200, body: {items: [{}, {}]}};
    }});
  await reader.tick();
  let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.Photos.backfill_count ?? 0, permanentlyRefused ? 0 : 1);
  assert.deepEqual(state.Photos.backfill_seen, ['already-kept']);
  assert.equal(state.Photos.backfill_before, state.Photos.first_since, 'the cursor remains at the partial batch');
  clock = Date.parse(state.Photos.backfill_retry_until) + 1;
  await reader.tick();
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(calls, [['storage-pending', 'already-kept'], ['storage-pending', 'same-time-next']]);
  assert.equal(state.Photos.backfill_count, permanentlyRefused ? 2 : 3);
  }
});
