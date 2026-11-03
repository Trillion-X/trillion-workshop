// tools/check-against-a-persons-rules-and-verdicts/do-work/read-words.mjs
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
//   4. A reader whose shape is declared (wordsOfSections, wordsOfCueNarration, wordsOfJsonRoles) reads only what its profile
//      or owner names. Anything else in the source (preamble, a quote of a source, code, an unknown section, a string no
//      role claims) is an issue the caller sees, never a unit and never a silent exclusion; a profile it cannot use is
//      itself an issue. Text it leaves out is counted, never copied into the result.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { wordsIn } from '../../judge-words/do-work/judge-words.mjs';

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
  const listStack = [];
  let paragraphRole = 'paragraph', paragraphListDepth = null;
  const add = (text, unitKind, line, role, listDepth = null) => {
    const clean = text.trim();
    if (!clean) return;
    const checks = role === 'paragraph' ? [] : ['starts-with-capital', 'capital-after-stop', 'ends-with-stop'];
    units.push({ text: clean, kind: unitKind, where: `${where}:${line}`,
      facts: { markdown_role: role, ...(listDepth === null ? {} : { markdown_list_depth: listDepth }) },
      ...(fields[role] ? { field: fields[role] } : {}),
      ...(checks.length ? { context_requires_review_checks: checks } : {}),
      ...(context_requires_review_rules.length ? { context_requires_review_rules } : {}) });
    bodyUnits++;
  };
  const flush = () => {
    if (paragraph.length) add(paragraph.join(' '), kind, paragraphLine, paragraphRole, paragraphListDepth);
    paragraph = [];
    paragraphLine = null;
    paragraphRole = 'paragraph';
    paragraphListDepth = null;
  };
  const indentation = raw => {
    let column = 0;
    for (const char of raw) {
      if (char === ' ') column++;
      else if (char === '\t') column += 4 - (column % 4);
      else break;
    }
    return column;
  };
  const clearLists = () => { flush(); listStack.length = 0; };
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
    const indent = indentation(raw);
    const open = /^(`{3,}|~{3,})/u.exec(line);
    if (open) {
      if (indent === 0) clearLists(); else flush();
      inTable = false;
      if (!documentHeadingSeen) { issues.push({ kind: 'preamble_content', line: number }); continue; }
      fence = { marker: open[1][0], length: open[1].length };
      displayBlocks++;
      continue;
    }
    if (!documentHeadingSeen) {
      if (indent === 0) listStack.length = 0;
      const title = new RegExp(`^#{${document_heading_level}}\\s+(.+?)\\s*#*\\s*$`, 'u').exec(line);
      if (title) {
        documentHeadingSeen = true;
        if (!document_heading_is_metadata) add(title[1], heading_kind, number, 'heading');
      } else issues.push({ kind: 'preamble_content', line: number });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (line.startsWith('#')) {
      clearLists(); inTable = false;
      if (!heading) { issues.push({ kind: 'unknown_heading_shape', line: number }); continue; }
      if (document_heading_level !== null && heading[1].length < document_heading_level) {
        issues.push({ kind: 'repeated_document_heading', line: number }); continue;
      }
      add(heading[2], heading_kind, number, 'heading');
      continue;
    }
    if (line.startsWith('>')) {
      clearLists(); inTable = false;
      if (quote_kind) add(line.replace(/^>\s?/u, ''), quote_kind, number, 'quote');
      else issues.push({ kind: 'unresolved_quote_role', line: number });
      continue;
    }
    const list = /^(?:[-*+]\s+|\d+[.)]\s+)/u.exec(line);
    if (list) {
      flush(); inTable = false;
      while (listStack.length && indent < listStack.at(-1).contentIndent) listStack.pop();
      if (!listStack.length && indent > 3) {
        issues.push({ kind: 'indented_code_or_unclassified_block', line: number });
        continue;
      }
      while (listStack.length && indent <= listStack.at(-1).markerIndent) listStack.pop();
      let contentColumn = indent;
      for (const char of list[0]) {
        if (char === '\t') contentColumn += 4 - (contentColumn % 4);
        else contentColumn++;
      }
      listStack.push({ markerIndent: indent, contentIndent: contentColumn });
      add(line.slice(list[0].length), kind, number, 'list_item', listStack.length);
      continue;
    }
    while (listStack.length && indent < listStack.at(-1).contentIndent) listStack.pop();
    const activeList = listStack.at(-1);
    const cells = cellsFor(line);
    const nextCells = index + 1 < lines.length ? cellsFor(lines[index + 1].trim()) : null;
    if (inTable && cells) { for (const cell of cells) add(cell, kind, number, 'table_cell'); continue; }
    inTable = false;
    if (cells?.length > 1 && cells.length === nextCells?.length && delimiter(nextCells)) {
      if (indent === 0) clearLists(); else flush();
      for (const cell of cells) add(cell, kind, number, 'table_cell');
      index++;
      inTable = true;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(line)) { clearLists(); inTable = false; continue; }
    if (/^<\/?[A-Za-z!]/u.test(line)) { clearLists(); inTable = false; issues.push({ kind: 'unclassified_markup', line: number }); continue; }
    if (activeList && indent >= activeList.contentIndent) {
      if (indent >= activeList.contentIndent + 4) {
        flush(); inTable = false; issues.push({ kind: 'indented_code_or_unclassified_block', line: number }); continue;
      }
      if (paragraph.length && paragraphRole !== 'list_item') flush();
      if (paragraphLine === null) paragraphLine = number;
      paragraphRole = 'list_item';
      paragraphListDepth = listStack.length;
      paragraph.push(line);
      continue;
    }
    if (indent >= 4) { clearLists(); inTable = false; issues.push({ kind: 'indented_code_or_unclassified_block', line: number }); continue; }
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

