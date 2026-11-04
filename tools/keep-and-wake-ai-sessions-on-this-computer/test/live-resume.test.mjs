// A screen socket that dropped and reconnects is sent the narrow changes it missed, in order, or told once to read
// everything again when the store no longer holds them (src/live-screen.mjs, src/live-resume.json); the page side keeps
// the position and asks (src/workspace/store-changes.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { liveScreen, resumeOf, watchedSql } from '../src/live-screen.mjs';
import rules from '../src/live-resume.json' with { type: 'json' };

function store() {
  const sockets = [];
  const ctx = { acceptWebSocket: socket => sockets.push(socket), getWebSockets: tag => (tag === 'screen' ? sockets : []), setWebSocketAutoResponse: () => {} };
  const { sql: raw } = sqliteHost(':memory:');
  let live = null;
  const sql = watchedSql(raw, () => live.noticeWrite());
  live = liveScreen(ctx, raw);
  sql.exec('CREATE TABLE devices (id TEXT PRIMARY KEY)');
  return { sql, live, sockets, settle: () => new Promise(resolve => setTimeout(resolve, 0)) };
}
// What opening a socket gives the page: the frames sent to the store's end of the pair, with Workers' globals stood in for.
function open(live, resume) {
  const heard = [];
  const realPair = globalThis.WebSocketPair, realResponse = globalThis.Response;
  globalThis.WebSocketPair = function () { return { 0: {}, 1: { send: text => heard.push(JSON.parse(text)), serializeAttachment() {} } }; };
  globalThis.Response = class { constructor(body, init) { this.status = init.status; } };
  try { live.open({ id: 's', issued_at: 'now' }, resume); } finally { globalThis.WebSocketPair = realPair; globalThis.Response = realResponse; }
  return heard;
}

test('the query a page sends is read as where it left off, and a first connection names nothing', () => {
  assert.deepEqual(resumeOf(new URLSearchParams('epoch=ab12&after=7')), { epoch: 'ab12', after: 7 });
  assert.equal(resumeOf(new URLSearchParams('')), null);
  assert.equal(resumeOf(new URLSearchParams('epoch=ab12&after=-1')), null);
  assert.equal(resumeOf(new URLSearchParams('epoch=ab12&after=x')), null);
});

test('narrow changes are numbered, kept while nobody listens, and replayed in order to a socket that names the last one it heard', async () => {
  const { sql, live, settle } = store();
  await settle();
  const first = open(live, null);
  assert.equal(first.length, 1, 'a first connection is told the revision and nothing else');
  const { epoch, seq } = first[0];
  assert.equal(seq, 0);
  for (const read of ['/work/api/catch-up', '/work/api/messages', '/work/api/activity']) {
    live.changedFor([read], () => sql.exec('INSERT INTO devices (id) VALUES (?)', read));
    await settle();
  }
  const back = open(live, { epoch, after: 1 });
  assert.deepEqual(back.slice(1).map(frame => [frame.seq, frame.changed]), [[2, ['/work/api/messages']], [3, ['/work/api/activity']]], 'only what it had not heard');
  assert.ok(back.every(frame => frame.reset === undefined));
  assert.equal(open(live, { epoch, after: 3 }).length, 1, 'a socket that heard everything is sent nothing more');
});

test('a store that restarted, or that no longer holds what was missed, tells the page to read everything again', async () => {
  const { sql, live, settle } = store();
  await settle();
  const { epoch } = open(live, null)[0];
  assert.deepEqual(open(live, { epoch: 'another-life', after: 0 }).slice(1).map(frame => frame.reset), [true]);
  for (let index = 0; index < rules.most_frames_replayed + 5; index += 1) {
    live.changedFor([`/work/api/read-${index}`], () => sql.exec('INSERT INTO devices (id) VALUES (?)', `row-${index}`));
    await settle();
  }
  assert.deepEqual(open(live, { epoch, after: 1 }).slice(1).map(frame => frame.reset), [true], 'more frames passed than are kept');
  const caughtUp = open(live, { epoch, after: 6 });
  assert.equal(caughtUp.slice(1).length, rules.most_frames_replayed + 5 - 6, 'within what is kept it replays');
});
