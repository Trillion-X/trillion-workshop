import { blake3 } from '@noble/hashes/blake3.js';
import { marked } from 'marked';
import { markdownCodeFence } from '../read-data/markdown-code-fence.ts';
import importFormats from '../read-data/document-import-formats.json' with { type: 'json' };
import editingRules from '../read-data/editing-rules.json' with { type: 'json' };

// ── address convention + kinds (SSOT mirror of read-data/document-index.ts) ──
const DOC_PREFIX = 'package::documents::documents::';
const IDX_PREFIX = 'package::documents::document-index::';
const INDEX_KIND = 'composition-document-index';
const PUBLISHED_PATH = ['current-item', 'published-record'];

// ── section -> style (SSOT mirror of read-data/document-sections.ts) ──
const HEADING_STYLE = { 1: { font_size: 30, font_weight: 700 }, 2: { font_size: 22, font_weight: 600 }, 3: { font_size: 18, font_weight: 600 } };
const BODY_STYLE = { font_size: 16, font_weight: 400 };
const MAX_LIST_INDENT = 8;
const INDENTABLE_SHORTCUTS = new Set(editingRules.rows.flatMap(row => row.rules ?? []).filter(rule => rule.indentable === true).map(rule => rule.id));
function styleForSection(s) {
  const base = s.heading || (s.level && s.level > 0) ? (HEADING_STYLE[s.level ?? 1] ?? HEADING_STYLE[3]) : BODY_STYLE;
  return { ...base, ...(s.style ?? {}) };
}
function structuralizeImportedLists(nodes, docId) {
  const roots = [];
  const stack = [];
  const bodiesByGroup = new Map();
  for (const node of nodes) {
    const { __import_list_group_id: groupId, __import_list_body_for: bodyFor, ...cleanNode } = node;
    if (bodyFor) {
      const body = bodiesByGroup.get(bodyFor);
      if (body) { body.children.push(cleanNode); continue; }
    }
    if (node.kind !== 'Text' || !INDENTABLE_SHORTCUTS.has(node.props?.made_by_shortcut)) {
      roots.push(cleanNode); stack.length = 0; continue;
    }
    const requested = Math.max(0, Math.min(MAX_LIST_INDENT, Number(node.props?.indent_level) || 0));
    const depth = Math.min(requested, stack.length);
    const owner = {
      id: `${node.id}-list-owner`, kind: 'Container',
      props: { interaction: { structure: { primary_role: 'primary', body_role: 'body', nestable: true, list_item: true } }, style: { layout: { mode: 'flex', axis: 'y', gap: 0 } } },
      visible: true,
      children: [
        { ...cleanNode, props: { ...cleanNode.props, content_role: 'primary', indent_level: null } },
        { id: `${node.id}-list-body`, kind: 'Container', props: { content_role: 'body', style: { padding: { left: 24 }, layout: { mode: 'flex', axis: 'y', gap: 0 } } }, visible: true, children: [] },
      ],
    };
    if (groupId) bodiesByGroup.set(groupId, owner.children[1]);
    if (depth) {
      const parent = stack[depth - 1];
      parent.children[1].children.push(owner);
    } else roots.push(owner);
    stack.length = depth;
    stack.push(owner);
  }
  return roots;
}
export function sectionsToContent(docId, sections) {
  const children = sections
    .filter((s) => s?.kind === 'divider' ? true : s?.kind === 'image' ? typeof s.src === 'string' && s.src.trim() : typeof s.text === 'string' && (s.interchange_kind === 'fenced-code' || s.text.trim().length > 0))
    .map((s, i) => {
      if (s.kind === 'divider') {
        const rule = SHORTCUT_RULES.find(candidate => candidate.markdown === '---');
        const template = rule?.effect_template?.find(patch => patch.type === 'INSERT_NODE' && patch.node?.kind === 'Container')?.node;
        if (!template) throw new Error('Markdown import requires the installed divider rule.');
        return { ...structuredClone(template), id: `${docId}-b${i}`, props: { ...template.props, made_by_shortcut: rule.id } };
      }
      if (s.kind === 'image') return {
        id: `${docId}-b${i}`, kind: 'Image',
        props: { src: s.src, ...(s.alt ? { alt: s.alt } : {}) },
        visible: true, children: [],
      };
      const lineage = buildLineage(s);
      const sourceRefs = normalizedStringArray(s.refs);
      const isHeading = s.heading || (s.level && s.level > 0);
      const headingLevel = Number.isInteger(s.level) && s.level >= 1 && s.level <= 6 ? s.level : 1;
      return { id: `${docId}-b${i}`, kind: 'Text', ...(s.list_group_id ? { __import_list_group_id: s.list_group_id } : {}), ...(s.list_body_for ? { __import_list_body_for: s.list_body_for } : {}), props: {
        text: s.interchange_kind === 'fenced-code' ? s.text : s.text.trim(), style: styleForSection(s),
        ...(Number.isInteger(s.indent_level) && s.indent_level > 0 ? { indent_level: Math.min(MAX_LIST_INDENT, s.indent_level) } : {}),
        ...(typeof s.made_by_shortcut === 'string' ? { made_by_shortcut: s.made_by_shortcut } : {}),
        ...(lineage || isHeading || sourceRefs.length || ['fenced-code', 'table-row'].includes(s.interchange_kind) || (Number.isInteger(s.indent_level) && s.indent_level > 0) ? { custom: {
          ...(lineage ? { lineage } : {}),
          ...(sourceRefs.length ? { source_refs: sourceRefs } : {}),
          ...(isHeading ? { heading_level: headingLevel } : {}),
          ...(Number.isInteger(s.indent_level) && s.indent_level > 0 ? { indent_level: Math.min(8, s.indent_level) } : {}),
          ...(s.interchange_kind === 'fenced-code' ? { interchange_kind: 'fenced-code' } : {}),
          ...(s.interchange_kind === 'table-row' ? { interchange_kind: 'table-row' } : {}),
          ...(Number.isInteger(s.table_row_index) ? { table_row_index: s.table_row_index } : {}),
          ...(Array.isArray(s.table_alignment) ? { table_alignment: s.table_alignment } : {}),
          ...(s.code_fence_language ? { code_fence_language: String(s.code_fence_language).slice(0, 64) } : {}),
        } } : {}),
      }, visible: true, children: [] };
    });
  // Normal Documents treats each scene root as a page. Keep the authored
  // sections inside the same ordinary vertical Container used by a new page,
  // preserving every block id and its order. This is content structure, not a
  // transcript-specific renderer or an alternate document store.
  const structuredChildren = structuralizeImportedLists(children, docId);
  return { children: [{
    id: `${docId}-page`,
    kind: 'Container',
    props: { style: { layout: { mode: 'flex', axis: 'y', gap: 10 } } },
    visible: true,
    children: structuredChildren,
  }] };
}

