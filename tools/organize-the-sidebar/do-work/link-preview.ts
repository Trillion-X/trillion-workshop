// packages/group/do-work/link-preview.ts
//
// Pure, zero-I/O helpers for the board LINK-CARD capability (Milanote/Bento-class).
// A saved URL becomes a rich card: favicon + domain + (optionally, once enriched as
// DATA) a thumbnail + title + description. This leaf owns the ONLY parsing of a raw
// href into its display parts and the ONLY reader of the self-describing
// `extra.linkPreview` DATA — so the renderer, the paste path, and (later) the OG
// enrichment workflow all agree (SSOT). No network here: the favicon URL is DERIVED
// from the href (a plain <img> src the renderer sets), never fetched by this module.
//
// Physics vs Society: the enrichment shape (title/description/image) is self-describing
// DATA (L090) written by an external generic package (http-client/process-engine) — this
// module never fetches, never names an OG tag; it only reads what is present.

/** The enrichment DATA a link card MAY carry on `extra.linkPreview` once fetched. All
 *  fields optional — the card renders from whatever is present (fail-open, no fake). */
export interface LinkPreview {
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
  /** The full image GALLERY (b196) — every og:image a multi-photo post declares (Pinterest board /
   *  IG carousel). Present only when there is more than one; `image` remains the hero (`images[0]`).
   *  `LinkGallery` renders this as a carousel; `linkPreviewImages` is the read SSOT. */
  readonly images?: readonly string[];
  readonly favicon?: string;
  /** A playable media URL for the embed (og:video / twitter:player) — a user's "real
   *  Pinterest/IG image OR VIDEO". When present the card plays it instead of the still. */
  readonly video?: string;
  /** The publisher name (og:site_name) — the human source label on the card. */
  readonly siteName?: string;
}

/** True iff `text` is exactly ONE http(s) URL (no surrounding whitespace/words). Used by
 *  the paste path to decide "this paste is a link" vs "this paste is note text". */
export function isSingleUrl(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  return /^https?:\/\/[^\s]+$/i.test(t);
}

/** The display host of a URL (`www.` stripped), or `fallback` if it can't be parsed. */
export function hostFromHref(href: string | undefined, fallback = ''): string {
  if (!href) return fallback;
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return fallback;
  }
}

/** A favicon image URL DERIVED from the href's host (Google's public s2 service — the
 *  standard way every app shows a site's icon). Returns null when the host is unknown so
 *  the renderer can fall back to a link glyph. This is an <img src>, not a fetch we own. */
export function faviconUrl(href: string | undefined, size = 64): string | null {
  const host = hostFromHref(href);
  if (!host) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
}

/** Read the self-describing `extra.linkPreview` DATA (L090) into a typed {@link LinkPreview},
 *  or null if absent/malformed. Only string fields survive — never invents values (L117). */
export function readLinkPreview(extra: Record<string, unknown> | undefined | null): LinkPreview | null {
  const raw = extra?.linkPreview;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  // A gallery: keep only non-empty strings; `undefined` when absent or all-empty (fail-closed).
  const strArray = (v: unknown): readonly string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return out.length > 0 ? out : undefined;
  };
  const preview: LinkPreview = {
    title: str(r.title),
    description: str(r.description),
    image: str(r.image),
    images: strArray(r.images),
    favicon: str(r.favicon),
    video: str(r.video),
    siteName: str(r.siteName),
  };
  // Null out an all-empty preview so callers get a clean "nothing enriched yet".
  if (
    !preview.title && !preview.description && !preview.image && !preview.images &&
    !preview.favicon && !preview.video && !preview.siteName
  ) {
    return null;
  }
  return preview;
}

/** The link's images as a gallery — the read SSOT for "what images does this link have" (b196): the stored
 *  `images` set if present, else the single hero `image` as a one-element list, else `[]`. `LinkGallery`
 *  renders exactly this, so a single-image and a multi-image link flow through one path. Pure. */
export function linkPreviewImages(preview: LinkPreview | null | undefined): string[] {
  if (!preview) return [];
  if (preview.images && preview.images.length > 0) return [...preview.images];
  return preview.image ? [preview.image] : [];
}

/** Build the draft for a pasted/typed URL → a `link` board item (src carries the href).
 *  The kind is a raw DATA key (L090); the renderer (ITEM_RENDERERS['link']) does the rest. */
export function linkCardDraft(url: string): { kind: 'link'; src: string; text: string } {
  const href = url.trim();
  return { kind: 'link', src: href, text: hostFromHref(href, href) };
}

/**
 * Fold a manual title/description edit (the Dub-style owner override) over the current
 * preview → the next {@link LinkPreview}, or `undefined` when the whole preview becomes
 * empty (so the caller clears the DATA — never leaves an empty object). Whitespace-only
 * fields are dropped, so typing then clearing a field removes it (no fake "" values,
 * L117). Untouched fields (`image`/`favicon` from enrichment) are preserved. Pure — the
 * testable SSOT of the edit logic; the panel callback is a thin askText → this → patch.
 */
export function mergeLinkPreviewEdit(
  current: LinkPreview | null | undefined,
  edit: { title?: string; description?: string },
): LinkPreview | undefined {
  const clean = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);
  const next: LinkPreview = {
    ...(current ?? {}),
    title: clean(edit.title),
    description: clean(edit.description),
  };
  // The preview survives on ANY populated field — including the enrichment-only `video`/`siteName`
  // (not just image/favicon), so editing then clearing the title never deletes a video-only card.
  return next.title || next.description || next.image || next.favicon || next.video || next.siteName
    ? next
    : undefined;
}
