import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { renderRecordPublicationProjection } from '../../export-documents-to-files/do-work/public-page-projection.mjs';
import { completeServedHtml } from '../../ai-readiness/do-work/complete-served-html.mjs';

const PLACEHOLDER_VERSIONS = new Set(['pending', 'unknown', 'unversioned', 'unversioned-source', 'placeholder', 'fake', 'todo', 'process-session:pending']);
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requiredText = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value.trim();
};
const requiredVersion = (value, label) => {
  const text = requiredText(value, label);
  if (PLACEHOLDER_VERSIONS.has(text.toLowerCase())) throw new TypeError(`${label} must be an actual source version, not a placeholder.`);
  return text;
};
const digest = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text));
const RESERVED_SCHEMA_KEYS = new Set(['@context', '@type', 'name', 'description', 'inLanguage', 'mainEntityOfPage', 'dateModified', 'citation']);
const PUBLIC_URL_SCHEMA_KEYS = new Set(['url', 'image', 'contentUrl', 'thumbnailUrl', 'embedUrl', 'sameAs']);
const privateLocalPath = /(?:file:\/\/|(?:^|[\s"'(])~\/|(?:^|[\s"'(])\/(?:Users|home)\/[^/\s]+|(?:^|[\s"'(])\/private\/var\/folders\/)/i;
const publicText = (value, label) => {
  const text = requiredText(value, label);
  if (privateLocalPath.test(text)) throw new TypeError(`${label} cannot contain a private local path.`);
  return text;
};

function visibleSchemaProperty(key, value) {
  const display = item => {
    if (typeof item === 'string') return item;
    if (typeof item === 'number' || typeof item === 'boolean') return String(item);
    if (Array.isArray(item)) return item.map(display).filter(Boolean).join(', ');
    if (isObject(item)) return Object.values(item).map(display).filter(Boolean).join(', ');
    return '';
  };
  const labels = { author: 'Author', datePublished: 'Published', image: 'Image', keywords: 'Keywords', headline: 'Headline' };
  return `${labels[key] ?? key}: ${display(value)}`;
}

function safeSchemaProperties(value) {
  if (value == null) return {};
  if (!isObject(value)) throw new TypeError('document.schemaProperties must be an object.');
  const copy = {};
  const visit = (item, label, key) => {
    if (typeof item === 'string' && privateLocalPath.test(item)) throw new TypeError(`${label} cannot contain a private local path.`);
    if (typeof item === 'string' && PUBLIC_URL_SCHEMA_KEYS.has(key)) {
      let url;
      try { url = new URL(item); } catch { throw new TypeError(`${label} must be a public HTTPS URL.`); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError(`${label} must be a public HTTPS URL.`);
      return url.href;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((entry, index) => visit(entry, `${label}[${index}]`, key));
    if (isObject(item)) return Object.fromEntries(Object.entries(item).map(([childKey, entry]) => [childKey, visit(entry, `${label}.${childKey}`, childKey)]));
    throw new TypeError(`${label} must be JSON-compatible.`);
  };
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_SCHEMA_KEYS.has(key)) throw new TypeError(`schemaProperties cannot override canonical field ${key}.`);
    copy[key] = visit(item, `schemaProperties.${key}`, key);
  }
  return copy;
}

function plainMarkdownInline(markdown) {
  return String(markdown)
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, (whole, label, target) => {
      try { const url = new URL(target); return /^https?:$/.test(url.protocol) ? `${label} (${url.href})` : label; }
      catch { return label; }
    })
    .replace(/<[^>]*>/g, ' ')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .replace(/&(?:amp|#38);/gi, '&').replace(/&(?:lt|#60);/gi, '<').replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:quot|#34);/gi, '"').replace(/&(?:apos|#39);/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Parses Markdown source into safe text-only blocks; raw HTML is stripped and links become visible text + URL. */
export function sectionsFromMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('Markdown body must be a string.');
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const result = [];
  let paragraph = [];
  let quote = [];
  let list = [];
  let code = false;
  const flushParagraph = () => { if (paragraph.length) { const text = plainMarkdownInline(paragraph.join(' ')); if (text) result.push({ kind: 'paragraph', text }); paragraph = []; } };
  const flushQuote = () => { if (quote.length) { const text = plainMarkdownInline(quote.join(' ')); if (text) result.push({ kind: 'quote', text }); quote = []; } };
  const flushList = () => { if (list.length) { const items = list.map(plainMarkdownInline).filter(Boolean); if (items.length) result.push({ kind: 'list', items }); list = []; } };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { flushParagraph(); flushQuote(); flushList(); code = !code; continue; }
    if (code) { paragraph.push(line); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    const quoteLine = line.match(/^\s*>\s?(.*)$/);
    const listLine = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/);
    if (!line.trim()) { flushParagraph(); flushQuote(); flushList(); continue; }
    if (heading) { flushParagraph(); flushQuote(); flushList(); const text = plainMarkdownInline(heading[2]); if (text) result.push({ kind: 'heading', level: Math.max(2, Math.min(6, heading[1].length)), text }); continue; }
    if (quoteLine) { flushParagraph(); flushList(); quote.push(quoteLine[1]); continue; }
    if (listLine) { flushParagraph(); flushQuote(); list.push(listLine[1]); continue; }
    flushQuote(); flushList(); paragraph.push(line.trim());
  }
  flushParagraph(); flushQuote(); flushList();
  return result;
}

const markdownEscape = text => String(text).replace(/([\\`*_{}\[\]()#+!>|~])/g, '\\$1');
const markdownCitationUrl = url => String(url).replaceAll('(', '%28').replaceAll(')', '%29');

/** Serializes semantic sections as body-only Markdown, escaping syntax in source text. */
export function sectionsToMarkdown(sections) {
  if (!Array.isArray(sections)) throw new TypeError('Sections must be an array.');
  return sections.map(section => {
    if (!isObject(section)) throw new TypeError('Sections must be objects.');
    if (section.kind === 'heading') {
      const level = Number(section.level ?? 2);
      if (!Number.isInteger(level) || level < 2 || level > 6) throw new TypeError('Section heading level must be from 2 to 6.');
      return `${'#'.repeat(level)} ${markdownEscape(requiredText(section.text, 'heading text'))}`;
    }
    if (section.kind === 'paragraph') return markdownEscape(requiredText(section.text, 'paragraph text'));
    if (section.kind === 'quote') return `> ${markdownEscape(requiredText(section.text, 'quote text'))}`;
    if (section.kind === 'list') {
      if (!Array.isArray(section.items) || !section.items.length) throw new TypeError('List sections need items.');
      return section.items.map(item => `- ${markdownEscape(requiredText(item, 'list item'))}`).join('\n');
    }
    throw new TypeError(`Unsupported section kind: ${section.kind}`);
  }).join('\n\n');
}

function normalizeSnapshot(input) {
  if (!isObject(input) || !isObject(input.site) || !isObject(input.source) || !Array.isArray(input.routes)) throw new TypeError('Expected site, source, and routes.');
  const origin = requiredText(input.site.origin, 'site.origin');
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch { throw new TypeError('site.origin must be an HTTPS origin.'); }
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin.replace(/\/$/, '') || parsedOrigin.username || parsedOrigin.password) throw new TypeError('site.origin must be a clean HTTPS origin.');
  const source = input.source;
  const sourceRef = requiredText(source.ref, 'source.ref');
  const sourceVersion = requiredVersion(source.version, 'source.version');
  const observedAt = requiredText(source.observedAt, 'source.observedAt');
  if (!Number.isFinite(Date.parse(observedAt))) throw new TypeError('source.observedAt must be a valid visibility observation time.');
  const requestedCursor = source.requestedCursor ?? null;
  if (requestedCursor !== null && (typeof requestedCursor !== 'string' || !requestedCursor)) throw new TypeError('source.requestedCursor must be null or a non-empty cursor.');
  if (typeof source.complete !== 'boolean') throw new TypeError('Source snapshot must declare whether this page is complete.');
  if (source.complete && source.nextCursor != null) throw new TypeError('A complete source page cannot have a continuation cursor.');
  if (!source.complete) requiredText(source.nextCursor, 'source.nextCursor');
  if (!source.complete && source.nextCursor === requestedCursor) throw new TypeError('A page continuation cannot repeat its requested cursor.');
  if (!Array.isArray(source.documents)) throw new TypeError('Source snapshot must contain a documents page.');
  const docs = new Map();
  for (const doc of source.documents) {
    if (!isObject(doc)) throw new TypeError('Each document must be an object.');
    const ref = requiredText(doc.ref, 'document.ref');
    if (docs.has(ref)) throw new TypeError(`Duplicate document reference: ${ref}`);
    requiredVersion(doc.version, `document ${ref} version`);
    requiredText(doc.title, `document ${ref} title`);
    requiredText(doc.schemaType, `document ${ref} schemaType`);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(doc.schemaType)) throw new TypeError(`Document ${ref} schemaType must be a schema.org type name.`);
    requiredText(doc.openGraphType, `document ${ref} openGraphType`);
    if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(doc.openGraphType)) throw new TypeError(`Document ${ref} openGraphType must be a metadata token.`);
    if (typeof doc.description !== 'string' || (!Array.isArray(doc.sections) && typeof doc.bodyMarkdown !== 'string') || !Array.isArray(doc.citations)) throw new TypeError(`Document ${ref} needs description, sections or Markdown, and a citations array.`);
    requiredText(doc.updatedAt, `document ${ref} updatedAt`);
    if (!Number.isFinite(Date.parse(doc.updatedAt))) throw new TypeError(`Document ${ref} updatedAt must be a valid date.`);
    if (doc.schemaProperties?.datePublished != null && (typeof doc.schemaProperties.datePublished !== 'string' || !Number.isFinite(Date.parse(doc.schemaProperties.datePublished)))) throw new TypeError(`Document ${ref} datePublished must be a valid date string.`);
    docs.set(ref, doc);
  }
  const paths = new Set();
  const routeByRef = new Map();
  for (const route of input.routes) {
    if (!isObject(route)) throw new TypeError('Each route must be an object.');
    const ref = requiredText(route.documentRef, 'route.documentRef');
    if (!docs.has(ref) || routeByRef.has(ref)) throw new TypeError(`Route has an unknown or duplicate document reference: ${ref}`);
    const path = requiredText(route.path, `route ${ref} path`);
    if (!path.startsWith('/') || path.startsWith('//') || /[?#\s\\]/.test(path)) throw new TypeError(`Route ${ref} must be an origin-relative path without query, fragment, whitespace, or backslash.`);
    const normalizedPath = new URL(path, origin).pathname;
    if (normalizedPath !== path || paths.has(path)) throw new TypeError(`Duplicate or non-canonical route: ${path}`);
    paths.add(path);
    routeByRef.set(ref, path);
  }
  if (routeByRef.size !== docs.size) throw new TypeError('Every document in this source page must have exactly one route.');
  return { origin, site: { name: publicText(input.site.name, 'site.name'), language: requiredText(input.site.language, 'site.language') }, sourceRef, sourceVersion, observedAt, requestedCursor, complete: source.complete, nextCursor: source.nextCursor ?? null, docs, routeByRef };
}

function safeSections(sections) {
  const semantic = sections.map(section => {
    if (!isObject(section)) throw new TypeError('Document sections must be objects.');
    if (section.kind === 'heading') {
      const level = Number(section.level ?? 2);
      if (!Number.isInteger(level) || level < 2 || level > 6) throw new TypeError('Section heading level must be from 2 to 6.');
      return { kind: 'heading', level, text: publicText(section.text, 'heading text') };
    }
    if (section.kind === 'paragraph') return { kind: 'paragraph', text: publicText(section.text, 'paragraph text') };
    if (section.kind === 'quote') return { kind: 'quote', text: publicText(section.text, 'quote text') };
    if (section.kind === 'list') {
      if (!Array.isArray(section.items) || !section.items.length) throw new TypeError('List sections need items.');
      return { kind: 'list', items: section.items.map(item => publicText(item, 'list item')) };
    }
    throw new TypeError(`Unsupported section kind: ${section.kind}`);
  });
  const materializedValues = { sections: semantic.map(section => section.kind === 'list' ? section.items : []) };
  const operations = semantic.map((section, index) => section.kind === 'list'
    ? { operation: 'list', items: { from: 'materialized_values', path: `sections.${index}` } }
    : { operation: section.kind === 'heading' ? 'heading' : section.kind === 'quote' ? 'quote' : 'paragraph', text: section.text });
  return { semantic, operations, materializedValues };
}

/** Pure projection of one complete or continued page whose caller has resolved current public rights. */
export function prepareContentForDiscovery(input) {
  const normalized = normalizeSnapshot(input);
  const documents = [];
  for (const [ref, sourceDoc] of normalized.docs) {
    const path = normalized.routeByRef.get(ref);
    const canonicalUrl = new URL(path, normalized.origin).href;
    const title = publicText(sourceDoc.title, `document ${ref} title`);
    const description = publicText(sourceDoc.description, `document ${ref} description`);
    const schemaProperties = safeSchemaProperties(sourceDoc.schemaProperties);
    if (schemaProperties.datePublished) schemaProperties.datePublished = new Date(schemaProperties.datePublished).toISOString();
    const bodySections = safeSections(sourceDoc.sections ?? sectionsFromMarkdown(sourceDoc.bodyMarkdown));
    const citations = sourceDoc.citations.map(citation => {
      if (!isObject(citation)) throw new TypeError(`Document ${ref} citations must be objects.`);
      const label = publicText(citation.label, 'citation.label');
      let url;
      try { url = new URL(requiredText(citation.url, 'citation.url')); } catch { throw new TypeError('citation.url must be a public HTTPS URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('citation.url must be a public HTTPS URL.');
      return { url: url.href, label };
    });
    const semanticSections = [...bodySections.semantic, ...citations.map(citation => ({ kind: 'paragraph', text: `Source: ${citation.label} (${citation.url})` }))];
    const renderSections = [...bodySections.operations, ...citations.map(citation => ({ operation: 'paragraph', text: `Source: ${citation.label} (${citation.url})` }))];
    const schemaLines = Object.entries(schemaProperties).map(([key, value]) => visibleSchemaProperty(key, value));
    semanticSections.push(...schemaLines.map(text => ({ kind: 'paragraph', text })));
    renderSections.push(...schemaLines.map(text => ({ operation: 'paragraph', text })));
    const jsonLd = { '@context': 'https://schema.org', '@type': sourceDoc.schemaType, name: title, description, inLanguage: normalized.site.language, mainEntityOfPage: canonicalUrl, dateModified: sourceDoc.updatedAt, citation: citations.map(item => item.url), ...schemaProperties };
    if (jsonLd.dateModified && !Number.isFinite(Date.parse(jsonLd.dateModified))) throw new TypeError(`Document ${ref} updatedAt must be a date.`);
    const page = renderRecordPublicationProjection({
      publication_descriptor: {
        descriptor_ref: `projection:${ref}:${sourceDoc.version}`,
        artifact: { kind: 'public-content-page', mime_type: 'text/html', url: { scheme: 'https', domain: new URL(normalized.origin).host, path_segments: path.split('/').filter(Boolean) }, integrity_policy: { untrusted_content: 'escaped' } },
        proof: { materialized_input_ref: normalized.sourceVersion, process_session_ref: normalized.observedAt },
        view: { title, description, language: normalized.site.language, metadata: [{ property: 'og:type', value: sourceDoc.openGraphType }], sections: renderSections, schema_graph: { context: 'https://schema.org', nodes: [jsonLd] } },
      },
      source_record: { ref, revision_ref: sourceDoc.version },
      materialized_values: bodySections.materializedValues,
      correlation_id: `${normalized.sourceRef}:${ref}:${sourceDoc.version}`,
    });
    let html = completeServedHtml(page.artifact.bytes, { canonical_url: canonicalUrl, updated_at: sourceDoc.updatedAt });
    const headingLevels = semanticSections.filter(section => section.kind === 'heading').map(section => section.level);
    let headingIndex = 0;
    const oldHeadings = new RegExp(`${LT}h2([^>]*)${GT}([\\s\\S]*?)${LT}/h2${GT}`, 'gi');
    html = html.replace(oldHeadings, (_match, attrs, body) => {
      const level = headingLevels[headingIndex++] ?? 2;
      return `${LT}h${level}${attrs}${GT}${body}${LT}/h${level}${GT}`;
    });
    const bodyMarkdown = [
      sectionsToMarkdown([...bodySections.semantic, ...schemaLines.map(text => ({ kind: 'paragraph', text }))]),
      ...(citations.length ? [`## Sources\n\n${citations.map(citation => `- [${markdownEscape(citation.label)}](${markdownCitationUrl(citation.url)})`).join('\n')}`] : []),
    ].filter(Boolean).join('\n\n');
    const markdown = `# ${markdownEscape(title)}\n\n${markdownEscape(description)}${bodyMarkdown ? `\n\n${bodyMarkdown}` : ''}\n`;
    documents.push({ updatedAt: new Date(sourceDoc.updatedAt).toISOString(), canonicalUrl, path, title, description, openGraphType: sourceDoc.openGraphType, schemaProperties, sections: semanticSections, citations, bodyMarkdown, html, markdown, jsonLd, identity: { html: digest(html), markdown: digest(markdown), jsonLd: digest(JSON.stringify(jsonLd)) } });
  }
  const sitemap = { kind: 'urlset-page', complete: normalized.complete, nextCursor: normalized.nextCursor, urls: documents.map(doc => ({ loc: doc.canonicalUrl, lastmod: doc.updatedAt })) };
  const rss = { kind: 'rss-channel-page', title: normalized.site.name, link: normalized.origin, complete: normalized.complete, nextCursor: normalized.nextCursor, items: documents.map(doc => ({ title: doc.title, link: doc.canonicalUrl, guid: doc.canonicalUrl, description: doc.description, pubDate: new Date(doc.updatedAt).toUTCString(), sources: doc.citations })) };
  const llms = [`# ${normalized.site.name}`, '', ...documents.flatMap(doc => [`## ${doc.title}`, doc.canonicalUrl, doc.description, ...Object.entries(doc.schemaProperties).map(([key, value]) => visibleSchemaProperty(key, value)), ...doc.citations.map(citation => `Source: ${citation.label} (${citation.url})`), ''])].join('\n');
  const manifest = { kind: 'public-content-discovery-manifest', source: { version: normalized.sourceVersion, observedAt: normalized.observedAt, requestedCursor: normalized.requestedCursor, complete: normalized.complete, continuation: normalized.nextCursor }, site: { ...normalized.site, origin: normalized.origin }, documents: documents.map(({ path, canonicalUrl, title, description, updatedAt, openGraphType, schemaProperties, citations, identity }) => ({ path, canonicalUrl, title, description, updatedAt, openGraphType, schemaProperties, citations, identity })) };
  return { manifest, outputs: { documents, sitemap, rss, llms }, diagnostics: [] };
}
