// tools/measure-search-visibility/do-work/measure.mjs
//
// Measures how one site shows up in Google's organic results, in keyword volume and in AI answers, and returns the rows
// and the SQL that record them. The endpoints, the table and the sample replies are DATA in ../data; this file only fills
// the templates, reads the answers and builds the rows.
//
//   node measure.mjs REQUEST.json   -> last stdout line: {"result": ...} or {"error": "what to change"}
//
// Node's standard library only. treg is called through its own command (signed in on this computer); a request that
// names a replay file (a file in ../data) reads its answers from that file instead, so a sample run needs no network.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');
const execFileAsync = promisify(execFile);
const PHASES = ['before', 'after', 'check'];
const KEPT_BY_DEFAULT = 'ai:tool:measure-search-visibility';

export const readData = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Fills a template: "{name}" takes the whole value (an array stays an array); "{name}" inside text is replaced by its text;
// an object key whose whole value is a placeholder with no value given is left out of the body.
export function fill(template, vars) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{(\w+)\}$/);
    if (whole) return vars[whole[1]] ?? undefined;
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
  }
  if (Array.isArray(template)) return template.map((item) => fill(item, vars));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template)
      .map(([key, value]) => [key, fill(value, vars)])
      .filter(([, value]) => value !== undefined));
  }
  return template;
}

// The request's problems, every one at once. An empty list is a valid request.
export function requestProblems(request, engineNames) {
  const problems = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) return ['The request must be one JSON object.'];
  if (typeof request.site !== 'string' || !/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(request.site)) {
    problems.push('site must be a bare host such as example.com: no https://, no path.');
  }
  if (typeof request.store !== 'string' || !request.store.trim()) {
    problems.push('store must name the database the rows go to, the name the person saved its connection under.');
  }
  if (!Array.isArray(request.keywords) || request.keywords.length === 0 || request.keywords.some((k) => typeof k !== 'string' || !k.trim())) {
    problems.push('keywords must list at least one search term, each a non-empty text.');
  }
  if (request.questions !== undefined && (!Array.isArray(request.questions) || request.questions.some((q) => typeof q !== 'string' || !q.trim()))) {
    problems.push('questions must be a list of question texts (may be empty).');
  }
  if (request.phase !== undefined && !PHASES.includes(request.phase)) problems.push(`phase must be one of ${PHASES.join(', ')}.`);
  if (request.engines !== undefined && (!Array.isArray(request.engines) || request.engines.some((e) => !engineNames.includes(e)))) {
    problems.push(`engines must be a list drawn from ${engineNames.join(', ')}.`);
  }
  if (request.name_pattern !== undefined) {
    try { new RegExp(request.name_pattern, 'i'); } catch { problems.push('name_pattern must be a valid regular expression (the name the answer must say).'); }
  }
  if (request.search_console !== undefined) {
    const sc = request.search_console;
    if (!sc || typeof sc !== 'object' || !Array.isArray(sc.rows) || typeof sc.site_url !== 'string') {
      problems.push('search_console must hold site_url and the rows already read from Search Console.');
    }
  }
  return problems;
}

// The default caller: the treg command, signed in on this computer. Resolves to the envelope treg prints, or throws an
// Error whose message says what treg answered.
export async function callTreg(endpoint, body) {
  try {
    const { stdout } = await execFileAsync('treg', ['--json', 'call', endpoint, '--method', 'POST', '--data', JSON.stringify(body)],
      { maxBuffer: 64 * 1024 * 1024, timeout: 240000 });
    return JSON.parse(stdout);
  } catch (error) {
    let envelope = null;
    try { envelope = JSON.parse(error.stdout); } catch { /* not JSON */ }
    const detail = envelope?.result?.detail?.error;
    throw new Error(detail ?? (error.code ? `treg exited ${error.code}` : 'treg call failed'));
  }
}

// A caller that answers from a replay file in ../data: replies keyed by "endpoint question-or-keyword-list".
export function replayCall(replayName) {
  const file = path.basename(replayName);
  const { replies } = JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
  return async (endpoint, body) => {
    const key = body.q ?? body.prompt ?? body.input ?? (Array.isArray(body.keywords) ? body.keywords.join('|') : '');
    const reply = replies[`${endpoint} ${key}`];
    if (!reply) throw new Error(`no replay reply for ${endpoint} ${key}`);
    if (reply.error) throw new Error(reply.error);
    return reply;
  };
}

