// What the listener says about a listening (read-data/meeting-ledger.mjs), and the listening loop leaving out text a
// hearing model makes up out of silence. Moved from the product repo's test/meeting-ledger.test.mjs: its pure assertions
// one to one; the parts that drove the Mac listener's own `listen` tool and notes job stay with that listener.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listenForAWhile } from '../read-data/listen-for-a-while.mjs';
import { isFalseText, jobState, livenessOf } from '../read-data/meeting-ledger.mjs';

test('a line that is only text a hearing model makes up out of silence is told apart from real words', () => {
  assert.equal(isFalseText('Thank you for watching!'), true);
  assert.equal(isFalseText('We thank you for watching the demo carefully, Ben said.'), false);
});

test('a listening whose heartbeat is old reads as finished without anything being rewritten, and the notes job tells its state in words', () => {
  assert.deepEqual(livenessOf({ listening: true, heartbeat_ms: 1000 }, 300_000), { live: false, why: 'stale', age_ms: 299_000 });
  assert.equal(livenessOf({ listening: true, heartbeat_ms: 99_000 }, 100_000).live, true);
  assert.equal(livenessOf({ listening: false, heartbeat_ms: 99_000 }, 100_000).live, false);
  const status = Object.freeze({ listening: true, heartbeat_ms: 1000, notes: jobState('failed', 'no model answered') });
  assert.equal(livenessOf(status, 600_000).live, false);
  assert.equal(status.notes.says, 'The notes could not be made: no model answered');
  assert.deepEqual(jobState('noted').controls, ['ask_again', 'propose_tasks']);
});

test('the listening loop leaves out a stretch that is only made-up text before it is named or written', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(folder, '0.wav');
  writeFileSync(file, 'x');
  const writes = [];
  const door = { async *list() {}, async read() { return null; }, async write(records) { writes.push(records); return { changed: records.length }; } };
  let named = null;
  async function* record() { yield { file, startMs: 1_000_000, endMs: 1_030_000 }; }
  const hear = async () => [{ start: 0, end: 2, text: 'Thanks for watching.' }, { start: 3, end: 5, text: 'Ship it on Friday.' }];
  const name = async request => { named = request.segments.map(segment => segment.text); return { speakers: request.segments.map(s => ({ ...s, who: 'Someone (voice-1)', me: false })), records: [] }; };
  const tally = await listenForAWhile({ until: 2_000_000, listening: 'l1', model_path: 'm' }, { door }, { record, hear, name });
  assert.deepEqual(named, ['Ship it on Friday.']);
  assert.deepEqual(writes.flat().map(row => row.value.text), ['Ship it on Friday.']);
  assert.equal(tally.rows_written, 1);
});
