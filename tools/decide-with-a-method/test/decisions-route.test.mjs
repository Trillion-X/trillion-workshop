// The page route GET /work/api/decisions as a Workshop route tool: the Decisions screen's rows, the same read as
// tool:see-my-decisions with no input (old trillion src/worker.mjs:1026 answered person.workScreen(), tag
// old-trillion-before-worker-retire), and 404 for anything else. The row itself runs against the records door
// stand-in with exactly its rights. Every record is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryDoor } from './fixtures.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerDecisionsRoute } from '../read-data/decisions-route.mjs';
import { seeMyDecisions } from '../read-data/work-screen.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const ROUTE = rowOf(ROWS, 'tool:answer-the-decisions-route');
const page = (path, method) => ({ path, method, query: {}, body: {}, browser: { user_agent: 'Sample browser', origin: 'https://app.example', visitor: 'sample' } });
const decision = { input: { goal: 'Choose a sample supplier', options: [{ id: 'a', label: 'A' }] }, status: 'needs_outcome', decision: { option_id: 'a' },
  created_at: '2026-01-01T00:00:00Z', decided_at: '2026-01-02T00:00:00Z' };

test('GET /decisions answers 200 with the screen read tool:see-my-decisions gives with no input', async () => {
  const door = memoryDoor();
  door.put('decision-1', 'decision', decision);
  door.put('pursuit-1', 'pursuit', { title: 'Sample pursuit', status: 'active' });
  const reply = await answerDecisionsRoute(page('/decisions', 'GET'), { door });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, await seeMyDecisions({}, { door }));
  assert.equal(reply.body.summaries[0].case_id, 'decision-1');
  assert.equal(reply.body.free, false);
});

test('another path or method answers 404 Not found and reads nothing', async () => {
  const door = { list: () => { throw new Error('read'); }, read: () => { throw new Error('read'); } };
  assert.deepEqual(await answerDecisionsRoute(page('/decisions', 'POST'), { door }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await answerDecisionsRoute(page('/decisions/other', 'GET'), { door }), { status: 404, body: { error: 'Not found' } });
});

test('the row runs with its own rights over the person\'s records and answers the page', async () => {
  const run = await answerOf(ROUTE, page('/decisions', 'GET'), { records: [{ id: 'decision-1', type: 'decision', value: decision }] });
  assert.equal(run.status, 0, run.error);
  assert.equal(run.result.status, 200);
  assert.equal(run.result.body.summaries.length, 1);
  assert.match(run.result.body.pursuits_words.text, /working toward/);
});
