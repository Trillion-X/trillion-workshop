// Local compatibility entry for sets made by make_vector_set_from_kept_vectors.py.
// Store parsing and ranking stay in their shared owners; this maps their answers
// into the earlier CLI's seen/said envelope. All source locations are input DATA.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSimilarAcross, findWordsSaid } from '../read-data/meaning-search.mjs';
import { mintCanonicalMultihashOfText } from './process-scripts/canonical_multihash.mjs';

// The values this local CLI hands the seam: its descriptors, and bounded spans of the set files named in its input (read
// from disk here, the caller's own files). No store is read.
export function localGiven(descriptors) {
  return {
    recordsOf: type => (type === 'semantic-index-descriptor' ? descriptors.map(value => ({ id: `semantic-index-descriptor:${value.index_id}`, type, value })) : []),
    readSpan(name, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error('Only bounded file reads are supported.');
      const file = openSync(name, 'r');
      try {
        const byte_length = fstatSync(file).size;
        const bytes = Buffer.alloc(Math.min(length, Math.max(0, byte_length - offset)));
        const count = readSync(file, bytes, 0, bytes.length, offset);
        return { content: bytes.subarray(0, count).toString('base64'), encoding: 'base64', byte_length };
      } finally { closeSync(file); }
    },
    run: async () => { throw new Error('This local CLI runs no tools.'); },
  };
}

export async function searchKeptVectorSets(input) {
  const { queries, vectors, sets, model_id, model_version, top = 8, per_clip = 2 } = input;
  if (!Array.isArray(queries) || !Array.isArray(vectors) || queries.length !== vectors.length || !Array.isArray(sets)) throw new Error('Send queries, their vectors, and ordered sets.');
  if (!Number.isInteger(top) || top < 1 || !Number.isInteger(per_clip) || per_clip < 1) throw new Error('top and per_clip must be positive integers.');
  if (typeof model_id !== 'string' || !model_id || typeof model_version !== 'string' || !model_version) throw new Error('Send the query model identity.');
  const descriptors = sets.map(({ index_id, metadata }) => {
    const set = JSON.parse(readFileSync(metadata, 'utf8'));
    return {
      kind: 'semantic-index-descriptor', index_id, model_id, model_version,
      descriptor_revision: mintCanonicalMultihashOfText(JSON.stringify(set)), model_provenance_ref: `model:${model_id}@${model_version}`,
      search_mode: 'exact', similarity: 'float32-dot', tie_order: 'source', min_score: -Number.MAX_VALUE, result_limit: top,
      vector_set: set.vector_set,
    };
  });
  const transcriptId = 'local-transcript-lines';
  if (input.transcripts && existsSync(input.transcripts)) descriptors.push({
    kind: 'semantic-index-descriptor', index_id: transcriptId,
    vector_set: { items: { file: input.transcripts }, points_to: { file: 'path', start: 't', end: 'end', text: 'text' } },
  });
  const given = localGiven(descriptors);
  const results = {};
  const names = new Map();
  for (const [at, query] of queries.entries()) {
    const answer = sets.length ? await findSimilarAcross({
      index_ids: sets.map(set => set.index_id), query_vector_base64: Buffer.from(JSON.stringify({ vector: vectors[at] })).toString('base64'),
      limit: top, spread: { per_file: per_clip, seconds_apart: 10 },
    }, { given }) : null;
    const seen = (answer?.result.items ?? []).map(item => {
      const point = answer.points_to[item.address];
      const index = item.index_id.startsWith('asset-index-') ? 'asset-index' : item.index_id;
      if (index === 'asset-index') names.set(point.file, point.name);
      return { path: point.file, score: item.score, kind: point.kind, seconds: point.start, index,
        ...(index === 'expansion-picture-vectors' ? { expansion_id: point.id ?? null, b2: point.b2 ?? null } : {}) };
    });
    const said = input.transcripts && existsSync(input.transcripts)
      ? (await findWordsSaid({ index_ids: [transcriptId], query_text: query, limit: top }, { given })).lines.map(point => ({ path: point.file, seconds: point.start, end: point.end, text: point.text, kind: 'said' })) : [];
    results[query] = { seen, said };
  }
  for (const result of Object.values(results)) for (const hit of [...result.seen, ...result.said]) {
    hit.name = names.get(hit.path) ?? basename(hit.path);
    hit.exists = existsSync(hit.path);
  }
  return { model: `${model_id} ${model_version}`, indexes: input.indexes, results };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(await searchKeptVectorSets(JSON.parse(readFileSync(0, 'utf8'))))}\n`);
}