// A producer never supplies the revision hash. Documents derives it from the
// exact canonical editable tree it is about to write, so imported and manually
// edited documents share one hash basis at publication time.
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
// Compare the JSON data that crosses the engine boundary, ignoring object key
// order and omitted undefined properties while preserving array/block order.
export function sameImportedPage(left, right) {
  return stableJson(JSON.parse(JSON.stringify(left))) === stableJson(JSON.parse(JSON.stringify(right)));
}

/** Compare complete blocks by stable identity; formatting and source links count
 * as changes too. The caller presents this comparison before requesting a write. */
export function compareImportedPages(current, incoming) {
  const blocks = page => {
    if (!page || typeof page.id !== 'string' || !page.id.trim() || !Array.isArray(page.children)) throw new Error('A complete page is required.');
    // Scene identities address every descendant, not only direct text blocks.
    // Reject collisions with the page itself and across nested subtrees before
    // offering a replacement that the scene owner cannot address unambiguously.
    const identities = new Set([page.id]);
    const pending = [...page.children];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node.id !== 'string' || !node.id.trim() || identities.has(node.id)) throw new Error('Page block identities must be unique.');
      identities.add(node.id);
      if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('A complete page is required.');
      pending.push(...(node.children ?? []));
    }
    const result = new Map();
    for (const block of page.children) {
      if (!block || typeof block.id !== 'string' || !block.id || result.has(block.id)) throw new Error('Page block identities must be unique.');
      result.set(block.id, block);
    }
    return result;
  };
  const before = blocks(current), after = blocks(incoming);
  if (current.id !== incoming.id) throw new Error('The incoming revision must name the same page.');
  return {
    added: [...after.keys()].filter(id => !before.has(id)),
    removed: [...before.keys()].filter(id => !after.has(id)),
    changed: [...after.keys()].filter(id => before.has(id) && !sameImportedPage(before.get(id), after.get(id))),
    unchanged: [...after.keys()].filter(id => before.has(id) && sameImportedPage(before.get(id), after.get(id))),
    order_changed: !sameImportedPage([...before.keys()].filter(id => after.has(id)), [...after.keys()].filter(id => before.has(id))),
    page_changed: !sameImportedPage({ ...current, children: [] }, { ...incoming, children: [] }),
  };
}

/** Scene ids address every block in a document. Reject cross-page collisions before admitting an insertion. */
export function importedSceneIdentityConflicts(tree, incoming, replacedId = null) {
  const existing = new Set();
  const collect = node => {
    if (!node || node.id === replacedId) return;
    existing.add(node.id);
    for (const child of node.children ?? []) collect(child);
  };
  collect(tree);
  const conflicts = [];
  const pending = [incoming];
  while (pending.length) {
    const node = pending.pop();
    if (existing.has(node.id)) conflicts.push(node.id);
    pending.push(...(node.children ?? []));
  }
  return conflicts;
}

/** A preview never authorizes overwriting later edits. This pure plan is consumed
 * by the existing guarded scene writer; it does not persist or mint a receipt. */
