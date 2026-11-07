// The new seen lane on the Mac: Workshop meaning-search findSimilarAcross over the four sets, each query vector the
// old q.py embedded (queries.json), spread { per_file: 2, seconds_apart: 10 }, limit 8 (q.py --top 8 --per-clip 2).
// The door is a stand-in reading the sets from this Mac's disk: the same bytes the person's files would hold.
//   node new-across.mjs <workshop checkout> <sets.json> <queries.json>  > new-across.json
import { readFileSync, statSync } from 'node:fs';
const [ws, setsFile, queriesFile] = process.argv.slice(2);
const { findSimilarAcross } = await import(`${ws}/tools/meaning-search/read-data/meaning-search.mjs`);
const { sets, ann } = JSON.parse(readFileSync(setsFile, 'utf8'));
const descriptors = sets.map(set => ({
  kind: 'semantic-index-descriptor', index_id: set.index_id, model_id: 'open_clip ViT-B-32', model_version: 'openai', model_endpoint: 'http://127.0.0.1:9',
  descriptor_revision: `1f:${'0'.repeat(64)}`, model_provenance_ref: 'model:open_clip-ViT-B-32@openai', min_score: -1, result_limit: 300, ann_params: ann,
  vector_set: { items: { file: set.items }, vectors: { file: set.vectors }, points_to: set.points_to },
}));
const door = {
  async *list({ type }) { if (type === 'semantic-index-descriptor') for (const value of descriptors) yield { id: `semantic-index-descriptor:${value.index_id}`, value }; },
  async files(method, { name_or_identity, offset, length }) {
    const bytes = readFileSync(name_or_identity);
    return { content: bytes.subarray(offset, offset + length).toString('base64'), encoding: 'base64', byte_length: statSync(name_or_identity).size };
  },
};
const { queries, vectors } = JSON.parse(readFileSync(queriesFile, 'utf8'));
const results = {};
for (const [i, query] of queries.entries()) {
  const query_vector_base64 = Buffer.from(JSON.stringify({ vector: vectors[i] })).toString('base64');
  results[query] = await findSimilarAcross({ index_ids: sets.map(set => set.index_id), query_vector_base64, limit: 8, spread: { per_file: 2, seconds_apart: 10 } }, { door });
}
console.log(JSON.stringify({ results }, null, 1));