const headingKey = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/**
 * Reads a Markdown document made of declared sections: the first level-one heading is its title, and each level-two
 * heading the profile names opens a section whose paragraphs, list items and lower headings are its words. Everything
 * else is accounted for, never silently judged or dropped: text before the first section is preamble (counted, its text
 * not kept), a quote is an unresolved source quote (counted and an issue, its text not kept), an unknown section and the
 * text under it are issues, and a required section that never opens, a missing title and an empty body are issues.
 *
 * profile: { title_kind, sections: [{ heading, kind, heading_kind?, keeps_headings? }], required?: [heading],
 *   fields?: { <kind>: <field> } }. A section with keeps_headings reads every later heading below the title as one of its
 * own (a script whose scene headings are words), so no level-two heading leaves it.
 * Returns { units, issues, excluded: { preamble_lines, unresolved_quote_lines }, public_body_units }.
 */
export function wordsOfSections(markdown, where = 'markdown', profile = {}) {
  const units = [], issues = [], excluded = { preamble_lines: 0, unresolved_quote_lines: 0 };
  const sections = Array.isArray(profile.sections) ? profile.sections : [];
  if (typeof markdown !== 'string' || !nonempty(profile.title_kind) || !sections.length
      || sections.some(section => !nonempty(section.heading) || !nonempty(section.kind))) {
    return { units, issues: [{ kind: 'invalid_reader_profile' }], excluded, public_body_units: 0 };
  }
  const byKey = new Map(sections.map(section => [headingKey(section.heading), section]));
  const opened = new Set();
  let current = null, unknown = false, titleSeen = false, bodyUnits = 0;
  const add = (text, kind, line, role) => {
    if (!text.trim()) return;
    units.push({ text: text.trim(), kind, where: `${where}:${line}`, facts: { content_role: role },
      ...(profile.fields?.[kind] ? { field: profile.fields[kind] } : {}) });
    if (role === 'public_body') bodyUnits++;
  };
  markdown.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim(), number = index + 1;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      const depth = heading[1].length, title = heading[2].trim();
      if (depth === 1) {
        if (!titleSeen) { titleSeen = true; add(title, profile.title_kind, number, 'public_title'); }
        else issues.push({ kind: 'repeated_document_title', line: number });
        return;
      }
      if (current?.keeps_headings) { add(title, current.heading_kind ?? profile.title_kind, number, 'public_heading'); return; }
      if (depth === 2) {
        const section = byKey.get(headingKey(title));
        if (section) { current = section; unknown = false; opened.add(headingKey(section.heading)); }
        else if (!current && !unknown) excluded.preamble_lines++;
        else { current = null; unknown = true; issues.push({ kind: 'unknown_section', line: number }); }
        return;
      }
      if (current) add(title, current.heading_kind ?? profile.title_kind, number, 'public_heading');
      else if (unknown) issues.push({ kind: 'content_under_unrecognized_section', line: number });
      else excluded.preamble_lines++;
      return;
    }
    if (!line) return;
    if (!current && !unknown) { excluded.preamble_lines++; return; }
    if (unknown) { issues.push({ kind: 'content_under_unrecognized_section', line: number }); return; }
    if (line.startsWith('>')) { excluded.unresolved_quote_lines++; issues.push({ kind: 'unresolved_quote_role', line: number }); return; }
    add(line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, ''), current.kind, number, 'public_body');
  });
  if (!titleSeen) issues.push({ kind: 'missing_document_title' });
  for (const required of profile.required ?? []) if (!opened.has(headingKey(required))) issues.push({ kind: 'missing_required_section', section: required });
  if (!bodyUnits) issues.push({ kind: 'missing_public_body' });
  return { units, issues, excluded, public_body_units: bodyUnits };
}