export function planImportedPageReplacement(reviewed, current, incoming) {
  const comparison = compareImportedPages(reviewed, incoming);
  if (!sameImportedPage(reviewed, current)) return { ok: false, reason: 'The page changed after this preview. Review it again before replacing it.' };
  return { ok: true, comparison, page: JSON.parse(JSON.stringify(incoming)) };
}
export function revisionHashFor(content) {
  return `1f:${Array.from(blake3(new TextEncoder().encode(stableJson(content))), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function normalizedStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

function buildLineage(input) {
  const provenance = optionalObject(input.provenance);
  const hasLineage = provenance || optionalString(input.correlation_ref) || optionalString(input.reusable_job_ref)
    || optionalString(input.source) || optionalObject(input.rights) || optionalObject(input.authorization);
  if (!hasLineage) return undefined;

  const sourceIdentityRefs = normalizedStringArray(provenance?.source_identity_refs);
  const sourceRevisionRefs = normalizedStringArray(provenance?.source_revision_refs);
  const evidenceLocatorRefs = normalizedStringArray(provenance?.evidence_locator_refs);
  if (provenance && (sourceIdentityRefs.length === 0 || sourceRevisionRefs.length === 0 || evidenceLocatorRefs.length === 0)) {
    throw new Error('provenance requires source_identity_refs, source_revision_refs, and evidence_locator_refs');
  }

  return {
    correlation_ref: optionalString(input.correlation_ref),
    reusable_job_ref: optionalString(input.reusable_job_ref),
    source_ref: optionalString(input.source),
    provenance: provenance ? {
      ...provenance,
      source_identity_refs: sourceIdentityRefs,
      source_revision_refs: sourceRevisionRefs,
      evidence_locator_refs: evidenceLocatorRefs,
    } : undefined,
    rights: optionalObject(input.rights),
    authorization: optionalObject(input.authorization),
  };
}

// ── HTML body -> generic sections (the generated body is a known h1-6/p shape) ──
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' };
// HTML numeric references retain the standard Windows-1252 compatibility map.
const NUMERIC_REPLACEMENTS = { 128: 0x20ac, 130: 0x201a, 131: 0x192, 132: 0x201e, 133: 0x2026,
  134: 0x2020, 135: 0x2021, 136: 0x2c6, 137: 0x2030, 138: 0x160, 139: 0x2039,
  140: 0x152, 142: 0x17d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d,
  149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x2dc, 153: 0x2122, 154: 0x161,
  155: 0x203a, 156: 0x153, 158: 0x17e, 159: 0x178 };
function decodeEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|nbsp|#[0-9]+|#[xX][0-9a-fA-F]+);/g, (entity) => {
    if (ENTITIES[entity] !== undefined) return ENTITIES[entity];
    const hex = entity[2] === 'x' || entity[2] === 'X';
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(NUMERIC_REPLACEMENTS[code] ?? code) : '\uFFFD';
  });
}
function stripTags(html) {
  return decodeEntities(html.replace(/<br\b[^>]*>/gi, ' ')
    .replace(/<\/(?:div|li|ul|ol|tr|td|th|section|article|blockquote)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
function htmlAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : '';
}
function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function encodeInlineLink(href, label) {
  return `⟦link:${encodeURIComponent(href)}⟧${label}⟦/link⟧`;
}
const HTML_INLINE_MARKS = editingRules.rows.flatMap(row => row.kind === 'inline-mark-set' ? row.marks ?? [] : []);
const INLINE_MARK_BY_ID = new Map(HTML_INLINE_MARKS.map(mark => [mark.id, mark]));
function preserveInlineMarkup(html) {
  return html.replace(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, closing, name) => {
    const mark = HTML_INLINE_MARKS.find(row => row.legacy_tags?.includes(name.toLowerCase()));
    return mark ? (closing ? mark.close_marker : mark.open_marker) : tag;
  });
}
function preserveLinks(html) {
  return html.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, (anchor) => {
    const open = /^<a\b[^>]*>/i.exec(anchor)?.[0] ?? '';
    const href = safeHttpUrl(htmlAttribute(open, 'href'));
    const label = stripTags(preserveInlineMarkup(anchor.slice(open.length).replace(/<\/a\s*>$/i, '')));
    return href && label ? encodeInlineLink(href, label) : label;
  });
}
// What each element of imported HTML becomes: a heading, a paragraph, a list (its items written as the editor's own
// list shortcuts write them, read-data/editing-rules.json), or a table (one paragraph per row, its cells joined).
// Anything else is the text around it.
const HTML_BLOCKS = {
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  p: 'paragraph', blockquote: 'paragraph', li: 'item', ul: 'bullets', ol: 'numbers', tr: 'row', td: 'cell', th: 'cell',
};
const SHORTCUT_RULES = editingRules.rows.flatMap((row) => row.rules ?? []);
// A list item as the shortcut that types one writes it: its text prefix and the rule it carries as made_by_shortcut.
function listItemOf(list, text) {
  const rule = SHORTCUT_RULES.find((candidate) => (list.kind === 'numbers' ? candidate.match?.numeric === true : candidate.match?.prefix === '-'));
  const parts = rule?.effect_template?.[0]?.changes?.props?.text?.parts ?? [];
  const lead = parts.map((part) => (typeof part === 'string' ? part : part?.select?.path === 'match' ? `${list.count}.` : '')).join('');
  return rule ? { text: `${lead}${text}`, made_by_shortcut: rule.id } : { text };
}
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
function bodyHtmlToSections(bodyHtml) {
  if (typeof bodyHtml !== 'string' || bodyHtml.trim() === '') return [];
  // Drop JSON-LD / any <script> blocks — never editable body content.
  let cleaned = bodyHtml.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const images = [];
  cleaned = cleaned.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = safeHttpUrl(htmlAttribute(tag, 'src'));
    if (!src) return ' ';
    const index = images.push({ kind: 'image', src, alt: htmlAttribute(tag, 'alt').trim() }) - 1;
    return `<imageplaceholder data-index="${index}"></imageplaceholder>`;
  });
  cleaned = preserveInlineMarkup(preserveLinks(cleaned));
  const sections = [];
  const lists = [];
  let text = '';
  let block = null;
  let cells = null;
  const flush = () => {
    const words = stripTags(text);
    text = '';
    if (!words) return;
    if (block?.kind === 'heading') sections.push({ text: words, heading: true, level: block.level });
    else if (block?.kind === 'item' && lists.length) sections.push(listItemOf(lists[lists.length - 1], words));
    else sections.push({ text: words });
  };
  let at = 0;
  for (const match of cleaned.matchAll(TAG)) {
    text += cleaned.slice(at, match.index);
    at = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    if (name === 'imageplaceholder' && !closing) {
      flush();
      const index = Number(htmlAttribute(match[0], 'data-index'));
      if (Number.isInteger(index) && images[index]) sections.push(images[index]);
      block = null;
      continue;
    }
    const kind = HTML_BLOCKS[name];
    if (!kind) { text += name === 'br' ? ' ' : match[0]; continue; }
    if (kind === 'cell') {
      if (closing && cells) { cells.push(stripTags(text)); text = ''; }
      else if (!closing) text = '';
      continue;
    }
    if (kind === 'row') {
      if (!closing) { flush(); cells = []; }
      else if (cells) { const row = cells.filter(Boolean).join(' | '); if (row) sections.push({ text: row }); cells = null; text = ''; }
      continue;
    }
    if (kind === 'bullets' || kind === 'numbers') {
      flush();
      if (closing) lists.pop(); else lists.push({ kind, count: 0 });
      continue;
    }
    if (!closing) {
      flush();
      if (kind === 'item' && lists.length) lists[lists.length - 1].count += 1;
      block = { kind, level: kind === 'heading' ? Number(name.slice(1)) : undefined };
    } else {
      flush();
      block = null;
    }
  }
  text += cleaned.slice(at);
  flush();
  return sections;
}

// Resolve the final ordered sections: prefer structured `sections`, else parse
// `body_html`; always lead with the title as an H1 (unless the first section is
// already that exact title heading) so the document opens with a clear heading.
function resolveSections(input) {
  const provided = Array.isArray(input.sections)
    ? input.sections.filter((s) => s && typeof s.text === 'string' && s.text.trim()).flatMap((s) =>
      typeof s.heading === 'string' && s.heading.trim()
        ? [{ text: s.heading.trim(), heading: true, level: 2 }, { ...s, heading: false }]
        : [s])
    : [];
  const body = provided.length ? provided : typeof input.body_markdown === 'string'
    ? markdownToSections(input.body_markdown)
    : typeof input.body_text === 'string'
    ? input.body_text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(text => ({ text: text.trim() })).filter(s => s.text)
    : bodyHtmlToSections(input.body_html);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const firstIsTitle = body.length > 0 && body[0].heading && body[0].text.trim() === title;
  const lead = title && !firstIsTitle ? [{ text: title, heading: true, level: 1 }] : [];
  return [...lead, ...body];
}

// Markdown enters through the declared parser. Parser token kinds carry semantic
// emphasis, so CommonMark __strong__ cannot be mistaken for the editor's __underline__.
const parserInlineMark = id => {
  const mark = INLINE_MARK_BY_ID.get(id);
  if (!mark || typeof mark.open_marker !== 'string' || typeof mark.close_marker !== 'string') {
    throw new Error(`Markdown import requires the declared "${id}" inline mark.`);
  }
  return mark;
};
function inlineTokensToStored(tokens, { extractImages = true } = {}, budget = { count: 0 }, depth = 0) {
  if (!Array.isArray(tokens) || depth > 64) throw new Error('Markdown inline content exceeds safe import limits.');
  let text = '';
  for (const token of tokens) {
    if (++budget.count > 100_000) throw new Error('The Markdown file exceeds safe import limits.');
    switch (token.type) {
      case 'text':
        text += token.tokens ? inlineTokensToStored(token.tokens, { extractImages }, budget, depth + 1)
          : decodeEntities(String(token.raw ?? token.text ?? ''));
        break;
      case 'escape':
        // Keep the source escape so punctuation remains literal in the editor and on re-export.
        text += String(token.raw ?? `\\${token.text ?? ''}`);
        break;
      case 'strong': {
        const mark = parserInlineMark('strong');
        text += `${mark.open_marker}${inlineTokensToStored(token.tokens, { extractImages }, budget, depth + 1)}${mark.close_marker}`;
        break;
      }
      case 'em': {
        const mark = parserInlineMark('em');
        text += `${mark.open_marker}${inlineTokensToStored(token.tokens, { extractImages }, budget, depth + 1)}${mark.close_marker}`;
        break;
      }
      case 'del': {
        const mark = parserInlineMark('strike');
        text += `${mark.open_marker}${inlineTokensToStored(token.tokens, { extractImages }, budget, depth + 1)}${mark.close_marker}`;
        break;
      }
      case 'codespan': {
        const mark = parserInlineMark('code');
        if (String(token.text).includes(mark.open_marker)) throw new Error('Markdown inline code containing a backtick is not supported by this editor format.');
        text += `${mark.open_marker}${token.text}${mark.close_marker}`;
        break;
      }
      case 'link': {
        const label = inlineTokensToStored(token.tokens, { extractImages: false }, budget, depth + 1);
        const safe = safeHttpUrl(token.href);
        text += safe && label ? encodeInlineLink(safe, label) : label;
        break;
      }
      case 'image': {
        const alt = inlineTokensToStored(token.tokens, { extractImages: false }, budget, depth + 1);
        const safe = safeHttpUrl(token.href);
        text += safe && extractImages ? `⟦image:${encodeURIComponent(safe)}⟧${alt}` : alt;
        break;
      }
      case 'br': text += '  \n'; break;
      case 'html': {
        const raw = String(token.raw ?? '').trim().toLowerCase();
        if (raw === '<u>') text += parserInlineMark('underline').open_marker;
        else if (raw === '</u>') text += parserInlineMark('underline').close_marker;
        else throw new Error('Markdown import supports inline HTML only for <u> underline tags.');
        break;
      }
      default:
        throw new Error(`Markdown inline form "${String(token.type).slice(0, 40)}" is not supported.`);
    }
  }
  return text;
}

function markdownInline(tokens, options = {}, budget) {
  return inlineTokensToStored(tokens, options, budget);
}

function splitMarkdownTableRow(line) {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = []; let cell = ''; let escaped = false; let code = false;
  for (const character of value) {
    if (escaped) { cell += character; escaped = false; continue; }
    if (character === '\\') { cell += character; escaped = true; continue; }
    if (character === '`') code = !code;
    if (character === '|' && !code) { cells.push(cell.trim()); cell = ''; } else cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function markdownToSections(markdown) {
  if (markdown.length > 2_000_000) throw new Error('The Markdown file exceeds safe import limits.');
  const tokens = marked.lexer(markdown.replace(/\r\n?/g, '\n'), { gfm: true, breaks: false });
  const sections = [];
  const budget = { count: 0 };
  let listGroupCount = 0;
  const inline = (inlineTokens, options = {}) => markdownInline(inlineTokens, options, budget);
  const listItems = (list, indent = 0) => {
    if (indent > MAX_LIST_INDENT) throw new Error('Markdown list nesting exceeds safe import limits.');
    const descriptor = { kind: list.ordered ? 'numbers' : 'bullets', count: Number(list.start) > 0 ? Number(list.start) - 1 : 0 };
    for (const item of list.items) {
      descriptor.count += 1;
      const groupId = `list-group-${++listGroupCount}`;
      let hasPrimary = false;
      for (const token of item.tokens ?? []) {
        if (token.type === 'checkbox' || token.type === 'space') continue;
        if (token.type === 'list') { listItems(token, indent + 1); continue; }
        if (token.type !== 'paragraph' && token.type !== 'text') {
          throw new Error(`Markdown list form "${String(token.type).slice(0, 40)}" is not supported.`);
        }
        const content = inline(token.tokens ?? (token.type === 'text' ? [token] : []));
        if (!hasPrimary) {
          const row = listItemOf(descriptor, content);
          if (item.task) {
            row.text = `${item.checked ? '☑' : '☐'}  ${content}`;
            row.made_by_shortcut = item.checked ? 'shortcut:todo-done-markdown' : 'shortcut:todo-markdown';
          }
          if (indent) row.indent_level = indent;
          row.list_group_id = groupId;
          sections.push(row);
          hasPrimary = true;
        } else if (content.trim()) {
          sections.push({ text: content, list_body_for: groupId });
        }
      }
      if (!hasPrimary) {
        const row = listItemOf(descriptor, '');
        if (item.task) {
          row.text = item.checked ? '☑  ' : '☐  ';
          row.made_by_shortcut = item.checked ? 'shortcut:todo-done-markdown' : 'shortcut:todo-markdown';
        }
        if (indent) row.indent_level = indent;
        row.list_group_id = groupId;
        sections.push(row);
      }
    }
  };
  const blocks = (items, quoteDepth = 0) => {
    if (quoteDepth > 16) throw new Error('Markdown block nesting exceeds safe import limits.');
    for (const token of items) {
      if (++budget.count > 100_000) throw new Error('The Markdown file exceeds safe import limits.');
      switch (token.type) {
        case 'space': case 'def': break;
        case 'heading': sections.push({ text: inline(token.tokens), heading: true, level: token.depth }); break;
        case 'paragraph': sections.push({ text: inline(token.tokens) }); break;
        case 'code': sections.push({ text: token.text, interchange_kind: 'fenced-code', code_fence_language: String(token.lang ?? '').slice(0, 64),
          made_by_shortcut: SHORTCUT_RULES.find(rule => rule.match?.prefix === '```')?.id }); break;
        case 'list': listItems(token); break;
        case 'blockquote':
          for (const child of token.tokens ?? []) {
            if (child.type === 'paragraph') sections.push({ text: inline(child.tokens), made_by_shortcut: SHORTCUT_RULES.find(rule => rule.match?.prefix === '>')?.id });
            else if (child.type === 'space') continue;
            else throw new Error(`Markdown blockquote form "${String(child.type).slice(0, 40)}" is not supported.`);
          }
          break;
        case 'table': {
          const alignments = token.align.map(alignment => alignment ?? 'default');
          const header = token.header.map(cell => inline(cell.tokens, { extractImages: false }));
          sections.push({ text: `| ${header.join(' | ')} |`, interchange_kind: 'table-row', table_row_index: 0, table_alignment: alignments });
          token.rows.forEach((cells, index) => sections.push({ text: `| ${cells.map(cell => inline(cell.tokens, { extractImages: false })).join(' | ')} |`, interchange_kind: 'table-row', table_row_index: index + 1 }));
          break;
        }
        case 'hr': sections.push({ kind: 'divider' }); break;
        case 'html': throw new Error('Markdown block HTML is not supported by this document importer.');
        default: throw new Error(`Markdown block form "${String(token.type).slice(0, 40)}" is not supported.`);
      }
    }
  };
  blocks(tokens);
  if (sections.reduce((total, section) => total + String(section.text ?? '').length, 0) > 2_000_000) {
    throw new Error('The Markdown file exceeds safe import limits.');
  }
  return sections.flatMap(section => {
    if (section.kind === 'divider') return [section];
    const parts = section.text.split(/(⟦image:[^⟧]+⟧[^\n]*)/g).filter(Boolean);
    if (parts.length === 1 && !parts[0].startsWith('⟦image:')) return [section];
    return parts.map(part => {
      const image = /^⟦image:([^⟧]+)⟧(.*)$/.exec(part);
      if (image) { try { return { kind: 'image', src: decodeURIComponent(image[1]), alt: image[2] }; } catch { return { text: image[2] }; } }
      return { ...section, text: part };
    });
  });
}

/** Parse a stored UTF-8 file into an editable Documents page. JSON is accepted
 * only for the two declared portable bundle formats; markup/text never executes. */
export function documentImportFormat(entry = {}) {
  const name = String(entry.name ?? '').toLowerCase();
  const type = String(entry.media_type ?? '').split(';')[0].trim().toLowerCase();
  return (importFormats.formats.find(row => row.extensions.some(extension => name.endsWith(extension)))
    ?? importFormats.formats.find(row => row.media_types.includes(type)))?.id ?? 'auto';
}

export function importDocumentText(text, pageId, { format = 'auto' } = {}) {
  if (format !== 'auto' && !importFormats.formats.some(row => row.id === format)) throw new Error('This document file format is not supported.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('The selected file is empty.');
  if (typeof pageId !== 'string' || !pageId.trim()) throw new Error('A new page identity is required.');
  const source = text.replace(/^\uFEFF/, '');
  // Supported bundles are JSON objects; a Markdown link at byte zero begins
  // with `[` and must stay on the Markdown path.
  if (format === 'json' || (format === 'auto' && /^\s*\{/.test(source))) {
    let bundle;
    try { bundle = JSON.parse(source); } catch { throw new Error('This JSON file is not valid.'); }
    if (bundle?.format === COMPOSITION_FRAGMENT_FORMAT) {
      const imported = importCompositionFragment(bundle, pageId);
      return { title: bundle.title.trim(), page: imported, block_count: countSceneBlocks(imported) };
    }
    if (bundle?.format === COMPOSITION_DOCUMENT_INTERCHANGE_FORMAT) {
      const records = importCompositionDocumentInterchange(bundle);
      const roots = records.document_record.payload.children;
      if (roots.length !== 1 || !roots[0] || roots[0].kind !== 'Container') throw new Error('The document bundle must contain one page.');
      const page = cloneJson(roots[0], 'The imported page');
      return { title: records.index_record.payload.title, page, block_count: countSceneBlocks(page) };
    }
    throw new Error('This JSON file is not a supported Trillion composition bundle.');
  }
  const html = format === 'html' || (format === 'auto' && /^\s*(?:<!doctype\s+html|<html\b|<(?:p|div|h[1-6]|ul|ol|table|blockquote|section|article)\b)/i.test(source));
  const id = pageId.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const built = buildImportedDocument({ doc_id: id, title: '', ...(html ? { body_html: source } : { body_markdown: source }) });
  if (!built.ok) throw new Error(built.reason || 'This file could not be imported.');
  const page = built.document_record.payload.children[0];
  page.id = pageId;
  return { title: '', page, block_count: built.block_count, materialize_shortcuts: !html };
}

/** Convert the ordinary editable page tree to Markdown. This is a readable
 * interchange projection: composition-only styling, source lineage, and remote
 * asset bytes remain with their owning records. */
export function exportDocumentMarkdown(page) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.children)) throw new Error('An editable document page is required.');
  const escapeMarkdown = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/([\\`*_{}\[\]()#+.!>~-])/g, '\\$1');
  const renderInline = value => {
    const marks = [...HTML_INLINE_MARKS].sort((a, b) => b.open_marker.length - a.open_marker.length);
    const findClose = (text, marker, from) => {
      for (let index = from; index < text.length;) {
        const found = text.indexOf(marker, index);
        if (found < 0) return -1;
        let slashes = 0;
        for (let cursor = found - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
        if (slashes % 2 === 0 && found > 0 && !/\s/.test(text[found - 1])) return found;
        index = found + marker.length;
      }
      return -1;
    };
    const render = (text, depth = 0, inLinkLabel = false) => {
      if (depth > 64) throw new Error('The document exceeds safe Markdown export limits.');
      let output = '';
      for (let index = 0; index < text.length;) {
        if (text[index] === '\\' && index + 1 < text.length) { output += text.slice(index, index + 2); index += 2; continue; }
        if (text.startsWith('⟦link:', index)) {
          const tokenEnd = text.indexOf('⟧', index + 6);
          const linkEnd = tokenEnd >= 0 ? text.indexOf('⟦/link⟧', tokenEnd + 1) : -1;
          if (linkEnd >= 0) {
            let url = ''; try { url = safeHttpUrl(decodeURIComponent(text.slice(index + 6, tokenEnd))); } catch { /* malformed token becomes text */ }
            const label = render(text.slice(tokenEnd + 1, linkEnd), depth + 1, true);
            output += url ? `[${label}](${url.replace(/\)/g, '%29')})` : label;
            index = linkEnd + 7;
            continue;
          }
        }
        const mark = marks.find(candidate => text.startsWith(candidate.open_marker, index)
          && !/\s/.test(text[index + candidate.open_marker.length] ?? '')
          && findClose(text, candidate.close_marker, index + candidate.open_marker.length) >= 0);
        if (mark) {
          const close = findClose(text, mark.close_marker, index + mark.open_marker.length);
          const content = text.slice(index + mark.open_marker.length, close);
          const inner = mark.id === 'code' ? content : render(content, depth + 1, inLinkLabel);
          output += mark.id === 'underline' ? `<u>${inner}</u>` : `${mark.open_marker}${inner}${mark.close_marker}`;
          index = close + mark.close_marker.length;
          continue;
        }
        const character = text[index++];
        output += character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;'
          : inLinkLabel && (character === '[' || character === ']') ? `\\${character}` : character;
      }
      return output;
    };
    return render(String(value ?? ''));
  };
  const blocks = [];
  let listState = null;
  const listCounters = new Map();
  const listMarkerWidths = new Map();
  const indentationFor = depth => ' '.repeat(Array.from({ length: depth }, (_, level) => listMarkerWidths.get(level) ?? 2).reduce((sum, width) => sum + width, 0));
  const resetList = () => { listState = null; listCounters.clear(); listMarkerWidths.clear(); };
  let outputSize = 0;
  const addBlock = value => {
    outputSize += String(value).length + 2;
    if (outputSize > 2_000_000) throw new Error('The document exceeds safe Markdown export limits.');
    blocks.push(value);
  };
  const pending = [...page.children].reverse().map(node => ({ node, depth: 0, listIndent: 0 }));
  let visited = 0;
  while (pending.length) {
    const { node, depth, listIndent } = pending.pop();
    if (++visited > 10_000 || depth > 64) throw new Error('The document exceeds safe Markdown export limits.');
    if (!node || typeof node !== 'object') continue;
    if (node.kind === 'Container') {
      if (/^(?:embed|iframe|object|script|style)$/i.test(String(node.props?.custom?.web_element?.tag_name ?? ''))) {
        throw new Error('Markdown export does not support embedded web elements.');
      }
      if (node.props?.look === 'divider' || node.props?.custom?.look === 'divider') {
        resetList(); addBlock('---'); continue;
      }
      const children = Array.isArray(node.children) ? node.children : [];
      const structure = node.props?.interaction?.structure;
      const isListOwner = structure?.list_item === true;
      if (node.props?.shortcut_material_id && structure?.primary_role) {
        const roles = new Map(); const search = [...children]; let inspected = 0;
        let materialState = node.fsm?.initial;
        while (search.length) {
          if (++inspected > 10000) throw new Error('The document exceeds safe Markdown export limits.');
          const child = search.pop();
          // A nested item's primary/state belongs to that item, not this one.
          if (child?.props?.interaction?.structure) continue;
          materialState ??= child?.fsm?.initial;
          const role = child?.props?.content_role;
          if (role && !roles.has(role)) roles.set(role, child);
          search.push(...(child?.children ?? []));
        }
        const primary = roles.get(structure.primary_role);
        const body = roles.get(structure.body_role ?? 'body');
        if (primary?.kind !== 'Text') throw new Error('This interactive block has no supported Markdown text projection.');
        const rules = editingRules.rows.flatMap(row => row.rules ?? []);
        const sameMaterial = rules.filter(rule => rule.material_template?.id === node.props.shortcut_material_id);
        const currentRule = sameMaterial.find(rule => rule.material_template.state === materialState)
          ?? sameMaterial.find(rule => rule.material_template.state === undefined);
        const projected = currentRule ? { ...primary, props: { ...primary.props, made_by_shortcut: currentRule.id } } : primary;
        if (body) pending.push({ node: body, depth: depth + 1, listIndent: isListOwner ? listIndent + 1 : listIndent });
        pending.push({ node: projected, depth: depth + 1, listIndent });
        continue;
      }
      pending.push(...children.slice().reverse().map(child => ({
        node: child, depth: depth + 1,
        listIndent: isListOwner && child.props?.content_role === 'body' ? listIndent + 1 : listIndent,
      })));
      continue;
    }
    if (node.visible === false) continue;
    if (node.kind === 'Image') {
      resetList();
      const src = safeHttpUrl(node.props?.src);
      const alt = String(node.props?.alt ?? '');
      if (src) addBlock(`![${escapeMarkdown(alt)}](${src})`);
      else if (alt) addBlock(alt);
      continue;
    }
    if (node.kind !== 'Text') throw new Error(`Markdown export does not support scene block kind "${String(node.kind ?? 'unknown').slice(0, 64)}".`);
    const props = node.props ?? {};
    const custom = props.custom ?? {};
    let text = renderInline(props.text);
    if (custom.interchange_kind === 'fenced-code') {
      resetList();
      const language = typeof custom.code_fence_language === 'string' ? custom.code_fence_language.replace(/[^a-zA-Z0-9_+.-]/g, '') : '';
      const code = String(props.text ?? '');
      addBlock(markdownCodeFence(code, '`', 3, language));
      continue;
    }
    if (custom.interchange_kind === 'table-row') {
      resetList();
      addBlock(`\u0000TABLE\u0000${text}`);
      if (custom.table_row_index === 0) {
        const alignments = Array.isArray(custom.table_alignment) ? custom.table_alignment : [];
        const separator = alignments.map(align => align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---').join(' | ');
        addBlock(`\u0000TABLESEP\u0000| ${separator} |`);
      }
      continue;
    }
    const level = Number(custom.heading_level);
    if (Number.isInteger(level) && level >= 1 && level <= 6) { resetList(); addBlock(`${'#'.repeat(level)} ${text}`); continue; }
    const shortcut = props.made_by_shortcut;
    if (typeof shortcut === 'string' && /^(?:shortcut:bullet-|shortcut:number-list|shortcut:todo)/.test(shortcut)) {
      if (/^shortcut:todo/.test(shortcut)) text = text.replace(/^[☐☑]\s*/, '');
      else if (shortcut === 'shortcut:number-list') text = text.replace(/^\s*\d+[.)]\s+/, '');
      else text = text.replace(/^[•*-]\s*/, '');
      const indent = Math.min(8, Math.max(listIndent, Number(custom.indent_level) || 0));
      const kind = /^shortcut:todo/.test(shortcut) ? 'todo' : shortcut === 'shortcut:number-list' ? 'number' : 'bullet';
      const key = `${kind}:${indent}`;
      if (!listState || indent > listState.indent || (indent === listState.indent && kind !== listState.kind)) listCounters.set(key, 0);
      const count = (listCounters.get(key) ?? 0) + 1;
      listCounters.set(key, count);
      listState = { kind, indent, count };
      const marker = kind === 'todo' ? (shortcut.includes('done') ? '- [x] ' : '- [ ] ') : kind === 'number' ? `${count}. ` : '- ';
      const indentation = indentationFor(indent);
      listMarkerWidths.set(indent, kind === 'todo' ? 2 : marker.length);
      addBlock(String(text).split('\n').map((line, index) => index ? `${indentation}${' '.repeat(kind === 'todo' ? 2 : marker.length)}${line}` : `${indentation}${marker}${line}`).join('\n'));
      continue;
    }
    if (listIndent > 0) {
      const indentation = indentationFor(Math.min(listIndent, MAX_LIST_INDENT));
      addBlock(String(text).split('\n').map(line => `${indentation}${line}`).join('\n'));
      continue;
    }
    resetList();
    if (shortcut === 'shortcut:quote' || shortcut === 'shortcut:quote-alt') { addBlock(`> ${text.replace(/^>\s*/, '')}`); continue; }
    addBlock(text);
  }
  let markdown = '';
  let previousWasTable = false;
  for (const block of blocks) {
    const row = block.startsWith('\u0000TABLE\u0000');
    const separator = block.startsWith('\u0000TABLESEP\u0000');
    const table = row || separator;
    const value = row ? block.slice('\u0000TABLE\u0000'.length) : separator ? block.slice('\u0000TABLESEP\u0000'.length) : block;
    markdown += `${markdown ? (table && previousWasTable ? '\n' : '\n\n') : ''}${value}`;
    previousWasTable = table;
  }
  if (markdown.length > 2_000_000) throw new Error('The document exceeds safe Markdown export limits.');
  return markdown;
}

