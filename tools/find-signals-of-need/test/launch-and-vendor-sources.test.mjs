// The launch rows (group launches) and the vendor proof row (group vendors) of sources.json, run by the same finder.
// Every launch, vendor, address and number here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MEASURES, SOURCES, findSignals, sourceProblems } from '../read-data/signals.mjs';

const group = name => SOURCES.records.filter(row => row.group === name);
const NOW = '2026-11-02T10:30:00Z';

test('every launch row is a valid source row that keeps only the last 24 hours, and a new launch source is only a row', () => {
  const launches = group('launches');
  assert.ok(launches.length >= 5, 'X, Product Hunt, YC launches, Hacker News and more are rows');
  for (const row of launches) {
    assert.deepEqual(sourceProblems(row), [], row.id);
    assert.ok(row.filters.some(filter => filter.measure === 'age-hours' && filter.test.between?.[1] === 24), `${row.id} keeps 24 hours`);
    assert.ok(row.signals.some(signal => signal.measure === 'age-hours' && signal.test.at_most === 0), `${row.id} scores the first hour highest`);
  }
  const added = { ...launches[0], id: 'launches-made-up-board', request: undefined };
  const answer = findSignals({ source_row: added, now: NOW, items: [{ objectID: 'z', title: 'Made-up launch', created_at: '2026-11-02T10:10:00Z', points: 1 }] });
  return answer.then(result => assert.equal(result.prospects[0].key, 'z'));
});

test('age-hours is a measure row, and a launch scores highest in its first hour and drops out after 24 hours', async () => {
  assert.ok(MEASURES.measures.some(row => row.measure === 'age-hours'));
  const items = [
    { objectID: 'fresh', title: 'Show HN: Fresh', url: 'https://fresh.example', created_at: '2026-11-02T10:05:00Z', points: 30, num_comments: 12 },
    { objectID: 'morning', title: 'Show HN: Morning', url: 'https://morning.example', created_at: '2026-11-02T06:00:00Z', points: 30, num_comments: 0 },
    { objectID: 'stale', title: 'Show HN: Stale', url: 'https://stale.example', created_at: '2026-10-31T09:00:00Z', points: 900 },
    { objectID: 'undated', title: 'Show HN: Undated', points: 5 },
  ];
  const answer = await findSignals({ source: 'launches-hacker-news', now: NOW, items });
  assert.deepEqual(answer.prospects.map(prospect => prospect.key), ['fresh', 'morning']);
  assert.deepEqual(answer.prospects[0].signals.map(signal => signal.id), ['launched-within-the-hour', 'launched-within-six-hours', 'drawing-votes', 'drawing-comments']);
  assert.deepEqual(answer.prospects[1].signals.map(signal => signal.id), ['launched-within-six-hours', 'drawing-votes']);
  assert.deepEqual(answer.skipped.map(skip => skip.key), ['stale', 'undated']);
});

test('a launch row with a public address reads it; one behind a login asks for items', async () => {
  const asked = [];
  const fetchPage = async url => { asked.push(String(url)); return new Response(JSON.stringify({ items: [{ id: 7, full_name: 'maker/tool', html_url: 'https://code.example/maker/tool', created_at: '2026-11-02T09:00:00Z', stargazers_count: 80 }] }), { status: 200 }); };
  const answer = await findSignals({ source: 'launches-github', parameters: { since: '2026-11-01' }, now: NOW }, { fetchPage });
  assert.match(asked[0], /created:%3E2026-11-01/);
  assert.equal(answer.prospects[0].name, 'maker/tool');
  await assert.rejects(findSignals({ source: 'launches-product-hunt', now: NOW }), /Send items: source launches-product-hunt reads no address/);
});

test('vendors are scored only on metrics with proof: a missing metric never counts, and the row has no sponsorship field', async () => {
  const [row] = group('vendors');
  assert.deepEqual(sourceProblems(row), []);
  assert.ok(!Object.keys(row.fields).some(name => /sponsor/i.test(name)), 'sponsorship cannot move a score');
  const items = [
    { slug: 'alpha', name: 'Alpha', url: 'https://alpha.example', proof: { named_customers: 8, review_count: 240, review_rating: 4.6, uptime_percent: 99.95, price_published: 1, security_attestations: 1, last_release_at: '2026-10-20' } },
    { slug: 'beta', name: 'Beta', url: 'https://beta.example', proof: { named_customers: 2, review_count: 40, review_rating: 4.8, uptime_percent: null, price_published: 0 } },
    { slug: 'gamma', name: 'Gamma', url: 'https://gamma.example', proof: { named_customers: 50, price_published: 1 } },
  ];
  const answer = await findSignals({ source: 'vendors-by-verifiable-proof', now: '2026-11-02', items });
  assert.deepEqual(answer.prospects.map(vendor => [vendor.key, vendor.score]), [['alpha', 13], ['beta', 2]]);
  assert.ok(!answer.prospects[1].signals.some(signal => signal.id === 'reliable'), 'a metric sent as null stays quiet');
  assert.deepEqual(answer.skipped, [{ key: 'gamma', reason: 'review_count is missing' }]);
});
