// packages/documents/read-data/document-sections.ts
//
// The GENERIC "ordered sections -> composition document" mapper (L069/L090). A
// composition document is just `{children: SceneNode[]}` (see CompositionContent:
// "there is no document/page/title unit — the things that feel like pages are
// just nodes among these children"). So ANY producer of ordered text pieces — an
// article engine, a caption generator, a legal-brief pipeline, a changelog — maps
// its output to a flat list of self-describing `DocumentSection` rows, and this
// pure function turns them into one editable page via the actual import mapper. documents owns
// the DOCUMENT format; the producer owns its own vocabulary (article/bluf/faq/…)
// and translates to sections at ITS boundary (L098). This source names NO domain
// field — sections carry generic text, heading, style and optional source references.
//
// Every node is a plain `kind:'Text'` block with a `style` the composition-engine
// already renders (font_size/font_weight from FORMAT_DESCRIPTORS), so the produced
// document opens in the SAME editor and every piece (heading, paragraph, sources
// line) is individually selectable/editable — zero article-specific rendering.

import type { CompositionContent } from './documents';
import { sectionsToContent } from '../do-work/imported-document.mjs';

// One ordered piece of a document. `heading:true` (or a `level`) renders the text
// as a heading block; otherwise it is a body paragraph. `style` overrides/extends
// the derived style (the engine reads the same style keys the format bar writes).
export type DocumentSection = {
  text: string;
  heading?: boolean;
  level?: number; // 1..6; only meaningful when heading (or non-zero). Defaults to 1.
  style?: Record<string, unknown>;
  provenance?: { source_identity_refs: string[]; source_revision_refs: string[]; evidence_locator_refs: string[]; [key: string]: unknown };
  source?: string;
  refs?: string[];
};

// The shared mapper resolves heading level -> the engine style the format bar's H1/H2 descriptors produce, so a
// mapped heading looks identical to one the user styles by hand (SSOT with
// FORMAT_DESCRIPTORS: h1 = 30/700, h2 = 22/600, h3+ = 18/600). Body = 16/400.

// The shared mapper builds Text block nodes. Ids are derived from the document id + ordinal so a
// re-map of the same document is byte-stable (the write path is full-replace, but
// stable ids keep version-note diffs meaningful and MOVE identity survivable).

// The GENERIC mapper: ordered sections -> a full composition document (node tree).
// Empty/whitespace sections are dropped (a document with zero authored text hits the
// surface's capable empty-state seed, and the fail-closed write guard refuses to
// persist an all-empty tree over authored content — see write-composition-documents).
export function sectionsToCompositionContent(
  docId: string,
  sections: readonly DocumentSection[],
): CompositionContent {
  // Reuse the actual import mapping, including its ordinary page container and
  // per-block provenance. A preview must not invent a different document tree.
  return sectionsToContent(docId, sections) as CompositionContent;
}
