// The page's GET /work/api/search, as the engine runs it through tool:answer-the-search-page-route (workshop-routes):
// old trillion's tests of that route at the tag old-trillion-before-worker-retire, ported to this route tool.
// - test/search.test.mjs:382-390 (searchOptions: places, sources and matches as comma lists, limit as a number) and
//   :61-92 ("places filter": only the asked places' lanes answer).
// - test/namespace-account-route.test.mjs:128-140 (GET /work/api/search reaches the one search with its question and
//   places, and nothing else).
// The row runs as the runner runs it, against the fake records door with exactly its rights. Every record and file
// name here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsDoorFromCall } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerTheSearchRoute } from '../do-work/search-everything.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

// A door that records what each lane was asked and answers one hit per lane.
function askedDoor() {
  const asked = [];
  const door = recordsDoorFromCall(async (method, input) => {
    asked.push({ method, input });
    return method === 'records:search'
      ? { question: input.question, terms: [], results: [{ id: 'record:k1', type: 'note', record: 'k1', said: 'kiln notes', score: 0.016 }], unavailable: [], pending: [] }
      : { results: [{ id: 'file:/kiln.txt', identity: 'f1', name: 'kiln.txt', score: 0.013 }], unavailable: [], pending: [] };
  }, { resource: '@own-records', filesResource: '@namespace' });
  return { door, asked };
}

test('GET /search reaches the one search with its question, and the places filter the lanes (search.test.mjs:61, namespace-account-route.test.mjs:134)', async () => {
  const every = askedDoor();
  const answer = await answerTheSearchRoute({ path: '/search', method: 'GET', query: { q: 'kiln' }, body: {}, browser: {} }, { door: every.door });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.question, 'kiln');
  assert.deepEqual(answer.body.results.map(hit => hit.found_in), [['written'], ['name']]);
  assert.deepEqual(every.asked.map(call => call.method).sort(), ['records:search', 'search']);
  assert.deepEqual(every.asked.find(call => call.method === 'records:search').input, { question: 'kiln' },
    'the records lane is asked only its question (and a limit when one is asked)');

  const namesOnly = askedDoor();
  const named = await answerTheSearchRoute({ path: '/search', method: 'GET', query: { q: 'kiln', places: 'name' } }, { door: namesOnly.door });
  assert.deepEqual(named.body.results.map(hit => hit.name), ['kiln.txt']);
  assert.deepEqual(namesOnly.asked.map(call => call.method), ['search'], 'a place not asked is not searched');

  const writtenOnly = askedDoor();
  const written = await answerTheSearchRoute({ path: '/search', method: 'GET', query: { q: 'kiln', places: 'written' } }, { door: writtenOnly.door });
  assert.deepEqual(written.body.results.map(hit => hit.found_in), [['written']]);
});

test('searchOptions: places, sources and matches are comma lists and limit a number, at most 200 (search.test.mjs:388)', async () => {
  const sourced = askedDoor();
  const fromSources = await answerTheSearchRoute({ path: '/search', method: 'GET', query: { q: 'kiln', sources: 'files, ', limit: '5' } }, { door: sourced.door });
  assert.deepEqual(fromSources.body.results.map(hit => hit.name), ['kiln.txt']);
  assert.deepEqual(sourced.asked, [{ method: 'search', input: { question: 'kiln', limit: 5 } }]);

  const matched = askedDoor();
  await answerTheSearchRoute({ path: '/search', method: 'GET', query: { q: 'kiln', matches: 'records', limit: '900' } }, { door: matched.door });
  assert.deepEqual(matched.asked, [{ method: 'records:search', input: { question: 'kiln', limit: 200 } }]);

  const unbounded = askedDoor();
  await answerTheSearchRoute({ path: '/search', method: 'GET', query: { q: 'kiln', limit: '0', matches: 'files' } }, { door: unbounded.door });
  assert.deepEqual(unbounded.asked, [{ method: 'search', input: { question: 'kiln' } }], 'a limit that is no whole number above 0 is left out');
});

test('a question left out is the empty question, which asks no lane; any other request is no route of this one', async () => {
  const none = askedDoor();
  const empty = await answerTheSearchRoute({ path: '/search', method: 'GET', query: {} }, { door: none.door });
  assert.deepEqual([empty.status, empty.body.question, empty.body.results, none.asked], [200, '', [], []]);
  assert.deepEqual(await answerTheSearchRoute({ path: '/search', method: 'POST', query: { q: 'kiln' } }, { door: none.door }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await answerTheSearchRoute({ path: '/search/lanes', method: 'GET', query: {} }, { door: none.door }), { status: 404, body: { error: 'Not found' } });
});

test('the route row runs as the engine runs it, with only its two read-only rights', async () => {
  const row = rowOf(rows, 'tool:answer-the-search-page-route');
  assert.deepEqual(row.invoke.records.rights, [{ kind: '*', operations: ['records:search'] }, { files: '/', operations: ['search'] }]);
  const [sample] = row.verify;
  const ran = await answerOf(row, sample.input, sample);
  assert.equal(ran.status, 0, 'the run ends well');
  assert.equal(ran.result.status, 200);
  assert.deepEqual(ran.result.body.results.map(hit => hit.record).sort(), ['c1', 'i1', 'p1']);
  assert.ok(ran.result.body.results.every(hit => hit.found_in.includes('written')), 'sources=trillion leaves the files out');
});
