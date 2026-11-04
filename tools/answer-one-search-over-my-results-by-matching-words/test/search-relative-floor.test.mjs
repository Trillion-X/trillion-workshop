// A vector lane may declare `relative_floor` (src/search.json): only candidates scoring at least that share of the lane's
// best are kept, so one strong hit does not drag marginal ones in behind it (src/search-candidate-pages.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { searchCandidatePages } from '../src/search-candidate-pages.mjs';
import settings from '../../shared-code/src/search.json' with { type: 'json' };

const hit = (identity, score) => ({ identity, n: 0, start: 0, end: 1, timed: false, said: null, score });

test('a candidate under the relative floor of the lane best is dropped, ties and the best are kept, and no floor keeps all', () => {
  const { sql } = sqliteHost(':memory:');
  const pages = searchCandidatePages(sql, { pageSize: 2 });
  pages.putPage('nearest', 'l', 'q', [hit('a', 0.9), hit('b', 0.7)]);
  pages.putPage('nearest', 'l', 'q', [hit('c', 0.6), hit('d', 0.3)]);
  pages.putPage('nearest', 'l', 'q', [hit('e', 0.9)]);
  const ref = { kind: 'nearest', lane: 'l', question: 'q', max_hits: null };
  const walk = relative => {
    const seen = []; let cursor = {};
    for (let turn = 0; turn < 10; turn += 1) {
      const result = pages.candidatePage({ ...ref, relative_floor: relative }, cursor);
      seen.push(...result.rows.map(row => `${row.identity}:${row.score}`));
      cursor = result.cursor;
      if (!result.more) break;
    }
    return seen;
  };
  assert.deepEqual(walk(0.72), ['a:0.9', 'e:0.9', 'b:0.7']);
  assert.deepEqual(walk(null), ['a:0.9', 'e:0.9', 'b:0.7', 'c:0.6', 'd:0.3']);
});

test('the picture-meaning lane declares its relative floor as DATA', () => {
  assert.equal(settings.lanes.find(lane => lane.id === 'picture-meaning').relative_floor, 0.72);
});