function countSceneBlocks(root) {
  let count = 0;
  const pending = [root];
  while (pending.length) { const node = pending.pop(); count += 1; pending.push(...(node.children ?? [])); }
  return count;
}

export function buildImportedDocument(input) {
  // Sanitize any id/title into a safe address segment (lowercase alphanumerics +
  // single dashes) so a producer may hand any raw id/slug (e.g. "article:Foo Bar").
  const slugify = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // Never hard-fail a workflow on a weak id: fall back to a title slug so the emit
  // step always produces an editable document (the title is always present).
  const docId = slugify(input.doc_id) || slugify(input.title);
  if (!docId) {
    return { ok: false, reason: 'missing doc_id and title' };
  }
  const sections = resolveSections(input);
  let content;
  const title = (typeof input.title === 'string' && input.title.trim()) ? input.title.trim() : 'Untitled document';
  const summary = typeof input.summary === 'string' ? input.summary.trim() : (sections.find((s) => !s.heading)?.text ?? '');
  let lineage;
  try {
    content = sectionsToContent(docId, sections);
    lineage = buildLineage(input);
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }

  const documentRecord = { address: `${DOC_PREFIX}${docId}`, path: PUBLISHED_PATH, payload: content };
  const indexRecord = {
    address: `${IDX_PREFIX}${docId}`,
    path: PUBLISHED_PATH,
    payload: {
      kind: INDEX_KIND,
      doc_id: docId,
      doc_address: `${DOC_PREFIX}${docId}`,
      title,
      summary,
      content_labels: Array.isArray(input.content_labels)
        ? input.content_labels.filter((label) => typeof label === 'string' && label.trim()).map((label) => label.trim())
        : [],
      content_type: (typeof input.content_type === 'string' && input.content_type.trim()) ? input.content_type.trim() : 'document',
      status: (typeof input.status === 'string' && input.status.trim()) ? input.status.trim() : 'draft',
      document_revision_hash: revisionHashFor(content),
      ...(lineage ? { lineage } : {}),
      surface_intent: {
        title,
        packageEntry: { packageName: 'documents', entryName: 'documents' },
        surfaceInput: { scene_address: `${DOC_PREFIX}${docId}`, scene_address_mode: 'identity_text', expected_document_revision: revisionHashFor(content) },
      },
      updated_at: typeof input.updated_at === 'string' && input.updated_at ? input.updated_at : '',
    },
  };

  const result = { ok: true, document_record: documentRecord, index_record: indexRecord, block_count: sections.length };
  // Match the exact JSON shape the existing importer writes, including omitted
  // optional lineage fields. In-memory undefined members are not stored facts.
  return JSON.parse(JSON.stringify(result));
}