/**
 * Reads narration split into cues: optional flat frontmatter between `---` lines (only the fields the profile declares,
 * each a string or a number), then one heading per cue at the profile's level whose text is the cue id, then the cue's
 * ordinary prose. A paragraph that wraps over lines is one unit, and each unit keeps its `cue_id`. Quotes, code (fenced,
 * inline or indented), lists, tables, rules, markup, text outside a cue, an empty cue, a repeated or malformed cue id and
 * any frontmatter it cannot read are issues, never words.
 *
 * profile: { kind, field?, cue_heading_level, cue_id_pattern, frontmatter?: { fields: { <name>: "string" | "number" },
 *   required?: [name] } }. Returns { units, issues, frontmatter, cue_ids }.
 */
export function wordsOfCueNarration(markdown, where = 'narration', profile = {}) {
  const units = [], issues = [], cueIds = [], frontmatter = {};
  const metadata = profile.frontmatter ?? { fields: {}, required: [] };
  let cueId = null;
  try { cueId = new RegExp(profile.cue_id_pattern, 'u'); } catch { cueId = null; }
  if (typeof markdown !== 'string' || !nonempty(profile.kind) || !cueId || typeof profile.cue_id_pattern !== 'string'
      || !Number.isInteger(profile.cue_heading_level) || profile.cue_heading_level < 1 || profile.cue_heading_level > 6
      || !metadata.fields || typeof metadata.fields !== 'object' || Object.values(metadata.fields).some(type => !['string', 'number'].includes(type))
      || (metadata.required ?? []).some(key => !Object.hasOwn(metadata.fields, key))) {
    return { units, issues: [{ kind: 'invalid_reader_profile' }], frontmatter, cue_ids: cueIds };
  }
  const lines = markdown.split(/\r?\n/u);
  let index = 0, active = null, paragraph = [], paragraphLine = null, fence = null;
  const flush = () => {
    if (paragraph.length && active) {
      const text = paragraph.join(' ').trim();
      if (text) units.push({ text, kind: profile.kind, cue_id: active.id, where: `${where}:${paragraphLine}`, facts: { content_role: 'cue_narration' },
        ...(nonempty(profile.field) ? { field: profile.field } : {}) });
    }
    paragraph = [];
    paragraphLine = null;
  };
  const finishCue = () => {
    flush();
    if (active && active.units === units.length) issues.push({ kind: 'empty_cue', cue_id: active.id, line: active.line });
    active = null;
  };
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) issues.push({ kind: 'unterminated_frontmatter' });
    else {
      for (let at = 1; at < end; at++) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*$/u.exec(lines[at]);
        if (!match) { issues.push({ kind: 'invalid_frontmatter_line', line: at + 1 }); continue; }
        const [, key, value] = match;
        const type = Object.hasOwn(metadata.fields, key) ? metadata.fields[key] : null;
        if (!type) { issues.push({ kind: 'unknown_frontmatter_field', line: at + 1 }); continue; }
        if (Object.hasOwn(frontmatter, key)) { issues.push({ kind: 'duplicate_frontmatter_field', line: at + 1 }); continue; }
        if (type === 'string' && value && !/^['"`]|['"`]$/u.test(value)) frontmatter[key] = value;
        else if (type === 'number' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value) && Number.isFinite(Number(value))) frontmatter[key] = Number(value);
        else issues.push({ kind: 'invalid_frontmatter_value', line: at + 1 });
      }
      if (end === 1) issues.push({ kind: 'empty_frontmatter' });
      for (const key of metadata.required ?? []) if (!Object.hasOwn(frontmatter, key)) issues.push({ kind: 'missing_frontmatter_field', field: key });
      index = end + 1;
    }
  }
  const cueHeading = new RegExp(`^#{${profile.cue_heading_level}}\\s+(.+?)\\s*#*\\s*$`, 'u');
  for (; index < lines.length; index++) {
    const raw = lines[index], line = raw.trim(), number = index + 1;
    if (fence) { if (new RegExp(`^${fence.marker}{${fence.length},}\\s*$`, 'u').test(line)) fence = null; continue; }
    if (!line) { flush(); continue; }
    if (/^(?: {4,}|\t)/u.test(raw)) { flush(); issues.push({ kind: 'code_shape', ...(active ? { cue_id: active.id } : {}), line: number }); continue; }
    if (line.startsWith('#')) {
      const heading = cueHeading.exec(line);
      finishCue();
      if (!heading) { issues.push({ kind: 'unknown_heading_shape', line: number }); continue; }
      const id = heading[1].replace(/\s+#+$/u, '').trim();
      if (!cueId.test(id)) { issues.push({ kind: 'invalid_cue_id', line: number }); continue; }
      if (cueIds.includes(id)) { issues.push({ kind: 'duplicate_cue_id', cue_id: id, line: number }); continue; }
      cueIds.push(id);
      active = { id, line: number, units: units.length };
      continue;
    }
    if (!active) { issues.push({ kind: 'text_outside_cue', line: number }); continue; }
    if (line.startsWith('>')) { flush(); issues.push({ kind: 'unresolved_quote', cue_id: active.id, line: number }); continue; }
    const open = /^(`{3,}|~{3,})/u.exec(line);
    if (open) { flush(); issues.push({ kind: 'code_shape', cue_id: active.id, line: number }); fence = { marker: open[1][0], length: open[1].length }; continue; }
    if (line.includes('`')) { flush(); issues.push({ kind: 'code_shape', cue_id: active.id, line: number }); continue; }
    if (/^(?:[-*+]\s+|\d+[.)]\s+|\|)/u.test(line) || /^(?:-{3,}|\*{3,}|_{3,})$/u.test(line) || /^<\/?[A-Za-z!]/u.test(line)) {
      flush(); issues.push({ kind: 'unknown_content_shape', cue_id: active.id, line: number }); continue;
    }
    if (paragraphLine === null) paragraphLine = number;
    paragraph.push(line);
  }
  finishCue();
  if (!cueIds.length) issues.push({ kind: 'missing_cues' });
  return { units, issues, frontmatter, cue_ids: cueIds };
}

