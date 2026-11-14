// package-set://bitfield-studio/packages/customer-support/show/humanize.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The view-layer translation boundary (L098): turn raw machine refs/roles/keys
// into human words for display. ZERO domain vocabulary lives here — it is a
// pure, generic string transform that works for ANY record-work surface
// (support, relationships, bookings, anything). The blind renderers call these
// helpers so internal refs (`package::tickets::record::t-1`,
// `process-session::reply-1`) never leak into product copy (L117/L118).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No package/runtime vocabulary, no support vocabulary — generic only.
// 2. Pure functions — same input always yields the same output.
// 3. Empty/garbage in → empty string out, never throws.
//
// =============================================================================

/** Split a ref on the common separators (`::`, `.`, `/`) into clean segments. */
function segments(raw: string): string[] {
  return raw.split(/::|[./]/).map((part) => part.trim()).filter(Boolean);
}

/** Sentence-case a single token, de-hyphenating and collapsing whitespace. */
function sentenceCase(token: string): string {
  const spaced = token.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (spaced.length === 0) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Human label for an opaque ref. Takes the most specific (last) segment so
 * `package::tickets::record::t-1` → `T 1` and `reply-composer` →
 * `Reply composer`. A bare role like `requester` → `Requester`.
 */
export function humanizeToken(raw: string | undefined | null): string {
  if (!raw) return '';
  const parts = segments(raw);
  const tail = parts.length > 0 ? parts[parts.length - 1] : raw;
  return sentenceCase(tail);
}

/**
 * Human label for the ORIGIN of a ref — the owning namespace rather than the
 * leaf. `package::tickets::record::t-1` → `Tickets`. Falls back to the leaf
 * when there is only one segment.
 */
export function humanizeOrigin(raw: string | undefined | null): string {
  if (!raw) return '';
  const parts = segments(raw);
  if (parts.length <= 1) return sentenceCase(raw);
  // Skip a leading STRUCTURAL ref-grammar prefix ("package", "slot") — these are
  // part of the addressing scaffolding, not a meaningful origin. Specific package
  // identities (tickets, calendar, crm, …) are DATA and must never be enumerated
  // here (invariant #1, L098): the real namespace IS the honest origin.
  const structuralPrefix = new Set(['package', 'slot']);
  const meaningful = parts.find((part) => !structuralPrefix.has(part.toLowerCase())) ?? parts[0];
  return sentenceCase(meaningful);
}
