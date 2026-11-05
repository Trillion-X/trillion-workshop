// The page's GET /work/api/search as a Workshop route tool: the query's q and limit as old trillion's route read them
// (src/worker.mjs:865, src/search.mjs:2221 searchOptions), the answer {status: 200, body: searchEverything's answer},
// and 404 for another path or method; then the container row run as the engine runs it, against the stand-in door
// with exactly its rights. Every record and name here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerSearchPage } from '../do-work/search-page-route.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

// A door that records what each lane was asked and finds nothing.
function askedDoor() {
  const asked = [];
  const none = input => ({ question: input.question, terms: [], results: [], unavailable: [], pending: [] });
  return { asked, door: {
    search: async input => { asked.push(['records:search', input]); return none(input); },
    files: async (operation, input) => { asked.push([operation, input]); return none(input); },
  } };
}

test('q is the question, limit a whole number above 0 at most 200, and the narrowings are left out', async () => {
  const wrapped = async query => {
    const { asked, door } = askedDoor();
    const answer = await answerSearchPage({ path: '/search', method: 'GET', query, body: {}, browser: {} }, { door });
    return { answer, asked };
  };
  const plain = await wrapped({ q: 'kestrel notes', limit: '500', places: 'name', sources: 'files' });
  assert.equal(plain.answer.status, 200);
  assert.equal(plain.answer.body.question, 'kestrel notes');
  assert.ok(plain.asked.length > 0, 'the search was asked');
  for (const [, input] of plain.asked) {
    assert.equal(input.question, 'kestrel notes');
    assert.equal(input.limit, 200, 'a limit above 200 is 200');
    assert.equal(input.places ?? input.sources, undefined);
  }
  const empty = await wrapped({});
  assert.equal(empty.answer.status, 200);
  assert.equal(empty.answer.body.question, '', 'no q is the empty question, as old `q ?? ""`');
  assert.deepEqual(empty.answer.body.results, []);
  for (const other of [{ path: '/search', method: 'POST' }, { path: '/search/more', method: 'GET' }]) {
    assert.deepEqual(await answerSearchPage({ ...other, query: {}, body: {} }, { door: askedDoor().door }), { status: 404, body: { error: 'Not found' } });
  }
});

test('the route row answers the page with what the container search answers, under the same read-only rights', async () => {
  const row = rowOf(rows, 'tool:search-everything-from-the-page');
  const search = rowOf(rows, 'tool:search-everything-in-a-small-container');
  assert.deepEqual(row.invoke.records.rights, search.invoke.records.rights);
  const sample = row.verify.find(check => check.kind === 'sample-run');
  const ran = await answerOf(row, sample.input, sample);
  assert.equal(ran.status, 0, JSON.stringify(ran));
  assert.equal(ran.result.status, 200);
  const direct = await answerOf(search, { question: 'merlinfalcon', limit: 5 }, sample);
  assert.deepEqual(ran.result.body.results.map(hit => hit.id), direct.result.results.map(hit => hit.id));
  assert.deepEqual(ran.result.body.results.map(hit => hit.id), ['record:c1', 'record:i1', 'record:p1', 'file:/Notes/merlinfalcon care.txt']);
  assert.equal(ran.calls.find(item => item.method === 'records:search').input.limit, 5, 'the page\'s limit is the search\'s');
});
