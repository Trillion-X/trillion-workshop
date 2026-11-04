// packages/group/read-data/text-replace.ts
//
// Find-and-replace across board notes — a pure, zero-I/O leaf. The board already has free-text FIND
// (highlight/filter via boardFocusMatch); this is its missing twin: bulk text REPLACE ("rename every
// 'v1' to 'v2' on my board"). ONE generative primitive — a text transform over matching items —
// configured by DATA (find/replace + case/whole-word/regex/scope flags), yielding several emergent
// modes from the same engine: plain replace, case-insensitive, whole-word-only, regex, count-only,
// and selection-scoped (L069). Blind to what an item IS — it only reads `text` (L090). Fail-closed:
// an empty find, an invalid regex, or a no-op replacement (X→X) produces ZERO patches, never throws.

/** An item as far as text-replace cares: an id and its (optional) text. Any board item projects to
 *  this; items without a string `text` are skipped (connectors, media, furniture never match). */
export interface TextItem {
  readonly memberId: string;
  readonly text?: string;
}

export interface TextReplaceOptions {
  readonly find: string;
  readonly replaceWith: string;
  readonly caseSensitive?: boolean; // default false
  readonly wholeWord?: boolean; // default false — match only whole words (\bfind\b)
  readonly regex?: boolean; // default false — treat `find` as a RegExp source
  readonly scopeIds?: readonly string[]; // limit to these member ids (selection-scoped replace)
}

/** One changed item: its id, the FULL replaced text, and how many occurrences changed. */
export interface TextReplacePatch {
  readonly memberId: string;
  readonly text: string;
  readonly count: number;
}

export interface TextReplaceResult {
  readonly patches: TextReplacePatch[];
  readonly matchCount: number; // total occurrences replaced across all items
  readonly itemCount: number; // number of items that changed
}

/** Escape a literal string so it matches verbatim inside a RegExp (used when `regex` is off). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the matching RegExp from the options, or null when nothing can match (empty find, or an
 * invalid regex source). The ONE place the match semantics live (SSOT): literal-vs-regex,
 * whole-word boundaries, and case-sensitivity are all folded here so `replaceInItems` /
 * `countInItems` can never disagree on what "matches". Always global (`g`) so every occurrence is
 * found. Fail-closed: a malformed regex returns null (a no-op), never a thrown error.
 */
export function buildMatcher(opts: TextReplaceOptions): RegExp | null {
  if (typeof opts.find !== 'string' || opts.find === '') return null;
  let pattern = opts.regex ? opts.find : escapeRegex(opts.find);
  if (opts.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  const flags = `g${opts.caseSensitive ? '' : 'i'}`;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * The replacement string prepared for `String.prototype.replace`. In LITERAL mode (regex off) the
 * user's replacement must be inserted VERBATIM, so a `$` is escaped to `$$` — otherwise `$&`, `$1`,
 * `` $` ``, and `$'` are interpreted as match/group tokens and silently corrupt the output (replacing
 * "cat" with "R$5" would emit "R", not "R$5"). In REGEX mode those tokens are a deliberate feature
 * (backreferences), so the replacement is passed through untouched. This is the SSOT for replacement
 * semantics — both the plain-text and the HTML-text-node replace paths call it, so they can never
 * disagree on how a `$` is treated (mirrors `buildMatcher` as the SSOT for MATCH semantics).
 */
export function replacementFor(opts: Pick<TextReplaceOptions, 'replaceWith' | 'regex'>): string {
  const raw = typeof opts.replaceWith === 'string' ? opts.replaceWith : '';
  // In `.replace()` the pattern '$$$$' emits two literal '$', so each user '$' becomes '$$'.
  return opts.regex ? raw : raw.replace(/\$/g, '$$$$');
}

/** Count occurrences of `find` in one string under the given matcher (global, zero-width safe). */
function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  const found = text.match(re);
  return found ? found.length : 0;
}

/** Replace every match in ONE string with a PREBUILT matcher — the atom both the plain-text item
 *  replace and the HTML-text-node replace share (SSOT: identical match semantics in both). Returns
 *  the new value + how many occurrences changed (0 → value is the original, unchanged). */
export function replaceString(text: string, re: RegExp, replaceWith: string): { value: string; count: number } {
  const count = countMatches(text, re);
  if (count === 0) return { value: text, count: 0 };
  re.lastIndex = 0;
  return { value: text.replace(re, replaceWith), count };
}

/**
 * Replace every occurrence of `find` with `replaceWith` in the `text` of every matching item.
 * Returns one {@link TextReplacePatch} per CHANGED item (unchanged items — no match, or X→X — are
 * omitted), plus the total `matchCount` + `itemCount`. Pure: computes the new text, applies nothing.
 * Items with no string text, or outside `scopeIds` when given, are skipped. Deterministic (input
 * order preserved). Fail-closed: no matcher (empty/invalid find) → empty result.
 */
export function replaceInItems(items: readonly TextItem[], opts: TextReplaceOptions): TextReplaceResult {
  const re = buildMatcher(opts);
  if (!re) return { patches: [], matchCount: 0, itemCount: 0 };
  const scope = Array.isArray(opts.scopeIds) ? new Set(opts.scopeIds) : null;
  const replaceWith = replacementFor(opts);

  const patches: TextReplacePatch[] = [];
  let matchCount = 0;
  for (const it of items) {
    if (scope && !scope.has(it.memberId)) continue;
    if (typeof it.text !== 'string' || it.text === '') continue;
    const { value: next, count } = replaceString(it.text, re, replaceWith);
    if (count === 0 || next === it.text) continue; // no match, or a no-op (X→X) — not a change
    patches.push({ memberId: it.memberId, text: next, count });
    matchCount += count;
  }
  return { patches, matchCount, itemCount: patches.length };
}

/**
 * Count total occurrences of `find` across the (optionally scoped) items WITHOUT changing anything —
 * the "N matches" readout the find UI shows before the user commits a replace. Same matcher SSOT as
 * {@link replaceInItems}, so the previewed count is exactly what a replace would change.
 */
export function countInItems(items: readonly TextItem[], opts: Pick<TextReplaceOptions, 'find' | 'caseSensitive' | 'wholeWord' | 'regex' | 'scopeIds'>): number {
  const re = buildMatcher({ ...opts, replaceWith: '' });
  if (!re) return 0;
  const scope = Array.isArray(opts.scopeIds) ? new Set(opts.scopeIds) : null;
  let total = 0;
  for (const it of items) {
    if (scope && !scope.has(it.memberId)) continue;
    if (typeof it.text !== 'string' || it.text === '') continue;
    total += countMatches(it.text, re);
  }
  return total;
}
