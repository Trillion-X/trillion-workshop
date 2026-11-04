// packages/group/show/item-link.ts
//
// The board's item-hyperlink leaf — pure, zero I/O. A board item can carry a source
// URL as self-describing DATA on `extra.href` (the same blind `extra.*` family as
// crop / opacity / filter / rotation). This leaf is the read + normalize + display
// boundary: the panel writes a normalized href, the blind chip reads it and opens it.
// Adding "link" is one DATA prop — no item-kind branch, no engine change (L090).

/** A board item, viewed only for its presentation `extra` bag (we never name kinds). */
interface ItemLike {
  extra?: Record<string, unknown> | undefined;
}

/** Does the input already carry ANY URL scheme (`https:`, `ftp:`, `javascript:`, …)?
 *  If so we never prefix `https://` — we let the allowlist parse below judge it. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** The ONLY protocols an item link may use — an allowlist, not a blocklist. Anything
 *  else (`javascript:`, `data:`, `file:`, `vbscript:`, `blob:`, `ftp:`, …) is rejected,
 *  so a stored href can never become a script/exfiltration vector. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Normalize raw user input into a safe href, or `null` when it is not a safe URL.
 * - empty / whitespace → null (clears the link)
 * - already schemed (anything `xxx:`) → kept verbatim as the candidate
 * - a bare host (`example.com`, `foo.co/bar`) — a dot, no whitespace, no scheme →
 *   prefixed with `https://`
 * The candidate is then PARSED (`new URL`) and accepted ONLY if it parses AND its
 * protocol is in the safe allowlist — so `javascript:`, `data:`, `ftp://…`, malformed
 * `https://javascript:alert(1).com`, etc. all return null.
 */
export function normalizeHref(raw: string): string | null {
  const v = (raw ?? '').trim();
  if (v === '') return null;
  const candidate = HAS_SCHEME.test(v)
    ? v
    : !/\s/.test(v) && v.includes('.')
      ? `https://${v}`
      : v;
  try {
    const u = new URL(candidate);
    return SAFE_PROTOCOLS.has(u.protocol) ? candidate : null;
  } catch {
    return null;
  }
}

/** The item's stored href (a non-empty string), or undefined. Read guard — the value
 *  was normalized at write time, so reading is just presence + type. */
export function itemHref(item: ItemLike | undefined): string | undefined {
  const h = item?.extra?.href;
  return typeof h === 'string' && h.trim() !== '' ? h : undefined;
}

/**
 * A short, human label for the link chip — the host without `www.` for web URLs,
 * or the address itself for `mailto:`/`tel:` (and as a fallback when URL parsing
 * fails, e.g. in an environment without `URL`). Never throws.
 */
export function linkHost(href: string): string {
  const v = (href ?? '').trim();
  const lower = v.toLowerCase();
  if (lower.startsWith('mailto:')) return v.slice(7);
  if (lower.startsWith('tel:')) return v.slice(4);
  try {
    return new URL(v).host.replace(/^www\./, '');
  } catch {
    return v.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0];
  }
}
