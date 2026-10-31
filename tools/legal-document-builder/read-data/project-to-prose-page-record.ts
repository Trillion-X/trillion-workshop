// tools/legal-document-builder/read-data/project-to-prose-page-record.ts
//
// Pure projection from an AssembledDocument to a generic prose page record
// (the public-sales-page/page shape every business's display surface already
// renders). This is the ONE place legal text becomes display DATA; per-app
// scripts only splice the emitted record into their own live aggregate and
// carry it through the forward-change runner. Route paths, brand strings, and
// nav links are caller DATA, never package knowledge.

import type { AssembledDocument } from './assemble-legal-documents';

export type ProsePageNavLink = { label: string; href: string };

export type ProsePageProjection = {
  /** Record id prefix, e.g. "public-sales-page:legal-" */
  id_prefix: string;
  /** Route for THIS document, e.g. "/tos" */
  route_path: string;
  brand: string;
  footer_tagline?: string;
  nav: readonly ProsePageNavLink[];
};

/** Strip the H1 (the record carries the heading separately) and rule lines,
 * then split into trimmed non-empty paragraphs. */
export function proseParagraphs(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('# ') && line.trim() !== '---')
    .join('\n')
    .split('\n\n')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function projectToProsePageRecord(
  doc: AssembledDocument,
  projection: ProsePageProjection,
) {
  const slug = doc.document_type;
  return {
    kind: 'public-sales-page',
    schema: 'public-sales-page/page',
    id: `${projection.id_prefix}${slug}`,
    route_path: projection.route_path,
    brand: projection.brand,
    footerTagline: projection.footer_tagline ?? projection.brand,
    footerNote: `Document identity: ${doc.document_content_hash}`,
    sections: [
      ...projection.nav.map((link, i) => ({
        id: `legal-${slug}-nav-${i}`,
        category: 'nav',
        label: link.label,
        href: link.href,
      })),
      {
        id: `legal-${slug}-body`,
        category: 'prose',
        anchor: slug,
        heading: doc.title,
        tone: 'lede',
        items: proseParagraphs(doc.text).map((t, i) => ({
          id: `legal-${slug}-p${i}`,
          text: [{ text: t }],
        })),
      },
    ],
  };
}
