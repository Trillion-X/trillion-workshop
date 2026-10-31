// tools/funnels-and-offers/do-work/draft-a-funnel.mjs
//
// The command of tool:draft-a-funnel. One JSON input (argv[2]):
//   { title, stages?: [stage titles], entropy? }            a new funnel-definition, as empty as you ask
//   { add_to: <funnel-definition>, stages: [stage titles] }  the same record with those stages appended (every other field kept as it is)
// Prints one JSON line { funnel }: the funnel-definition record for the person to save in their own records. Each stage
// is title-only; pointing it at a workflow node, an offer or a measure is adding a ref to its row.
import { randomBytes } from 'node:crypto';
import { appendStage, buildNewFunnelDefinition, readFunnelDefinition } from '../read-data/funnel-definition.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function draftAFunnel(input, entropy = () => randomBytes(3).toString('hex')) {
  if (!object(input)) throw new Error('Give { title } for a new funnel or { add_to, stages } to grow one.');
  const problems = [];
  if (input.stages !== undefined && !(Array.isArray(input.stages) && input.stages.every(title => typeof title === 'string' && title.trim()))) problems.push('stages must be a list of stage titles');
  if (input.add_to === undefined && !(typeof input.title === 'string' && input.title.trim())) problems.push('a new funnel needs a title');
  if (input.add_to !== undefined && readFunnelDefinition(input.add_to) === null) problems.push('add_to must be a funnel-definition record with an id');
  if (input.add_to !== undefined && !(Array.isArray(input.stages) && input.stages.length)) problems.push('add_to needs the stage titles to append');
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
  const start = input.add_to !== undefined ? input.add_to : buildNewFunnelDefinition(input.title, input.entropy ?? entropy());
  return { funnel: (input.stages ?? []).reduce((definition, title) => appendStage(definition, title), start) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(draftAFunnel(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
