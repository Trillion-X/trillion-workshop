// Tests on made-up data: a fake treg caller, a PGlite database for the SQL plan, and the sample run through the command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { measure, requestProblems, fill, replayCall, readData } from '../do-work/measure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMAND = path.join(HERE, '..', 'do-work', 'measure.mjs');
const NOW = new Date('2026-01-02T03:04:05.000Z');

// A made-up site: every name, domain and address here is invented.
const REQUEST = {
  site: 'example-flooring.test',
  store: 'sample_store_for_who_runs_it',
  phase: 'before',
  client: 'sample-client',
  location: 'Sample Town, ST',
  keywords: ['sample flooring service', 'example flooring', 'sample floor removal'],
  questions: ['who installs example floors'],
  engines: ['chatgpt', 'perplexity'],
  name_pattern: 'Example Flooring',
};

// Fake treg: answers from a table keyed like the replay file, and fails for one made-up keyword.
function fakeCall(overrides = {}) {
  const seen = [];
  const replies = {
    'treg.google.serp.organic sample flooring service': { result: { output: { results: [
      { position: 1, domain: 'other-floors.test', url: 'https://other-floors.test/' },
      { position: 2, domain: 'example-flooring.test', url: 'https://example-flooring.test/hardwood' },
    ] } }, _treg: { call_id: 'c-serp-1' } },
    'treg.google.serp.organic example flooring': { result: { output: { results: [
      { position: 1, domain: 'other-floors.test', url: 'https://other-floors.test/' },
      { position: 3, domain: 'third.test', url: 'https://third.test/' },
    ] } }, _treg: { call_id: 'c-serp-2' } },
    'treg.google.serp.organic sample floor removal': { result: { output: { results: [
      { title: 'no domain here' },
    ] } }, _treg: { call_id: 'c-serp-3' } },
    'treg.google.keywords.volume sample flooring service|example flooring|sample floor removal': { result: { output: { rows: [
      { keyword: 'sample flooring service', search_volume: 320, cpc: 1.5 },
      { keyword: 'example flooring', volume: 40 },
    ] } }, _treg: { call_id: 'c-volume' } },
    'cloro.ai-search.chatgpt.scrape who installs example floors': { result: { result: {
      text: 'Example Flooring installs hardwood in the sample town.',
      sources: [{ url: 'https://example-flooring.test/hardwood' }],
    } }, _treg: { call_id: 'c-chatgpt' } },
    'perplexity.web.answer.fast who installs example floors': { result: { output: [
      { type: 'search_results', results: [{ url: 'https://other-floors.test/' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Local installers serve the town.', annotations: [] }] },
    ] }, _treg: { call_id: 'c-perplexity' } },
    ...overrides,
  };
  const call = async (endpoint, body) => {
    const key = body.q ?? body.prompt ?? body.input ?? (Array.isArray(body.keywords) ? body.keywords.join('|') : '');
    seen.push({ endpoint, body });
    const reply = replies[`${endpoint} ${key}`];
    if (!reply) throw new Error(`fake treg has no answer for ${endpoint} ${key}`);
    if (reply.fail) throw new Error(reply.fail);
    return reply;
  };
  call.seen = seen;
  return call;
}

test('a request with several faults names every one at once', () => {
  const problems = requestProblems({ site: 'https://example.test/x', store: ' ', keywords: [], engines: ['bing'], phase: 'soon' }, ['chatgpt']);
  assert.equal(problems.length, 5);
  assert.match(problems.join(' '), /bare host/);
  assert.match(problems.join(' '), /store must name/);
  assert.match(problems.join(' '), /give at least one search term/);
  assert.match(problems.join(' '), /engines must be/);
  assert.match(problems.join(' '), /phase must be/);
});

test('an empty request object and a bad regular expression are refused', () => {
  assert.deepEqual(requestProblems(null, []), ['The request must be one JSON object.']);
  assert.match(requestProblems({ ...REQUEST, name_pattern: '(' }, ['chatgpt', 'perplexity']).join(' '), /valid regular expression/);
});

test('fill drops a placeholder with no value and keeps arrays whole', () => {
  assert.deepEqual(fill({ q: '{query}', location: '{location}', keywords: '{keywords}' }, { query: 'a b', location: null, keywords: ['x', 'y'] }),
    { q: 'a b', keywords: ['x', 'y'] });
  assert.equal(fill('per {x} now', { x: 'day' }), 'per day now');
});

test('the rows: ranked, not ranked, not measured, volume, answers and the client tag', async () => {
  const call = fakeCall();
  const result = await measure(REQUEST, { call, now: NOW });
  const ranking = result.rows.filter((r) => r.kind === 'ranking');
  const byQuery = Object.fromEntries(ranking.map((r) => [r.query, r]));
  assert.equal(byQuery['sample flooring service'].position, 2);
  assert.equal(byQuery['sample flooring service'].ranking_url, 'https://example-flooring.test/hardwood');
  assert.equal(byQuery['example flooring'].position, null, 'a keyword with no site result is measured-not-ranking');
  assert.equal(byQuery['example flooring'].raw.measured, true);
  assert.equal(byQuery['sample floor removal'].raw.measured, false, 'a SERP with no readable domains is not measured');
  assert.equal(byQuery['sample flooring service'].raw.top3.length, 2, 'the top-3 list is kept for the keywords of the top ten');
  const volume = Object.fromEntries(result.rows.filter((r) => r.kind === 'keyword-volume').map((r) => [r.query, r.search_volume]));
  assert.deepEqual(volume, { 'sample flooring service': 320, 'example flooring': 40, 'sample floor removal': null });
  const answers = result.rows.filter((r) => r.kind === 'answer-engine');
  assert.equal(answers.length, 2);
  const chatgpt = answers.find((r) => r.engine === 'chatgpt');
  assert.equal(chatgpt.named, true);
  assert.equal(chatgpt.cited, true);
  assert.deepEqual(chatgpt.cited_addresses, ['https://example-flooring.test/hardwood']);
  const perplexity = answers.find((r) => r.engine === 'perplexity');
  assert.equal(perplexity.named, false);
  assert.equal(perplexity.cited, false);
  assert.deepEqual(perplexity.cited_addresses, []);
  for (const row of result.rows) {
    assert.equal(row.raw.client, 'sample-client');
    assert.equal(row.site, 'example-flooring.test');
    assert.equal(row.phase, 'before');
    assert.equal(row.kept_by, 'ai:tool:measure-search-visibility');
    assert.equal(row.measured_at, NOW.toISOString());
  }
  assert.deepEqual(result.counts, { ranking: 3, 'keyword-volume': 3, 'answer-engine': 2 });
});

test('a location is sent only when given, and a failed call is an error, not a row', async () => {
  const call = fakeCall({ 'treg.google.serp.organic sample floor removal': { fail: 'treg answered 503' } });
  const withLocation = await measure({ ...REQUEST, engines: ['google-ai-mode'] }, { call: fakeCall({
    'cloro.google.serp.ai_mode who installs example floors': { result: { result: { text: 'Example Flooring is in Sample Town.', sources: [] } }, _treg: { call_id: 'c-mode' } },
  }), now: NOW });
  assert.equal(withLocation.rows.find((r) => r.engine === 'google-ai-mode').location, 'Sample Town, ST');
  const withoutLocation = await measure({ ...REQUEST, location: null, engines: ['chatgpt'], keywords: ['example flooring'] }, { call: fakeCall(), now: NOW });
  assert.equal(withoutLocation.rows.some((r) => r.location !== null), false);
  assert.equal(call.seen.length, 0, 'no call yet');
  const failing = await measure(REQUEST, { call, now: NOW });
  assert.deepEqual(failing.errors, [{ kind: 'ranking', engine: 'google-us-organic', query: 'sample floor removal', msg: 'treg answered 503' }]);
  assert.equal(failing.rows.some((r) => r.query === 'sample floor removal' && r.kind === 'ranking'), false);
});

test('a Search Console read is mapped into ranking rows only when given', async () => {
  const without = await measure(REQUEST, { call: fakeCall(), now: NOW });
  assert.equal(without.search_console, 'not provided');
  const withRows = await measure({ ...REQUEST, search_console: {
    site_url: 'sc-domain:example-flooring.test', start_date: '2025-12-01', end_date: '2025-12-31',
    rows: [
      { query: 'example flooring company', clicks: 2, impressions: 40, ctr: 0.05, position: 4.6 },
      { page: 'https://example-flooring.test/hardwood', clicks: 0, impressions: 9, ctr: 0, position: 12.2 },
      { clicks: 1, impressions: 1 },
    ],
  } }, { call: fakeCall(), now: NOW });
  assert.equal(withRows.search_console, 'read');
  const sc = withRows.rows.filter((r) => r.engine === 'google-search-console');
  assert.equal(sc.length, 2, 'a row with no query or page is skipped');
  assert.equal(sc[0].position, 5);
  assert.equal(sc[0].raw.average_position, 4.6);
  assert.equal(sc[1].ranking_url, 'https://example-flooring.test/hardwood');
  assert.equal(sc[1].raw.dimension, 'page');
});

test('the SQL plan creates the table, writes every row and refuses a bad phase, on PGlite', async () => {
  const result = await measure(REQUEST, { call: fakeCall(), now: NOW });
  const db = new PGlite();
  try {
    for (const statement of result.sql.statements) await db.exec(statement);
    for (const values of result.sql.inserts) await db.query(result.sql.insert, values);
    const back = await db.query('select kind, count(*)::int as n, count(*) filter (where raw->>\'client\' = \'sample-client\')::int as tagged from public.search_visibility_measures group by kind order by kind');
    assert.deepEqual(back.rows, [
      { kind: 'answer-engine', n: 2, tagged: 2 },
      { kind: 'keyword-volume', n: 3, tagged: 3 },
      { kind: 'ranking', n: 3, tagged: 3 },
    ]);
    const cited = await db.query('select cited_addresses from public.search_visibility_measures where engine = \'chatgpt\'');
    assert.deepEqual(cited.rows[0].cited_addresses, ['https://example-flooring.test/hardwood']);
    await assert.rejects(db.query(result.sql.insert, [...result.sql.inserts[0].slice(0, 2), 'soon', ...result.sql.inserts[0].slice(3)]), /check constraint|violates/);
  } finally {
    await db.close();
  }
});

test('the replay file answers the sample run through the command, with one JSON line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-search-visibility-'));
  const file = path.join(dir, 'request.json');
  const sample = { site: 'example-flooring.test', store: 'sample-store', phase: 'before', client: 'sample-client',
    keywords: ['sample flooring service', 'example flooring'], questions: ['who installs example floors'], engines: ['chatgpt', 'perplexity'],
    name_pattern: 'Example Flooring', replay: 'sample-replies.json' };
  fs.writeFileSync(file, JSON.stringify(sample));
  const out = execFileSync(process.execPath, [COMMAND, file], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  const answer = JSON.parse(lines[lines.length - 1]);
  assert.ok(answer.result, `expected a result, got ${lines[lines.length - 1]}`);
  assert.deepEqual(answer.result.counts, { ranking: 2, 'keyword-volume': 2, 'answer-engine': 2 });
  assert.deepEqual(answer.result.errors, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bad request file answers an error to change, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-search-visibility-'));
  const file = path.join(dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify({ site: 'nope', keywords: [] }));
  const answer = JSON.parse(execFileSync(process.execPath, [COMMAND, file], { encoding: 'utf8' }).trim());
  assert.match(answer.error, /bare host/);
  assert.match(answer.error, /store must name/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the replay caller refuses a question with no recorded reply', async () => {
  const call = replayCall('sample-replies.json');
  await assert.rejects(call('cloro.ai-search.chatgpt.scrape', { prompt: 'an unrecorded question' }), /no replay reply/);
  const endpoints = readData('endpoints.json');
  assert.equal(endpoints.organic.endpoint, 'treg.google.serp.organic');
});

test('local-map rows: the place order, its rating, reviews, photos and category, beside the first place', async () => {
  const mapsReply = (term, places) => ({ result: { output: { places } }, _treg: { call_id: `c-maps-${term.replace(/ /g, '-')}` } });
  const place = (rank, title, domain, rating, reviews, photos, category) => ({
    rank_absolute: rank, title, domain, url: `https://${domain}/`, rating: { value: rating, votes_count: reviews }, total_photos: photos, category,
  });
  const replies = {
    'treg.google.serp.maps sample local flooring': mapsReply('a', [
      place(1, 'Sample Floors Store', 'sample-floors.test', 4.9, 440, 135, 'Flooring store'),
      place(2, 'Other Floor Shop', 'other-shop.test', 4.2, 80, 20, 'Flooring store'),
      place(3, 'Example Flooring Co', 'example-flooring.test', 5.0, 7, 22, 'Flooring contractor'),
    ]),
    'treg.google.serp.maps sample floor removal': mapsReply('b', [
      place(1, 'Sample Floors Store', 'sample-floors.test', 4.9, 440, 135, 'Flooring store'),
      place(2, 'Other Floor Shop', 'other-shop.test', 4.2, 80, 20, 'Flooring store'),
    ]),
    'treg.google.serp.maps sample flooring install': { result: { output: { places: [] } }, _treg: { call_id: 'c-maps-empty' } },
  };
  const call = async (endpoint, body) => {
    if (endpoint === 'treg.google.serp.maps') {
      const reply = replies[`${endpoint} ${body.q}`];
      if (!reply) throw new Error(`fake treg has no maps answer for ${body.q}`);
      return reply;
    }
    return fakeCall()(endpoint, body);
  };
  const result = await measure({
    site: 'example-flooring.test', store: 'sample_store_for_who_runs_it', client: 'sample-client', location: 'Sample Town, ST',
    keywords: [], local_keywords: ['sample local flooring', 'sample floor removal', 'sample flooring install'],
    name_pattern: 'Example Flooring',
  }, { call, now: NOW });
  const local = Object.fromEntries(result.rows.filter((r) => r.kind === 'local-map').map((r) => [r.query, r]));
  assert.equal(Object.keys(local).length, 3, 'one row per local term, the absent and empty ones too');
  const found = local['sample local flooring'];
  assert.equal(found.position, 3, 'the place order among the returned places');
  assert.equal(found.engine, 'google-maps');
  assert.equal(found.ranking_url, 'https://example-flooring.test/');
  assert.deepEqual(found.raw.top1, { title: 'Sample Floors Store', rating: 4.9, reviews: 440, photos: 135, category: 'Flooring store' });
  assert.equal(found.raw.rating, 5.0);
  assert.equal(found.raw.reviews, 7);
  assert.equal(found.raw.photos, 22);
  assert.equal(found.raw.category, 'Flooring contractor');
  assert.equal(found.raw.client, 'sample-client');
  const absent = local['sample floor removal'];
  assert.equal(absent.position, null, 'a returned list without the business is measured as absent');
  assert.equal(absent.raw.measured, true);
  assert.equal(absent.raw.rating, null);
  const empty = local['sample flooring install'];
  assert.equal(empty.position, null);
  assert.equal(empty.raw.measured, false, 'an empty Maps answer is not measured, not a confirmed absence');
  assert.equal(result.counts['local-map'], 3);
});

test('a request with only local terms is valid; no terms at all is refused', () => {
  assert.deepEqual(requestProblems({ site: 'example.test', store: 's', local_keywords: ['sample local flooring'] }, ['chatgpt']), []);
  assert.match(requestProblems({ site: 'example.test', store: 's' }, ['chatgpt']).join(' '), /at least one search term/);
  assert.match(requestProblems({ site: 'example.test', store: 's', local_keywords: [''] }, ['chatgpt']).join(' '), /local_keywords must be/);
});

test('the kind constraint is replaced, so a table made before local-map accepts it, on PGlite', async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE public.search_visibility_measures (id bigserial primary key, site text not null, measured_at timestamptz not null, phase text not null check (phase in ('before','after','check')), kind text not null check (kind in ('ranking','answer-engine','keyword-volume')), query text not null, engine text not null, location text, position int, ranking_url text, search_volume int, named boolean, cited boolean, cited_addresses text[], source text not null, raw jsonb, kept_by text not null)");
    const local = await measure({ site: 'example-flooring.test', store: 's', local_keywords: ['sample local flooring'], name_pattern: 'Example Flooring' }, {
      call: async (endpoint) => ({ result: { output: { places: [{ rank_absolute: 1, title: 'Example Flooring Co', domain: 'example-flooring.test', rating: { value: 4.8, votes_count: 9 }, total_photos: 3, category: 'Flooring store' }] } }, _treg: { call_id: 'c' } }),
      now: NOW,
    });
    await assert.rejects(db.query(local.sql.insert, local.sql.inserts[0]), /check constraint|violates/);
    for (const statement of local.sql.statements) await db.exec(statement);
    await db.query(local.sql.insert, local.sql.inserts[0]);
    const back = await db.query("select kind, position from public.search_visibility_measures where kind = 'local-map'");
    assert.deepEqual(back.rows, [{ kind: 'local-map', position: 1 }]);
  } finally {
    await db.close();
  }
});
