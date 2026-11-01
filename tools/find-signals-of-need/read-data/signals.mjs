// tools/find-signals-of-need/read-data/signals.mjs
//
// One finder for any list of candidates: a signal-source row says how an item maps to fields, which items are kept and
// which signals of need add to a score; the measures a signal may take are rows of signal-measures.json, each a list of
// steps from the closed set below. No source, site, word or number is written here; a row brings them.
//
//   findSignals(input, { sources, measures, fetchPage }) -> { source, count, prospects, skipped, said }
//   sourceProblems(row, measures) -> every problem with a source row, as plain sentences
//
// Invariants: a field an item lacks makes a filter refuse the item and a signal stay quiet, never count as zero; the
// same items give the same ranking (score, then key); nothing is sent or kept.
import { readFileSync } from 'node:fs';
import { fetchText } from '../../research-a-creator-or-topic/do-work/fetch-text.mjs';

const load = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
export const MEASURES = load('signal-measures.json');
export const SOURCES = load('sources.json');

const DAY = 86_400_000;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const MAX_SKIPPED = 100;
const MAX_TEXT = 500;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const TEST_KEYS = ['at_least', 'at_most', 'between'];

const pathValue = (value, path) => String(path).split('.').reduce((at, key) => (at === undefined || at === null ? undefined : at[key]), value);
const missing = value => value === undefined || value === null || value === '';
const dateOf = value => { const time = typeof value === 'string' || typeof value === 'number' ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : null; };

// What each step of a measure does to { value, total, kept }. A step that cannot read its value ends the measure as missing.
const STEPS = {
  read: (state, signal, fields) => { const value = fields[signal.of]; if (missing(value)) return null; return { ...state, value, total: Array.isArray(value) ? value.length : undefined }; },
  matching: (state, signal) => {
    if (!Array.isArray(state.value)) return null;
    const words = signal.matching.map(word => word.toLowerCase());
    return { ...state, value: state.value.filter(entry => { const text = String(entry?.text ?? entry ?? '').toLowerCase(); return words.some(word => text.includes(word)); }) };
  },
  'within-days': (state, signal, _fields, now) => {
    if (!Array.isArray(state.value)) return null;
    const from = now - signal.within_days * DAY;
    const dated = state.value.filter(entry => dateOf(entry?.date) !== null);
    return { ...state, value: dated.filter(entry => { const time = dateOf(entry.date); return time >= from && time <= now; }), total: dated.length };
  },
  count: state => (Array.isArray(state.value) ? { ...state, value: state.value.length, kept: state.value } : null),
  share: state => (Array.isArray(state.value) && state.total > 0 ? { ...state, value: state.value.length / state.total, kept: state.value } : null),
  'age-days': state => { const time = dateOf(state.value); return time === null ? null : { ...state, value: Math.floor((state.now - time) / DAY) }; },
  number: state => { const number = typeof state.value === 'number' || nonempty(state.value) ? Number(state.value) : NaN; return Number.isFinite(number) ? { ...state, value: number } : null; },
};
export const STEP_NAMES = Object.keys(STEPS);

// Whether a value passes a test ({ at_least }, { at_most } or { between: [low, high] }, all that are present).
export function passes(value, test) {
  return (test.at_least === undefined || value >= test.at_least) && (test.at_most === undefined || value <= test.at_most)
    && (test.between === undefined || (value >= test.between[0] && value <= test.between[1]));
}

// The measure of one field of one item: { value, matched } or null when the item lacks what the measure reads.
function measure(spec, fields, now, measures) {
  const row = measures.measures.find(entry => entry.measure === spec.measure);
  let state = { now };
  for (const step of row.steps) { state = STEPS[step](state, spec, fields, now); if (state === null) return null; state.now = now; }
  const matched = Array.isArray(state.kept) ? state.kept.slice(0, 3).map(entry => String(entry?.text ?? entry ?? '').slice(0, 120)).filter(Boolean) : undefined;
  return { value: state.value, ...(matched?.length ? { matched } : {}) };
}

