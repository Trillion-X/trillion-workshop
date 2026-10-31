// tools/funnels-and-offers/do-work/walk-a-funnel.mjs
//
// The command of tool:walk-a-funnel. One JSON input (argv[2]):
//   { graphs, nodes, experiments?, variants?, offer_experiments?, graph_id?, at?, outcome?, cta_links?, page? }
// Prints one JSON line: { flow, current?, advance?, cta_links? }. `flow` is the resolved funnel (null with `reason` when
// there is no graph or no entry node). `at` is where the buyer is (the entry when absent or unknown); with `outcome` the
// answer also says where the buyer goes next.
import { advanceFunnel, funnelStepAtCursor, resolveCtaLinks, resolveFunnelFlow } from '../read-data/funnel-flow.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const lists = ['graphs', 'nodes', 'experiments', 'variants', 'offer_experiments', 'cta_links'];

export function walkAFunnel(input) {
  if (!object(input)) throw new Error('Give { graphs, nodes } as records.');
  const problems = lists.filter(name => (name === 'graphs' || name === 'nodes' ? !Array.isArray(input[name]) : input[name] !== undefined && !Array.isArray(input[name])))
    .map(name => `${name} must be a list of records`);
  for (const name of ['graph_id', 'at', 'outcome', 'page']) if (input[name] !== undefined && typeof input[name] !== 'string') problems.push(`${name} must be text`);
  if (input.outcome !== undefined && input.at === undefined) problems.push('outcome needs at: the node the buyer is on');
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
  const flow = resolveFunnelFlow(input.graphs, input.nodes, input.experiments ?? [], input.variants ?? [], input.offer_experiments ?? [], input.graph_id);
  const answer = { flow };
  if (flow === null) answer.reason = 'No funnel graph with an entry node that is one of the nodes was found.';
  else {
    answer.current = funnelStepAtCursor(flow, input.at);
    if (input.outcome !== undefined) answer.advance = advanceFunnel(flow, input.at, input.outcome);
  }
  if (input.cta_links) answer.cta_links = resolveCtaLinks(input.cta_links, input.page);
  return answer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(walkAFunnel(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
