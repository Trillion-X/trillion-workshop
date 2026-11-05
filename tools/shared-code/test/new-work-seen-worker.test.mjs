// Ported from old trillion test/new-work-seen-worker.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. Showing a screen marks it seen where its count is read: the old test drove the Worker's
// POST /work/api/new-work/seen and GET /work/api/new-work through a built Worker over a record book stand-in, which wrote
// screens:markSeen and read screens:newWork on the account's own records. The Worker went with #243 and no running code
// serves those routes (searched new-work/seen, screens:markSeen, screens:newWork in trillion-workshop tools/, trillion-apps
// web/, trillion-rust src/), so this checks the same on the code that keeps the marks and counts, src/new-work.mjs
// markScreenSeen and readNewWork, over the shipped src/new-work.json. Left out with the Worker: which owner and operation the
// route called, that the former person store was never asked, the 400 and 403 statuses, and the refusal of a page from
// another site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { markScreenSeen, readNewWork } from '../src/new-work.mjs';

// Any SQLite, in the Durable Object's exec shape: a cursor that can be spread or walked.
function sqlite() {
  const db = new DatabaseSync(':memory:');
  return { exec: (query, ...binds) => { const statement = db.prepare(query); const rows = /^\s*select/i.test(query) ? statement.all(...binds) : (statement.run(...binds), []); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
}

test('the seen mark the browser writes is the mark the new-work counts read, in the account\'s own records', async () => {
  const sql = sqlite();
  const written = markScreenSeen(sql, 'trillion.files');
  assert.equal(written.surface, 'trillion.files');
  const read = await readNewWork(sql);
  assert.equal(read.seen['trillion.files'], written.seen_at, 'the count reads the very mark the browser wrote');
});

test('a screen with no count is refused as a request', () => {
  const sql = sqlite();
  assert.throws(() => markScreenSeen(sql, 'trillion.nowhere'), error => error.failure_code === 'request-refused' && /nothing to mark seen/.test(error.message));
});
