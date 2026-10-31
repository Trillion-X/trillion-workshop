// tools/check-copy/do-work/read-words.mjs
//
// Purpose
//   Turns what a site or a deck publishes into units of words, so one check judges them all. A unit is
//   { kind, text, where, facts }. Pure functions over values the caller hands in (parsed JSON, HTML text, a deck's HTML):
//   this file reads no file, calls nothing and knows no product, person, word list or page.
//
// Non-negotiable invariants
//   1. Which strings are prose is decided by what a string is (not an address, id, date, colour, file name or one lower-case
//      token), never by a list of keys; the keys that are authoring metadata are the caller's `skip_keys`.
//   2. A source that yields no words is an error the caller sees (`wordsOfDeck` throws); nothing here turns "no words found"
//      into a pass.
//   3. One unit per distinct (kind, text), carrying every place it was found, so a line used on ten pages is judged once.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const NOT_PROSE = [
  /^(?:\/|#|https?:|mailto:|tel:|data:)/,
  /^[\w.:-]+$/,
  /^\d{4}-\d{2}-\d{2}(?:T[\d:.+Z-]+)?$/,
  /^#?[0-9a-f]{3,8}$/i,
  /^[^\s]+\.(?:png|jpe?g|webp|svg|gif|mp4|webm|css|js|json)$/i,
];

/** Whether a string is words a person reads. */
export const isProse = value => typeof value === 'string' && value.trim().length > 0 && !NOT_PROSE.some(rx => rx.test(value.trim()))
  && (/\s/.test(value.trim()) || /^[A-Z]/.test(value.trim()));

/** Every prose string in any JSON value, with its dot path; `skip_keys` names keys whose values are not read. */
export function proseIn(value, { skip_keys = [], prefix = '' } = {}, out = []) {
  const skip = new Set(skip_keys);
  const walk = (node, path) => {
    if (typeof node === 'string') { if (isProse(node)) out.push({ text: node, path }); return; }
    if (Array.isArray(node)) { node.forEach((child, index) => walk(child, `${path}.${index}`)); return; }
    if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) if (!skip.has(key)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(value, prefix);
  return out;
}

/** The visible lines of an HTML page: its text, plus the prose in its JSON-LD blocks; scripts, styles and templates are not words. */
export function wordsOfHtml(html) {
  const body = html.replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi, (_, json) => {
    try { return ` ${proseIn(JSON.parse(json)).map(piece => piece.text).join(' \n ')} `; } catch { return ' '; }
  });
  return body.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line.split(' ').length >= 3);
}

/**
 * The words of a rendered deck: one inert JSON block, `<script type="application/json" id="slide-words">`, holds
 * { id, fields: { text, slide } } rows. Throws when the block is missing or holds no words.
 */
export function wordsOfDeck(html, where = 'deck') {
  const block = html.match(/<script type="application\/json" id="slide-words">([\s\S]*?)<\/script>/);
  if (!block) throw new Error(`${where} has no slide-words block`);
  const found = [];
  for (const slide of JSON.parse(block[1])) {
    for (const [field, value] of Object.entries(slide.fields ?? {})) {
      if (field === 'slide' || !isProse(value)) continue;
      found.push({ text: value, where: `${where}#${slide.id}.${field}` });
    }
  }
  if (!found.length) throw new Error(`${where} holds no words`);
  return found;
}

/**
 * Reads authored words from a Markdown document without guessing at source-only blocks. A document title may be metadata
 * when the caller declares its heading level; otherwise headings are ordinary words. Unclassified quotes, preamble before
 * a declared document title, unsupported markup and code-shaped indentation are coverage issues, not silent exclusions.
 */
