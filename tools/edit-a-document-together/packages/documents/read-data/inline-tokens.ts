// packages/documents/read-data/inline-tokens.ts
//
// The INLINE-TOKEN primitive (L069/L090) — the pure, engine-free model behind inline reference CHIPS
// (@-mentions rendered as an icon+label pill, not plain text). The composition-engine stores a block
// as PLAIN TEXT, so a reference lives IN that text as ONE self-describing, machine-readable token; the
// host renders each token as a chip and serializes chips back to the token on read. This file owns the
// token syntax + the text↔runs split — ZERO DOM, ZERO React — so it is unit-testable in isolation and
// the risky contenteditable wiring only has to trust these two pure functions.
//
// A token is `⟦ref:<url-encoded-json>⟧` — the `⟦ ⟧` sentinels (U+27E6/27E7) never occur in normal
// typing, and encodeURIComponent guarantees the payload can't contain `⟧`, so parsing is unambiguous
// and lossless. The payload is `{k,v,l}` = kind, value, label — all DATA (the picker option), never a
// hardcoded reference vocabulary. A new reference kind is just a different `k`; this file never names
// "task" or "skill".

// `icon` is an OPTIONAL self-describing glyph the DATA (the picker option's source) carries so the chip
// renders the reference's own icon — a task glyph, a person glyph, a date glyph — NEVER a per-kind
// switch in code (L090). Absent → the host falls back to a neutral mention glyph. Old tokens with no
// icon are byte-identical (JSON.stringify drops undefined), so nothing existing changes.
export type Ref = { kind: string; value: string; label: string; icon?: string };
// `marks` on a text run = inline mark IDs parsed from the stored text's marker pairs (`**…**` etc.)
// against a DATA mark table (parseEmphasisRuns). The STORED text keeps the literal markers (lossless
// SSOT — the marks are a RENDER-TIME projection, exactly like ref chips); marks only ever appear on
// runs produced by the mark parser, so plain parseInlineRuns callers are untouched. Mark ids are
// OPEN strings — the vocabulary lives in the table rows, never in this type (enum-dissolution).
export type Run = { type: 'text'; text: string; marks?: readonly string[] } | ({ type: 'ref' } & Ref);

/** One DATA row of the inline-mark table (`kind:"inline-mark-set"` record). The row IS the
 *  vocabulary: which marker pair means what, and which element renders it. This module never
 *  names a marker or a tag — it compiles whatever rows the owner ships (L090). `legacy_tags`
 *  lets the DOM serializer recognize elements it didn't create (browser-native formatting,
 *  pre-table DOM) as this mark. */
export type InlineMark = {
  readonly id: string;
  readonly open_marker: string;
  readonly close_marker: string;
  readonly render_tag: string;
  readonly legacy_tags?: readonly string[];
};

const OPEN = '⟦ref:';
const CLOSE = '⟧';
// Global matcher for one token: `⟦ref:` then anything up to the next `⟧`.
const TOKEN_RE = /⟦ref:([^⟧]*)⟧/g;

/** Encode a reference as its lossless plain-text token (what gets stored in the block's text).
 *  `g` (icon glyph) is only written when the DATA supplied one — JSON.stringify drops `undefined`, so
 *  a reference with no icon encodes byte-for-byte as before. */
export function encodeRefToken(ref: Ref): string {
  return OPEN + encodeURIComponent(JSON.stringify({ k: ref.kind, v: ref.value, l: ref.label, g: ref.icon })) + CLOSE;
}

/** True if `text` contains at least one reference token — the fast-path guard: a block with none
 *  renders exactly as before (plain textContent), so existing content is untouched (zero risk). */
export function hasRefToken(text: string): boolean {
  return text.includes(OPEN);
}

