// Score supplied candidates against a state, instead of asking a model to write an answer.
//
// When the possible answers are already known (tools for a job, options of a decision, labels of a verdict), one
// embedding of the state and one cached embedding per candidate give a similarity each; a softmax over those
// similarities, at the temperature the embedding model was trained with, gives a probability each. Below the
// confidence line the answer is "escalate": the caller hands the choice to something slower.
//
// The request has a state, optional instructions (the question), and criteria { candidate id: description }.
// A calibrated local scorer that serves that shape can sit behind the same call.
//
// Invariants
// - Nothing here knows what the candidates are: ids and descriptions are the caller's DATA.
// - Which model embeds, the temperature, the confidence line and the limits are one settings row (DATA).
// - A candidate's vector is kept under the BLAKE3 identity of [model id, text], so a description embedded once is
//   never embedded again, whoever asks; the kept row holds the vector only, never the text.
// - A state is never kept.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { cosine } from '../../find-pictures-by-colour-and-likeness/src/meaning.mjs';

export class ScoreError extends Error {}

export const fingerprint = (modelId, text) => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([modelId, text]))))}`;

// The question goes after the state, separated by a blank line, as the contrastive scorers read it.
const stateText = (state, instructions) => [typeof state === 'string' ? state : JSON.stringify(state), instructions].filter(part => typeof part === 'string' && part.trim()).map(part => part.trim()).join('\n\n');

/**
 * embed(modelId, texts) -> [vector]    one vector per text, in order
 * cache: { get(fingerprints) -> { [fingerprint]: vector }, put([{ fingerprint, vector }]) }
 * The settings row: { model: { id }, scale, escalate_below, max_candidates, max_characters }.
 */
export function makeScorer({ embed, cache }) {
  return {
    async score({ state, instructions, criteria }, row) {
      if (!row?.model?.id) throw new ScoreError('The scorer has no model setting.');
      const text = stateText(state, instructions);
      if (!text) throw new ScoreError('state is needed: the situation the choice is about.');
      if (text.length > row.max_characters) throw new ScoreError(`state and instructions are ${text.length} characters; at most ${row.max_characters} are read.`);
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw new ScoreError('criteria is needed: an object of { candidate id: description }.');
      const ids = Object.keys(criteria);
      if (ids.length < 2 || ids.length > row.max_candidates) throw new ScoreError(`Give between 2 and ${row.max_candidates} candidates.`);
      // A candidate is embedded as its description, or its id when the description is empty.
      const described = ids.map(id => (typeof criteria[id] === 'string' && criteria[id].trim() ? criteria[id].trim() : id));
      if (described.some(item => item.length > row.max_characters)) throw new ScoreError(`A candidate is read up to ${row.max_characters} characters.`);
      const keys = described.map(item => fingerprint(row.model.id, item));
      const kept = await cache.get([...new Set(keys)]);
      const missing = [...new Set(keys.filter(key => !kept[key]))];
      const texts = missing.map(key => described[keys.indexOf(key)]);
      const made = await embed(row.model.id, [text, ...texts]);
      if (!Array.isArray(made) || made.length !== texts.length + 1) throw new ScoreError('The embedding model did not return a vector for every text.');
      const [stateVector, ...fresh] = made;
      if (missing.length) await cache.put(missing.map((key, index) => ({ fingerprint: key, vector: fresh[index] })));
      const vectors = { ...kept, ...Object.fromEntries(missing.map((key, index) => [key, fresh[index]])) };
      const similarity = keys.map(key => cosine(stateVector, vectors[key]));
      const top = Math.max(...similarity);
      const weights = similarity.map(value => Math.exp(row.scale * (value - top)));
      const total = weights.reduce((sum, value) => sum + value, 0);
      const probability = weights.map(value => value / total);
      const best = probability.indexOf(Math.max(...probability));
      // How concentrated the distribution is: 1 when one candidate takes it all, 0 when it is spread evenly.
      const confidence = (ids.length * probability[best] - 1) / (ids.length - 1);
      const round = value => Math.round(value * 10000) / 10000;
      return {
        model: row.model.id,
        choice: ids[best],
        confidence: round(confidence),
        escalate: confidence < row.escalate_below,
        ranked: ids.map((id, index) => ({ id, probability: round(probability[index]), similarity: round(similarity[index]) })).sort((a, b) => b.probability - a.probability),
        embedded: texts.length + 1,
      };
    },
  };
}


/**
 * Scores every candidate even when an open catalog is larger than one scorer request.
 * Each call stays within the DATA max_candidates bound; raw cosine similarities, unlike
 * batch-relative probabilities, are comparable across calls. A one-item remainder
 * repeats one earlier candidate so makeScorer's two-candidate minimum still holds.
 */
export async function scoreCandidateSimilarities(scorer, input, row) {
  const entries = Object.entries(input?.criteria ?? {});
  const max = row?.max_candidates;
  const batches = [];
  if (!Number.isInteger(max) || max < 2 || entries.length <= max) {
    batches.push(entries);
  } else {
    for (let at = 0; at < entries.length; at += max) {
      const batch = entries.slice(at, at + max);
      if (batch.length === 1) batch.push(entries[0]);
      batches.push(batch);
    }
  }
  const similarities = {};
  for (const batch of batches) {
    const result = await scorer.score({ ...input, criteria: Object.fromEntries(batch) }, row);
    for (const candidate of result.ranked) similarities[candidate.id] = candidate.similarity;
  }
  return similarities;
}

// The kept vectors in a Durable Object's own SQLite, newest `limit` rows kept.
export function vectorCache(sql, limit) {
  sql.exec('CREATE TABLE IF NOT EXISTS candidate_vectors (fingerprint TEXT PRIMARY KEY, vector TEXT NOT NULL)');
  return {
    async get(fingerprints) {
      if (!fingerprints.length) return {};
      return Object.fromEntries(sql.exec('SELECT fingerprint, vector FROM candidate_vectors WHERE fingerprint IN (SELECT value FROM json_each(?))', JSON.stringify(fingerprints)).toArray().map(row => [row.fingerprint, JSON.parse(row.vector)]));
    },
    async put(entries) {
      for (const entry of entries) sql.exec('INSERT OR REPLACE INTO candidate_vectors (fingerprint, vector) VALUES (?, ?)', entry.fingerprint, JSON.stringify(entry.vector));
      sql.exec('DELETE FROM candidate_vectors WHERE rowid NOT IN (SELECT rowid FROM candidate_vectors ORDER BY rowid DESC LIMIT ?)', limit);
    },
  };
}

// Workers AI's embedding reply, as vectors.
export const workersAiEmbed = ai => async (modelId, texts) => (await ai.run(modelId, { text: texts })).data;

export const isScorePath = pathname => pathname === '/score';

export async function handleScoreRequest(scorer, row, request) {
  if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    const raw = await request.text();
    if (raw.length > 1_000_000) throw new ScoreError('Request too large');
    return Response.json(await scorer.score(JSON.parse(raw || '{}'), row));
  } catch (error) {
    // A refusal the model road gives for this account (such as a throwaway account's, src/throwaway-limits.mjs) keeps its own status and code.
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && typeof error.code === 'string')
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    return Response.json({ error: error.message }, { status: error instanceof ScoreError || error instanceof SyntaxError ? 400 : 502 });
  }
}

export const scoreTools = call => [
  { name: 'score_candidates', description: 'Picks from answers you already have, instead of generating one: give the situation (state), optionally the question (instructions), and criteria as { candidate id: description }, 2 to 200 candidates. Returns each candidate\'s probability, the choice, a confidence from 0 to 1, and escalate: true when the confidence is below the line, meaning a slower check should decide. Fast and cheap; best for routing and shortlisting, not for judging whether something really happened.', inputSchema: { type: 'object', required: ['state', 'criteria'], properties: { state: { type: 'string' }, instructions: { type: 'string' }, criteria: { type: 'object', additionalProperties: { type: 'string' } } } }, run: input => call('/score', input) },
];

export const scoreAnnotations = {
  score_candidates: { title: 'Score known answers', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
