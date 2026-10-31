// tools/legal-document-builder/read-data/project-to-blocks-page-record.ts
//
// Pure projection from an AssembledDocument to a blocks-shaped page record
// (paragraph rows with strong headings), the contract the customer public
// sales-page renderer and its SSR consume for exact per-path records. Sibling
// of project-to-prose-page-record (sections shape); one assembled document,
// per-surface display contracts, both projections owned here so no per-app
// script re-derives them.

import type { AssembledDocument } from './assemble-legal-documents.ts';
import { proseParagraphs } from './project-to-prose-page-record.ts';

export type BlocksPageNavLink = { label: string; href: string; role?: string };

export type BlocksPageProjection = {
  /** Record id, e.g. "public-sales-page:tos" */
  id: string;
  /** Route for THIS document, e.g. "/tos" */
  route_path: string;
  brand_label: string;
  navigation: readonly BlocksPageNavLink[];
  title?: string;
  /** Opaque structured-data payload (e.g. schema.org @graph) carried through untouched. */
  schema?: unknown;
};

type ParagraphBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'paragraph'; parts: { strong?: boolean; text: string }[] };

/** Numbered/short standalone lines read as headings; render them strong. */
function isHeadingLike(paragraph: string): boolean {
  return !paragraph.includes('\n') && paragraph.length <= 80 && /^[0-9]+\./.test(paragraph);
}

export function projectToBlocksPageRecord(
  doc: AssembledDocument,
  projection: BlocksPageProjection,
) {
  const blocks: ParagraphBlock[] = [
    { kind: 'paragraph', parts: [{ strong: true, text: doc.title }] },
    ...proseParagraphs(doc.text).map((paragraph): ParagraphBlock => (
      isHeadingLike(paragraph)
        ? { kind: 'paragraph', parts: [{ strong: true, text: paragraph }] }
        : { kind: 'paragraph', text: paragraph }
    )),
  ];
  return {
    id: projection.id,
    kind: 'public-sales-page',
    route_path: projection.route_path,
    title: projection.title ?? `${doc.title}, ${projection.brand_label}`,
    brand_label: projection.brand_label,
    navigation: [...projection.navigation],
    ...(projection.schema !== undefined ? { schema: projection.schema } : {}),
    blocks,
  };
}
