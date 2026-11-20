// tools/workflows/read-data/resolve-citations.mjs
//
// tool:resolve-citations: judge a list of citations with the resolver rows of citation-resolvers.json (resolveItem), so a
// workflow can check a cited line before a step is accepted. It answers one verdict per citation, never a judgement of its
// own: a citation `root/path:line-line@commit` is read at that commit (git show), one without a commit at the root's ref.
//
// Input:  { resolver?: "code-line" | "commits" (default "code-line"), items: [{ cite, quote? }] }
//         each item is one citation; `quote` is the text the cited line (or range) has to contain, when given.
// Answer: { result: [{ cite, ok, why, against }] } with ok true (holds), false (refused, with why) or null (cannot say here).
//
// It reads only the roots the resolver names, through git in their checkouts. A root whose checkout is not on this computer
// answers null, never true.
import { resolveItem } from './citation-resolvers.mjs';

export async function resolveCitations(input = {}) {
  const resolver = input.resolver ?? 'code-line';
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new Error('resolve-citations needs items: [{ cite, quote? }]');
  const check = { kind: 'cites-resolve', field: 'cite', resolver, quote: 'quote' };
  const result = [];
  for (const item of items) {
    const verdicts = await resolveItem(check, { cite: String(item?.cite ?? ''), quote: item?.quote });
    result.push(...verdicts.map(verdict => ({ cite: verdict.cite, ok: verdict.ok, why: verdict.why ?? null, against: verdict.against ?? null })));
  }
  return { result };
}