// The reader supplies current records, not caller assertions of completion.
// Reuse the import mapping so verification cannot drift from saved document
// identity, body normalization, lineage or the canonical revision calculation.
export function verifyImportedDocument(input, currentRecords) {
  const expected = buildImportedDocument(input);
  if (!expected.ok) throw new Error('The expected document is invalid.');
  if (!Array.isArray(currentRecords) || currentRecords.length !== 2) {
    throw new Error('Both saved document records are required.');
  }
  const refs = [];
  for (const wanted of [expected.document_record, expected.index_record]) {
    const rows = currentRecords.filter(row => row?.address === wanted.address);
    if (rows.length !== 1 || !/^1f:[0-9a-f]{64}$/.test(rows[0].content_hash ?? '') || !rows[0].payload) {
      throw new Error('A saved document record is missing or ambiguous.');
    }
    const actual = rows[0].payload;
    if (wanted === expected.document_record) {
      if (stableJson(actual) !== stableJson(wanted.payload)) throw new Error('The saved document does not match the requested draft.');
    } else {
      for (const key of Object.keys(wanted.payload)) {
        if (key === 'updated_at' && !input.updated_at) continue;
        if (stableJson(actual[key]) !== stableJson(wanted.payload[key])) {
          throw new Error('The saved document details do not match the requested draft.');
        }
      }
      if (stableJson(actual.lineage) !== stableJson(wanted.payload.lineage)) {
        throw new Error('The saved document source links do not match.');
      }
    }
    refs.push({address: wanted.address, content_hash: rows[0].content_hash});
  }
  return {verified: true, document_ref: refs[0], index_ref: refs[1],
    document_revision_hash: expected.index_record.payload.document_revision_hash};
}

