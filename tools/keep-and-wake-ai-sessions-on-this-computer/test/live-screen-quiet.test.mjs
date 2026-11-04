// test/live-screen-quiet.test.mjs
// Open screens read themselves again when the person's store changes (src/live-screen.mjs). An upload's bookkeeping
// (chunks arriving, spans described) is written quietly: a computer sending thousands of chunks must not make every
// open screen reload every few seconds, which kept a large account's store too busy to answer its screens. A write
// anyone sees still reaches every screen, including one made in the same turn as a quiet write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { liveScreen, watchedSql } from '../src/live-screen.mjs';
// Frames are numbered for resuming (test/live-resume.test.mjs); these tests are about what a frame says changed.
const bare = ({ seq, epoch, ...rest }) => rest;

function screenStore() {
  const told = [];
  const narrow = [];
  const socket = { send: value => { const frame = JSON.parse(value); if (frame.changed) narrow.push(frame.changed); else told.push(frame.revision); } };
  const ctx = { acceptWebSocket: () => {}, getWebSockets: tag => (tag === 'screen' ? [socket] : []), setWebSocketAutoResponse: () => {} };
  const { sql: raw } = sqliteHost(':memory:');
  let live = null;
  const sql = watchedSql(raw, () => live.noticeWrite());
  live = liveScreen(ctx, raw);
  sql.exec('CREATE TABLE chunks (id TEXT PRIMARY KEY)');
  sql.exec('CREATE TABLE decisions (id TEXT PRIMARY KEY)');
  return { sql, live, told, narrow, settle: () => new Promise(resolve => setTimeout(resolve, 0)) };
}

test('upload bookkeeping written quietly wakes no screen; a seen write still does, even in the same turn', async () => {
  const { sql, live, told, settle } = screenStore();
  await settle();
  const start = told.length;
  for (let index = 0; index < 50; index += 1) {
    live.quietly(() => sql.exec('INSERT INTO chunks (id) VALUES (?)', `chunk-${index}`));
    await settle();
  }
  assert.equal(told.length, start, 'fifty chunks arrived and no screen was told to read itself again');

  sql.exec('INSERT INTO decisions (id) VALUES (?)', 'a decision');
  await settle();
  assert.equal(told.length, start + 1, 'a decision saved reaches every open screen');

  sql.exec('INSERT INTO decisions (id) VALUES (?)', 'another');
  live.quietly(() => sql.exec('INSERT INTO chunks (id) VALUES (?)', 'chunk-in-the-same-turn'));
  await settle();
  assert.equal(told.length, start + 2, 'a seen write in the same turn as a quiet one still changes the revision');
});

test('a write only some reads show moves no revision and tells the screens which reads changed, once per turn', async () => {
  const { sql, live, told, narrow, settle } = screenStore();
  await settle();
  const start = told.length, revision = live.revision();
  live.changedFor(['/work/api/catch-up'], () => sql.exec('INSERT INTO chunks (id) VALUES (?)', 'device-a'));
  live.changedFor(['/work/api/catch-up'], () => sql.exec('INSERT INTO chunks (id) VALUES (?)', 'device-b'));
  await settle();
  assert.equal(told.length, start, 'no screen hears a new revision');
  assert.equal(live.revision(), revision, 'the revision (and every copy kept by it) stays');
  assert.deepEqual(narrow, [['/work/api/catch-up']], 'the screens are told once which read changed');

  live.changedFor(['/work/api/catch-up'], () => sql.exec('INSERT OR IGNORE INTO chunks (id) VALUES (?)', 'device-a'));
  await settle();
  assert.equal(narrow.length, 1, 'a write that changed no row tells nobody');

  sql.exec('INSERT INTO decisions (id) VALUES (?)', 'seen');
  live.changedFor(['/work/api/catch-up'], () => sql.exec('INSERT INTO chunks (id) VALUES (?)', 'device-c'));
  await settle();
  assert.equal(told.length, start + 1, 'a seen write in the same turn still moves the revision');
});

