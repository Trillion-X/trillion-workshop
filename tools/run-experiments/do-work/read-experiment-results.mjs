// tools/run-experiments/do-work/read-experiment-results.mjs
//
// The Workshop tool "Read how each candidate did". argv[2] is one JSON input:
//   { address: text,                                     the surface the experiment ran on
//     facts: [{ path: ['candidate', 'outcome', metric, candidate_id], value: number }],
//     rates?: [{ id, numerator, denominator }] }         a rate to work out per candidate, like converted over views
// Sums every outcome fact per candidate and metric. Prints one JSON line:
//   { address, candidates: { <candidate_id>: { views?, converted?, <metric>: number, <rate id>? } }, total_events,
//     leader: { <rate id>: candidate_id } }
// A rate is left out for a candidate whose numerator or denominator is missing or whose denominator is zero.
import { aggregateOutcomes, computeRate } from '../read-data/scoreboard.ts';

// The aggregation reports itself with console.log; this command's answer is its last stdout line.
console.log = console.error;

export function readExperimentResults(input) {
  const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!object(input) || typeof input.address !== 'string' || !input.address) throw new Error('address must name the surface the experiment ran on.');
  if (!Array.isArray(input.facts)) throw new Error('facts must be a list of { path, value }.');
  const facts = input.facts.map(fact => ({ path: fact.path, value: fact.value, trust_ref: typeof fact.trust_ref === 'string' ? fact.trust_ref : '' }));
  const board = aggregateOutcomes(input.address, facts);
  const leader = {};
  for (const rate of Array.isArray(input.rates) ? input.rates : []) {
    let best = null;
    for (const id of Object.keys(board.candidates)) {
      const value = computeRate(board, id, rate.numerator, rate.denominator);
      if (value === undefined) continue;
      board.candidates[id][rate.id] = value;
      if (best === null || value > best.value) best = { id, value };
    }
    if (best) leader[rate.id] = best.id;
  }
  return { address: board.address, candidates: board.candidates, total_events: board.total_events, leader };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(readExperimentResults(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