// Every problem with one list of filters or signals (`kind` names which) of a source row.
function specProblems(specs, kind, row, measures) {
  const problems = [];
  const known = new Map(measures.measures.map(entry => [entry.measure, entry]));
  const seen = new Set();
  for (const [at, spec] of (Array.isArray(specs) ? specs : []).entries()) {
    const where = `${kind}[${at}]`;
    if (!object(spec)) { problems.push(`${where} must be an object.`); continue; }
    if (kind === 'signals') {
      if (!nonempty(spec.id)) problems.push(`${where}.id must name the signal.`);
      else if (seen.has(spec.id)) problems.push(`${where}.id "${spec.id}" is used twice.`);
      seen.add(spec.id);
      if (!nonempty(spec.says)) problems.push(`${where}.says must say in plain words what the signal means.`);
      if (typeof spec.weight !== 'number' || !Number.isFinite(spec.weight)) problems.push(`${where}.weight must be a number: how much the signal adds to the score.`);
    }
    if (!nonempty(spec.of) || !(row.fields && spec.of in row.fields)) problems.push(`${where}.of must name a field the row's fields declare.`);
    const measureRow = known.get(spec.measure);
    if (!measureRow) { problems.push(`${where}.measure must be one of: ${[...known.keys()].join(', ')}.`); continue; }
    for (const need of measureRow.needs ?? []) {
      const value = spec[need];
      const good = need === 'matching' ? Array.isArray(value) && value.length > 0 && value.every(nonempty) : Number.isFinite(value) && value > 0;
      if (!good) problems.push(`${where}.${need} is needed by ${spec.measure}${need === 'matching' ? ' and must list the words to look for.' : ' and must be a number of days above 0.'}`);
    }
    const test = spec.test;
    const keys = object(test) ? Object.keys(test) : [];
    if (!keys.length || keys.some(key => !TEST_KEYS.includes(key))) problems.push(`${where}.test must use ${TEST_KEYS.join(', ')}.`);
    else {
      for (const key of ['at_least', 'at_most']) if (key in test && !Number.isFinite(test[key])) problems.push(`${where}.test.${key} must be a number.`);
      if ('between' in test && !(Array.isArray(test.between) && test.between.length === 2 && test.between.every(Number.isFinite) && test.between[0] <= test.between[1])) problems.push(`${where}.test.between must be [low, high] with low not above high.`);
    }
  }
  return problems;
}

