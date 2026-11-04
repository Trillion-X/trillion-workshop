// packages/group/show/node-accessibility.ts
//
// The board's SCREEN-READER accessibility leaf — pure, zero I/O, framework-agnostic. Produces ONE
// meaningful accessible NAME per board item so assistive tech announces "Note: buy milk" / "Link:
// example.com" / "Image" instead of an anonymous positioned box (Codex board-gap #5, the screen-
// reader half). Blind + DATA-driven (L090): the kind→noun mapping reuses the SAME `kindFamilyOf`
// SSOT the facets use (a new kind is one DATA row there, zero code here); link names reuse the SAME
// `readLinkPreview`/`hostFromHref` the LinkItem card renders from. The keyboard half of gap #5 is
// constrained by the board's existing keymap (Tab/Enter = mind-map child/sibling, arrows = nudge,
// Space = pan), so this leaf owns the non-conflicting screen-reader dimension only.

import type { BoardItem } from '../read-data/group-board-model';
import { kindFamilyOf } from './board-item-facets';
import { ownValue } from '../read-data/facet-filter';
import { hostFromHref, readLinkPreview } from '../do-work/link-preview';

/** Nouns for kinds `kindFamilyOf` intentionally returns empty for (a section is a container, a
 *  pending item is a transient placeholder — neither is a "content family", but both still deserve
 *  an accessible name). A kind mapped by `kindFamilyOf` never reaches this fallback. */
const KIND_NOUN_FALLBACK: Readonly<Record<string, string>> = {
  section: 'Group',
  pending: 'Loading item',
};

const MAX_NAME = 80; // keep the announced name scannable; longer text is elided

/** Strip any markup + collapse whitespace so the announced name is clean text (rich notes usually
 *  carry a plain-text projection already; this is a defensive normaliser). */
function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The kind NOUN for an item — the `kindFamilyOf` family label, else the section/pending fallback,
 *  else a Title-cased raw kind, else a generic "Item". Never a raw lowercase key (L090 human names). */
export function nodeKindNoun(item: BoardItem): string {
  const fam = kindFamilyOf(item)[0];
  if (fam) return fam;
  const kind = item.kind;
  // `kind` is untrusted item DATA — a plain `KIND_NOUN_FALLBACK[kind]` reads INHERITED members, so
  // '__proto__'/'constructor' return Object.prototype / the Object constructor as the a11y "noun"
  // (a screen reader would announce "[object Object]"). ownValue routes them to the Title-case fallback.
  const noun = kind ? ownValue<string>(KIND_NOUN_FALLBACK, kind) : undefined;
  if (typeof noun === 'string') return noun;
  if (kind) return kind.charAt(0).toUpperCase() + kind.slice(1);
  return 'Item';
}

/**
 * The accessible NAME for one board node — what a screen reader announces. `Kind: content`, e.g.
 * "Note: buy milk", "Group: Q3 goals", "Image". A link uses its enriched title, else its domain
 * ("Link: example.com"), reusing the same preview DATA the card renders. When `opts.selected` is
 * true the state is appended (", selected") so AT users hear selection WITHOUT the node having to
 * claim interactive-widget semantics it can't keyboard-fulfil (the board's keys are taken). Pure;
 * never throws; caps the content so the name stays scannable.
 */
export function nodeAriaLabel(item: BoardItem, opts?: { selected?: boolean }): string {
  const base = describeNode(item);
  return opts?.selected ? `${base}, selected` : base;
}

function describeNode(item: BoardItem): string {
  if (item.kind === 'link') {
    const preview = readLinkPreview(item.extra);
    const name = plainText(preview?.title) || hostFromHref(item.src, '') || plainText(item.text);
    return name ? `Link: ${elide(name)}` : 'Link';
  }
  const noun = nodeKindNoun(item);
  const text = plainText(item.text);
  return text ? `${noun}: ${elide(text)}` : noun;
}

function elide(s: string): string {
  return s.length > MAX_NAME ? `${s.slice(0, MAX_NAME - 1).trimEnd()}…` : s;
}