test('one asynchronous operation coalesces its visible writes and keeps scoped read changes narrow', async () => {
  const { sql, live, told, narrow, settle } = screenStore();
  await settle();
  const start = told.length;
  await live.coalesce(async () => {
    sql.exec('INSERT INTO decisions (id) VALUES (?)', 'before-await');
    await Promise.resolve();
    live.changedFor(['/work/api/messages'], () => sql.exec('INSERT INTO chunks (id) VALUES (?)', 'messages-changed'));
    await Promise.resolve();
    sql.exec('INSERT INTO decisions (id) VALUES (?)', 'after-await');
  });
  await settle();
  assert.equal(told.length, start + 1, 'the whole operation moves one revision');
  assert.deepEqual(narrow, [['/work/api/messages']], 'the message read still gets its own narrow change');
});

test('with no screen open the revision moves in memory and is written only when someone reads it', async () => {
  const ctx = { acceptWebSocket: () => {}, getWebSockets: () => [], setWebSocketAutoResponse: () => {} };
  const { sql: raw } = sqliteHost(':memory:');
  let live = null;
  const sql = watchedSql(raw, () => live.noticeWrite());
  live = liveScreen(ctx, raw);
  sql.exec('CREATE TABLE decisions (id TEXT PRIMARY KEY)');
  const written = () => raw.exec('SELECT revision FROM screen_revision WHERE id = 1').toArray()[0]?.revision ?? null;
  for (let index = 0; index < 20; index += 1) {
    sql.exec('INSERT INTO decisions (id) VALUES (?)', `d-${index}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(written(), null, 'twenty changes with nobody looking wrote no revision');
  const read = live.revision();
  const ceiling = written();
  assert.ok(ceiling > read, 'a page given the revision has a ceiling above it written');
  live.revision();
  assert.equal(written(), ceiling, 'reading it again writes nothing');
  for (let index = 0; index < 50; index += 1) {
    sql.exec('INSERT INTO decisions (id) VALUES (?)', `e-${index}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    live.revision();
  }
  assert.equal(written(), ceiling, 'fifty revisions given out under the ceiling write no row');
  const last = live.revision();
  const woken = liveScreen(ctx, raw);
  assert.ok(woken.revision() > last, 'a new instance starts past every revision given out, since changes may have gone unwritten');
  assert.equal(woken.revision(), ceiling + 1);
});

test('every message names the heads it was given, so a device reads again only when the head it follows moved', async () => {
  const frames = [];
  const socket = { send: value => frames.push(bare(JSON.parse(value))) };
  const ctx = { acceptWebSocket: () => {}, getWebSockets: tag => (tag === 'screen' ? [socket] : []), setWebSocketAutoResponse: () => {} };
  const { sql: raw } = sqliteHost(':memory:');
  let live = null;
  const sql = watchedSql(raw, () => live.noticeWrite());
  live = liveScreen(ctx, raw);
  let told = 7;
  live.heads('told', () => told);
  sql.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
  await new Promise(resolve => setTimeout(resolve, 0));
  frames.length = 0;
  sql.exec('INSERT INTO t (id) VALUES (?)', 'a');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(frames.at(-1).heads.told, 7);
  told = 8;
  live.changedFor(['/x'], () => sql.exec('INSERT INTO t (id) VALUES (?)', 'b'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(frames.at(-1), { changed: ['/x'], heads: { told: 8 } });
});

test('every message names the heads each listener keeps, so a device reads again only when its own head moved', async () => {
  const frames = [];
  const socket = { send: value => frames.push(bare(JSON.parse(value))) };
  const ctx = { acceptWebSocket: () => {}, getWebSockets: tag => (tag === 'screen' ? [socket] : []), setWebSocketAutoResponse: () => {} };
  const { sql: raw } = sqliteHost(':memory:');
  let live = null;
  const sql = watchedSql(raw, () => live.noticeWrite());
  live = liveScreen(ctx, raw);
  let told = 7;
  live.heads('told', () => told);
  sql.exec('CREATE TABLE decisions (id TEXT PRIMARY KEY)');
  await new Promise(resolve => setTimeout(resolve, 0));
  frames.length = 0;
  sql.exec('INSERT INTO decisions (id) VALUES (?)', 'one');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(frames.at(-1).heads, { told: 7 }, 'a revision carries the head unchanged');
  told = 8;
  live.changedFor(['/work/api/catch-up'], () => sql.exec('INSERT INTO decisions (id) VALUES (?)', 'two'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(frames.at(-1), { changed: ['/work/api/catch-up'], heads: { told: 8 } }, 'a narrow change carries the new head');
});