export function sourceProblems(row, measures = MEASURES) {
  if (!object(row)) return ['The source must be an object.'];
  const problems = [];
  if (!nonempty(row.id)) problems.push('id must name the source.');
  if (!nonempty(row.label)) problems.push('label must say in plain words what the source finds.');
  if (!object(row.fields) || !nonempty(typeof row.fields.key === 'string' ? row.fields.key : row.fields.key?.path) || !('name' in (row.fields ?? {}))) problems.push('fields must map "key" and "name": each is a path into an item, such as { "key": "id", "name": "company" }.');
  else for (const [name, spec] of Object.entries(row.fields)) {
    const path = typeof spec === 'string' ? spec : spec?.path;
    if (!nonempty(path)) problems.push(`fields.${name} must be a path (text) or { path, each: { text, date } }.`);
    if (object(spec) && spec.each !== undefined && !(object(spec.each) && Object.values(spec.each).every(nonempty))) problems.push(`fields.${name}.each must map entry fields to paths, such as { "text": "body", "date": "when" }.`);
  }
  problems.push(...specProblems(row.filters ?? [], 'filters', row, measures));
  if (!Array.isArray(row.signals) || row.signals.length === 0) problems.push('signals must list at least one signal.');
  else problems.push(...specProblems(row.signals, 'signals', row, measures));
  if (row.min_score !== undefined && !Number.isFinite(row.min_score)) problems.push('min_score must be a number.');
  if (row.request !== undefined) {
    if (!object(row.request) || !/^https?:\/\//.test(row.request.url ?? '')) problems.push('request.url must be an http or https address, with {name} holes filled from the parameters.');
    if (object(row.request) && !nonempty(row.request.items_path)) problems.push('request.items_path must name where the list of items is in the answer.');
  }
  for (const measureRow of measures.measures) {
    if (!Array.isArray(measureRow.steps) || measureRow.steps.length === 0 || measureRow.steps.some(step => !STEP_NAMES.includes(step))) problems.push(`measure ${measureRow.measure} must list steps from: ${STEP_NAMES.join(', ')}.`);
  }
  return problems;
}

// An item mapped to the source's fields. A list field is [{ text, date }]; a path an item lacks leaves the field out.
function mapItem(item, fieldSpecs) {
  const fields = {};
  for (const [name, spec] of Object.entries(fieldSpecs)) {
    const path = typeof spec === 'string' ? spec : spec.path;
    const value = pathValue(item, path);
    if (missing(value)) continue;
    if (typeof spec === 'object' && spec.each) {
      if (!Array.isArray(value)) continue;
      fields[name] = value.map(entry => Object.fromEntries(Object.entries(spec.each).map(([part, entryPath]) => [part, pathValue(entry, entryPath)])));
    } else fields[name] = value;
  }
  return fields;
}

const FILL = /\{([a-z][a-z0-9_]*)\}/g;
function fillAddress(template, parameters) {
  return template.replace(FILL, (_whole, name) => {
    const value = parameters?.[name];
    if (missing(value)) throw new Error(`Send parameters.${name}: the source's address needs it.`);
    return encodeURIComponent(String(value));
  });
}

async function readItems(row, input, fetchPage) {
  if (input.items !== undefined) {
    if (!Array.isArray(input.items)) throw new Error('items must be a list of the candidates to score.');
    return input.items;
  }
  if (!row.request) throw new Error(`Send items: source ${row.id} reads no address, so the candidates come from the person's connection tool.`);
  const text = await fetchText(fillAddress(row.request.url, input.parameters), { accept: 'application/json', fetchPage });
  let answer;
  try { answer = JSON.parse(text); } catch { throw new Error('The address did not answer JSON.'); }
  const items = pathValue(answer, row.request.items_path);
  if (!Array.isArray(items)) throw new Error(`The answer holds no list at ${row.request.items_path}.`);
  return items;
}

export async function findSignals(input, { sources = SOURCES, measures = MEASURES, fetchPage = fetch } = {}) {
  if (!object(input)) throw new Error('Send { source, items } as a JSON object.');
  const row = input.source_row ?? sources.records.find(entry => entry.id === input.source);
  if (!row) throw new Error(`Send source: one of ${sources.records.map(entry => entry.id).join(', ')}, or source_row with your own source.`);
  const problems = sourceProblems(row, measures);
  if (problems.length) throw new Error(`The source row cannot be used: ${problems.join(' ')}`);
  const nowTime = input.now === undefined ? Date.now() : dateOf(input.now);
  if (nowTime === null) throw new Error('now must be a date such as 2026-11-01.');
  const limit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);

  const items = await readItems(row, input, fetchPage);
  const skipped = [];
  const kept = new Map();
  for (const [at, item] of items.entries()) {
    const fields = object(item) ? mapItem(item, row.fields) : {};
    const key = fields.key === undefined ? undefined : String(fields.key);
    if (!key) { skipped.push({ key: `item ${at}`, reason: 'it has no key' }); continue; }
    if (kept.has(key)) { skipped.push({ key, reason: 'its key is already listed' }); continue; }
    const refusal = (row.filters ?? []).map(filter => {
      const found = measure(filter, fields, nowTime, measures);
      if (!found) return `${filter.of} is missing`;
      return passes(found.value, filter.test) ? null : `${filter.of} ${filter.measure} is ${found.value}, outside the filter`;
    }).find(Boolean);
    if (refusal) { skipped.push({ key, reason: refusal }); continue; }
    const signals = [];
    for (const signal of row.signals) {
      const found = measure(signal, fields, nowTime, measures);
      if (found && passes(found.value, signal.test)) signals.push({ id: signal.id, says: signal.says, weight: signal.weight, evidence: found });
    }
    const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
    if (score < (row.min_score ?? 0)) { skipped.push({ key, reason: `its score ${score} is below ${row.min_score}` }); continue; }
    const scalars = Object.fromEntries(Object.entries(fields).filter(([name, value]) => !['key', 'name', 'url', 'place'].includes(name) && !Array.isArray(value))
      .map(([name, value]) => [name, typeof value === 'string' ? value.slice(0, MAX_TEXT) : value]));
    kept.set(key, { key, name: fields.name === undefined ? null : String(fields.name), url: fields.url ?? null, place: fields.place ?? null, fields: scalars, signals, score });
  }
  const ranked = [...kept.values()].sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((prospect, at) => ({ ...prospect, rank: at + 1 }));
  const shown = ranked.slice(0, limit);
  return {
    source: row.id, count: ranked.length, prospects: shown, skipped: skipped.slice(0, MAX_SKIPPED),
    said: `${ranked.length} of ${items.length} candidates passed the filters; ${shown.length} shown, best score first.${skipped.length > MAX_SKIPPED ? ` ${skipped.length - MAX_SKIPPED} more were left out and are not listed.` : ''}${items.length > 0 && ranked.length === 0 ? ' None passed: loosen the source row\'s filters or check its field paths.' : ''}`,
  };
}
