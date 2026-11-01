// tools/find-signals-of-need: the finder on made-up candidates, the refusals of a bad source row, a measure added only as
// a row, a stand-in fetch, and the row's command as the container runs it. All data is made up.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { MEASURES, SOURCES, findSignals, sourceProblems } from '../read-data/signals.mjs';

const folder = join(import.meta.dirname, '..');
const now = '2026-11-01';
const post = (id, employees, posted_at) => ({ id, company: `Company ${id}`, url: `https://example.com/${id}`, location: 'Springfield', employees, posted_at, title: 'Dispatcher' });
const review = (text, date) => ({ text, date });

test('the shipped source rows have no problems', () => {
  for (const row of SOURCES.records) assert.deepEqual(sourceProblems(row), [], row.id);
});

test('job posts: filters keep sized companies with old posts, signals add up, rank is score then key', async () => {
  const items = [post('b', 50, '2026-10-05'), post('a', 50, '2026-10-05'), post('c', 120, '2026-09-20'), post('d', 5, '2026-09-01'), post('e', 50, '2026-10-30'), { id: 'f', company: 'Company f', employees: 'many', posted_at: '2026-09-01' }];
  const answer = await findSignals({ source: 'open-job-posts', items, now });
  assert.deepEqual(answer.prospects.map(item => [item.key, item.score, item.rank]), [['c', 3, 1], ['a', 1, 2], ['b', 1, 3]]);
  assert.deepEqual(answer.prospects[0].signals.map(signal => signal.id), ['open-a-month', 'open-three-weeks']);
  assert.equal(answer.prospects[0].signals[0].evidence.value, 42);
  assert.equal(answer.prospects[0].name, 'Company c');
  assert.equal(answer.prospects[0].place, 'Springfield');
  assert.equal(answer.prospects[0].fields.role, 'Dispatcher');
  assert.equal(answer.count, 3);
  assert.deepEqual(Object.fromEntries(answer.skipped.map(item => [item.key, item.reason])), {
    d: 'size value is 5, outside the filter', e: 'posted_at age-days is 2, outside the filter', f: 'size is missing',
  });
  assert.match(answer.said, /3 of 6 candidates passed/);
});

test('the same items always give the same ranking', async () => {
  const items = ['m', 'k', 'z', 'a'].map(id => post(id, 30, '2026-10-01'));
  const first = await findSignals({ source: 'open-job-posts', items, now });
  const second = await findSignals({ source: 'open-job-posts', items: [...items].reverse(), now });
  assert.deepEqual(first.prospects.map(item => item.key), ['a', 'k', 'm', 'z']);
  assert.deepEqual(second.prospects, first.prospects);
});

test('local businesses: slow-quote mentions and a spike of recent reviews, with the snippets as evidence', async () => {
  const slow = { place_id: 'p1', name: 'Roofing One', address: '1 Main St', email: 'info@example.com', reviews: [review('Very slow quote, waited weeks', '2026-10-20'), review('Slow quote again', '2026-10-25'), review('Fine work', '2026-10-28'), review('ok', '2025-01-02'), review('good', '2025-02-02')] };
  const quiet = { place_id: 'p2', name: 'Roofing Two', address: '2 Main St', reviews: [review('Great', '2024-01-01'), review('Great', '2024-02-01')] };
  const undated = { place_id: 'p3', name: 'Roofing Three', address: '3 Main St' };
  const answer = await findSignals({ source: 'local-businesses-by-place', items: [quiet, slow, undated], now });
  assert.deepEqual(answer.prospects.map(item => [item.key, item.score]), [['p1', 5], ['p2', 0], ['p3', 0]]);
  const found = answer.prospects[0].signals;
  assert.deepEqual(found.map(signal => signal.id), ['slow-quotes', 'review-spike']);
  assert.equal(found[0].evidence.value, 2);
  assert.match(found[0].evidence.matched[0], /slow quote/i);
  assert.equal(found[1].evidence.value, 0.6);
  assert.equal(answer.prospects[0].fields.email, 'info@example.com');
  assert.ok(!('reviews' in answer.prospects[0].fields), 'lists stay out of the answer');
});

test('a missing field keeps a signal quiet and refuses a filter', async () => {
  const answer = await findSignals({ source: 'local-businesses-by-place', items: [{ place_id: 'p3', name: 'No reviews listed' }, { name: 'No key' }, { place_id: 'p3', name: 'Twice' }], now });
  assert.equal(answer.prospects.length, 1);
  assert.equal(answer.prospects[0].score, 0);
  assert.deepEqual(answer.skipped, [{ key: 'item 1', reason: 'it has no key' }, { key: 'p3', reason: 'its key is already listed' }]);
});

test('limit cuts the list but count is everyone; min_score leaves out the quiet', async () => {
  const items = ['a', 'b', 'c'].map(id => post(id, 30, '2026-09-01'));
  const answer = await findSignals({ source: 'open-job-posts', items, now, limit: 2 });
  assert.equal(answer.count, 3);
  assert.equal(answer.prospects.length, 2);
  const row = { ...SOURCES.records[0], id: 'strict', min_score: 4 };
  assert.equal((await findSignals({ source_row: row, items, now })).count, 0);
  await assert.rejects(findSignals({ source: 'open-job-posts', items, limit: 0 }), /limit must be a whole number from 1 to 500/);
});

