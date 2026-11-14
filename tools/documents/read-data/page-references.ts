import { encodeRefToken, parseInlineRuns, type Ref } from 'trillion-workshop/tools/edit-a-document-together/read-data/inline-tokens.ts';

export type ReferenceResolution = 'resolved' | 'missing' | 'unchecked';
export interface PageReference {
  id: string;
  blockId: string;
  reference: Ref;
  resolution: Exclude<ReferenceResolution, 'resolved'>;
}
export interface PageReferenceOccurrence {
  id: string;
  blockId: string;
  reference: Ref;
}
export interface DocumentPageBacklink extends PageReferenceOccurrence {
  sourcePageId: string;
  sourcePageLabel: string;
}
export interface DocumentPageReferenceIndex {
  occurrencesByPage: Map<string, PageReferenceOccurrence[]>;
  backlinksByTarget: Map<string, DocumentPageBacklink[]>;
}
export interface ReferenceNode { id: string; props?: unknown; children?: readonly ReferenceNode[] }

/** The scene owner decides which subtrees interpret authored tokens as references. */
export type ReferenceReadPolicy = (node: ReferenceNode) => boolean;

/** Read every authored reference once per block, retaining its source block identity. */
export function pageReferencesIn(page: ReferenceNode, readsReferences?: ReferenceReadPolicy): PageReferenceOccurrence[] {
  const result: PageReferenceOccurrence[] = [];
  const visit = (node: typeof page) => {
    if (readsReferences && !readsReferences(node)) return;
    const text = (node.props as { text?: unknown } | undefined)?.text;
    const seen = new Set<string>();
    if (typeof text === 'string') for (const run of parseInlineRuns(text)) {
      if (run.type !== 'ref') continue;
      const key = JSON.stringify([node.id, run.kind, run.value]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ id: `document-reference:${key}`, blockId: node.id, reference: run });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(page);
  return result;
}

/** Parse the authored scene once to feed source-page checks and target-page backlinks together. */
export function documentPageReferenceIndex(
  pages: readonly { id: string; label: string; node: ReferenceNode }[],
  pageReferenceKind: string | null | undefined,
  readsReferences?: ReferenceReadPolicy,
): DocumentPageReferenceIndex {
  const occurrencesByPage = new Map<string, PageReferenceOccurrence[]>();
  const backlinksByTarget = new Map<string, DocumentPageBacklink[]>();
  for (const page of pages) {
    const occurrences = pageReferencesIn(page.node, readsReferences);
    occurrencesByPage.set(page.id, occurrences);
    if (!pageReferenceKind) continue;
    for (const occurrence of occurrences) {
      if (occurrence.reference.kind !== pageReferenceKind) continue;
      const backlinks = backlinksByTarget.get(occurrence.reference.value) ?? [];
      backlinks.push({ ...occurrence, sourcePageId: page.id, sourcePageLabel: page.label });
      backlinksByTarget.set(occurrence.reference.value, backlinks);
    }
  }
  return { occurrencesByPage, backlinksByTarget };
}

/** Resolve same-document page references locally; absence is confirmed only against the live scene tree. */
export function resolveDocumentPageReference(
  reference: Ref,
  pageReferenceKind: string | null | undefined,
  pageIds: ReadonlySet<string>,
): ReferenceResolution | null {
  if (!pageReferenceKind || reference.kind !== pageReferenceKind) return null;
  return pageIds.has(reference.value) ? 'resolved' : 'missing';
}

/** Keep self-links inside a duplicated page pointed at the duplicate's fresh identity. */
export function remapPageSelfReferences<T extends ReferenceNode>(
  page: T,
  pageReferenceKind: string | null | undefined,
  oldPageId: string,
  newPageId: string,
  readsReferences?: ReferenceReadPolicy,
): T {
  if (!pageReferenceKind || oldPageId === newPageId) return page;
  const visit = (node: ReferenceNode): ReferenceNode => {
    if (readsReferences && !readsReferences(node)) return node;
    let props = node.props;
    const text = (props as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string' && text.includes('⟦ref:')) {
      const remapped = text.replace(/⟦ref:([^⟧]*)⟧/g, (token) => {
        const run = parseInlineRuns(token)[0];
        return run?.type === 'ref' && run.kind === pageReferenceKind && run.value === oldPageId
          ? encodeRefToken({ ...run, value: newPageId })
          : token;
      });
      if (remapped !== text) props = { ...(props as Record<string, unknown>), text: remapped };
    }
    const children = node.children?.map(visit);
    if (props === node.props && (!children || children.every((child, index) => child === node.children?.[index]))) return node;
    return { ...node, props, ...(children ? { children } : {}) };
  };
  return visit(page) as T;
}

/** A missing feed row is unchecked, not evidence that the target was deleted.
 * The caller supplies resolution from the owner of each reference kind. */
export function pageReferencesToCheck(
  page: ReferenceNode,
  resolve: (reference: Ref) => ReferenceResolution,
  readsReferences?: ReferenceReadPolicy,
): PageReference[] {
  return referenceOccurrencesToCheck(pageReferencesIn(page, readsReferences), resolve);
}

export function referenceOccurrencesToCheck(
  occurrences: readonly PageReferenceOccurrence[],
  resolve: (reference: Ref) => ReferenceResolution,
): PageReference[] {
  return occurrences.flatMap(occurrence => {
    const resolution = resolve(occurrence.reference);
    return resolution === 'resolved' ? [] : [{ ...occurrence, resolution }];
  });
}
