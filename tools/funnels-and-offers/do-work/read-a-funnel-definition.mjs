// tools/funnels-and-offers/do-work/read-a-funnel-definition.mjs
//
// The command of tool:read-a-funnel-definition. One JSON input (argv[2]):
//   { definitions: [funnel-definition records], funnel_id?, owners?: { workflowNodes, variantSurfaces, offers, measures },
//     decisions?: [{ surface_address, winner_id }] }
// Prints one JSON line { funnel }: each stage with its title, versions (the decided one marked live), price, measures and
// conversion percent; or { funnel: null, reason } when there is no such funnel.
import { liveVariantMapFromDecisions, resolveFunnelDefinition } from '../read-data/funnel-definition.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function readAFunnelDefinition(input) {
  if (!object(input)) throw new Error('Give { definitions } as funnel-definition records.');
  const problems = [];
  if (!Array.isArray(input.definitions)) problems.push('definitions must be a list of funnel-definition records');
  if (input.owners !== undefined && !object(input.owners)) problems.push('owners must be an object of record lists');
  if (object(input.owners)) {
    for (const [name, value] of Object.entries(input.owners)) if (name !== 'liveVariantBySurface' && !Array.isArray(value)) problems.push(`owners.${name} must be a list of records`);
  }
  if (input.decisions !== undefined && !Array.isArray(input.decisions)) problems.push('decisions must be a list of { surface_address, winner_id }');
  if (input.funnel_id !== undefined && typeof input.funnel_id !== 'string') problems.push('funnel_id must be text');
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
  const owners = { ...(input.owners ?? {}), liveVariantBySurface: { ...(input.owners?.liveVariantBySurface ?? {}), ...liveVariantMapFromDecisions(input.decisions ?? []) } };
  const funnel = resolveFunnelDefinition(input.definitions, owners, input.funnel_id);
  return funnel ? { funnel } : { funnel: null, reason: 'No funnel-definition record with that id was found.' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(readAFunnelDefinition(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
