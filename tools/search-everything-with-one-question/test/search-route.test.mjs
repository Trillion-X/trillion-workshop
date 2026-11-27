// The page's GET /search route over the handed-in records and files: the question and the places, sources, matches and
// limit it asks, the empty question, other requests, and the row's declared shape. Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerTheSearchRoute } from '../do-work/search-everything.mjs';
import settings from '../read-data/settings.json' with { type: 'json' };
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
const RECORDS_SOURCE = settings.lanes.find(lane => lane.match === 'records').source;

const RECORDS = [{ id: 'k1', type: 'note', value: { title: 'Kiln notes', body: 'kiln at the studio' } }];
const FILES = { '/Notes/kiln plan.txt': 'made-up plan' };
const GET = (query, extra = {}) => ({ path: '/search', method: 'GET', query, body: {}, browser: {}, records: RECORDS, files: FILES, ...extra });

test('GET /search answers the one search with its question, and places narrow the lanes', async () => {
  const every = await answerTheSearchRoute(GET({ q: 'kiln' }));
  assert.equal(every.status, 200);
  assert.equal(every.body.question, 'kiln');
  assert.deepEqual(every.body.results.map(hit => hit.source).sort(), ['files', RECORDS_SOURCE].sort());
  const names = await answerTheSearchRoute(GET({ q: 'kiln', places: 'name' }));
  assert.deepEqual(names.body.results.map(hit => hit.path), ['/Notes/kiln plan.txt']);
  const written = await answerTheSearchRoute(GET({ q: 'kiln', places: 'written' }));
  assert.deepEqual(written.body.results.map(hit => hit.record), ['k1']);
});

test('sources and matches narrow the answer, and a limit is a whole number at most 200', async () => {
  const sourced = await answerTheSearchRoute(GET({ q: 'kiln', sources: 'files, ', limit: '5' }));
  assert.deepEqual(sourced.body.results.map(hit => hit.source), ['files']);
  const many = await answerTheSearchRoute(GET({ q: 'kiln', limit: '900' }));
  assert.equal(many.status, 200);
  const none = await answerTheSearchRoute(GET({ q: 'kiln', limit: '0', matches: 'indexes' }));
  assert.deepEqual(none.body.results, []);
});

test('a question left out is the empty question, which asks no lane; any other request is no route of this one', async () => {
  const empty = await answerTheSearchRoute({ path: '/search', method: 'GET', query: {} });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.results, []);
  assert.deepEqual(await answerTheSearchRoute({ path: '/search', method: 'POST', query: { q: 'kiln' } }), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await answerTheSearchRoute({ path: '/search/lanes', method: 'GET', query: {} }), { status: 404, body: { error: 'Not found' } });
});

test('a route row takes the records and files it is handed and declares no store right', () => {
  const row = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:answer-the-search-page-route');
  assert.equal(row.stored, undefined);
  assert.ok(row.input_schema.properties.records && row.input_schema.properties.files);
  assert.ok(!JSON.stringify(row).includes('"records:'));
  assert.deepEqual(row.input_schema.required, ['path', 'method']);
});
