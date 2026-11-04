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
export type Ref = { kind: string; value: string; label: string; icon?: string; destination?: string };
// `marks` on a text run = inline mark IDs parsed from the stored text's marker pairs (`**…**` etc.)
// against a DATA mark table (parseEmphasisRuns). The STORED text keeps the literal markers (lossless
// SSOT — the marks are a RENDER-TIME projection, exactly like ref chips); marks only ever appear on
// runs produced by the mark parser, so plain parseInlineRuns callers are untouched. Mark ids are
// OPEN strings — the vocabulary lives in the table rows, never in this type (enum-dissolution).
export type InlineSceneStyle = Readonly<Record<string, string | number | boolean>>;
export type Run = { type: 'text'; text: string; marks?: readonly string[]; style?: InlineSceneStyle; link?: string } | ({ type: 'ref' } & Ref & { marks?: readonly string[]; style?: InlineSceneStyle; link?: string });

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
  /** Safe, DATA-authored scene-style record, shared with block and composition styling. */
  readonly style?: InlineSceneStyle;
};

const OPEN = '⟦ref:';
const CLOSE = '⟧';
// Global matcher for one token: `⟦ref:` then anything up to the next `⟧`.
const TOKEN_RE = /⟦ref:([^⟧]*)⟧/g;
const STYLE_OPEN = '⟦style:';
const STYLE_CLOSE = '⟦/style⟧';
const LINK_OPEN = '⟦link:';
const LINK_CLOSE = '⟦/link⟧';
const BOOLEAN_STYLE_KEYS = new Set(['text_underline', 'text_strike']);

/** Only explicit web links can become clickable editor content. */
export function safeInlineLinkUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Lossless text token opener for a URL-backed inline link. */
export function encodeInlineLinkOpen(value: unknown): string | null {
  const url = safeInlineLinkUrl(value);
  return url ? `${LINK_OPEN}${encodeURIComponent(url)}⟧` : null;
}

function decodeInlineLinkOpen(token: string): string | null {
  if (!token.startsWith(LINK_OPEN) || !token.endsWith('⟧')) return null;
  try { return safeInlineLinkUrl(decodeURIComponent(token.slice(LINK_OPEN.length, -1))); }
  catch { return null; }
}

function safeStyle(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^(?:[a-z][a-z0-9_-]*|--[a-z0-9_-]+)$/.test(key)) continue;
    if (BOOLEAN_STYLE_KEYS.has(key)) {
      if (typeof raw === 'boolean') result[key] = raw;
      continue;
    }
    if (typeof raw === 'number') {
      if (Number.isFinite(raw)) result[key] = raw;
      continue;
    }
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 256) continue;
    if (/[{};\u0000-\u001f]/.test(raw) || /url\s*\(|expression\s*\(/i.test(raw)) continue;
    result[key] = raw;
  }
  return result;
}
export function sanitizeInlineStyle(value: unknown): Record<string, string | number | boolean> { return safeStyle(value); }

function styleToken(style: InlineSceneStyle): string {
  return `${STYLE_OPEN}${encodeURIComponent(JSON.stringify(safeStyle(style)))}⟧`;
}

/** Encode a reference as its lossless plain-text token (what gets stored in the block's text).
 *  `g` (icon glyph) is only written when the DATA supplied one — JSON.stringify drops `undefined`, so
 *  a reference with no icon encodes byte-for-byte as before. */