async function pool(items, size, task) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await task(items[next++]);
  }));
}

const urlsIn = (value) => JSON.stringify(value).match(/https?:\/\/[^\s"'\\)\]]+/g) ?? [];

// Runs the whole measure. Returns {site, store, phase, measured_at, counts, rows, sql, errors, search_console}.
export async function measure(request, { call = callTreg, now = new Date() } = {}) {
  const data = readData('endpoints.json');
  const table = readData('table.json');
  const engineNames = Object.keys(data.engines);
  const problems = requestProblems(request, engineNames);
  if (problems.length) throw new MeasureRequestError(problems.join(' '));

  const site = request.site;
  const phase = request.phase ?? 'before';
  const location = request.location ?? null;
  const client = request.client ?? null;
  const keptBy = request.kept_by ?? KEPT_BY_DEFAULT;
  const engines = request.engines ?? engineNames;
  const keywords = request.keywords;
  const questions = request.questions ?? [];
  const measuredAt = now.toISOString();
  const nameRe = request.name_pattern ? new RegExp(request.name_pattern, 'i') : null;
  const siteRe = new RegExp(`(^|\\.)${escapeRe(site)}$`, 'i');
  const onSite = (value) => siteRe.test(String(value ?? '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase());
  const withClient = (raw) => (client ? { client, ...raw } : raw);
  const top3Set = new Set(request.top3_keywords ?? keywords.slice(0, 10));

  const rows = [];
  const errors = [];
  const failed = (kind, query, engine, error) => errors.push({ kind, engine, query, msg: error.message });

  // 1. organic ranking, one call per keyword
  await pool(keywords, 4, async (keyword) => {
    let envelope;
    try { envelope = await call(data.organic.endpoint, fill(data.organic.body, { query: keyword })); } catch (error) { return failed('ranking', keyword, 'google-us-organic', error); }
    const results = Array.isArray(envelope.result?.output?.results) ? envelope.result.output.results : [];
    const readable = results.length > 0 && results.every((r) => r.domain || r.url);
    const hit = results.find((r) => onSite(r.domain) || onSite(r.url));
    const raw = withClient({ depth_returned: results.length, measured: readable });
    if (!readable) raw.note = 'SERP response had results without domain or url; not measured, not a confirmed non-ranking';
    if (top3Set.has(keyword) && readable) raw.top3 = results.filter((r) => r.position <= 3).map((r) => ({ position: r.position, domain: r.domain, url: r.url }));
    rows.push({
      kind: 'ranking', engine: 'google-us-organic', query: keyword, location,
      position: readable && hit ? hit.position : null, ranking_url: readable && hit ? hit.url : null, search_volume: null,
      named: null, cited: null, cited_addresses: null,
      source: `${data.organic.endpoint}#${envelope._treg?.call_id ?? 'none'}`, raw,
    });
  });

  // 2. keyword volume, one batch call
  if (keywords.length) {
    let envelope = null;
    try { envelope = await call(data.volume.endpoint, fill(data.volume.body, { keywords })); } catch (error) { failed('keyword-volume', keywords.join(', '), 'google-us-volume', error); }
    if (envelope) {
      const volumeRows = Array.isArray(envelope.result?.output?.rows) ? envelope.result.output.rows : [];
      const byKeyword = new Map(volumeRows.map((r) => [r.keyword, r]));
      for (const keyword of keywords) {
        const r = byKeyword.get(keyword);
        const volume = typeof r?.search_volume === 'number' ? r.search_volume : (typeof r?.volume === 'number' ? r.volume : null);
        rows.push({
          kind: 'keyword-volume', engine: 'google-us-volume', query: keyword, location,
          position: null, ranking_url: null, search_volume: volume,
          named: null, cited: null, cited_addresses: null,
          source: `${data.volume.endpoint}#${envelope._treg?.call_id ?? 'none'}`,
          raw: withClient({ cpc: r?.cpc ?? null, competition: r?.competition ?? null, is_data_found: volume != null }),
        });
      }
    }
  }

  // 3. answer engines, every question on every chosen engine
  const jobs = questions.flatMap((question) => engines.map((engine) => ({ question, engine })));
  await pool(jobs, 4, async ({ question, engine }) => {
    const spec = data.engines[engine];
    let envelope;
    try { envelope = await call(spec.endpoint, fill(spec.body, { question, location })); } catch (error) { return failed('answer-engine', question, engine, error); }
    let text = '';
    let cited = [];
    let sources = null;
    let extra = {};
    if (spec.parse === 'perplexity-answer') {
      const items = Array.isArray(envelope.result?.output) ? envelope.result.output : [];
      const messages = items.filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
      const found = items.filter((item) => item.type === 'search_results').flatMap((item) => item.results ?? []);
      text = messages.map((c) => c.text ?? '').join('\n');
      cited = [...new Set([...found.map((r) => r.url), ...messages.flatMap((c) => (c.annotations ?? []).map((a) => a.url))].filter(onSite))];
      sources = found.slice(0, 10).map((r) => ({ url: r.url, title: r.title ?? null }));
      extra = { model: envelope.result?.model ?? null };
    } else {
      const answer = envelope.result?.result ?? {};
      text = typeof answer.text === 'string' ? answer.text : (typeof answer.markdown === 'string' ? answer.markdown : '');
      const { markdown, html, rawResponse, ...kept } = answer;
      cited = [...new Set(urlsIn(kept).filter(onSite))];
      sources = answer.sources ?? answer.citations ?? answer.citationPills ?? null;
    }
    rows.push({
      kind: 'answer-engine', engine, query: question, location,
      position: null, ranking_url: null, search_volume: null,
      named: nameRe ? nameRe.test(text) : null, cited: cited.length > 0, cited_addresses: cited,
      source: `${spec.endpoint}#${envelope._treg?.call_id ?? 'none'}`,
      raw: withClient({ text: text.slice(0, 1500), sources, ...extra }),
    });
  });

  // 4. Search Console rows the caller already read (this tool does not call Google)
  let searchConsole = 'not provided';
  if (request.search_console) {
    searchConsole = 'read';
    const sc = request.search_console;
    for (const r of sc.rows) {
      const query = r.query ?? r.page;
      if (!query) continue;
      rows.push({
        kind: 'ranking', engine: 'google-search-console', query, location,
        position: typeof r.position === 'number' ? Math.round(r.position) : null,
        ranking_url: r.page ?? null, search_volume: null,
        named: null, cited: null, cited_addresses: null,
        source: `search-console:${sc.site_url}:${sc.start_date ?? ''}..${sc.end_date ?? ''}`,
        raw: withClient({ clicks: r.clicks ?? null, impressions: r.impressions ?? null, ctr: r.ctr ?? null, average_position: r.position ?? null, dimension: r.query ? 'query' : 'page' }),
      });
    }
  }

  const finished = rows.map((row) => ({ ...row, site, measured_at: measuredAt, phase, kept_by: keptBy }));
  const counts = {};
  for (const row of finished) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  const sql = {
    store: request.store,
    statements: table.statements,
    insert: table.insert,
    inserts: finished.map((row) => [row.site, row.measured_at, row.phase, row.kind, row.query, row.engine, row.location, row.position,
      row.ranking_url, row.search_volume, row.named, row.cited, row.cited_addresses, row.source, JSON.stringify(row.raw ?? null), row.kept_by]),
  };
  return { site, store: request.store, phase, measured_at: measuredAt, counts, rows: finished, sql, errors, search_console: searchConsole };
}

export class MeasureRequestError extends Error {}

// The command: read the request file, answer one JSON line.
async function main(file) {
  if (!file) return { error: 'Give the request file as the argument: node measure.mjs REQUEST.json' };
  let request;
  try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { error: `The request file is not readable JSON: ${error.message}` }; }
  try {
    const call = request.replay ? replayCall(request.replay) : callTreg;
    return { result: await measure(request, { call }) };
  } catch (error) {
    if (error instanceof MeasureRequestError) return { error: error.message };
    return { error: `The measure stopped: ${error.message}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await main(process.argv[2])));
}
