// Run saved query vectors through the existing search owner on sets supplied as DATA.
// The original model, descriptor, top and spread defaults remain available; settings
// may name search_mode, top, per_file, seconds_apart, result_limit and min_score.
//   node run-query-parity.mjs <workshop checkout> <sets.json> <queries.json> [old-baseline.json]
import { readFileSync, statSync } from 'node:fs';
import { openSync, readSync, closeSync } from 'node:fs';
const [ws, setsFile, queriesFile] = process.argv.slice(2);
const baselineFile = process.argv[5];
if (!ws || !setsFile || !queriesFile) throw new Error('Give the Workshop checkout, sets JSON, queries JSON and optional old-baseline JSON.');
const { findSimilarAcross } = await import(`${ws}/tools/meaning-search/read-data/meaning-search.mjs`);
const { sets, ann, ...settings } = JSON.parse(readFileSync(setsFile, 'utf8'));
const { top = 8, per_file = 2, seconds_apart = 10 } = settings;
const descriptorSettings = Object.fromEntries(['result_limit', 'min_score'].filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
const descriptors = sets.map(set => ({
  kind: 'semantic-index-descriptor', index_id: set.index_id, model_id: 'open_clip ViT-B-32', model_version: 'openai', model_endpoint: 'http://127.0.0.1:9',
  descriptor_revision: `1f:${'0'.repeat(64)}`, model_provenance_ref: 'model:open_clip-ViT-B-32@openai', min_score: -1, result_limit: 300, ann_params: ann,
  ...descriptorSettings,
  search_mode: set.search_mode ?? settings.search_mode ?? 'approximate',
  vector_set: { items: { file: set.items }, vectors: { file: set.vectors }, points_to: set.points_to },
}));
const door = {
  async *list({ type }) { if (type === 'semantic-index-descriptor') for (const value of descriptors) yield { id: `semantic-index-descriptor:${value.index_id}`, value }; },
  async files(method, { name_or_identity, offset, length }) {
    if (method !== 'read_file') throw new Error('This comparison bridge only reads file spans.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error('Read spans need non-negative integer offsets and lengths.');
    const file = openSync(name_or_identity, 'r');
    try {
      const byte_length = statSync(name_or_identity).size;
      const bytes = Buffer.alloc(Math.min(length, Math.max(0, byte_length - offset)));
      const count = readSync(file, bytes, 0, bytes.length, offset);
      return { content: bytes.subarray(0, count).toString('base64'), encoding: 'base64', byte_length };
    } finally { closeSync(file); }
  },
};
const { queries, vectors } = JSON.parse(readFileSync(queriesFile, 'utf8'));
if (!Array.isArray(queries) || !Array.isArray(vectors) || queries.length !== vectors.length) throw new Error('Queries and saved vectors must be arrays of equal length.');
const results = {};
for (const [i, query] of queries.entries()) {
  const query_vector_base64 = Buffer.from(JSON.stringify({ vector: vectors[i] })).toString('base64');
  results[query] = await findSimilarAcross({ index_ids: sets.map(set => set.index_id), query_vector_base64, limit: top, spread: { per_file, seconds_apart } }, { door });
}

function pair(file, start) {
  if (typeof file !== 'string' || !(start === null || Number.isFinite(start))) throw new Error('A comparison needs explicit file names and numeric or null times.');
  return [file, start];
}

if (baselineFile) {
  const answer = { results };
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  answer.comparison = Object.fromEntries(queries.map(query => {
    const seen = baseline.results?.[query]?.seen;
    if (!Array.isArray(seen)) throw new Error('The baseline must hold seen results for every requested query.');
    const oldPairs = seen.map(item => pair(item.path, item.seconds));
    const current = results[query];
    const newPairs = current.result.items.map(item => {
      const point = current.points_to[item.address];
      return pair(point?.file, point?.start);
    });
    const oldIds = oldPairs.map(value => JSON.stringify(value));
    const newIds = newPairs.map(value => JSON.stringify(value));
    const oldSet = new Set(oldIds), newSet = new Set(newIds);
    return [query, {
      equal: JSON.stringify(oldPairs) === JSON.stringify(newPairs),
      same_set: JSON.stringify([...oldIds].sort()) === JSON.stringify([...newIds].sort()),
      overlap: [...oldSet].filter(value => newSet.has(value)).length,
      old: oldPairs, new: newPairs,
    }];
  }));
  console.log(JSON.stringify(answer, null, 1));
} else {
  console.log(JSON.stringify({ results }, null, 1));
}