export function encodeRefToken(ref: Ref): string {
  return OPEN + encodeURIComponent(JSON.stringify({ k: ref.kind, v: ref.value, l: ref.label, g: ref.icon, d: ref.destination })) + CLOSE;
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
  let out = '';
  let active: string[] = [];
  let activeStyle = '';
  let activeLink = '';
  for (const run of runs) {
    const wantedLink = safeInlineLinkUrl(run.link) ?? '';
    if (activeLink !== wantedLink) {
      for (let index = active.length - 1; index >= 0; index--) {
        const mark = marks.find(row => row.id === active[index]);
        if (mark) out += mark.close_marker;
      }
      active = [];
      if (activeStyle) out += STYLE_CLOSE;
      activeStyle = '';
      if (activeLink) out += LINK_CLOSE;
      if (wantedLink) out += encodeInlineLinkOpen(wantedLink) ?? '';
      activeLink = wantedLink;
    }
    const nextStyle = Object.keys(run.style ?? {}).length ? JSON.stringify(safeStyle(run.style)) : '';
    if (activeStyle !== nextStyle) {
      for (let index = active.length - 1; index >= 0; index--) {
        const mark = marks.find(row => row.id === active[index]);
        if (mark) out += mark.close_marker;
      }
      active = [];
      if (activeStyle) out += STYLE_CLOSE;
      if (nextStyle) out += styleToken(JSON.parse(nextStyle) as InlineSceneStyle);
      activeStyle = nextStyle;
    }
    const wanted = [...(run.marks ?? [])];
    let common = 0;
    while (common < active.length && common < wanted.length && active[common] === wanted[common]) common++;
    for (let index = active.length - 1; index >= common; index--) {
      const mark = marks.find(row => row.id === active[index]);
      if (mark) out += mark.close_marker;
    }
    for (let index = common; index < wanted.length; index++) {
      const mark = marks.find(row => row.id === wanted[index]);
      if (mark) out += mark.open_marker;
    }
    active = wanted;
    out += run.type === 'text' ? run.text : encodeRefToken(run);
  }
  for (let index = active.length - 1; index >= 0; index--) {
    const mark = marks.find(row => row.id === active[index]);
    if (mark) out += mark.close_marker;
  }
  if (activeStyle) out += STYLE_CLOSE;
  if (activeLink) out += LINK_CLOSE;
  return out;
}

/** Apply or remove one DATA mark around a selected stored-text range. Selection offsets
 * are measured in the lossless serialized text, so the returned range still surrounds
 * the same content after marker bytes are inserted or removed. */
export function applyInlineMarkToText(
  text: string,
  start: number,
  end: number,
  markId: string,
  marks: readonly InlineMark[],
): { text: string; selectionStart: number; selectionEnd: number } {
  const mark = marks.find(row => row.id === markId);
  const from = Math.max(0, Math.min(text.length, Math.min(start, end)));
  const to = Math.max(from, Math.min(text.length, Math.max(start, end)));
  if (!mark || from === to) return { text, selectionStart: from, selectionEnd: to };
  const selected = text.slice(from, to);
  const beforeHasMark = text.slice(Math.max(0, from - mark.open_marker.length), from) === mark.open_marker;
  const afterHasMark = text.slice(to, to + mark.close_marker.length) === mark.close_marker;
  if (beforeHasMark && afterHasMark) {
    const before = text.slice(0, from - mark.open_marker.length);
    const after = text.slice(to + mark.close_marker.length);
    return { text: before + selected + after, selectionStart: from - mark.open_marker.length, selectionEnd: to - mark.open_marker.length };
  }
  const next = `${text.slice(0, from)}${mark.open_marker}${selected}${mark.close_marker}${text.slice(to)}`;
  return { text: next, selectionStart: from + mark.open_marker.length, selectionEnd: to + mark.open_marker.length };
}

/** Apply a generic descriptor-derived style patch to visible selection units. Text is
 * counted in UTF-16 units; each reference token is one atomic visible unit. The existing
 * style record is merged with the transform result so independent properties compose. */
