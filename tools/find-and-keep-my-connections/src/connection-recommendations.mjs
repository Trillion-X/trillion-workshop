// Personal suggestions on the Connections screen (src/screen-reads.mjs readConnections), read from the account's own
// owners: workScreen() (its pursuits), similarProviders() (the services people on similar paths use, src/network.mjs
// providersOnPath; only provider ids cross that boundary) and findTools(input) (the shared Workshop matcher).
import { optionalRead } from './optional-read.mjs';
import { providersForLinks } from '../../suggest-connections-from-links/src/connection-links.mjs';

// Personal Connections suggestions use only facts already visible to this account (computer source names and
// active pursuits). The shared Workshop matcher supplies aggregate runs for similar jobs; its counts are runs,
// never distinct people. Failure to read either source leaves the ordinary catalog intact.
export async function connectionRecommendations({ workScreen, similarProviders, findTools }, rows, computers = [], rules = []) {
  const tools = (rows.tools ?? []).filter(tool => tool.invoke?.provider && tool.invoke?.connects);
  const byProvider = new Map();
  for (const tool of tools) byProvider.set(tool.invoke.provider, tool);
  const computerFacts = computers.flatMap(computer => [
    ...(computer.sources ?? []).map(source => `${source.label ?? ''} ${source.category ?? ''} ${source.detail ?? ''}`),
    ...(computer.browser_sites ?? []),
  ]).filter(Boolean).join('\n');
  const work = await optionalRead(() => workScreen(), null, 1500);
  const pursuits = (work?.pursuits ?? []).filter(item => item.status !== 'ended');
  const sharedProviders = pursuits.length ? await optionalRead(() => similarProviders(), [], 1800) : [];
  const job = pursuits.flatMap(item => [item.title, item.now, item.after, item.why_it_matters]).filter(Boolean).join('\n').slice(0, 4000);
  const result = job && tools.length
    ? await optionalRead(() => findTools({ job, allowed_tool_ids: tools.map(tool => tool.id), limit: 20 }), null, 2500)
    : null;
  const recommendations = {};
  const vendorOfSource = new Map((rows.event_sources ?? []).filter(row => row.connects_with?.vendor).map(row => [row.id, row.connects_with.vendor]));
  for (const rule of rules) {
    const provider = vendorOfSource.get(rule.when?.source_id);
    if (provider && byProvider.has(provider)) recommendations[provider] = { reason: 'Used in one of your flows', rank: -1, similar_job_runs: 0 };
  }
  // A link in the person's work (or a site found on their computer) to a service they have not connected is a reason to offer it.
  for (const [provider, host] of providersForLinks(`${job}\n${computerFacts}`, tools)) {
    if (!recommendations[provider]) recommendations[provider] = { reason: `Your work links to ${host}`, rank: -0.5, similar_job_runs: 0 };
  }
  const candidates = result?.candidates ?? [];
  candidates.forEach((candidate, index) => {
    const tool = byProvider.get(candidate.tool_id) ?? tools.find(row => row.id === candidate.tool_id);
    const provider = tool?.invoke?.provider;
    if (!provider || index >= 8) return;
    if (!recommendations[provider]) recommendations[provider] = {
      reason: 'Fits work you are pursuing',
      rank: index,
      similar_job_runs: Number(candidate.earlier_runs?.similar_jobs?.runs) || 0,
    };
  });
  for (const provider of sharedProviders) {
    if (byProvider.has(provider) && !recommendations[provider]) recommendations[provider] = {
      reason: 'Used by people on similar paths', rank: 8, similar_job_runs: 0,
    };
  }
  // Computer findings are names and categories only. Exact service or meaningful word overlap can surface a relevant
  // connection even when this person has no recorded pursuit yet.
  const stopWords = new Set(['about', 'account', 'accounts', 'after', 'and', 'app', 'apps', 'connect', 'connection', 'connections', 'data', 'from', 'have', 'into', 'your', 'the', 'this', 'that', 'with', 'work', 'works', 'use', 'used', 'using', 'service', 'services', 'tool', 'tools']);
  const sourceWords = new Set((`${computerFacts}`.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(word => !stopWords.has(word)));
  for (const tool of tools) {
    const provider = tool.invoke.provider;
    if (recommendations[provider]) continue;
    const offered = `${tool.label ?? ''} ${tool.job ?? ''} ${tool.invoke.connects.category ?? ''} ${(tool.invoke.connects.capabilities ?? []).map(item => item.label).join(' ')}`.toLowerCase();
    const words = (offered.match(/[a-z0-9]{4,}/g) ?? []).filter(word => !stopWords.has(word));
    const overlap = words.some(word => sourceWords.has(word)) || (computerFacts.toLowerCase().includes(provider.toLowerCase()));
    if (overlap) recommendations[provider] = { reason: 'Matches something found on your computer', rank: 20, similar_job_runs: 0 };
  }
  return recommendations;
}
