import { blake3 } from '@noble/hashes/blake3.js';

// ── address convention + kinds (SSOT mirror of read-data/document-index.ts) ──
const DOC_PREFIX = 'package::documents::documents::';
const IDX_PREFIX = 'package::documents::document-index::';
const INDEX_KIND = 'composition-document-index';
const PUBLISHED_PATH = ['current-item', 'published-record'];

// ── section -> style (SSOT mirror of read-data/document-sections.ts) ──
const HEADING_STYLE = { 1: { font_size: 30, font_weight: 700 }, 2: { font_size: 22, font_weight: 600 }, 3: { font_size: 18, font_weight: 600 } };
const BODY_STYLE = { font_size: 16, font_weight: 400 };
function styleForSection(s) {
  const base = s.heading || (s.level && s.level > 0) ? (HEADING_STYLE[s.level ?? 1] ?? HEADING_STYLE[3]) : BODY_STYLE;
  return { ...base, ...(s.style ?? {}) };
}
export function sectionsToContent(docId, sections) {
  const children = sections
    .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s, i) => {
      const lineage = buildLineage(s);
      const isHeading = s.heading || (s.level && s.level > 0);
      const headingLevel = Number.isInteger(s.level) && s.level >= 1 && s.level <= 6 ? s.level : 1;
      return { id: `${docId}-b${i}`, kind: 'Text', props: {
        text: s.text.trim(), style: styleForSection(s),
        ...(lineage || isHeading ? { custom: {
          ...(lineage ? { lineage } : {}),
          ...(isHeading ? { heading_level: headingLevel } : {}),
        } } : {}),
      }, visible: true, children: [] };
    });
  // Normal Documents treats each scene root as a page. Keep the authored
  // sections inside the same ordinary vertical Container used by a new page,
  // preserving every block id and its order. This is content structure, not a
  // transcript-specific renderer or an alternate document store.
  return { children: [{
    id: `${docId}-page`,
    kind: 'Container',
    props: { style: { layout: { mode: 'flex', axis: 'y', gap: 10 } } },
    visible: true,
    children,
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
function bodyHtmlToSections(bodyHtml) {
  if (typeof bodyHtml !== 'string' || bodyHtml.trim() === '') return [];
  // Drop JSON-LD / any <script> blocks — never editable body content.
  const cleaned = bodyHtml.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const sections = [];
  const blockRe = /<(h([1-6])|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  let consumed = 0;
  while ((match = blockRe.exec(cleaned)) !== null) {
    const preceding = stripTags(cleaned.slice(consumed, match.index));
    if (preceding) sections.push({ text: preceding });
    const isHeading = match[1].toLowerCase().startsWith('h');
    const level = isHeading ? Number(match[2]) : undefined;
    const text = stripTags(match[3]);
    if (text) sections.push(isHeading ? { text, heading: true, level } : { text });
    consumed = blockRe.lastIndex;
  }
  const trailing = stripTags(cleaned.slice(consumed));
  if (trailing) sections.push({ text: trailing });
  return sections;
}

// Resolve the final ordered sections: prefer structured `sections`, else parse
// `body_html`; always lead with the title as an H1 (unless the first section is
// already that exact title heading) so the document opens with a clear heading.
function resolveSections(input) {
  const provided = Array.isArray(input.sections)
    ? input.sections.filter((s) => s && typeof s.text === 'string' && s.text.trim())
    : [];
  const body = provided.length ? provided : typeof input.body_text === 'string'
    ? input.body_text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(text => ({ text: text.trim() })).filter(s => s.text)
    : bodyHtmlToSections(input.body_html);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const firstIsTitle = body.length > 0 && body[0].heading && body[0].text.trim() === title;
  const lead = title && !firstIsTitle ? [{ text: title, heading: true, level: 1 }] : [];
  return [...lead, ...body];
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
