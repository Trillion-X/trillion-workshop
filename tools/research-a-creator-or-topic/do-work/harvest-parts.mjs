// tools/research-a-creator-or-topic/do-work/harvest-parts.mjs
//
// What the two polite readers of this folder share (harvest-channels.mjs and harvest-posts.mjs): the queue that decides
// when the next request may start and when a run must stop (its numbers are DATA in harvest-settings.json), the plain
// words that refuse an input, the output files filled a line at a time up to a byte bound, and the rows written over the
// rows the person already holds. Nothing here knows what is being read.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const SETTINGS = new URL('./harvest-settings.json', import.meta.url);

const VALUE_KINDS = ['fact', 'text', 'value'];

export const readSettings = () => JSON.parse(readFileSync(SETTINGS, 'utf8'));
export const tail = text => String(text ?? '').trim().split('\n').slice(-3).join(' ').slice(-400);
export const picked = (object, fields) => Object.fromEntries(fields.filter(field => object?.[field] !== undefined).map(field => [field, object[field]]));

// The run stops before its next request: why, as one word the answer carries.
export class Stop extends Error {
  constructor(why) { super(why); this.why = why; }
}

export const refuse = words => { throw new Error(words); };
export const wholeIn = (value, name, least, most) => (Number.isInteger(value) && value >= least && value <= most ? value : refuse(`${name} is a whole number from ${least} to ${most}.`));
export function words(value, name, least, most, shape = /\S/, hint = '') {
  const ok = Array.isArray(value) && value.length >= least && value.length <= most && value.every(item => typeof item === 'string' && shape.test(item.trim()));
  return ok ? value.map(item => item.trim()) : refuse(`${name} is a list of ${least} to ${most} words${hint}.`);
}

// The numbers every polite run shares, read from the input: the seconds it may work and the refusals already met.
export function readPoliteness(input, settings) {
  return {
    budget: input.budget_seconds === undefined ? settings.budget_seconds.default : wholeIn(input.budget_seconds, 'budget_seconds', 1, settings.budget_seconds.most),
    refusals: input.refusals_in_a_row === undefined ? 0 : wholeIn(input.refusals_in_a_row, 'refusals_in_a_row', 0, 1000),
  };
}

// How long to wait before sending `again` after a refusal: doubled for each refusal in a row, up to a bound.
export function minutesToWait(refusals, { first_minutes: first, doublings_at_most: doublings }) {
  return first * 2 ** Math.min(refusals, doublings);
}

// The queue of one run. `begin()` is called before each request: it keeps to the requests the run may make, waits a time
// drawn from the range, and answers the seconds the request may take (`atEnd` when that is all the run has left). It throws
// Stop when a request may not start. `check(said)` throws Stop('refusal') when the site's words are a refusal.
export function politeQueue(settings, { ends, now, sleep, random }) {
  let requests = 0;
  return {
    get requests() { return requests; },
    async begin() {
      if (requests >= settings.requests_per_run_at_most) throw new Stop('requests');
      if (requests > 0) {
        const { least, most } = settings.seconds_between_requests;
        const wait = least + random() * (most - least);
        if (ends - now() - wait < settings.least_seconds_for_a_request) throw new Stop('budget');
        await sleep(wait);
      }
      const left = ends - now();
      if (left < settings.least_seconds_for_a_request) throw new Stop('budget');
      requests += 1;
      const seconds = Math.min(left, settings.request_seconds_at_most);
      return { seconds, atEnd: seconds === left };
    },
    check(said) {
      const lower = String(said).toLowerCase();
      if (settings.refusal_words.some(word => lower.includes(word))) throw new Stop('refusal');
    },
  };
}

// One output file, filled a line at a time up to its byte bound.
export function lineFile(path, most) {
  writeFileSync(path, '');
  let bytes = 0;
  return {
    get empty() { return bytes === 0; },
    add(object) {
      const line = `${JSON.stringify(object)}\n`;
      const size = Buffer.byteLength(line);
      if (bytes + size > most) return false;
      appendFileSync(path, line);
      bytes += size;
      return true;
    },
  };
}

// One value of a row: a fact of what was read, a text with {fact} holes, or a value as it is.
function readValueSpec(spec, name) {
  const keys = spec && typeof spec === 'object' && !Array.isArray(spec) ? Object.keys(spec) : [];
  if (keys.length !== 1 || !VALUE_KINDS.includes(keys[0])) refuse(`${name} is one of { fact }, { text } or { value }.`);
  if (keys[0] !== 'value' && typeof spec[keys[0]] !== 'string') refuse(`${name}.${keys[0]} is a word.`);
  return spec;
}
const fill = (text, facts) => text.replace(/\{(\w+)\}/g, (_, name) => (facts[name] === undefined || facts[name] === null ? '' : String(facts[name])));
const valueOf = (spec, facts) => ('fact' in spec ? facts[spec.fact] : 'text' in spec ? fill(spec.text, facts) : spec.value);

// `rows` of an input: { one_per, id, fields }. `onePer` is the words one_per may be; `idFromElsewhere(onePer)` says
// whether the id may be left out because what is read carries its own.
export function readRowsSpec(rows, onePer, idFromElsewhere) {
  const { one_per: per, id, fields, ...more } = rows ?? {};
  if (Object.keys(more).length || !onePer.includes(per)) refuse(`rows is { one_per: ${onePer.map(word => `"${word}"`).join(' or ')}, id, fields }.`);
  if (id === undefined && !idFromElsewhere(per)) refuse('rows.id is needed unless rows are one per seed and every seed carries its own id.');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) refuse('rows.fields names at least one field.');
  return {
    one_per: per,
    id: id === undefined ? null : readValueSpec(id, 'rows.id'),
    fields: Object.fromEntries(Object.entries(fields).map(([field, spec]) => [field, readValueSpec(spec, `rows.fields.${field}`)])),
  };
}

// The rows for the person's list, each written over the row already held under its id. A fact's own `row_id` (a seed that
// carries the id of its row) wins over the id the request spells; `named` says which fact names it when it is refused.
export async function writeRows(spec, facts, named, context, { records: { type, id_start: idStart, writes_at_most: most } }) {
  const refused = [];
  const records = [];
  for (const fact of facts) {
    const id = fact.row_id ?? valueOf(spec.id, fact);
    if (typeof id !== 'string' && typeof id !== 'number') { refused.push({ for: fact[named], reason: 'its id is empty' }); continue; }
    const text = String(id).trim();
    if (!text || text.includes('/')) { refused.push({ for: fact[named], reason: 'its id is empty or holds a /' }); continue; }
    const value = Object.fromEntries(Object.entries(spec.fields).map(([field, value]) => [field, valueOf(value, fact)]).filter(([, value]) => value !== undefined));
    records.push({ id: `${idStart}${text}`, type, value });
  }
  if (!records.length) return { written: 0, refused };
  try {
    const door = context.door;
    for (const record of records) {
      const held = await door.read(type, record.id);
      if (held && typeof held === 'object' && !Array.isArray(held)) record.value = { ...held, ...record.value };
    }
    for (let at = 0; at < records.length; at += most) await door.write(records.slice(at, at + most));
    return { written: records.length, refused };
  } catch (error) {
    return { written: 0, refused, error: `${error.code ? `${error.code}: ` : ''}${error.message}` };
  }
}