// A portable bundle for the same owner that reads and writes these two records.
// It deliberately carries the editable scene and index verbatim: block IDs,
// layout/props, inline links, image references, lineage, and publication metadata
// survive without translating them through a narrower interchange format.
export const COMPOSITION_DOCUMENT_INTERCHANGE_FORMAT = 'trillion.composition-document/v1';

function cloneJson(value, label) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new Error(`${label} must contain JSON data.`); }
}

function validateCompositionNodes(roots) {
  const identities = new Set();
  const pending = roots.map(node => ({ node, depth: 0 }));
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    count += 1;
    if (count > 10_000 || depth > 128) throw new Error('The composition exceeds safe import limits.');
    if (!node || typeof node.id !== 'string' || !node.id.trim() || identities.has(node.id)
        || typeof node.kind !== 'string' || !node.kind
        || (node.props !== undefined && (!node.props || typeof node.props !== 'object' || Array.isArray(node.props)))
        || (node.visible !== undefined && typeof node.visible !== 'boolean')
        || (node.children !== undefined && !Array.isArray(node.children))) {
      throw new Error('Composition blocks must have unique identities and valid children.');
    }
    const props = node.props ?? {};
    const webTag = props.custom?.web_element?.tag_name;
    if (typeof webTag === 'string' && /^(?:embed|iframe|link|meta|object|script|style)$/i.test(webTag.trim())) {
      throw new Error('Active embedded web elements cannot be imported from a portable bundle.');
    }
    if (typeof props.src === 'string' && /^(?:javascript|data|vbscript):/i.test(props.src.trim())) {
      throw new Error('Executable or embedded data URLs cannot be imported as composition assets.');
    }
    identities.add(node.id);
    pending.push(...(node.children ?? []).map(child => ({ node: child, depth: depth + 1 })));
  }
}