test('a bad source row is refused with every problem and what to do', async () => {
  const bad = { id: 'x', label: 'x', fields: { key: 'id' }, signals: [{ id: 's', says: 's', weight: 'heavy', of: 'nowhere', measure: 'count-matching', test: { around: 3 } }] };
  const problems = sourceProblems(bad);
  assert.ok(problems.some(line => line.startsWith('fields must map "key" and "name"')));
  assert.ok(problems.some(line => line.includes('weight must be a number')));
  assert.ok(problems.some(line => line.includes('.of must name a field the row\'s fields declare')));
  assert.ok(problems.some(line => line.includes('matching is needed by count-matching')));
  assert.ok(problems.some(line => line.includes('test must use at_least, at_most, between')));
  assert.ok(sourceProblems({ ...SOURCES.records[0], signals: [{ ...SOURCES.records[0].signals[0], measure: 'vibes' }] })[0].includes('measure must be one of: value, age-days'));
  await assert.rejects(findSignals({ source_row: bad, items: [] }), /The source row cannot be used/);
  await assert.rejects(findSignals({ source: 'nope', items: [] }), /Send source: one of open-job-posts, local-businesses-by-place/);
  await assert.rejects(findSignals({ source: 'open-job-posts' }), /Send items: source open-job-posts reads no address/);
  await assert.rejects(findSignals({ source: 'open-job-posts', items: 'x' }), /items must be a list/);
  await assert.rejects(findSignals({ source: 'open-job-posts', items: [], now: 'soon' }), /now must be a date/);
});

test('a measure added only as a row in a copy of signal-measures.json is accepted and run', async () => {
  const measures = structuredClone(MEASURES);
  measures.measures.push({ measure: 'count-recent-matching', meaning: 'Mentions of words within the last days.', steps: ['read', 'within-days', 'matching', 'count'], needs: ['matching', 'within_days'] });
  const row = {
    id: 'own', label: 'Own', fields: { key: 'id', name: 'name', reviews: { path: 'reviews', each: { text: 'text', date: 'date' } } }, filters: [],
    signals: [{ id: 'recent-complaint', says: 'Recent complaints.', weight: 1, of: 'reviews', measure: 'count-recent-matching', matching: ['late'], within_days: 30, test: { at_least: 1 } }],
  };
  const items = [{ id: 'k', name: 'K', reviews: [review('Always late', '2026-10-25'), review('Late once', '2025-01-01')] }];
  assert.deepEqual(sourceProblems(row), ['signals[0].measure must be one of: value, age-days, count-matching, count-within-days, share-within-days.']);
  const answer = await findSignals({ source_row: row, items, now }, { measures });
  assert.equal(answer.prospects[0].signals[0].evidence.value, 1);
  assert.deepEqual(sourceProblems(row, measures), []);
});

test('a row with a public request fills its address from parameters, reads the answer and refuses what it cannot', async () => {
  const row = { ...SOURCES.records[0], id: 'public', request: { url: 'https://jobs.example.com/{place}/open', items_path: 'data.posts' } };
  const asked = [];
  const fetchPage = async url => { asked.push(String(url)); return new Response(JSON.stringify({ data: { posts: [post('a', 30, '2026-09-01')] } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const answer = await findSignals({ source_row: row, parameters: { place: 'New York' }, now }, { fetchPage });
  assert.deepEqual(asked, ['https://jobs.example.com/New%20York/open']);
  assert.equal(answer.prospects[0].key, 'a');
  await assert.rejects(findSignals({ source_row: row, now }, { fetchPage }), /Send parameters\.place/);
  await assert.rejects(findSignals({ source_row: row, parameters: { place: 'x' }, now }, { fetchPage: async () => new Response('<html>', { status: 200 }) }), /did not answer JSON/);
  await assert.rejects(findSignals({ source_row: row, parameters: { place: 'x' }, now }, { fetchPage: async () => new Response('{"data":{}}', { status: 200 }) }), /holds no list at data\.posts/);
  await assert.rejects(findSignals({ source_row: row, parameters: { place: 'x' }, now }, { fetchPage: async () => new Response('no', { status: 403 }) }), /HTTP 403/);
});

const run = input => new Promise(resolve => {
  const child = execFile('node', ['do-work/find-signals-of-need.mjs'], { cwd: folder }, (error, stdout) => resolve({ code: error?.code ?? 0, last: JSON.parse(stdout.trim().split('\n').at(-1)) }));
  child.stdin.end(JSON.stringify(input));
});

test('the row\'s command answers { result } and refuses with { error }', async () => {
  const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records;
  const sample = rows[0].payload.verify[0];
  const ok = await run(sample.input);
  assert.equal(ok.code, 0);
  assert.equal(ok.last.result.prospects[0].signals[0].id, sample.contains);
  const refused = await run({ source: 'nope' });
  assert.equal(refused.code, 1);
  assert.match(refused.last.error, /Send source/);
});