export function applyInlineStyleToText(
  text: string,
  start: number,
  end: number,
  transformStyle: (style: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
  marks: readonly InlineMark[],
  baseStyle: Readonly<Record<string, unknown>> = {},
): string {
  const runs = parseEmphasisRuns(text, marks);
  const total = runs.reduce((sum, run) => sum + (run.type === 'ref' ? 1 : run.text.length), 0);
  const from = Math.max(0, Math.min(total, Math.min(start, end)));
  const to = Math.max(from, Math.min(total, Math.max(start, end)));
  if (from === to) return text;
  let offset = 0;
  const updated: Run[] = [];
  for (const run of runs) {
    const length = run.type === 'ref' ? 1 : run.text.length;
    const lo = Math.max(0, from - offset);
    const hi = Math.min(length, to - offset);
    if (lo >= hi) { updated.push(run); offset += length; continue; }
    const apply = (piece: Run) => {
      const priorOverride = safeStyle(piece.style);
      const markStyle = Object.assign({}, ...((piece.marks ?? []).map(id => safeStyle(marks.find(row => row.id === id)?.style))));
      const effective = { ...safeStyle(baseStyle), ...markStyle, ...priorOverride };
      const changed = safeStyle(transformStyle(effective));
      const replacedKeys = new Set([
        ...Object.keys(effective).filter(key => !(key in changed)),
        ...Object.keys(changed).filter(key => key in markStyle && changed[key] !== markStyle[key]),
      ]);
      let retainedMarks = [...(piece.marks ?? [])];
      if (replacedKeys.size) retainedMarks = retainedMarks.filter(id => {
        const style = safeStyle(marks.find(row => row.id === id)?.style);
        return ![...replacedKeys].some(key => key in style);
      });
      updated.push({ ...piece, ...(retainedMarks.length ? { marks: retainedMarks } : { marks: undefined }), ...(Object.keys(changed).length ? { style: changed } : { style: undefined }) });
    };
    if (run.type === 'ref') apply(run);
    else {
      if (lo > 0) updated.push({ ...run, text: run.text.slice(0, lo) });
      apply({ ...run, text: run.text.slice(lo, hi) });
      if (hi < run.text.length) updated.push({ ...run, text: run.text.slice(hi) });
    }
    offset += length;
  }
  return runsToText(updated, marks);
}

/** Apply or remove one safe URL on a selected visible text range. Reference chips
 * are atomic, like they are for caret and selection accounting. */
export function applyInlineLinkToText(
  text: string,
  start: number,
  end: number,
  href: string | null,
  marks: readonly InlineMark[],
): string {
  const normalizedHref = href === null ? null : safeInlineLinkUrl(href);
  if (href !== null && !normalizedHref) return text;
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(from, Math.max(start, end));
  if (from === to) return text;
  let offset = 0;
  const updated: Run[] = [];
  for (const run of parseEmphasisRuns(text, marks)) {
    const length = run.type === 'ref' ? 1 : run.text.length;
    const lo = Math.max(0, from - offset);
    const hi = Math.min(length, to - offset);
    if (lo >= hi) {
      updated.push(run);
    } else if (run.type === 'ref') {
      updated.push({ ...run, ...(normalizedHref ? { link: normalizedHref } : { link: undefined }) });
    } else {
      if (lo > 0) updated.push({ ...run, text: run.text.slice(0, lo) });
      updated.push({ ...run, text: run.text.slice(lo, hi), ...(normalizedHref ? { link: normalizedHref } : { link: undefined }) });
      if (hi < run.text.length) updated.push({ ...run, text: run.text.slice(hi) });
    }
    offset += length;
  }
  return runsToText(updated, marks);
}

/** Return the common URL only when every visible unit in the selection shares it. */
export function selectedInlineLink(text: string, start: number, end: number, marks: readonly InlineMark[]): string | null {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(from, Math.max(start, end));
  if (from === to) return null;
  let offset = 0;
  let selectedHref: string | null = null;
  for (const run of parseEmphasisRuns(text, marks)) {
    const length = run.type === 'ref' ? 1 : run.text.length;
    if (Math.max(from, offset) < Math.min(to, offset + length)) {
      const href = safeInlineLinkUrl(run.link);
      if (!href || (selectedHref !== null && selectedHref !== href)) return null;
      selectedHref = href;
    }
    offset += length;
  }
  return selectedHref;
}

/** Effective selection style common to every selected text/reference unit. */
export function selectedInlineStyle(
  text: string,
  start: number,
  end: number,
  marks: readonly InlineMark[],
  baseStyle: Readonly<Record<string, unknown>> = {},
): Record<string, string | number | boolean> {
  const runs = parseEmphasisRuns(text, marks);
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(from, Math.max(start, end));
  let position = 0;
  let common: Record<string, string | number | boolean> | null = null;
  for (const run of runs) {
    const length = run.type === 'ref' ? 1 : run.text.length;
    if (Math.max(from, position) < Math.min(to, position + length)) {
      const inherited = Object.assign({}, ...((run.marks ?? []).map(id => safeStyle(marks.find(row => row.id === id)?.style))));
      const effective = { ...safeStyle(baseStyle), ...inherited, ...safeStyle(run.style) };
      if (common === null) common = effective;
      else for (const key of Object.keys(common)) if (common[key] !== effective[key]) delete common[key];
    }
    position += length;
  }
  return common ?? safeStyle(baseStyle);
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
  const usable = marks.filter(mark => mark.id && mark.open_marker && mark.close_marker)
    .slice().sort((a, b) => b.open_marker.length - a.open_marker.length);
  const out: Run[] = [];
  const stack: Array<{ mark: InlineMark; hasContent: boolean }> = [];
  const styles: Record<string, string | number | boolean>[] = [];
  let buffer = '';
  const active = () => stack.map(frame => frame.mark.id);
  const currentStyle = () => Object.assign({}, ...styles);
  let activeLink = '';
  const hasStyle = () => styles.length > 0;
  const flush = () => {
    if (!buffer) return;
    const marks = active();
    const style = currentStyle();
    const prior = out[out.length - 1];
    if (prior?.type === 'text' && JSON.stringify(prior.marks ?? []) === JSON.stringify(marks)
        && JSON.stringify(prior.style ?? {}) === JSON.stringify(style)
        && (prior.link ?? '') === activeLink) prior.text += buffer;
    else out.push({ type: 'text', text: buffer, ...(marks.length ? { marks } : {}), ...(Object.keys(style).length ? { style } : {}), ...(activeLink ? { link: activeLink } : {}) });
    buffer = '';
  };
  const hasCloserAhead = (mark: InlineMark, from: number) => {
    const end = text.indexOf('\n', from);
    const close = text.indexOf(mark.close_marker, from);
    return close >= 0 && (end < 0 || close < end);
  };
  const markAt = (at: number, field: 'open_marker' | 'close_marker') => usable.find(mark => text.startsWith(mark[field], at));
  for (let index = 0; index < text.length;) {
    if (activeLink && text.startsWith(LINK_CLOSE, index)) {
      flush();
      activeLink = '';
      index += LINK_CLOSE.length;
      continue;
    }
    if (!activeLink && text.startsWith(LINK_OPEN, index)) {
      const end = text.indexOf('⟧', index + LINK_OPEN.length);
      const href = end >= 0 ? decodeInlineLinkOpen(text.slice(index, end + 1)) : null;
      if (href) {
        flush();
        activeLink = href;
        index = end + 1;
        continue;
      }
    }
    if (text.startsWith(STYLE_CLOSE, index) && styles.length) {
      flush();
      styles.pop();
      index += STYLE_CLOSE.length;
      continue;
    }
    if (text.startsWith(STYLE_OPEN, index)) {
      const end = text.indexOf('⟧', index + STYLE_OPEN.length);
      const closing = end >= 0 ? text.indexOf(STYLE_CLOSE, end + 1) : -1;
      if (end >= 0 && closing >= 0) {
        try {
          const style = safeStyle(JSON.parse(decodeURIComponent(text.slice(index + STYLE_OPEN.length, end))));
          if (Object.keys(style).length) {
            flush();
            styles.push(style);
            index = end + 1;
            continue;
          }
        } catch { /* invalid style token remains literal text */ }
      }
    }
    const token = /^⟦ref:([^⟧]*)⟧/.exec(text.slice(index));
    if (token) {
      const reference = decodeRefPayload(token[1]);
      if (reference) {
        flush();
        const effectiveStyle = currentStyle();
        out.push({ type: 'ref', ...reference, ...(stack.length ? { marks: active() } : {}), ...(Object.keys(effectiveStyle).length ? { style: effectiveStyle } : {}), ...(activeLink ? { link: activeLink } : {}) });
        for (const frame of stack) frame.hasContent = true;
        index += token[0].length;
        continue;
      }
    }
    const top = stack[stack.length - 1];
    const closing = top && text.startsWith(top.mark.close_marker, index) ? top.mark : undefined;
    if (closing && top.hasContent && !/\s/.test(text[index - 1] ?? '')) {
      flush();
      stack.pop();
      index += closing.close_marker.length;
      continue;
    }
    const opening = markAt(index, 'open_marker');
    if (opening && hasCloserAhead(opening, index + opening.open_marker.length)
        && !/\s/.test(text[index + opening.open_marker.length] ?? '')) {
      flush();
      stack.push({ mark: opening, hasContent: false });
      index += opening.open_marker.length;
      continue;
    }
    const char = text[index++];
    buffer += char;
    if (!/\s/.test(char)) for (const frame of stack) frame.hasContent = true;
  }
  flush();
  if (stack.length || styles.length || activeLink) return parseInlineRuns(text);
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}

/** True if `text` carries at least one renderable mark span for this table — the fast-path guard
 *  mirror of hasRefToken: a block with neither tokens nor marks keeps the plain textContent path. */
export function hasEmphasisMarker(text: string, marks: readonly InlineMark[]): boolean {
  if (text.includes(STYLE_OPEN)) return true;
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
    const obj = JSON.parse(decodeURIComponent(encoded)) as { k?: unknown; v?: unknown; l?: unknown; g?: unknown; d?: unknown };
    if (typeof obj?.k === 'string' && typeof obj?.v === 'string' && typeof obj?.l === 'string') {
      const ref: Ref = { kind: obj.k, value: obj.v, label: obj.l };
      if (typeof obj.g === 'string' && obj.g) ref.icon = obj.g;
      if (typeof obj.d === 'string' && obj.d) ref.destination = obj.d;
      return ref;
    }
  } catch {
    /* fall through — malformed */
  }
  return null;
}