function validateInterchangeRecords(documentRecord, indexRecord) {
  const document = cloneJson(documentRecord, 'The document record');
  const index = cloneJson(indexRecord, 'The index record');
  const docId = typeof document.address === 'string' && document.address.startsWith(DOC_PREFIX)
    ? document.address.slice(DOC_PREFIX.length) : '';
  if (!docId || !Array.isArray(document.path) || !sameImportedPage({ id: 'path', children: document.path }, { id: 'path', children: PUBLISHED_PATH })) {
    throw new Error('A published composition document record is required.');
  }
  if (!document.payload || typeof document.payload !== 'object' || Array.isArray(document.payload)
      || !Array.isArray(document.payload.children)) {
    throw new Error('The composition document payload is invalid.');
  }
  validateCompositionNodes(document.payload.children);
  const expectedRevision = revisionHashFor(document.payload);
  if (index.address !== `${IDX_PREFIX}${docId}` || index.payload?.kind !== INDEX_KIND
      || index.payload.doc_id !== docId || index.payload.doc_address !== document.address
      || !Array.isArray(index.path) || !sameImportedPage({ id: 'path', children: index.path }, { id: 'path', children: PUBLISHED_PATH })
      || index.payload.document_revision_hash !== expectedRevision
      || index.payload.surface_intent?.surfaceInput?.scene_address !== document.address
      || index.payload.surface_intent?.surfaceInput?.expected_document_revision !== expectedRevision) {
    throw new Error('The document index does not match the composition document revision.');
  }
  return { document_record: document, index_record: index };
}

