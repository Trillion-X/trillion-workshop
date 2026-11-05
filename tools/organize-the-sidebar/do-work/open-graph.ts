// packages/group/do-work/open-graph.ts
//
// The ONE pure, zero-I/O extractor that turns a page's raw HTML into the self-describing
// LinkPreview DATA a board link card renders (R11 rich-embed ingest). It NEVER fetches — the
// HTML is handed in by a generic I/O owner (http-client / process-engine / observed-content),
// keeping `group` a blind renderer of DATA and NOT a god package that does its own network
// (L093/no-god-package). One extractor covers EVERY site: Open Graph, then Twitter Card, then
// bare-HTML fallbacks — Pinterest, Instagram, YouTube, news, blogs all expose og:image, so
// there is ZERO per-site code (L090). Adding a new metadata convention = one lookup in the
// ordered source list here, never a site branch.
//
// Physics vs Society: the DATA shape (title/description/image/favicon) is Physics-generic; the
// tag NAMES it reads (og:image, twitter:image, …) are the Society conventions the web agreed on
// — kept as a DATA list, not scattered as string literals in a renderer.

import type { LinkPreview } from './link-preview.ts';

/** Char cap on the fetched HTML this pure parser will scan. The input is ATTACKER-CONTROLLED (an
 *  arbitrary fetched page), and parseOpenGraph runs ~30 independent full-document regex scans + JSON-LD
 *  parses; a 100MB crafted doc is a synchronous CPU/memory DoS. OG/Twitter/JSON-LD metadata lives in
 *  <head>, so 4MB captures every real page's metadata while defusing a pathological body. */
const MAX_HTML = 4_000_000;
/** Depth cap for the recursive JSON-LD walk/normalizers. A crafted deeply-nested JSON-LD block parses
 *  fine but overflows the recursive traversal (the "never throws" contract only caught JSON.parse). */
const MAX_JSONLD_DEPTH = 200;

/**
 * Keep only a SAFE URL scheme for an extracted preview asset (image / video / favicon). Attacker HTML
 * can declare `javascript:` / `vbscript:` / `data:text/html` asset URLs; the current sinks are
 * `<img>`/`<video>` (where `javascript:` is inert), but storing an active-content scheme is a latent XSS
 * the moment the value reaches an `href`/`innerHTML` sink — so drop it at the parse boundary (fail-closed).
 * Allowed: http(s), a protocol-relative `//host`, a root/relative path, and `data:image/*` (a real inline
 * image). Any other explicit scheme is rejected.
 */
function safeAssetUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const u = url.trim();
  if (u === '') return undefined;
  if (/^data:/i.test(u)) return /^data:image\//i.test(u) ? u : undefined; // only inline images, never data:text/html
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u); // an explicit `scheme:` prefix
  if (scheme && scheme[1].toLowerCase() !== 'http' && scheme[1].toLowerCase() !== 'https') return undefined;
  return u; // http(s), protocol-relative //host, or a relative/root path
}

/** Decode the handful of named HTML entities that appear in meta content, plus numeric
 *  (`&#39;` / `&#x27;`) forms. Pure — no DOM. Order matters: `&amp;` LAST so `&amp;lt;`
 *  decodes to `&lt;` not `<`. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Read the `content` of a `<meta>` whose `property` OR `name` equals `key`, regardless of
 *  attribute order (`content` before or after the key attr) and quote style. Returns the
 *  FIRST match's trimmed, entity-decoded content, or `undefined`. Case-insensitive on tags
 *  and keys. Pure regex — the HTML is untrusted and never executed. */
