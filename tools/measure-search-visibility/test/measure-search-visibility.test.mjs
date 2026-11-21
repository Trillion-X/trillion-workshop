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
  assert.match(problems.join(' '), /keywords must list/);
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