/** Export the exact records owned by Documents. Remote asset bytes and effective
 * sharing grants live with their own owners, so the bundle names those boundaries
 * instead of implying that it contains them. */
export function exportCompositionDocument(documentRecord, indexRecord) {
  const records = validateInterchangeRecords(documentRecord, indexRecord);
  return {
    format: COMPOSITION_DOCUMENT_INTERCHANGE_FORMAT,
    ...records,
    portability: {
      preserved: ['block-identities', 'composition-content', 'index-metadata', 'lineage-and-source-references'],
      not_included: [
        { kind: 'remote-asset-bytes', owner: 'file-and-content owners', effect: 'Image source references are preserved; referenced bytes are not copied into this bundle.' },
        { kind: 'effective-access-grants', owner: 'sharing-and-permission owners', effect: 'Access policy is not represented by the document and index records.' },
      ],
    },
  };
}

/** Read the Documents interchange format back into the exact records the
 * existing owner writer consumes. This is a pure mapper; persistence still goes
 * through the declared document record action and its current authorization. */
export function importCompositionDocumentInterchange(bundle) {
  if (!bundle || bundle.format !== COMPOSITION_DOCUMENT_INTERCHANGE_FORMAT) {
    throw new Error(`Expected ${COMPOSITION_DOCUMENT_INTERCHANGE_FORMAT}.`);
  }
  return validateInterchangeRecords(bundle.document_record, bundle.index_record);
}

// A projection unit carries only the selected subtree, not the owning page's
// document-index record. Keep its export honest and portable as a composition
// fragment instead of manufacturing a record pair the caller never resolved.
export const COMPOSITION_FRAGMENT_FORMAT = 'trillion.composition-fragment/v1';

function validateCompositionFragment(root) {
  const cloned = cloneJson(root, 'The composition fragment');
  validateCompositionNodes([cloned]);
  return cloned;
}

/** Export exactly the selected scene subtree. Asset bytes and effective access
 * grants belong to their own owners and are deliberately called out. */
export function exportCompositionFragment({ title, subtree }) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('A composition title is required.');
  return {
    format: COMPOSITION_FRAGMENT_FORMAT,
    title: title.trim(),
    root: validateCompositionFragment(subtree),
    portability: {
      preserved: ['selected-scene-subtree', 'block-identities', 'composition-content', 'inline-links-and-image-references'],
      not_included: [
        { kind: 'remote-asset-bytes', owner: 'file-and-content owners', effect: 'Image references remain, but their bytes are not copied.' },
        { kind: 'effective-access-grants', owner: 'sharing-and-permission owners', effect: 'Permissions are not represented by a selected scene subtree.' },
      ],
    },
  };
}

/** Validate a portable fragment and turn it into a page accepted by the
 * existing guarded Documents add/replace flow. The caller supplies a fresh id
 * so the imported page cannot collide with an existing page identity. */
export function importCompositionFragment(bundle, pageId) {
  if (!bundle || bundle.format !== COMPOSITION_FRAGMENT_FORMAT) {
    throw new Error(`Expected ${COMPOSITION_FRAGMENT_FORMAT}.`);
  }
  if (typeof bundle.title !== 'string' || !bundle.title.trim()) throw new Error('A composition title is required.');
  if (typeof pageId !== 'string' || !pageId.trim()) throw new Error('A new page identity is required.');
  const root = validateCompositionFragment(bundle.root);
  return {
    id: pageId,
    kind: 'Container',
    props: { style: { layout: { mode: 'flex', axis: 'y', gap: 10 } } },
    visible: true,
    children: [root],
  };
}
