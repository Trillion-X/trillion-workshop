// tools/notice-when-something-shows-up: one page of the messages already there, newest first, told to nobody.
//
// The database is a real SQLite file with the Messages tables the leaf reads. Numbers are the reserved fiction ranges (555-01xx).
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { appleNanos, changesSince, readDatabase, readSettings } from '../do-work/mechanisms/imessage-chat-database.mjs';
import { readAPage } from '../do-work/read-a-page-of-messages.mjs';

const FRIEND = '+15555550101';
const DM = 'iMessage;-;+15555550101';
const BASE = '2026-11-20T06:30:00.000Z';
const plus = (seconds) => new Date(Date.parse(BASE) + seconds * 1000).toISOString();

function database(t, messages) {
  const folder = tempFolder(path.join(tmpdir(), 'imessage-page-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'chat.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, date_edited INTEGER DEFAULT 0,
      date_retracted INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, account TEXT, is_audio_message INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0,
      thread_originator_guid TEXT, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, mime_type TEXT, uti TEXT, transfer_name TEXT, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle VALUES (1, '${FRIEND}');
    INSERT INTO chat VALUES (1, '${DM}', '${FRIEND}', '', 45);`);
  messages.forEach(({ text, mine = 0, reaction = 0, account = null }, index) => {
    const row = index + 1;
    db.prepare(`INSERT INTO message (ROWID, guid, text, date, is_from_me, associated_message_type, handle_id, account)
      VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, 1, ?)`).run(row, `GUID-${row}`, text, appleNanos(plus(row * 60)), mine, reaction, account);
    db.prepare('INSERT INTO chat_message_join VALUES (1, ?)').run(row);
  });
  db.close();
  return { file, open: (target) => new DatabaseSync(target, { readOnly: true }) };
}

const words = (count) => Array.from({ length: count }, (_, index) => ({ text: `made-up words ${index + 1}` }));

test('a page is the newest messages first, and the next page starts where it ended', (t) => {
  const { file, open } = database(t, words(7));
  const first = readAPage({ database: file, max_facts: 3 }, { open });
  assert.deepEqual(first.facts.map((fact) => fact.key.split('/')[1]), ['GUID-7', 'GUID-6', 'GUID-5']);
  assert.equal(first.next_before_row, 5);
  assert.equal(first.done, false);
  const second = readAPage({ database: file, max_facts: 3, before_row: first.next_before_row }, { open });
  assert.deepEqual(second.facts.map((fact) => fact.key.split('/')[1]), ['GUID-4', 'GUID-3', 'GUID-2']);
  const third = readAPage({ database: file, max_facts: 3, before_row: second.next_before_row }, { open });
  assert.deepEqual(third.facts.map((fact) => fact.key.split('/')[1]), ['GUID-1']);
  assert.equal(third.done, true);
});

test('every page together is every message once, with the watcher\'s own facts', (t) => {
  const { file, open } = database(t, words(12));
  const seen = [];
  let before_row;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = readAPage({ database: file, max_facts: 5, before_row }, { open });
    seen.push(...page.facts);
    if (page.done) break;
    before_row = page.next_before_row;
  }
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen.map((fact) => fact.key)).size, 12);
  const watched = changesSince(readSettings({ kinds: [] }), readDatabase(open(file)), { last_row: 0, edited_mark: '0', retracted_mark: '0', started_at: null });
  assert.deepEqual(
    [...seen].sort((a, b) => a.key.localeCompare(b.key)),
    watched.changes.map((change) => change.detail).sort((a, b) => a.key.localeCompare(b.key)),
  );
});

test('a page stops at its byte limit, and a tapback, an own send and an empty message pass without a fact', (t) => {
  const { file, open } = database(t, [{ text: 'made-up words 1' }, { text: 'a tapback', reaction: 2000 }, { text: 'my own', mine: 1 }, { text: '' }, ...words(6)]);
  const page = readAPage({ database: file, max_facts: 40, max_bytes: 700 }, { open });
  assert.ok(page.facts.length >= 1 && page.facts.length < 6);
  assert.ok(page.bytes <= 700);
  const rest = readAPage({ database: file, before_row: page.next_before_row }, { open });
  assert.equal(page.facts.length + rest.facts.length, 7);
  assert.equal(rest.done, true);
});

test('a database that macOS refuses is told with the setting, not as an empty page', () => {
  const answer = readAPage({ database: '/nowhere/chat.db' }, { open: () => { throw new Error('authorization denied'); } });
  assert.match(answer.error, /Full Disk Access/);
});

test('an own send names the handle it went out from, and a message received names none', (t) => {
  const { file, open } = database(t, [{ text: 'made-up words 1', account: 'P:+15555550199' }, { text: 'my own', mine: 1, account: 'P:+15555550199' }, { text: 'my own by mail', mine: 1, account: 'E:someone@example.com' }]);
  const page = readAPage({ database: file, include_own: true }, { open });
  const after = Object.fromEntries(page.facts.map((fact) => [fact.key.split('/')[1], JSON.parse(fact.after)]));
  assert.equal(after['GUID-2'].from, 'me');
  assert.equal(after['GUID-2'].account, '+15555550199');
  assert.equal(after['GUID-3'].account, 'someone@example.com');
  assert.equal('account' in after['GUID-1'], false);
});
