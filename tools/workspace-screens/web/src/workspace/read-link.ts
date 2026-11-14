// src/workspace/read-link.ts
//
// PURPOSE
//   A link a person pastes, read into the card the page describes itself with, for any screen that takes a paste
//   (the composer, Saved examples): find the one link in what was pasted (`linkInPaste`), read it (`readLink`, GET
//   /work/api/read-link, src/read-link.mjs), and hand the card to the shared LinkPreview (`linkPreviewProps`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One reader: the Worker reads the page (the same reader AIs run as tool:read-a-link); nothing here fetches a
//      page itself.
//   2. A pasted text is a link only when it is exactly one http(s) address; words around an address are words.
//   3. A page that says nothing about itself still gives a card: its address and site, never a guessed title.

import type { LinkPreviewProps } from '../../parts/ui/show/link-preview';
import { readJson } from './api';

/** What one public link says about itself (src/read-link.mjs readLinkCard). `unread` says why reading stopped or
 *  found no information; a bounded partial card can still contain useful facts. */
export type LinkCard = {
  url: string;
  final_url: string;
  host: string;
  site: string | null;
  title: string | null;
  description: string | null;
  /** The first of `images`, the picture the page leads with. */
  image: string | null;
  /** Every picture and video address the page declares (or the link itself, when it is one). */
  images: string[];
  videos: string[];
  icon: string | null;
  /** The page's structured data (schema.org JSON-LD objects). */
  data: Record<string, unknown>[];
  text: string;
  unread: string | null;
};

/** The one rule for when a paste is a link lives with the shared composer; every screen uses it. */
export { linkInPaste } from '../../parts/ui/show/composer/link-in-paste';

/** Reads one public link into its card. Rejects with the Worker's own words when the address is not a public page
 *  address; a page that cannot be read resolves to a card with `unread` set. */
export function readLink(url: string, init: { signal?: AbortSignal } = {}): Promise<LinkCard> {
  return readJson<LinkCard>(`/work/api/read-link?url=${encodeURIComponent(url)}`, init);
}

/** The card as the shared LinkPreview draws it. */
export function linkPreviewProps(card: LinkCard): LinkPreviewProps {
  return {
    url: card.final_url,
    title: card.title ?? card.site ?? card.host,
    site: card.site ?? card.host,
    icon: card.icon,
    picture: card.image,
    description: card.description,
    unread: card.unread,
  };
}
