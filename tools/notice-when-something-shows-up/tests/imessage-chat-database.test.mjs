// tools/notice-when-something-shows-up: the iMessage waiter tells each message once, as Messages writes it, and never sends.
//
// The database is a real SQLite file with the Messages tables the leaf reads (message, handle, chat, chat_message_join,
// attachment, message_attachment_join), so these tests cover the real read, the words decoding the iMessage connection
// owns, and the dates as nanosecond text past 2^53. Numbers are the reserved fiction ranges (555-01xx).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  CARRIED_BYTES, accessChange, afterOf, appleNanos, changesSince, describeMechanism, readDatabase, readSettings, watchEach, watchForTransitions,
} from '../do-work/mechanisms/imessage-chat-database.mjs';

const FRIEND = '+15555550101';
const OTHER = '+15555550102';
const DM = 'iMessage;-;+15555550101';
const GROUP = 'iMessage;+;chat555000199';
const BASE = '2026-11-20T06:30:00.000Z';
const nanos = (iso) => appleNanos(iso);
const plus = (seconds) => new Date(Date.parse(BASE) + seconds * 1000).toISOString();

function database(t) {
  const folder = mkdtempSync(path.join(tmpdir(), 'imessage-waiter-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'chat.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, date_edited INTEGER DEFAULT 0,
      date_retracted INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0,
      thread_originator_guid TEXT, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, mime_type TEXT, uti TEXT, transfer_name TEXT, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle VALUES (1, '${FRIEND}'), (2, '${OTHER}');
    INSERT INTO chat VALUES (1, '${DM}', '${FRIEND}', '', 45), (2, '${GROUP}', 'chat555000199', 'Tennis crew', 43);`);
  let row = 0;
  const add = ({ guid, text = null, body = null, at = BASE, handle = 1, chat = 1, mine = 0, audio = 0, reaction = 0, reply = null, attachments = [] }) => {
    row += 1;
    db.prepare(`INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, is_audio_message, associated_message_type, thread_originator_guid, handle_id)
      VALUES (?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?)`).run(row, guid, text, body, nanos(at), mine, audio, reaction, reply, handle);
    db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(chat, row);
    for (const [index, item] of attachments.entries()) {
      const id = row * 10 + index;
      db.prepare('INSERT INTO attachment VALUES (?, ?, ?, ?, ?, ?)').run(id, item.guid, item.mime ?? null, item.uti ?? null, item.name ?? null, item.bytes ?? 0);
      db.prepare('INSERT INTO message_attachment_join VALUES (?, ?)').run(row, id);
    }
    return row;
  };
  const edit = (guid, { text, at }) => db.prepare('UPDATE message SET text = ?, date_edited = CAST(? AS INTEGER) WHERE guid = ?').run(text, nanos(at), guid);
  const unsend = (guid, at) => db.prepare("UPDATE message SET text = NULL, date_retracted = CAST(? AS INTEGER) WHERE guid = ?").run(nanos(at), guid);
  return { file, folder, db, add, edit, unsend, reader: () => readDatabase(new DatabaseSync(file, { readOnly: true })) };
}

// The attributedBody shape Messages writes when the text column is empty: NSString, '+', a one-byte length, the words.
const attributed = (words) => Buffer.concat([Buffer.from('streamtyped\u0000NSAttributedString\u0000NSString\u0001+'), Buffer.from([Buffer.byteLength(words)]), Buffer.from(words)]);
const own = readSettings({ history_since: BASE });
const start = (reader) => ({ last_row: 0, edited_mark: '0', retracted_mark: '0', started_at: BASE, told: [] });

test('the leaf declares its identity and the eight fields of a change fact', () => {
  assert.deepEqual(describeMechanism().detail_fields, ['where', 'place', 'change', 'at', 'key', 'by', 'after', 'kinds']);
  assert.equal(readSettings({}).where, 'imessage');
  assert.equal(readSettings({}).database, 'Library/Messages/chat.db');
  assert.deepEqual(readSettings({}).kinds, ['seed']);
  assert.equal(readSettings({ history_since: 'not a time' }).history_since, null);
});

test('a text, a words-only-in-attributedBody text, an attachment and a group message are each one added fact', (t) => {
  const d = database(t);
  d.add({ guid: 'M1', text: 'can you share the footage you have of me?', at: plus(1) });
  d.add({ guid: 'M2', body: attributed('see you Thursday'), at: plus(2) });
  d.add({ guid: 'M3', text: '￼', at: plus(3), attachments: [{ guid: 'AT-1', mime: 'image/jpeg', name: 'IMG_0001.jpeg', bytes: 1200 }] });
  d.add({ guid: 'M4', text: 'court 3 at 6?', at: plus(4), chat: 2, handle: 2 });
  d.add({ guid: 'M5', audio: 1, at: plus(5), attachments: [{ guid: 'AT-2', mime: 'audio/x-caf', name: 'Audio Message.caf' }] });
  d.add({ guid: 'R1', text: 'Loved “court 3 at 6?”', reaction: 2000, at: plus(6), chat: 2 });
  const { changes, state } = changesSince(own, d.reader(), start());
  assert.deepEqual(changes.map((c) => c.event_key), [`${DM}/M1:added`, `${DM}/M2:added`, `${DM}/M3:added`, `${GROUP}/M4:added`, `${DM}/M5:added`], 'a tapback is not a message');
  const [first, second, third, fourth, fifth] = changes.map((c) => ({ ...c.detail, after: JSON.parse(c.detail.after) }));
  assert.deepEqual(first, { where: 'imessage', place: 'message', change: 'added', at: plus(1), key: `${DM}/M1`, by: FRIEND,
    after: { chat: DM, chat_name: null, group: false, from: FRIEND, words: 'can you share the footage you have of me?', media: [], reply_to: null }, kinds: '["seed"]' });
  assert.equal(second.after.words, 'see you Thursday');
  assert.equal(third.after.words, null);
  assert.deepEqual(third.after.media, [{ kind: 'photo', identity: 'AT-1', media_type: 'image/jpeg', bytes: 1200, name: 'IMG_0001.jpeg' }]);
  assert.deepEqual({ group: fourth.after.group, chat_name: fourth.after.chat_name, from: fourth.by }, { group: true, chat_name: 'Tennis crew', from: OTHER });
  assert.equal(fifth.after.media[0].kind, 'voice_note');
  assert.equal(state.last_row, 6);
  for (const change of changes) for (const value of Object.values(change.detail)) assert.ok(value === null || Buffer.byteLength(value) <= 1024);
});

test('an edit is a changed fact under the same key, and an unsend a removed one; neither is told again', (t) => {
  const d = database(t);
  d.add({ guid: 'M1', text: 'can you share the footage?', at: plus(1) });
  let { state } = changesSince(own, d.reader(), start());
  d.edit('M1', { text: 'can you share both clips?', at: plus(60) });
  let read = changesSince(own, d.reader(), state);
  assert.deepEqual(read.changes.map((c) => [c.detail.change, c.detail.key, c.detail.at, JSON.parse(c.detail.after).words]), [['changed', `${DM}/M1`, plus(60), 'can you share both clips?']]);
  assert.equal(read.changes[0].event_key, `${DM}/M1:changed:${nanos(plus(60))}`);
  state = read.state;
  assert.deepEqual(changesSince(own, d.reader(), state).changes, [], 'the same edit is not told twice');
  d.unsend('M1', plus(90));
  read = changesSince(own, d.reader(), state);
  assert.deepEqual(read.changes.map((c) => [c.event_key, c.detail.change, c.detail.at]), [[`${DM}/M1:removed`, 'removed', plus(90)]]);
  assert.deepEqual(JSON.parse(read.changes[0].detail.after), { chat: DM, chat_name: null, group: false, from: FRIEND });
});

test('history_since: messages before it are not told, and the person\'s own sends are left out unless asked for', (t) => {
  const d = database(t);
  d.add({ guid: 'OLD', text: 'yesterday', at: '2026-11-19T20:00:00.000Z' });
  d.add({ guid: 'MINE', text: 'on my way', mine: 1, at: plus(1) });
  d.add({ guid: 'NEW', text: 'today', at: plus(2) });
  assert.deepEqual(changesSince(own, d.reader(), start()).changes.map((c) => c.detail.key), [`${DM}/NEW`]);
  const withOwn = readSettings({ history_since: BASE, include_own: true });
  const mine = changesSince(withOwn, d.reader(), start()).changes.find((c) => c.detail.key === `${DM}/MINE`);
  assert.equal(mine.detail.by, 'me');
});

test('words longer than a fact field are cut to fit and marked with their whole length', () => {
  const words = 'tennis '.repeat(400);
  const after = afterOf({ chat: DM, group: false, from: FRIEND, words, media: [], reply_to: null });
  assert.ok(Buffer.byteLength(after) <= CARRIED_BYTES);
  const parsed = JSON.parse(after);
  assert.equal(parsed.words_cut, Buffer.byteLength(words));
  assert.ok(words.startsWith(parsed.words));
});

function run(t, d, { state = null, settings = {}, open } = {}) {
  const controller = new AbortController();
  const facts = [];
  const kept = [];
  let wake = null;
  const done = watchForTransitions({ database: d.file, history_since: BASE, settle_ms: 1, ...settings }, {
    signal: controller.signal, state, now: () => Date.parse(plus(30)),
    open: open ?? ((file) => new DatabaseSync(file, { readOnly: true })),
    watchFiles: (files, onWake) => { assert.deepEqual(files, [d.file, `${d.file}-wal`]); wake = onWake; return { close() {} }; },
    keepState: async (value) => kept.push(value),
    onTransition: async (transition) => { facts.push(transition); return true; },
  });
  t.after(async () => { controller.abort(); await done; });
  return { facts, kept, wake: () => wake?.(), controller, done };
}

const until = async (check, what) => {
  for (let i = 0; i < 400; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail(`timed out waiting for ${what}`);
};

test('live: a write in the folder wakes one read; a restart from the kept state tells nothing twice', async (t) => {
  const d = database(t);
  d.add({ guid: 'M1', text: 'first', at: plus(1) });
  const w = run(t, d);
  await until(() => w.facts.length === 1, 'the message since history_since');
  d.add({ guid: 'M2', text: 'second', at: plus(2) });
  w.wake(); w.wake(); w.wake();
  await until(() => w.facts.length === 2, 'the woken read');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(w.facts.length, 2, 'a burst of writes is one read');
  assert.deepEqual(w.facts.map((f) => f.event_key), [`${DM}/M1:added`, `${DM}/M2:added`]);
  w.controller.abort(); await w.done;
  const state = w.kept.at(-1);
  assert.equal(state.last_row, 2);
  const again = run(t, d, { state });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(again.facts.length, 0, 'a restart from the kept state tells nothing already told');
  d.add({ guid: 'M3', text: 'third', at: plus(3) });
  again.wake();
  await until(() => again.facts.length === 1, 'only the new message');
  assert.equal(again.facts[0].detail.key, `${DM}/M3`);
});

test('with no history_since, the first start tells nothing already in the database', async (t) => {
  const d = database(t);
  d.add({ guid: 'M1', text: 'already there', at: plus(1) });
  const w = run(t, d, { settings: { history_since: undefined } });
  await until(() => w.kept.length >= 1, 'the start kept');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.facts.length, 0);
  d.add({ guid: 'M2', text: 'new', at: plus(40) });
  w.wake();
  await until(() => w.facts.length === 1, 'the new message');
});

test('a refused database is told once at place "access" with the setting to change, then the leaf waits', async (t) => {
  const d = database(t);
  const w = run(t, d, { open: () => { throw new Error('unable to open database file: authorization denied'); } });
  await until(() => w.facts.length === 1, 'the refusal fact');
  const fact = w.facts[0];
  assert.equal(fact.detail.place, 'access');
  assert.deepEqual(JSON.parse(fact.detail.kinds), ['imessage-needs-full-disk-access']);
  assert.match(JSON.parse(fact.detail.after).setting, /Full Disk Access/);
  let finished = false;
  w.done.then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false, 'it waits instead of failing or spinning');
  assert.equal(accessChange(own, new Error('x'), BASE, '/opt/node').event_key, 'access:refused');
});

test('each file is watched on its own; a missing file or a failed watch is no crash, and the other file rewatches it', () => {
  const made = [];
  let walThere = false;
  const fake = (file, options, onChange) => {
    if (file.endsWith('-wal') && !walThere) { const error = new Error('no file'); error.code = 'ENOENT'; throw error; }
    const handlers = {};
    const watcher = { file, onChange, close() { this.closed = true; }, on(event, handler) { handlers[event] = handler; }, fail(error) { handlers.error?.(error); } };
    made.push(watcher);
    return watcher;
  };
  let wakes = 0;
  const watching = watchEach(['/m/chat.db', '/m/chat.db-wal'], () => { wakes += 1; }, { watchFile: fake });
  assert.deepEqual(made.map((m) => m.file), ['/m/chat.db'], 'the -wal file that is not there yet is skipped');
  walThere = true;
  made[0].onChange();
  assert.equal(wakes, 1);
  assert.deepEqual(made.map((m) => m.file), ['/m/chat.db', '/m/chat.db-wal'], 'a wake watches the -wal file once it is there');
  made[1].fail(Object.assign(new Error('too many'), { code: 'EMFILE' }));
  assert.equal(made[1].closed, true, 'a failed watch is closed, not thrown');
  made[0].onChange();
  assert.equal(made.at(-1).file, '/m/chat.db-wal', 'and watched again at the next wake');
  watching.close();
  assert.throws(() => watchEach(['/m/none'], () => {}, { watchFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), /could be watched/);
});
