import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { answerSettle, settleWith } from '../do-work/record-sync.mjs';
import { bucketOf } from '../do-work/record-digest.mjs';

const host = () => {
  const db = new DatabaseSync(':memory:'), statements = new Map();
  const sql = { exec(query, ...params) { let stmt = statements.get(query); if (!stmt) statements.set(query, stmt = db.prepare(query)); const rows = stmt.all(...params); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
  let depth = 0;
  const transaction = fn => { if (depth) return fn(); depth++; db.exec('BEGIN'); try { const answer = fn(); db.exec('COMMIT'); return answer; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { depth--; } };
  return { store: recordLogStore(sql, { transaction }), close: () => db.close() };
};
const idsIn = (bucket, count) => { const ids = []; for (let n = 0; ids.length < count; n++) { const id = 'selected:' + n; if (bucketOf(id) === bucket) ids.push(id); } return ids; };
function fixture() {
  const leader = host(), follower = host(), target = bucketOf('selected:0'), ids = idsIn(target, 6);
  const outside = idsIn((target + 1) % 256, 1)[0];
  leader.store.write(ids.map((id, n) => ({ id, type: 'item', value: { n } })));
  leader.store.write([{ id: outside, type: 'item', value: { n: -1 } }]);
  leader.store.checksum(); leader.store.sealLog(); for (const table of leader.store.sealedLogs()) leader.store.dropSealedLog(table);
  // Exercise the production page owner and checksum on two-record pages, without creating a customer account.
  const page = leader.store.recordsInBucketsPage.bind(leader.store);
  leader.store.recordsInBucketsPage = (buckets, options) => page(buckets, { ...options, limit: 2 });
  return { leader, follower, ids, outside, target, close() { leader.close(); follower.close(); } };
}
test('unrelated bucket writes do not discard a stable requested group, while the final global root remains honest', async () => {
  const f = fixture(); let pages = 0, changes = 0;
  try {
    const send = async request => {
      if (request.want_buckets?.includes(f.target)) {
        pages++;
        f.leader.store.write([{ id: f.outside, type: 'item', value: { n: ++changes } }]);
      }
      return JSON.parse(JSON.stringify(answerSettle(f.leader.store, request)));
    };
    const result = await settleWith(f.follower.store, send, { id: 'scope-stable', verify_buckets: 1 });
    for (let n = 0; n < f.ids.length; n++) assert.deepEqual(f.follower.store.read(f.ids[n]), { n });
    assert.equal(result.buckets_moved, 0); assert.equal(pages, 4, 'six values and the bounded final empty page are read once');
    if (result.equal) assert.equal(f.follower.store.checksum().root, f.leader.store.checksum().root);
  } finally { f.close(); }
});
test('actual selected bucket changes still retry, persistent churn stays untaken and transport corruption remains refused', async () => {
  for (const mode of ['once', 'always', 'corrupt']) {
    const f = fixture(); let pages = 0;
    try {
      const send = async request => {
        if (request.want_buckets?.includes(f.target)) {
          pages++;
          if ((mode === 'once' && pages === 2) || mode === 'always') f.leader.store.write([{ id: f.ids[0], type: 'item', value: { n: 100 + pages } }]);
        }
        const answer = JSON.parse(JSON.stringify(answerSettle(f.leader.store, request)));
        if (mode === 'corrupt' && request.want_buckets?.includes(f.target) && answer.records.length) answer.records[0].value.n = 'tampered';
        return answer;
      };
      if (mode === 'corrupt') {
        await assert.rejects(settleWith(f.follower.store, send, { id: 'corrupt', verify_buckets: 1 }), error => error.status === 409);
        assert.equal(f.follower.store.read(f.ids[0]), null);
      } else {
        const answer = await settleWith(f.follower.store, send, { id: mode, verify_buckets: 1 });
        if (mode === 'once') { assert.equal(answer.buckets_moved, 0); assert.deepEqual(f.follower.store.read(f.ids[0]), { n: 102 }); assert.ok(pages > 4); }
        else { assert.equal(answer.buckets_moved, 1); assert.equal(f.follower.store.read(f.ids[0]), null); assert.equal(pages, 6); }
      }
    } finally { f.close(); }
  }
});