export function metaContent(html: string, key: string): string | undefined {
  const k = escapeRegExp(key);
  // Two orders: key-attr then content, or content then key-attr. `property` or `name`.
  const patterns = [
    new RegExp(`<meta[^>]*\\b(?:property|name)\\s*=\\s*["']${k}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b(?:property|name)\\s*=\\s*["']${k}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) {
      const v = decodeHtmlEntities(m[1]).trim();
      if (v) return v;
    }
  }
  return undefined;
}

/** The `<title>` text (entity-decoded, trimmed), or `undefined`. */
export function titleTag(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m || !m[1]) return undefined;
  const v = decodeHtmlEntities(m[1].replace(/\s+/g, ' ')).trim();
  return v || undefined;
}

/** The href of the first `<link>` whose `rel` CONTAINS `relKeyword` (case-insensitive,
 *  attribute-order agnostic), entity-decoded and absolutized against `baseUrl`. The ONE
 *  `<link>`-tag reader: the favicon (`rel~=icon`) and the classic image hint (`rel=image_src`)
 *  are both CONFIGURATIONS of it, so a new rel-based hint is one call, not another scan loop
 *  (L069 — the scanner is generic, the keyword is DATA). Returns `undefined` when none match. */
export function linkRelHref(html: string, relKeyword: string, baseUrl?: string): string | undefined {
  const re = /<link\b[^>]*>/gi;
  const relRe = new RegExp(`\\brel\\s*=\\s*["'][^"']*${escapeRegExp(relKeyword)}[^"']*["']`, 'i');
  let tag: RegExpExecArray | null;
  while ((tag = re.exec(html)) !== null) {
    const t = tag[0];
    if (!relRe.test(t)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(t);
    if (href && href[1]) return absolutize(decodeHtmlEntities(href[1]).trim(), baseUrl);
  }
  return undefined;
}

/** The href of the first `<link rel="icon|shortcut icon|apple-touch-icon">`, or `undefined`.
 *  A configuration of {@link linkRelHref} (rel contains "icon"). */
export function faviconHref(html: string, baseUrl?: string): string | undefined {
  return linkRelHref(html, 'icon', baseUrl);
}

/** The URL declared via schema.org microdata `itemprop="{prop}"`, read from the same tag's
 *  `content`/`href`/`src` (so `<meta>`, `<link>`, and `<img>` microdata all resolve). The
 *  structured-data fallback for pages that ship no OG/Twitter tags (common on recipe + news
 *  sites — a user's "cooking ones"). Attribute-order agnostic; first match; entity-decoded. */
export function itempropUrl(html: string, prop: string): string | undefined {
  const m = new RegExp(`<[^>]*\\bitemprop\\s*=\\s*["']${escapeRegExp(prop)}["'][^>]*>`, 'i').exec(html);
  if (!m) return undefined;
  const attr = /\b(?:content|href|src)\s*=\s*["']([^"']+)["']/i.exec(m[0]);
  const v = attr && attr[1] ? decodeHtmlEntities(attr[1]).trim() : undefined;
  return v || undefined;
}

/** Parse every JSON-LD block and return the first non-undefined value `visit` yields for any node,
 *  walking arrays + nested objects (incl. schema.org `@graph`), self before children. THE ONE
 *  JSON-LD walker — `jsonLdField` (match by field) and `jsonLdNodeByType` (match by `@type`) are
 *  configurations of it (L069, the predicate is DATA), so a new JSON-LD lookup is one `visit`, not
 *  another parse+recurse loop. Malformed blocks are skipped, never thrown (fail-open). */
export function jsonLdSearch(html: string, visit: (obj: Record<string, unknown>) => unknown): unknown {
  const re = /<script[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_JSONLD_DEPTH) return undefined; // fail-open on pathologically deep JSON-LD (no stack overflow)
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      for (const el of node) {
        const f = walk(el, depth + 1);
        if (f !== undefined) return f;
      }
      return undefined;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const hit = visit(obj);
      if (hit !== undefined) return hit;
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
          const f = walk(v, depth + 1);
          if (f !== undefined) return f;
        }
      }
    }
    return undefined;
  };
  let block: RegExpExecArray | null;
  while ((block = re.exec(html)) !== null) {
    const body = block[1].trim();
    if (body.length > MAX_HTML) continue; // skip an absurdly large JSON-LD block (DoS guard)
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      continue; // a malformed JSON-LD block is skipped, never throws (fail-open)
    }
    const found = walk(data, 0);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The first defined value for `field` anywhere in a page's JSON-LD (image/name/headline/…). A
 *  config of {@link jsonLdSearch} — the field name is DATA. Returns the raw value to normalize. */
export function jsonLdField(html: string, field: string): unknown {
  return jsonLdSearch(html, (obj) => (obj[field] !== undefined && obj[field] !== null ? obj[field] : undefined));
}

/** The first JSON-LD node whose `@type` is (or includes) `type` — a TYPE-safe entity lookup, so a
 *  VideoObject's `contentUrl` is never confused with an ImageObject's. Handles the top-level entity
 *  form (YouTube ships a bare `VideoObject`, no `video` wrapper). A config of {@link jsonLdSearch}. */
export function jsonLdNodeByType(html: string, type: string): unknown {
  return jsonLdSearch(html, (obj) => {
    const t = obj['@type'];
    return t === type || (Array.isArray(t) && t.includes(type)) ? obj : undefined;
  });
}

/** Normalize a JSON-LD image value — a bare URL string, an `ImageObject` `{url}`, or an ARRAY
 *  of either (schema.org allows all three) — down to the first URL string, or `undefined`. */
export function jsonLdUrl(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_JSONLD_DEPTH) return undefined; // fail-open on a pathologically deep nested array
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const u = jsonLdUrl(v, depth + 1);
      if (u) return u;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const url = (value as Record<string, unknown>).url;
    return typeof url === 'string' ? url.trim() || undefined : undefined;
  }
  return undefined;
}

