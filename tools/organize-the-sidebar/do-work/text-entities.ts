// packages/group/do-work/text-entities.ts
//
// INLINE TEXT ENTITY DETECTION — the generative primitive behind "turn what a note SAYS into things you can
// act on". `detectEntities` is a BLIND tokenizer: it scans plain text and returns typed, NON-OVERLAPPING
// spans, but it NEVER names an entity kind — it iterates an INJECTED pattern map (`TEXT_ENTITY_PATTERNS`), so
// URL / email / hashtag / mention / phone are DATA rows (each a regex + kind + optional href builder) and a
// NEW entity type is ONE row with ZERO tokenizer change (enum-dissolution / L090). ONE seam yields many
// emergent features — clickable links in a note, auto-extracted #tags, @mention chips, tel:/mailto: — each a
// configuration of the same detector. Pure leaf: zero I/O, zero DOM, deterministic (no Date/random).
//
// Overlap resolution (the adversarial case — a URL that CONTAINS an @ or a #frag): all patterns run, then
// candidates are ranked by (earliest start, then longest) and accepted greedily left-to-right, so the URL
// starting first swallows the fragment and the inner #frag/@user candidate is dropped. Deterministic and
// pattern-order-independent — position decides, never which row was registered first.

export interface TextEntity {
  readonly start: number; // inclusive index into the source text
  readonly end: number; // exclusive
  readonly kind: string; // the pattern's kind (data-supplied — the tokenizer never enumerates these)
  readonly value: string; // text.slice(start, end)
}

export interface EntityPattern {
  readonly kind: string;
  /** Finds matches. Re-created with the global flag per scan so `lastIndex` state never leaks between calls. */
  readonly regex: RegExp;
  /** The href/action target for a matched value — null = no navigable target (e.g. a #tag is a board action,
   *  not a URL). A display linkifier wraps ONLY entities whose href is non-null; extractors read every kind. */
  readonly href?: (value: string) => string | null;
}

/** The built-in inline entity vocabulary — DATA, not code branches. Order is irrelevant to detection
 *  (position resolves overlaps); it only affects which candidate wins a same-start, same-length tie. */
export const TEXT_ENTITY_PATTERNS: readonly EntityPattern[] = [
  // http(s):// OR a bare www.… , ending on a non-punctuation char (so a trailing . , ) ! ? is left OUT of the
  // link). ONE pattern per kind (so entityHref is unambiguous): the href prefixes https:// only for bare www.
  { kind: 'url', regex: /(?:https?:\/\/|www\.)[^\s<]*[^\s<.,!?;:'")\]}]/gi, href: (v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`) },
  { kind: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, href: (v) => `mailto:${v}` },
  // #tag / @mention start with a LETTER (so #123 / @1 aren't caught) → board actions, no href.
  { kind: 'hashtag', regex: /#[A-Za-z][\w-]*/g, href: () => null },
  { kind: 'mention', regex: /@[A-Za-z][\w.-]*/g, href: () => null },
  // Phone: conservative — requires a + country code OR a (area) code, so plain number/date runs aren't links.
  { kind: 'phone', regex: /(?:\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{0,4}|\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4})/g, href: (v) => `tel:${v.replace(/[\s().-]/g, '')}` },
];

/** Every match of one pattern in `text`, guarding against a zero-width match looping forever. */
function matchesOf(text: string, pattern: EntityPattern): TextEntity[] {
  const re = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`);
  const out: TextEntity[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // zero-width match → advance or exec would spin in place forever
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length, kind: pattern.kind, value: m[0] });
  }
  return out;
}

/**
 * The typed, non-overlapping entities in `text`, left-to-right. Runs every pattern, then accepts the
 * earliest-starting (ties → longest) candidate and skips anything that overlaps an accepted span — so a URL
 * that contains an @ or #frag yields ONLY the URL. Empty text or no patterns → [].
 */
export function detectEntities(text: string, patterns: readonly EntityPattern[] = TEXT_ENTITY_PATTERNS): TextEntity[] {
  if (!text) return [];
  const candidates: TextEntity[] = [];
  for (const p of patterns) candidates.push(...matchesOf(text, p));
  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const accepted: TextEntity[] = [];
  let lastEnd = 0;
  for (const c of candidates) {
    if (c.start < lastEnd) continue; // overlaps an already-accepted span → drop
    accepted.push(c);
    lastEnd = c.end;
  }
  return accepted;
}

/** The navigable target for a detected entity (via its pattern's href builder), or null when it has none
 *  (a #tag/@mention) or its kind isn't in `patterns`. */
export function entityHref(entity: TextEntity, patterns: readonly EntityPattern[] = TEXT_ENTITY_PATTERNS): string | null {
  const pattern = patterns.find((p) => p.kind === entity.kind);
  return pattern?.href ? pattern.href(entity.value) : null;
}

/** All detected values of one kind (e.g. every #tag or @mention in a note) — the extractor emergent use. */
export function entitiesOfKind(text: string, kind: string, patterns: readonly EntityPattern[] = TEXT_ENTITY_PATTERNS): string[] {
  return detectEntities(text, patterns).filter((e) => e.kind === kind).map((e) => e.value);
}
