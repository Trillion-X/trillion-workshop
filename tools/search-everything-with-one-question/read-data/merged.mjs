// tools/search-everything-with-one-question/read-data/merged.mjs
//
// One answer of several owners' answers to the same question (old trillion src/search.mjs:1750 `finish` over every
// lane): their results merged by score (each owner's scores are already reciprocal-rank-fused, weight over k + rank),
// cut to `limit`, with every owner's `unavailable` and `pending` kept, and each one that could not answer named
// `unavailable` with its reason.
//
// Moved one to one from trillion-rust src/record_value/search.rs `merged` (deleted there in the same change: the
// engine merges nothing; every feature is a Workshop tool, engine-feature-boundary.json, Avery 2026-10-29). Pure, so a
// page can bundle it too.

const scoreOf = result => (typeof result?.score === 'number' && Number.isFinite(result.score) ? result.score : 0);
const listOf = value => (Array.isArray(value) ? value : []);

export function merged(question, terms, answers, refused, limit) {
  const results = [];
  const unavailable = [...refused];
  const pending = [];
  for (const answer of answers) {
    results.push(...listOf(answer?.results));
    unavailable.push(...listOf(answer?.unavailable));
    pending.push(...listOf(answer?.pending));
  }
  // A stable sort, best score first: ties keep the owners' order (records before files), as the engine's did.
  results.sort((a, b) => scoreOf(b) - scoreOf(a));
  return { question, terms, results: results.slice(0, limit), unavailable, pending };
}