/** Normalize a JSON-LD text value — a string, or the first string of an array (schema.org lets a
 *  `headline`/`description` be either) — trimmed, or `undefined`. */
export function jsonLdText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return undefined;
}

/** The image URL from a page's JSON-LD structured data (`"image"`), the schema.org format
 *  Instagram / Pinterest / news / recipe pages emit — the richest fallback when a page ships no
 *  OG/Twitter tags. A config of {@link jsonLdField} (field `image`) + {@link jsonLdUrl} normalize. */
export function jsonLdImage(html: string): string | undefined {
  return jsonLdUrl(jsonLdField(html, 'image'));
}

/** Normalize a JSON-LD video value — a URL string, a `VideoObject` (`contentUrl` > `embedUrl` >
 *  `url`), or an ARRAY of either — down to the first playable URL, or `undefined`. */
export function jsonLdVideoUrl(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_JSONLD_DEPTH) return undefined; // fail-open on a pathologically deep nested array
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const u = jsonLdVideoUrl(v, depth + 1);
      if (u) return u;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of ['contentUrl', 'embedUrl', 'url']) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return undefined;
}

/** The playable video URL from a page's JSON-LD `"video"` (`VideoObject`), the way Instagram Reels
 *  / Pinterest video pins expose their clip when they ship no `og:video` — a user's "…OR a video".
 *  A config of {@link jsonLdField} (field `video`) + {@link jsonLdVideoUrl} normalize. */
export function jsonLdVideo(html: string): string | undefined {
  // A `video` property (Article/SocialMediaPosting) OR a top-level VideoObject (YouTube ships the
  // bare entity, no wrapper) — the type-safe node lookup avoids grabbing an ImageObject's contentUrl.
  return jsonLdVideoUrl(jsonLdField(html, 'video') ?? jsonLdNodeByType(html, 'VideoObject'));
}

/** Resolve a possibly-relative URL against `baseUrl`. Returns the input unchanged when it is
 *  already absolute or when no/invalid base is given (never throws). */
