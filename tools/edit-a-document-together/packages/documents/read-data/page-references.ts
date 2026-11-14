import { parseInlineRuns, type Ref } from './inline-tokens';

export type ReferenceResolution = 'resolved' | 'missing' | 'unchecked';
export interface PageReference {
  id: string;
  blockId: string;
  reference: Ref;
  resolution: Exclude<ReferenceResolution, 'resolved'>;
}
interface ReferenceNode { id: string; props?: unknown; children?: readonly ReferenceNode[] }

/** A missing feed row is unchecked, not evidence that the target was deleted.
 * The caller supplies resolution from the owner of each reference kind. */
export function pageReferencesToCheck(
  page: ReferenceNode,
  resolve: (reference: Ref) => ReferenceResolution,
): PageReference[] {
  const result: PageReference[] = [];
  const visit = (node: typeof page) => {
    const text = (node.props as { text?: unknown } | undefined)?.text;
    const seen = new Set<string>();
    if (typeof text === 'string') for (const run of parseInlineRuns(text)) {
      if (run.type !== 'ref') continue;
      const key = JSON.stringify([node.id, run.kind, run.value]);
      if (seen.has(key)) continue;
      seen.add(key);
      const resolution = resolve(run);
      if (resolution !== 'resolved') result.push({
        id: `document-reference:${key}`, blockId: node.id,
        reference: run, resolution,
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(page);
  return result;
}
