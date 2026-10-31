// tools/funnels-and-offers/do-work/measure-funnel-stages.mjs
//
// The command of tool:measure-funnel-stages. One JSON input (argv[2]):
//   { facts: [records], stage_ids: [text], group_by: "field holding a stage id", amount_field: "field holding whole cents" }
// Prints one JSON line { stages: { <stage id>: { visits, conversions, conversion_rate, revenue_cents } }, facts_read, facts_unplaced }.
// A fact that names no stage in the list is counted in facts_unplaced, not dropped silently.
import { reduceStageMeasures } from '../read-data/stage-measures.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function measureFunnelStages(input) {
  if (!object(input)) throw new Error('Give { facts, stage_ids, group_by, amount_field }.');
  const problems = [];
  if (!Array.isArray(input.facts)) problems.push('facts must be a list of records');
  if (!(Array.isArray(input.stage_ids) && input.stage_ids.length > 0 && input.stage_ids.every(id => typeof id === 'string' && id))) problems.push('stage_ids must be a non-empty list of stage ids');
  if (typeof input.group_by !== 'string' || !input.group_by) problems.push('group_by must name the field that holds a stage id');
  if (typeof input.amount_field !== 'string' || !input.amount_field) problems.push('amount_field must name the field that holds the amount in cents');
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
  const stages = reduceStageMeasures(input.facts, input.stage_ids, input.group_by, input.amount_field);
  const placed = Object.values(stages).reduce((sum, measures) => sum + measures.visits, 0);
  return { stages, facts_read: input.facts.length, facts_unplaced: input.facts.length - placed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(measureFunnelStages(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
