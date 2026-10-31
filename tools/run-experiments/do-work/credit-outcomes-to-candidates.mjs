// tools/run-experiments/do-work/credit-outcomes-to-candidates.mjs
//
// The Workshop tool "Credit what visitors did to the version they saw". argv[2] is one JSON input:
//   { join: { entity_type: 'attribution-join', join_id,
//             assignment: { observer_key_path, candidate_key_path, where? },   which record says who saw which candidate
//             outcome: { observer_key_path, metric_path, value_path?, where? }, which record says who did what
//             emit: { observe_address, metric_map, value_metric?, trust_ref? } },
//     assignments: [record], outcomes: [record], at: ISO time }
// Joins the two lists by visitor and sums, per visitor, outcome and candidate, how many times it happened and the value
// it carried. Running it again over the same records gives the same answer. Prints one JSON line:
//   { observations: [{ observerId, trustRef, path, value, at }], findings: [text] }
// A join that does not validate is refused with every problem listed.
import { attributeOutcomes } from '../read-data/attribute-outcomes.ts';

// The join reports itself with console.log; this command's answer is its last stdout line.
console.log = console.error;

export function creditOutcomesToCandidates(input) {
  const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!object(input)) throw new Error('The input must be { join, assignments, outcomes, at }.');
  if (!Array.isArray(input.assignments) || !Array.isArray(input.outcomes)) throw new Error('assignments and outcomes must each be a list of records.');
  if (typeof input.at !== 'string' || Number.isNaN(Date.parse(input.at))) throw new Error('at must be an ISO time.');
  const result = attributeOutcomes(input.join, input.assignments, input.outcomes, input.at);
  const refused = result.findings.filter(finding => finding.startsWith('config: '));
  if (refused.length) throw new Error(refused.map(finding => finding.slice('config: '.length)).join('\n'));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(creditOutcomesToCandidates(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
