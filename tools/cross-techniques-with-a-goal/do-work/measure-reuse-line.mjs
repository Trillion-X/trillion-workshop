// tools/cross-techniques-with-a-goal/do-work/measure-reuse-line.mjs
//
// Purpose
//   Measures a vocabulary's reuse_at for one embedding model: embeds hand-labelled term pairs (reuse-line-pairs.json,
//   or `pairs` in the request) and returns every pair's closeness and the line that best separates "means the same"
//   from "means something else". One JSON request on standard input ({ meaning, pairs? }), { result } on the last line.
//
// Non-negotiable invariants
//   1. The line is the midpoint of the widest gap between the closest "different" pair above it and the least close
//      "same" pair below it, chosen to misplace the fewest pairs; misplaced pairs are listed by name, never hidden.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { readFileSync } from 'node:fs';
import { cosine, embedder } from './meaning.mjs';

export async function measureReuseLine({ meaning, pairs }) {
  const embed = embedder(meaning);
  const scored = {};
  for (const label of ['same', 'different']) {
    const flat = pairs[label].flat();
    const vectors = await embed.texts(flat.map(([, says]) => says), 'document', flat.map(([term]) => ({ title: term })));
    scored[label] = pairs[label].map(([one, other], index) => ({ pair: `${one[0]} / ${other[0]}`, closeness: Math.round(cosine(vectors[2 * index], vectors[2 * index + 1]) * 1000) / 1000 }));
  }
  const values = [...scored.same, ...scored.different].map(item => item.closeness).sort((a, b) => a - b);
  const lines = values.slice(1).map((value, index) => (value + values[index]) / 2);
  const misplaced = line => [...scored.same.filter(item => item.closeness < line), ...scored.different.filter(item => item.closeness >= line)];
  const best = lines.reduce((chosen, line) => {
    const wrong = misplaced(line).length;
    return wrong < chosen.wrong ? { line, wrong } : chosen;
  }, { line: lines[0], wrong: Infinity });
  return { meaning: { model: meaning.model, dims: meaning.dims }, reuse_at: Math.round(best.line * 1000) / 1000, misplaced: misplaced(best.line).map(item => item.pair), ...scored };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const pairs = request.pairs ?? JSON.parse(readFileSync(new URL('./reuse-line-pairs.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify({ result: await measureReuseLine({ meaning: request.meaning, pairs }) }));
}
