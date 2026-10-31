// tools/run-experiments/do-work/choose-what-a-visitor-sees.mjs
//
// The Workshop tool "Choose what one visitor sees". argv[2] is one JSON input:
//   { surface: { entity_type: 'selection-surface', address, decider_program_ref, candidates: [{ candidate_id, material_ref }] },
//     decider: { entity_type: 'decider', decider_id, score, accepts_trust: [text] },
//     facts?: [{ path: [text], value, trust_ref }],      what is known about this visitor
//     visitor?: text }                                    a stable key: the same visitor always lands in the same split
// The decider scores every candidate from the facts; the highest score wins and a tie goes to the first candidate. A
// split by sticky hash gives the same visitor the same candidate every time. Prints one JSON line:
//   { chosen: candidate | null, ranked: [{ candidate_id, score, is_winner }], findings: [text], rule_used: text }
// A surface or decider that does not validate is refused with every problem listed, so nothing is chosen from a broken set.
import { validateCandidateSet } from '../read-data/candidate-set-schema.ts';
import { validateDecider } from '../read-data/decider-schema.ts';
import { builtinOps, scoreCandidates } from '../read-data/score-candidates.ts';

// The scoring code reports each decision with console.log; this command's answer is its last stdout line.
console.log = console.error;

export function chooseWhatAVisitorSees(input) {
  const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!object(input)) throw new Error('The input must be { surface, decider, facts?, visitor? }.');
  const surface = validateCandidateSet(input.surface);
  const decider = validateDecider(input.decider, new Set(Object.keys(builtinOps)));
  const problems = [
    ...surface.errors.map(error => `surface: ${error}`),
    ...decider.errors.map(error => `decider: ${error}`),
    ...(Array.isArray(input.facts ?? []) ? [] : ['facts must be a list of { path, value, trust_ref }.']),
  ];
  if (problems.length) throw new Error(problems.join('\n'));
  const facts = (input.facts ?? []).map(fact => ({ path: fact.path, value: fact.value, trust_ref: typeof fact.trust_ref === 'string' ? fact.trust_ref : '' }));
  const scored = scoreCandidates(input.surface, facts, input.decider, builtinOps, typeof input.visitor === 'string' ? input.visitor : '');
  return { chosen: scored.winner, ranked: scored.ranked, findings: scored.findings, rule_used: scored.op_used };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(chooseWhatAVisitorSees(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