export function absolutize(url: string, baseUrl?: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
  if (!baseUrl) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/**
 * Extract a {@link LinkPreview} from a page's raw HTML. Ordered fallback per field so ANY
 * site yields the richest available card (Open Graph → Twitter Card → bare HTML):
 *   image:       og:image → twitter:image → twitter:image:src → <link rel="image_src"> → JSON-LD "image" → itemprop="image"
 *   video:       og:video:secure_url → og:video:url → og:video → twitter:player:stream → twitter:player → JSON-LD VideoObject
 *   title:       og:title → twitter:title → <title> → JSON-LD headline/name
 *   description: og:description → twitter:description → <meta name="description"> → JSON-LD description
 *   siteName:    og:site_name → twitter:site
 *   favicon:     <link rel="…icon…">
 * Relative image/favicon URLs are absolutized against `baseUrl` when provided. Every field is
 * optional — the card renders from whatever is present (fail-open, never fabricates). Pure,
 * deterministic, no I/O, never throws.
 */
export function parseOpenGraph(htmlRaw: string, baseUrl?: string): LinkPreview {
  if (!htmlRaw) return {};
  // Cap the attacker-controlled HTML before the ~30 full-document scans + JSON-LD parses (DoS guard);
  // page metadata lives in <head>, so this never drops a real OG/Twitter/JSON-LD tag.
  const html = htmlRaw.length > MAX_HTML ? htmlRaw.slice(0, MAX_HTML) : htmlRaw;
  const firstOf = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = metaContent(html, k);
      if (v) return v;
    }
    return undefined;
  };
  const rawImage =
    firstOf('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src') ??
    linkRelHref(html, 'image_src', baseUrl) ?? // classic <link rel="image_src"> (Pinterest/WordPress/FB-share)
    jsonLdImage(html) ?? // schema.org JSON-LD "image" (Instagram/Pinterest/news/recipe structured data)
    itempropUrl(html, 'image'); // schema.org microdata (recipe/news pages with no OG tags)
  const rawVideo =
    firstOf('og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream', 'twitter:player') ??
    jsonLdVideo(html); // schema.org JSON-LD VideoObject (Instagram Reels / Pinterest video pins)
  const preview: {
    title?: string;
    description?: string;
    image?: string;
    images?: string[];
    favicon?: string;
    video?: string;
    siteName?: string;
  } = {};
  const title =
    firstOf('og:title', 'twitter:title') ?? titleTag(html) ??
    jsonLdText(jsonLdField(html, 'headline') ?? jsonLdField(html, 'name')); // JSON-LD-only page (no OG/<title>)
  const description =
    firstOf('og:description', 'twitter:description', 'description') ??
    jsonLdText(jsonLdField(html, 'description')); // JSON-LD caption/summary when no meta description
  // safeAssetUrl AFTER absolutize: only a safe scheme (http(s) / data:image/* / relative) survives, so a
  // javascript:/vbscript:/data:text/html asset URL from hostile HTML is never stored in the preview.
  const image = safeAssetUrl(rawImage ? absolutize(rawImage, baseUrl) : undefined);
  const video = safeAssetUrl(rawVideo ? absolutize(rawVideo, baseUrl) : undefined);
  const siteName = firstOf('og:site_name', 'twitter:site');
  const favicon = safeAssetUrl(faviconHref(html, baseUrl));
  // The gallery (b196): every og:image, deduped + safe. Store only a GENUINE gallery (>1) — a single-image
  // link keeps just `image` (the hero), so nothing changes for the common case. `image` remains the hero.
  const images = parseOpenGraphImages(html, baseUrl);
  if (title) preview.title = title;
  if (description) preview.description = description;
  if (image) preview.image = image;
  if (images.length > 1) preview.images = images;
  if (video) preview.video = video;
  if (siteName) preview.siteName = siteName;
  if (favicon) preview.favicon = favicon;
  return preview;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ALL `<meta property/name="key">` content values (entity-decoded, trimmed), in document order. The multi
 *  sibling of `metaContent` (first-only) — a page can repeat a tag (e.g. several `og:image` for a carousel). */
export function metaContentAll(html: string, key: string): string[] {
  const k = escapeRegExp(key);
  const out: string[] = [];
  const patterns = [
    new RegExp(`<meta[^>]*\\b(?:property|name)\\s*=\\s*["']${k}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`, 'gi'),
    new RegExp(`<meta[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b(?:property|name)\\s*=\\s*["']${k}["']`, 'gi'),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const v = decodeHtmlEntities(m[1]).trim();
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * Extract the full image GALLERY from a page's HTML — every `og:image`/`og:image:url`/`twitter:image`/
 * `twitter:image:src` a page declares, absolutized against `baseUrl`, safety-filtered (same `safeAssetUrl` guard
 * as the single-image parse — no `javascript:`/`data:text/html`), and DEDUPED in first-seen order. A single-image
 * page yields `[preview.image]`; a Pinterest/IG multi-photo post yields the carousel. Pure, never throws (caps
 * the HTML like `parseOpenGraph`). The single-image `parseOpenGraph().image` is `parseOpenGraphImages()[0]`.
 */
export function parseOpenGraphImages(htmlRaw: string, baseUrl?: string): string[] {
  if (!htmlRaw) return [];
  const html = htmlRaw.length > MAX_HTML ? htmlRaw.slice(0, MAX_HTML) : htmlRaw;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) {
    for (const raw of metaContentAll(html, key)) {
      const url = safeAssetUrl(absolutize(raw, baseUrl));
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}