export function wordsOfMarkdown(markdown, where = 'markdown', {
  kind = 'copy', heading_kind = kind, display_kind = kind, document_heading_level = null,
  document_heading_is_metadata = false, quote_kind = null, fields = {}, context_requires_review_rules = [],
} = {}) {
  const units = [], issues = [];
  if (typeof markdown !== 'string') return { units, issues: [{ kind: 'markdown_text_missing' }], coverage: { selected_units: 0, display_blocks: 0 } };
  if (document_heading_level !== null && (!Number.isInteger(document_heading_level) || document_heading_level < 1 || document_heading_level > 6)) {
    return { units, issues: [{ kind: 'invalid_document_heading_level' }], coverage: { selected_units: 0, display_blocks: 0 } };
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)
      || Object.values(fields).some(field => typeof field !== 'string')
      || !Array.isArray(context_requires_review_rules) || context_requires_review_rules.some(id => typeof id !== 'string')) {
    return { units, issues: [{ kind: 'invalid_markdown_context_options' }], coverage: { selected_units: 0, display_blocks: 0 } };
  }
  const lines = markdown.split(/\r?\n/u);
  let documentHeadingSeen = document_heading_level === null;
  let fence = null, paragraph = [], paragraphLine = null, inTable = false, bodyUnits = 0, displayBlocks = 0;
  const add = (text, unitKind, line, role) => {
    const clean = text.trim();
    if (!clean) return;
    const checks = role === 'paragraph' ? [] : ['starts-with-capital', 'capital-after-stop', 'ends-with-stop'];
    units.push({ text: clean, kind: unitKind, where: `${where}:${line}`, facts: { markdown_role: role },
      ...(fields[role] ? { field: fields[role] } : {}),
      ...(checks.length ? { context_requires_review_checks: checks } : {}),
      ...(context_requires_review_rules.length ? { context_requires_review_rules } : {}) });
    bodyUnits++;
  };
  const flush = () => {
    if (paragraph.length) add(paragraph.join(' '), kind, paragraphLine, 'paragraph');
    paragraph = [];
    paragraphLine = null;
  };
  const cellsFor = value => {
    if (!value.includes('|')) return null;
    let row = value.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
    return row.split(/(?<!\\)\|/u).map(cell => cell.trim().replace(/\\\|/gu, '|'));
  };
  const delimiter = cells => cells?.length > 1 && cells.every(cell => /^:?-{3,}:?$/u.test(cell));

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index], line = raw.trim(), number = index + 1;
    if (fence) {
      if (new RegExp(`^${fence.marker}{${fence.length},}\\s*$`, 'u').test(line)) { fence = null; continue; }
      if (line) add(line, display_kind, number, 'display_text');
      continue;
    }
    if (!line) { flush(); inTable = false; continue; }
    const open = /^(`{3,}|~{3,})/u.exec(line);
    if (open) {
      flush(); inTable = false;
      if (!documentHeadingSeen) { issues.push({ kind: 'preamble_content', line: number }); continue; }
      fence = { marker: open[1][0], length: open[1].length };
      displayBlocks++;
      continue;
    }
    if (!documentHeadingSeen) {
      const title = new RegExp(`^#{${document_heading_level}}\\s+(.+?)\\s*#*\\s*$`, 'u').exec(line);
      if (title) {
        documentHeadingSeen = true;
        if (!document_heading_is_metadata) add(title[1], heading_kind, number, 'heading');
      } else issues.push({ kind: 'preamble_content', line: number });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (line.startsWith('#')) {
      flush(); inTable = false;
      if (!heading) { issues.push({ kind: 'unknown_heading_shape', line: number }); continue; }
      if (document_heading_level !== null && heading[1].length < document_heading_level) {
        issues.push({ kind: 'repeated_document_heading', line: number }); continue;
      }
      add(heading[2], heading_kind, number, 'heading');
      continue;
    }
    if (line.startsWith('>')) {
      flush(); inTable = false;
      if (quote_kind) add(line.replace(/^>\s?/u, ''), quote_kind, number, 'quote');
      else issues.push({ kind: 'unresolved_quote_role', line: number });
      continue;
    }
    const cells = cellsFor(line);
    const nextCells = index + 1 < lines.length ? cellsFor(lines[index + 1].trim()) : null;
    if (inTable && cells) { for (const cell of cells) add(cell, kind, number, 'table_cell'); continue; }
    inTable = false;
    if (cells?.length > 1 && cells.length === nextCells?.length && delimiter(nextCells)) {
      flush();
      for (const cell of cells) add(cell, kind, number, 'table_cell');
      index++;
      inTable = true;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(line)) { flush(); inTable = false; continue; }
    if (/^<\/?[A-Za-z!]/u.test(line)) { flush(); inTable = false; issues.push({ kind: 'unclassified_markup', line: number }); continue; }
    const list = /^(?:[-*+]\s+|\d+[.)]\s+)/u.exec(line);
    if (list) { flush(); inTable = false; add(line.slice(list[0].length), kind, number, 'list_item'); continue; }
    if (/^(?: {4,}|\t)/u.test(raw)) { flush(); inTable = false; issues.push({ kind: 'indented_code_or_unclassified_block', line: number }); continue; }
    if (paragraphLine === null) paragraphLine = number;
    paragraph.push(line);
  }
  flush();
  if (fence) issues.push({ kind: 'unterminated_fence' });
  if (!documentHeadingSeen) issues.push({ kind: 'missing_document_heading' });
  if (!bodyUnits) issues.push({ kind: 'missing_public_body' });
  return { units, issues, coverage: { selected_units: bodyUnits, display_blocks: displayBlocks } };
}

/** One unit per distinct (kind, text), each with every place it was found (the first three are named). */
export function distinctUnits(found, defaults = {}) {
  const byKey = new Map();
  for (const unit of found) {
    const { text, where, kind = defaults.kind ?? 'copy', facts = defaults.facts ?? {}, ...metadata } = unit;
    const key = JSON.stringify({ kind, text: text.trim(), facts, metadata });
    if (!byKey.has(key)) byKey.set(key, { ...metadata, kind, text: text.trim(), where: [], facts });
    byKey.get(key).where.push(where);
  }
  return [...byKey.values()].map(unit => ({ ...unit, where: unit.where.slice(0, 3).join('; ') + (unit.where.length > 3 ? ` (+${unit.where.length - 3})` : '') }));
}
