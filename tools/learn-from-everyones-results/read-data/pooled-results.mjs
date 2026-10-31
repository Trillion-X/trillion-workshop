// tools/learn-from-everyones-results/read-data/pooled-results.mjs
//
// Results learned from everyone, kept as rows of lists in the one account that holds the pool, and the only answer
// anyone gets from them. The math is ./pooled-learning.mjs (unchanged from the old app); this file reads and writes
// the rows through the records door the run was handed (tools/records-door).
//
// What a person's own store does: `randomizeAResult` turns "did it work?" into the one bit that may leave the store
// (randomized response at the rules' epsilon, drawn from the platform's cryptographic random source). The store keeps
// the bit it drew for that result, and its random contributor id, as its own records; neither is made here.
//
// What the pool account does:
//   addPooledSituation      one shared situation: { entry, embedding, day }, the entry's words checked again by the
//                           plain privacy pass (./plain-privacy-pass.mjs) with no private terms; a new random id.
//   addPooledResult         one row: { contributor, situation, worked, embedding, day }. The embedding is the
//                           situation row's, read here, never one the sender gives, so a sender cannot aim a result at
//                           a situation that is not shared, and the row is not linked to any shared text.
//   withdrawPooledResults   every row of one contributor removed.
//   howSimilarResultsTurnedOut   the one read: rows whose situation is close in meaning to the asked one, then
//                           aggregateOnRead (one vote per contributor, the minimum number of people, the median of
//                           contributor shards, fixed noise, buckets). No call returns a row.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No export returns a pooled row, a contributor id or a count under the rules' minimum number of people.
//   2. The shard of a contributor is worked out from its id at read time (shardOf), never stored beside it.
//   3. The noise is fixed by the question and by the rows of the shards that answer it: the same question over the
//      same rows gets the same answer, and any join or withdrawal in those shards draws new noise. No counter is kept.
//   4. Every rule comes from the caller (the pool's own settings); none has a default here.
import { readFileSync } from 'node:fs';
import { aggregateOnRead, contributorIdentity, randomizedResponse, shardOf } from './pooled-learning.mjs';
import { findings } from './plain-privacy-pass.mjs';

const settings = JSON.parse(readFileSync(new URL('./pooled-results.json', import.meta.url), 'utf8'));
const RULES = ['epsilon', 'min_people', 'shards', 'query_epsilon', 'people_bucket', 'share_step', 'min_similarity'];
const CONTRIBUTOR = /^[0-9a-f]{64}$/;

const refuse = message => { throw Object.assign(new Error(message), { code: 'refused' }); };
const rowId = (rows, id) => `record:${rows.row_type}:${id}`;
const rowType = rows => `record:${rows.row_type}`;

