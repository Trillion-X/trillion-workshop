// tools/workflows/read-data/resolve-citations.mjs
//
// tool:resolve-citations: judge citations with the resolver rows of citation-resolvers.json (resolveItem), so a workflow can
// refuse a wrong citation before a step relies on it. Each run is granted ONE repository folder (its read-a-folder grant); the
// citation's root must be that folder's name, or the citation is refused with "root not granted to this run". A citation
// `root/path:line-line@commit` is read at that commit (git show); one without a commit at the root's configured ref.
//
// Input:  { items: [{ cite, quote? }] }; `quote` is the text the cited line (or range) has to contain, when given.
// Answer: { result: [{ cite, ok, why, against }] }: ok true (holds), false (refused, with why) or null (cannot say here).
import { basename } from 'node:path';
import { resolveItem } from './citation-resolvers.mjs';

export async function resolveCitationsInGrantedRoot(input = {}, grantedFolder) {
  const root = basename(String(grantedFolder ?? '').replace(/\/+$/, ''));
  if (!root) throw new Error('resolve-citations needs the one folder granted to this run');
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new Error('resolve-citations needs items: [{ cite, quote? }]');
  const check = { kind: 'cites-resolve', field: 'cite', resolver: 'code-line', quote: 'quote' };
  const result = [];
  for (const item of items) {
    const cite = String(item?.cite ?? '');
    if (!cite.startsWith(`${root}/`)) {
      result.push({ cite, ok: false, why: 'root not granted to this run', against: null });
      continue;
    }
    const verdicts = await resolveItem(check, { cite, quote: item?.quote });
    result.push(...verdicts.map(verdict => ({ cite: verdict.cite, ok: verdict.ok, why: verdict.why ?? null, against: verdict.against ?? null })));
  }
  return { result };
}
