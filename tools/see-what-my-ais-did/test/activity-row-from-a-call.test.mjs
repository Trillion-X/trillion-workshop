// A raw tool call an AI made becomes the row the person keeps, by the marks in activity-marks.json, and the write tool keeps
// either a raw call or a finished row. The store is in memory; every name and id here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import marks from '../../shared-code/src/activity-marks.json' with { type: 'json' };
import { rowFromCall, CallError } from '../do-work/activity-row-from-a-call.mjs';
import { keepOne } from '../do-work/activity-in-database.mjs';
import { listRows } from '../read-data/activity-generations.mjs';
import { memoryStore } from './memory-activity-store.mjs';

// A marked tool whose item is read from the answer, with a made-up answer that carries an id at that place.
const marked = marks.marks.find(mark => mark.item?.some(place => place.from === 'result' && place.path?.length));
function answerWithItem(mark, id) {
  const place = mark.item.find(item => item.from === 'result' && item.path?.length);
  const answer = {};
  let cursor = answer;
  place.path.slice(0, -1).forEach(key => { cursor[key] = {}; cursor = cursor[key]; });
  cursor[place.path.at(-1)] = id;
  return answer;
}

test('a marked call with an answer that names its item leaves a row with that item, and the marks say it is marked', () => {
  const result = answerWithItem(marked, 'item:made-up-1');
  const { row, marked: isMarked } = rowFromCall({ tool: marked.tool, at: '2026-11-20T04:40:00-06:00', app: 'sample-app', result });
  assert.equal(isMarked, true);
  assert.equal(row.tool, marked.tool);
  assert.equal(row.item, 'item:made-up-1');
  assert.equal(row.ok, true);
});

test('a marked call that threw is kept as not ok, with the words it threw', () => {
  const { row } = rowFromCall({ tool: marked.tool, at: '2026-11-20T04:40:00-06:00', app: 'sample-app', error: 'made-up failure words' });
  assert.equal(row.ok, false);
  assert.equal(row.reason, 'made-up failure words');
});

test('an unmarked call with no receipt and no work it was done for leaves no row, and says why', () => {
  const answer = rowFromCall({ tool: 'tool:made-up-unmarked-tool', at: '2026-11-20T04:40:00-06:00', description: 'Does a made-up thing' });
  assert.equal(answer.row, undefined);
  assert.equal(answer.left.tool, 'tool:made-up-unmarked-tool');
  assert.equal(answer.left.marked, false);
  assert.match(answer.left.why, /no mark/);
});

test('a call without a tool, without a time, or with access that is not a list is refused', () => {
  assert.throws(() => rowFromCall({ at: '2026-11-20T04:40:00-06:00' }), CallError);
  assert.throws(() => rowFromCall({ tool: marked.tool }), /at must say when/);
  assert.throws(() => rowFromCall({ tool: marked.tool, at: '2026-11-20T04:40:00-06:00' }, 'access:x'), /Give access as a list/);
  assert.throws(() => rowFromCall(null), /Give call/);
});

test('keepOne keeps a raw call (kept true, with where it went), a finished row, and leaves an unmarked call with why', async () => {
  const store = memoryStore();
  const raw = await keepOne(store, { call: { tool: marked.tool, at: '2026-11-20T04:40:00-06:00', app: 'sample-app', result: answerWithItem(marked, 'item:made-up-2') } });
  assert.equal(raw.kept, true);
  assert.equal(raw.seq, 1);
  const finished = await keepOne(store, { row: { tool: 'tool:sample-tool', at: '2026-11-20T04:41:00-06:00', app: 'sample-app', item: 'item:made-up-3', ok: true } });
  assert.equal(finished.seq, 2);
  assert.equal(finished.kept, undefined);
  const left = await keepOne(store, { call: { tool: 'tool:made-up-unmarked-tool', at: '2026-11-20T04:42:00-06:00' } });
  assert.equal(left.kept, false);
  assert.equal(left.left.tool, 'tool:made-up-unmarked-tool');
  const { items } = await listRows(store, {});
  assert.deepEqual(items.map(item => item.item), ['item:made-up-3', 'item:made-up-2']);
});