/**
 * The "active token" at a caret — the maximal whitespace-delimited run of `text` that ENDS at `offset`
 * (the character index of the caret in the flattened block/composer text). This is what an inline input
 * shortcut keys on: matchInputShortcut('inline') needs the token the caret is sitting after, NOT the
 * trailing token of the whole value. Using the whole value breaks mid-text triggers — caret after `@ada`
 * in `write about @ada please` must yield `@ada`, not `please`. A ref-token chip (`⟦ref:…⟧`) contains no
 * spaces, so it stays one unit. `offset` out of range falls back to end-of-text (the old behaviour), so a
 * missing/unresolvable caret degrades safely to trailing-token. Pure — unit-testable, zero DOM.
 */
export function activeTokenAt(text: string, offset: number): string {
  const upto = offset >= 0 && offset <= text.length ? text.slice(0, offset) : text;
  return /(\S*)$/.exec(upto)?.[1] ?? '';
}

/**
 * Split a block's plain text into an ordered list of runs — text spans and reference tokens — for the
 * host to render (text as text, ref as a chip). A malformed token payload degrades to a literal text
 * run (fail-safe: a bad token shows its raw characters, never throws, never eats content).
 */
export function parseInlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) runs.push({ type: 'text', text: text.slice(last, m.index) });
    const ref = decodeRefPayload(m[1]);
    if (ref) runs.push({ type: 'ref', ...ref });
    else runs.push({ type: 'text', text: m[0] }); // malformed → keep raw
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ type: 'text', text: text.slice(last) });
  if (runs.length === 0) runs.push({ type: 'text', text: '' });
  return runs;
}

/** Recombine runs back into the stored plain text (chips → their token, marked runs → their
 *  table row's literal markers). Inverse of parseInlineRuns AND parseEmphasisRuns — lossless
 *  either way. A run whose mark id has no table row degrades to its bare text (fail-safe). */
export function runsToText(runs: readonly Run[], marks: readonly InlineMark[]): string {
  return runs
    .map((r) => {
      if (r.type !== 'text') return encodeRefToken(r);
      const mark = r.marks?.length ? marks.find((m) => m.id === r.marks![0]) : undefined;
      return mark ? `${mark.open_marker}${r.text}${mark.close_marker}` : r.text;
    })
    .join('');
}

// ---- Inline-mark matching (compiled from the DATA table, memoized per table identity) ----

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type CompiledMarks = { re: RegExp; ids: readonly string[] };
const MATCHER_CACHE = new WeakMap<readonly InlineMark[], CompiledMarks | null>();

/** Compile the mark table to ONE alternation regex, longest open marker first (so a 2-char
 *  marker wins over its 1-char prefix — pure length ordering, no marker is named). Each branch:
 *  open, then ≥1 content chars (no newline, never starting/ending with whitespace, never
 *  containing the close marker — the exact conservative shape models emit; a stray/unpaired
 *  marker stays literal, never eats characters), then close. Rows with an empty marker are
 *  skipped (they can never terminate). Null when the table yields no usable rows. */
function compileMarks(marks: readonly InlineMark[]): CompiledMarks | null {
  const cached = MATCHER_CACHE.get(marks);
  if (cached !== undefined) return cached;
  const usable = marks
    .filter((m) => m.id && m.open_marker && m.close_marker)
    .slice()
    .sort((a, b) => b.open_marker.length - a.open_marker.length);
  let compiled: CompiledMarks | null = null;
  if (usable.length > 0) {
    const branch = (m: InlineMark) => {
      const close = escapeRe(m.close_marker);
      // Content: no newline, no close-marker occurrence, hugging (no space at either edge).
      return `${escapeRe(m.open_marker)}(?!\\s)((?:(?!${close})[^\\n]){1,}?)(?<!\\s)${close}`;
    };
    try {
      compiled = { re: new RegExp(usable.map(branch).join('|'), 'g'), ids: usable.map((m) => m.id) };
    } catch {
      compiled = null; // hostile marker DATA that breaks regex compilation → no marks (fail-safe)
    }
  }
  MATCHER_CACHE.set(marks, compiled);
  return compiled;
}