/**
 * Reads the words an owner declares in any JSON value, and only those: `owner.paths` (dot paths, `*` one level, `**` any
 * depth) select the strings, and each `owner.roles` row ({ paths, kind, field, context_requires_review? }) gives the
 * strings at its paths their kind and field. A string two roles claim, a role reaching outside the selected words, a
 * selected string no role claims (when roles are declared) and an owner whose paths match nothing are issues. A role
 * with context_requires_review marks its units for context review, so a word finding holds them and never fails them.
 *
 * owner: { paths, kind, field?, roles? }. Returns { units, issues }.
 */
export function wordsOfJsonRoles(value, where = 'json', owner = {}) {
  const issues = [];
  if (!Array.isArray(owner.paths) || !owner.paths.length || owner.paths.some(path => !nonempty(path)) || !nonempty(owner.kind)
      || (owner.roles !== undefined && (!Array.isArray(owner.roles) || owner.roles.some(role => !Array.isArray(role.paths) || !role.paths.length
        || !nonempty(role.kind) || !nonempty(role.field))))) {
    return { units: [], issues: [{ kind: 'invalid_json_owner' }] };
  }
  const selected = wordsIn(value, { paths: owner.paths });
  const selectedPaths = new Set(selected.map(row => JSON.stringify(row.path)));
  const roles = new Map();
  for (const role of owner.roles ?? []) for (const row of wordsIn(value, { paths: role.paths })) {
    const key = JSON.stringify(row.path);
    if (!selectedPaths.has(key)) issues.push({ kind: 'role_outside_selected_words', path: row.path });
    if (roles.has(key)) issues.push({ kind: 'ambiguous_word_role', path: row.path });
    roles.set(key, role);
  }
  const units = selected.map(row => {
    const role = roles.get(JSON.stringify(row.path));
    if (owner.roles && !role) issues.push({ kind: 'unclassified_word_role', path: row.path });
    const field = role?.field ?? owner.field ?? row.field;
    return { text: row.text, kind: role?.kind ?? owner.kind, where: `${where}#${row.path.map(String).join('.')}`, path: row.path,
      facts: { content_role: role?.kind ?? owner.kind }, ...(field ? { field } : {}),
      ...(role?.context_requires_review ? { context_requires_review: true } : {}) };
  });
  if (!units.length) issues.push({ kind: 'owner_paths_matched_no_words' });
  return { units, issues };
}
