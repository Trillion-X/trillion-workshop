// What the listener says about a listening (read-data/meeting-ledger.mjs), and the listening loop leaving out text a
// hearing model makes up out of silence. Moved from the product repo's test/meeting-ledger.test.mjs: its pure assertions
// one to one; the parts that drove the Mac listener's own `listen` tool and notes job stay with that listener.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listenForAWhile } from '../read-data/listen-for-a-while.mjs';
import { isFalseText, jobState } from '../read-data/meeting-ledger.mjs';

test('a line that is only text a hearing model makes up out of silence is told apart from real words', () => {
  assert.equal(isFalseText('Thank you for watching!'), true);
  assert.equal(isFalseText('We thank you for watching the demo carefully, Ben said.'), false);
});

test('the notes job tells its state in words', () => {
  const status = Object.freeze({ notes: jobState('failed', 'no model answered') });
  assert.equal(status.notes.says, 'The notes could not be made: no model answered');
  assert.deepEqual(jobState('noted').controls, ['ask_again', 'propose_tasks']);
});

test('the listening loop leaves out a stretch that is only made-up text before it is named or written', async () => {
  const folder = tempFolder(join(tmpdir(), 'ledger-'));
  const file = join(folder, '0.wav');
  writeFileSync(file, 'x');
  let named = null;
  async function* record() { yield { file, startMs: 1_000_000, endMs: 1_030_000 }; }
  const hear = async () => [{ start: 0, end: 2, text: 'Thanks for watching.' }, { start: 3, end: 5, text: 'Ship it on Friday.' }];
  const name = async request => { named = request.segments.map(segment => segment.text); return { speakers: request.segments.map(s => ({ ...s, who: 'Someone (voice-1)', me: false })), records: [] }; };
  const tally = await listenForAWhile({ until: 2_000_000, listening: 'l1', model_path: 'm' }, {}, { record, hear, name });
  assert.deepEqual(named, ['Ship it on Friday.']);
  assert.deepEqual(tally.heard.map(row => row.value.text), ['Ship it on Friday.']);
});