/** The rules every answer is given under, each one present and a finite positive number. */
export function rulesOf(rules) {
  if (!rules || typeof rules !== 'object') refuse(settings.words.no_rules);
  for (const name of RULES) if (!(Number.isFinite(rules[name]) && rules[name] > 0)) refuse(`${settings.words.rule_missing} ${name}`);
  if (!Number.isInteger(rules.shards) || !Number.isInteger(rules.min_people)) refuse(settings.words.rule_whole);
  return rules;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function embeddingOf(value) {
  const ok = Array.isArray(value) && value.length > 0 && value.length <= settings.limits.dimensions && value.every(Number.isFinite);
  if (!ok) refuse(settings.words.bad_embedding);
  return value;
}

const uniform = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

/** In the person's own store: the one randomized bit for a result, and nothing else. */
export function randomizeAResult({ worked, rules } = {}) {
  if (typeof worked !== 'boolean') refuse(settings.words.worked_not_boolean);
  if (!(Number.isFinite(rules?.epsilon) && rules.epsilon > 0)) refuse(`${settings.words.rule_missing} epsilon`);
  return { worked: randomizedResponse(worked, rules.epsilon, uniform()) };
}

/** A shared entry: an object of at most `limits.entry_fields` fields, each words or a list of words, every text at
 * most `limits.entry_characters` long. */
function entryOf(entry) {
  const fields = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.entries(entry) : [];
  const text = value => typeof value === 'string' && value.trim() && value.length <= settings.limits.entry_characters;
  const ok = fields.length > 0 && fields.length <= settings.limits.entry_fields
    && fields.every(([, value]) => text(value) || (Array.isArray(value) && value.length > 0 && value.length <= settings.limits.entry_fields && value.every(text)));
  if (!ok) refuse(settings.words.bad_entry);
  return entry;
}

/** In the pool account: one shared situation, the words a person made safe to show strangers and their meaning. The
 * plain privacy pass runs again here with no private terms, so words that still carry an address, a handle, a long
 * number, an amount of money, a key, the removed mark or a name inside a sentence never enter the pool, whatever the
 * sender checked. The id is new and random: nothing links the row to who sent it. */
export async function addPooledSituation({ entry, embedding } = {}, { door }) {
  const words = entryOf(entry);
  const found = findings(words);
  if (found.length) refuse(`${settings.words.not_safe} ${found.slice(0, 5).join('; ')}`);
  const meaning = embeddingOf(embedding);
  const id = crypto.randomUUID();
  const value = { entry: words, embedding: meaning, day: new Date().toISOString().slice(0, 10) };
  await door.write([{ id: rowId(settings.situations, id), type: rowType(settings.situations), value }], { key: `pooled-situation:${id}` });
  return { situation: id };
}

/** In the pool account: one result row under a contributor, placed at a shared situation's meaning. */
export async function addPooledResult({ contributor, situation, worked } = {}, { door }) {
  if (typeof contributor !== 'string' || !CONTRIBUTOR.test(contributor)) refuse(settings.words.bad_contributor);
  if (typeof worked !== 'boolean') refuse(settings.words.worked_not_boolean);
  if (typeof situation !== 'string' || !situation || situation.includes('/')) refuse(settings.words.no_situation);
  const shared = await door.read(rowType(settings.situations), rowId(settings.situations, situation));
  if (!shared) refuse(settings.words.no_situation);
  const embedding = embeddingOf(shared.embedding);
  const id = `${contributor}:${crypto.randomUUID()}`;
  const value = { contributor, situation, worked: worked ? 1 : 0, embedding, day: new Date().toISOString().slice(0, 10) };
  await door.write([{ id: rowId(settings.results, id), type: rowType(settings.results), value }], { key: `pooled-result:${id}` });
  return { added: true };
}

/** In the pool account: every row one contributor sent, removed. */
export async function withdrawPooledResults({ contributor } = {}, { door }) {
  if (typeof contributor !== 'string' || !CONTRIBUTOR.test(contributor)) refuse(settings.words.bad_contributor);
  const ids = [];
  for await (const row of door.list({ type: rowType(settings.results), prefix: rowId(settings.results, `${contributor}:`), fields: [] })) ids.push(row.id);
  for (let at = 0; at < ids.length; at += settings.limits.writes) {
    const batch = ids.slice(at, at + settings.limits.writes);
    await door.write(batch.map(id => ({ id, type: rowType(settings.results), value: null })), { key: `withdraw:${contributor}:${batch[0]}:${batch.length}` });
  }
  return { removed: ids.length };
}

/** In the pool account: how results at situations like this one turned out, under every rule, and nothing more. */
export async function howSimilarResultsTurnedOut({ embedding, rules } = {}, { door }) {
  const asked = embeddingOf(embedding);
  const kept = rulesOf(rules);
  const all = [];
  for await (const row of door.list({ type: rowType(settings.results), fields: ['contributor', 'worked', 'embedding'] })) {
    const { contributor, worked, embedding: at } = row.value ?? {};
    if (typeof contributor !== 'string' || !Array.isArray(at)) continue;
    all.push({ id: row.id, contributor, shard: shardOf(contributor, kept.shards), worked: worked === 1, close: at.length === asked.length && cosine(asked, at) >= kept.min_similarity });
  }
  const rows = all.filter(row => row.close);
  const shards = new Set(rows.map(row => row.shard));
  const version = contributorIdentity(JSON.stringify(all.filter(row => shards.has(row.shard)).map(row => [row.id, row.worked]).sort((a, b) => (a[0] < b[0] ? -1 : 1))));
  const question = contributorIdentity(JSON.stringify(asked.map(value => Math.round(value * 1000))));
  return aggregateOnRead(rows.map(({ contributor, shard, worked }) => ({ contributor, shard, worked })), kept, { question, version });
}
