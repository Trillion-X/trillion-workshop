import { marked } from 'marked';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { markdownCodeFence } from '../read-data/markdown-code-fence.ts';
import editingRules from '../read-data/editing-rules.json' with { type: 'json' };
import importPolicy from '../read-data/import-policy.json' with { type: 'json' };
const utf8Encoder = new TextEncoder();
const HEADING_STYLE = importPolicy.heading_styles;
const BODY_STYLE = importPolicy.body_style;
const MAX_LIST_INDENT = importPolicy.max_list_indent;
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

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
export function revisionHashFor(content) { return makeHashCodeHexFromBytes(utf8Encoder.encode(stableJson(content))); }

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
const SHORTCUT_RULES = editingRules.rows.flatMap((row) => row.rules ?? []);
// A list item as the shortcut that types one writes it: its text prefix and the rule it carries as made_by_shortcut.
function listItemOf(list, text) {
  const rule = SHORTCUT_RULES.find((candidate) => (list.kind === 'numbers' ? candidate.match?.numeric === true : candidate.match?.prefix === '-'));
  const parts = rule?.effect_template?.[0]?.changes?.props?.text?.parts ?? [];
  const lead = parts.map((part) => (typeof part === 'string' ? part : part?.select?.path === 'match' ? `${list.count}.` : '')).join('');
  return rule ? { text: `${lead}${text}`, made_by_shortcut: rule.id } : { text };
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
  const normalizedMarkdown = markdown.replace(/\r\n?/g, '\n');
  const tokens = marked.lexer(normalizedMarkdown, { gfm: true, breaks: false });
  const normalizedByteBoundaries = [];
  const normalizedCharacterBoundaries = [];
  let originalByteOffset = 0;
  let normalizedOffset = 0;
  for (let index = 0; index < markdown.length;) {
    const char = String.fromCodePoint(markdown.codePointAt(index));
    normalizedByteBoundaries[normalizedOffset] = originalByteOffset;
    normalizedCharacterBoundaries[normalizedOffset] = index;
    if (char === '\r' && markdown[index + char.length] === '\n') {
      originalByteOffset += 2;
      normalizedOffset += 1;
      index += 2;
      continue;
    }
    const codePoint = char.codePointAt(0);
    originalByteOffset += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    normalizedOffset += (char === '\r' ? '\n' : char).length;
    index += char.length;
  }
  normalizedByteBoundaries[normalizedOffset] = originalByteOffset;
  normalizedCharacterBoundaries[normalizedOffset] = markdown.length;
  const sections = [];
  const budget = { count: 0 };
  let listGroupCount = 0;
  const inline = (inlineTokens, options = {}) => markdownInline(inlineTokens, options, budget);
  const listItems = (list, sourceBlock, indent = 0) => {
    if (indent > MAX_LIST_INDENT) throw new Error('Markdown list nesting exceeds safe import limits.');
    const start = Number(list.start);
    const descriptor = { kind: list.ordered ? 'numbers' : 'bullets',
      count: Number.isSafeInteger(start) && start >= 0 ? start - 1 : 0 };
    for (const item of list.items) {
      descriptor.count += 1;
      const groupId = `list-group-${++listGroupCount}`;
      let hasPrimary = false;
      for (const token of item.tokens ?? []) {
        if (token.type === 'checkbox' || token.type === 'space') continue;
        if (token.type === 'list') { listItems(token, sourceBlock, indent + 1); continue; }
        if (token.type === 'code') {
          // A fenced code block may be the only body of a list item. Keep an
          // empty primary list shortcut in that case, then attach the code as
          // an ordinary child of the same editable list owner.
          if (!hasPrimary) {
            const row = listItemOf(descriptor, '');
            if (indent) row.indent_level = indent;
            row.list_group_id = groupId;
            sections.push({ ...row, ...(sourceBlock ? { __source_block: sourceBlock } : {}) });
            hasPrimary = true;
          }
          sections.push({
            text: token.text,
            interchange_kind: 'fenced-code',
            code_fence_language: String(token.lang ?? '').slice(0, 64),
            list_body_for: groupId,
            ...(sourceBlock ? { __source_block: sourceBlock } : {}),
          });
          continue;
        }
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
          sections.push({ ...row, ...(sourceBlock ? { __source_block: sourceBlock } : {}) });
          hasPrimary = true;
        } else if (content.trim()) {
          sections.push({ text: content, list_body_for: groupId, ...(sourceBlock ? { __source_block: sourceBlock } : {}) });
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
        sections.push({ ...row, ...(sourceBlock ? { __source_block: sourceBlock } : {}) });
      }
    }
  };
  let sourceTokenIndex = 0;
  let sourceCursor = 0;
  const blocks = (items, quoteDepth = 0) => {
    if (quoteDepth > 16) throw new Error('Markdown block nesting exceeds safe import limits.');
    for (const token of items) {
      if (++budget.count > 100_000) throw new Error('The Markdown file exceeds safe import limits.');
      const tokenRaw = typeof token.raw === 'string' ? token.raw : '';
      const tokenStart = tokenRaw ? normalizedMarkdown.indexOf(tokenRaw, sourceCursor) : -1;
      if (tokenStart >= 0) sourceCursor = tokenStart + tokenRaw.length;
      const normalizedText = tokenRaw.replace(/[\r\n]+$/g, '');
      const textEnd = tokenStart < 0 ? -1 : tokenStart + normalizedText.length;
      const originalTextStart = tokenStart < 0 ? -1 : normalizedCharacterBoundaries[tokenStart];
      const originalTextEnd = textEnd < 0 ? -1 : normalizedCharacterBoundaries[textEnd];
      const text = originalTextStart >= 0 && originalTextEnd >= 0
        ? markdown.slice(originalTextStart, originalTextEnd) : normalizedText;
      const sourceBlock = tokenRaw ? {
        token_index: sourceTokenIndex,
        token_kind: token.type,
        text,
        ...(tokenStart >= 0 && normalizedByteBoundaries[tokenStart] !== undefined && normalizedByteBoundaries[textEnd] !== undefined
          ? { byte_start: normalizedByteBoundaries[tokenStart], byte_end: normalizedByteBoundaries[textEnd] } : {}),
      } : null;
      sourceTokenIndex += 1;
      const tagged = section => ({ ...section, ...(sourceBlock ? { __source_block: sourceBlock } : {}) });
      switch (token.type) {
        case 'space': case 'def': break;
        case 'heading': sections.push(tagged({ text: inline(token.tokens), heading: true, level: token.depth })); break;
        case 'paragraph': sections.push(tagged({ text: inline(token.tokens) })); break;
        case 'code': sections.push(tagged({ text: token.text, interchange_kind: 'fenced-code', code_fence_language: String(token.lang ?? '').slice(0, 64),
          made_by_shortcut: SHORTCUT_RULES.find(rule => rule.match?.prefix === '```')?.id })); break;
        case 'list': listItems(token, sourceBlock); break;
        case 'blockquote':
          for (const child of token.tokens ?? []) {
            if (child.type === 'paragraph') sections.push(tagged({ text: inline(child.tokens), made_by_shortcut: SHORTCUT_RULES.find(rule => rule.match?.prefix === '>')?.id }));
            else if (child.type === 'space') continue;
            else throw new Error(`Markdown blockquote form "${String(child.type).slice(0, 40)}" is not supported.`);
          }
          break;
        case 'table': {
          const alignments = token.align.map(alignment => alignment ?? 'default');
          const header = token.header.map(cell => inline(cell.tokens, { extractImages: false }));
          sections.push(tagged({ text: `| ${header.join(' | ')} |`, interchange_kind: 'table-row', table_row_index: 0, table_alignment: alignments }));
          token.rows.forEach((cells, index) => sections.push(tagged({ text: `| ${cells.map(cell => inline(cell.tokens, { extractImages: false })).join(' | ')} |`, interchange_kind: 'table-row', table_row_index: index + 1 })));
          break;
        }
        case 'hr': sections.push(tagged({ kind: 'divider' })); break;
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
      const language = typeof custom.code_fence_language === 'string' ? custom.code_fence_language.replace(/[^a-zA-Z0-9_+.-]/g, '') : '';
      const code = String(props.text ?? '');
      const fenced = markdownCodeFence(code, '`', 3, language);
      if (listIndent > 0) {
        const indentation = indentationFor(Math.min(listIndent, MAX_LIST_INDENT));
        addBlock(fenced.split('\n').map(line => `${indentation}${line}`).join('\n'));
      } else {
        resetList();
        addBlock(fenced);
      }
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
      const declaredNumber = shortcut === 'shortcut:number-list' ? /^\s*(\d+)[.)]\s+/.exec(text) : null;
      if (/^shortcut:todo/.test(shortcut)) text = text.replace(/^[☐☑]\s*/, '');
      else if (shortcut === 'shortcut:number-list') text = text.replace(/^\s*\d+[.)]\s+/, '');
      else text = text.replace(/^[•*-]\s*/, '');
      const indent = Math.min(8, Math.max(listIndent, Number(custom.indent_level) || 0));
      const kind = /^shortcut:todo/.test(shortcut) ? 'todo' : shortcut === 'shortcut:number-list' ? 'number' : 'bullet';
      const key = `${kind}:${indent}`;
      if (!listState || indent > listState.indent || (indent === listState.indent && kind !== listState.kind)) {
        const start = declaredNumber ? Number(declaredNumber[1]) : 1;
        listCounters.set(key, Number.isSafeInteger(start) && start >= 0 ? start - 1 : 0);
      }
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

export function importMarkdownDocument(markdown, pageId, { includeSourceProvenance = true } = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('The selected Markdown is empty.');
  if (typeof pageId !== 'string' || !pageId.trim()) throw new Error('A new page identity is required.');
  const sections = markdownToSections(markdown);
  const page = sectionsToContent(pageId.replace(/[^a-zA-Z0-9_-]+/g, '-'), sections).children[0];
  page.id = pageId;
  const provenance = includeSourceProvenance ? sections.map((section, blockIndex) => ({
    block_index: blockIndex,
    source_block: section.__source_block ? {
      token_index: section.__source_block.token_index,
      token_kind: section.__source_block.token_kind,
      text: section.__source_block.text,
      ...(Number.isInteger(section.__source_block.byte_start) && Number.isInteger(section.__source_block.byte_end)
        ? { byte_start: section.__source_block.byte_start, byte_end: section.__source_block.byte_end } : {}),
    } : null,
  })) : undefined;
  return { page, block_count: sections.length, ...(provenance ? { source_provenance: provenance } : {}) };
}