/**
 * Split a block's text into runs INCLUDING inline marks: ref tokens → chip runs (exactly as
 * parseInlineRuns), then each text span is further split on the DATA table's marker pairs into
 * marked runs. The stored text is untouched — marks are a render projection; runsToText restores
 * the literal markers byte-for-byte. Text matching no marker (or an empty table) returns the
 * parseInlineRuns shape unchanged (the zero-cost fast path for the overwhelming majority of blocks).
 * Applied AFTER token parsing so a marker char inside a ref label can never split a chip.
 */
export function parseEmphasisRuns(text: string, marks: readonly InlineMark[]): Run[] {
  const compiled = compileMarks(marks);
  if (!compiled) return parseInlineRuns(text);
  const out: Run[] = [];
  for (const run of parseInlineRuns(text)) {
    if (run.type !== 'text' || !run.text) { out.push(run); continue; }
    let last = 0;
    compiled.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = compiled.re.exec(run.text)) !== null) {
      const g = m.slice(1).findIndex((v) => v !== undefined);
      if (g < 0) break; // defensive — a match always has exactly one filled group
      any = true;
      if (m.index > last) out.push({ type: 'text', text: run.text.slice(last, m.index) });
      out.push({ type: 'text', text: m[g + 1]!, marks: [compiled.ids[g]!] });
      last = m.index + m[0].length;
    }
    if (!any) { out.push(run); continue; }
    if (last < run.text.length) out.push({ type: 'text', text: run.text.slice(last) });
  }
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}

/** True if `text` carries at least one renderable mark span for this table — the fast-path guard
 *  mirror of hasRefToken: a block with neither tokens nor marks keeps the plain textContent path. */
export function hasEmphasisMarker(text: string, marks: readonly InlineMark[]): boolean {
  const compiled = compileMarks(marks);
  if (!compiled) return false;
  compiled.re.lastIndex = 0;
  return compiled.re.test(text);
}

/**
 * Insert a reference token into a block/composer's text, replacing the `@query` the picker opened on.
 * The ONE splice primitive both insertion paths configure (L069): the composer supplies the caret
 * `range` it captured at @-detection (→ a precise mid-text splice: "summarize @ada| for me" replaces
 * exactly `@ada`), and the block supplies none (→ the trailing-`@` fallback). A stale/out-of-bounds
 * range also degrades to the trailing fallback, and an empty base yields just the token — so the caller
 * never has to special-case emptiness. A trailing space follows the token so the caret lands past the
 * chip ready to keep typing. Pure — zero DOM, unit-testable; the two call sites now share ONE tested
 * operation instead of each inlining its own `slice`/`replace`.
 */
export function insertRefTokenIntoText(
  baseText: string,
  refToken: string,
  range?: { start: number; end: number },
): string {
  if (baseText === '') return `${refToken} `;
  if (range && range.start >= 0 && range.end <= baseText.length && range.start <= range.end) {
    const after = baseText.slice(range.end);
    // A single space follows the chip so the caret lands past it ready to type — but NOT a second one
    // when the remaining text already begins with whitespace (that would leave "chip  rest"); at
    // end-of-text (after === '') we still add the space.
    const sep = after.startsWith(' ') ? '' : ' ';
    return `${baseText.slice(0, range.start)}${refToken}${sep}${after}`;
  }
  return baseText.replace(/@[^\s@]*$/, `${refToken} `);
}

function decodeRefPayload(encoded: string): Ref | null {
  try {
    const obj = JSON.parse(decodeURIComponent(encoded)) as { k?: unknown; v?: unknown; l?: unknown; g?: unknown };
    if (typeof obj?.k === 'string' && typeof obj?.v === 'string' && typeof obj?.l === 'string') {
      const ref: Ref = { kind: obj.k, value: obj.v, label: obj.l };
      if (typeof obj.g === 'string' && obj.g) ref.icon = obj.g;
      return ref;
    }
  } catch {
    /* fall through — malformed */
  }
  return null;
}
