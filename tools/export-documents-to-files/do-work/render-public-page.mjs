// tools/export-documents-to-files: write a web page from one record and one descriptor.
//
// The record and a descriptor of how to publish it become the page's bytes, its address and a replay proof.
// Which fields are shown, the page's words, colours and structured-data nodes all live in the descriptor,
// never in this code. A section whose operation is unknown still renders through the generic block.
//
// Command: node render-public-page.mjs ENVELOPE.json [OUTPUT.html]
// The envelope is { publication_descriptor, source_record, materialized_values?, correlation_id? }.
// The last line printed is JSON: the artifact's facts (without its bytes when OUTPUT is given) and the proof.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_THEME_TOKENS = {
  backgroundColor: '#111827',
  foregroundColor: '#f8fafc',
  primaryColor: '#38bdf8',
  surfaceColor: '#1f2937',
  defaultBorderRadius: 16,
  defaultPrimaryFontFamily: 'system-ui',
};

const RENDER_OPERATIONS = {
  heading: renderHeading,
  text: renderParagraph,
  paragraph: renderParagraph,
  prose: renderProse,
  list: renderList,
  quote: renderQuote,
  code: renderCode,
  image: renderImage,
  group: renderGroup,
};

export function renderRecordPublicationProjection(input) {
  const descriptor = objectOrEmpty(input.publication_descriptor);
  const source = objectOrEmpty(input.source_record);
  const context = {
    input,
    descriptor,
    source,
    values: objectOrEmpty(input.materialized_values),
  };
  const view = objectOrEmpty(descriptor.view);
  const artifact = objectOrEmpty(descriptor.artifact);
  const title = textFrom(view.title, context, 'Untitled');
  const description = firstNonEmpty([
    textFrom(view.description, context, ''),
    firstTextFromSections(view.sections || [], context),
  ]);
  const language = textFrom(view.language, context, 'en');
  const canonicalUrl = buildCanonicalUrl(artifact.url, context);
  const metadata = buildMetadata(view.metadata || [], title, description, canonicalUrl, context);
  const jsonLd = buildJsonLd(view.schema_graph, context);
  const themeTokens = resolveThemeTokens(descriptor.theme, context);
  const cssVars = Object.entries(resolvePalette(themeTokens))
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');
  const body = (view.sections || []).map((operation) => renderOperation(operation, context)).join('\n');
  const bytes = renderDocumentShell({ language, title, description, canonicalUrl, metadata, jsonLd, cssVars, body });

  return {
    artifact: {
      kind: String(artifact.kind || 'publication_artifact'),
      mime_type: String(artifact.mime_type || 'text/html'),
      bytes,
      canonical_url: canonicalUrl,
      metadata,
      storage_ref: stringOrUndefined(artifact.storage_ref),
      projection_refs: Array.isArray(artifact.projection_refs) ? artifact.projection_refs.map(String) : [],
    },
    proof: {
      descriptor_ref: String(descriptor.descriptor_ref || 'inline-descriptor'),
      source_ref: String(source.ref || 'inline-source'),
      source_revision_ref: String(source.revision_ref || 'unversioned-source'),
      materialized_input_ref: String(descriptor.proof?.materialized_input_ref || 'inline-materialization'),
      process_session_ref: String(descriptor.proof?.process_session_ref || 'process-session:pending'),
      correlation_id: String(input.correlation_id || descriptor.proof?.correlation_id || 'correlation:pending'),
      integrity_policy: objectOrEmpty(artifact.integrity_policy),
    },
  };
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' ? value : {};
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value ? value : undefined;
}

function firstNonEmpty(values) {
  return values.find((value) => value.trim().length > 0) || '';
}

function textFrom(value, context, fallback = '') {
  const resolved = resolveValue(value, context, fallback);
  return resolved == null ? fallback : String(resolved);
}

function resolveValue(value, context, fallback) {
  if (typeof value === 'string' || value == null) return value ?? fallback;
  const from = value.from || 'source_record';
  const root = from === 'materialized_values' ? context.values : from === 'descriptor' ? context.descriptor : context.source;
  const resolved = readPath(root, value.path);
  return resolved == null ? value.fallback ?? fallback : resolved;
}

function readPath(root, path) {
  if (!path) return root;
  const parts = Array.isArray(path) ? path : path.split('.').filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function resolveThemeTokens(theme, context) {
  const tokens = { ...DEFAULT_THEME_TOKENS, ...objectOrEmpty(theme?.tokens) };
  for (const [key, binding] of Object.entries(theme?.token_bindings || {})) {
    const value = resolveValue(binding, context);
    if (value != null) tokens[key] = value;
  }
  return tokens;
}

function renderOperation(operation, context) {
  const renderer = RENDER_OPERATIONS[operation.operation] || renderGeneric;
  return renderer(operation, context);
}

function renderHeading(operation, context) {
  return `<h2>${htmlEscape(textFrom(operation.text, context))}</h2>`;
}

function renderParagraph(operation, context) {
  return `<p>${htmlEscape(textFrom(operation.text, context))}</p>`;
}

// The text of a prose section is written into the page as it is: the owner of the content makes it safe first.
function renderProse(operation, context) {
  return `<div class="prose-section">${textFrom(operation.html || operation.text, context)}</div>`;
}

function renderList(operation, context) {
  const rawItems = resolveValue(operation.items, context, operation.items);
  const items = Array.isArray(rawItems) ? rawItems : [];
  return `<ul>${items.map((item) => `<li>${htmlEscape(String(resolveValue(item, context, item)))}</li>`).join('')}</ul>`;
}

function renderQuote(operation, context) {
  return `<blockquote><p>${htmlEscape(textFrom(operation.text, context))}</p></blockquote>`;
}

function renderCode(operation, context) {
  return `<pre><code>${htmlEscape(textFrom(operation.text, context))}</code></pre>`;
}

function renderImage(operation, context) {
  const attrs = objectOrEmpty(operation.attributes);
  const src = textFrom(attrs.src, context);
  if (!src) return '';
  const alt = textFrom(attrs.alt, context);
  return `<figure><img src="${htmlEscape(src)}" alt="${htmlEscape(alt)}" loading="lazy" /></figure>`;
}

function renderGroup(operation, context) {
  return `<section>${(operation.children || []).map((child) => renderOperation(child, context)).join('\n')}</section>`;
}

function renderGeneric(operation, context) {
  const text = firstNonEmpty([
    textFrom(operation.text, context),
    textFrom(operation.html, context),
    JSON.stringify(operation.attributes || {}),
  ]);
  return text ? `<div class="generic-block">${htmlEscape(text)}</div>` : '';
}

function firstTextFromSections(sections, context) {
  for (const section of sections) {
    const own = textFrom(section.text, context);
    if (own) return own;
    const child = firstTextFromSections(section.children || [], context);
    if (child) return child;
  }
  return '';
}

function buildCanonicalUrl(url, context) {
  const descriptor = objectOrEmpty(url);
  const scheme = String(descriptor.scheme || 'https').replace(/:$/, '');
  const domain = textFrom(descriptor.domain, context, 'example.com').replace(/\/$/, '');
  const path = (descriptor.path_segments || [])
    .map((part) => textFrom(part, context))
    .filter(Boolean)
    .map((part) => part.replace(/^\/|\/$/g, ''))
    .filter(Boolean)
    .join('/');
  return `${scheme}://${domain}/${path}`;
}

function buildMetadata(operations, title, description, canonicalUrl, context) {
  const metadata = {
    'og:title': title,
    'og:type': 'article',
    'og:url': canonicalUrl,
  };
  if (description) metadata['og:description'] = description.slice(0, 160);
  for (const operation of operations) {
    const key = operation.property || operation.name;
    metadata[key] = textFrom(operation.value, context);
  }
  return metadata;
}

// Structured data (schema.org @graph) built from the descriptor's own node list: this code does not know what
// any node type is. It walks the nodes, fills every { "$bind": FieldBinding } from the render context, drops
// whatever ends up empty, and writes the result. A new node type is a new descriptor node, never a code change.
// Returns '' when there is nothing to write.
function buildJsonLd(descriptor, context) {
  const graph = objectOrEmpty(descriptor);
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (rawNodes.length === 0) return '';
  const nodes = rawNodes
    .map((node) => resolveSchemaValue(node, context))
    .filter((node) => node != null && typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length > 0);
  if (nodes.length === 0) return '';
  const doc = {
    '@context': typeof graph.context === 'string' && graph.context ? graph.context : 'https://schema.org',
    '@graph': nodes,
  };
  // `<` is escaped so a filled-in value can never close the script element.
  return JSON.stringify(doc).replace(/</g, '\\u003c');
}

function resolveSchemaValue(value, context) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => resolveSchemaValue(item, context)).filter((item) => item != null && item !== '');
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'object') {
    if ('$bind' in value) {
      const resolved = resolveValue(value.$bind, context);
      return resolved == null || resolved === '' ? undefined : resolved;
    }
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      const resolved = resolveSchemaValue(raw, context);
      if (resolved !== undefined) out[key] = resolved;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

function htmlEscape(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseHexColor(hex) {
  const normalized = String(hex || '').trim();
  const short = /^#([0-9a-f]{3})$/i.exec(normalized);
  if (short) {
    const [r, g, b] = short[1].split('');
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) };
  }
  const long = /^#([0-9a-f]{6})$/i.exec(normalized);
  if (!long) return null;
  return {
    r: parseInt(long[1].slice(0, 2), 16),
    g: parseInt(long[1].slice(2, 4), 16),
    b: parseInt(long[1].slice(4, 6), 16),
  };
}

function rgba(color, alpha) {
  const rgb = parseHexColor(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : color;
}

function readableTextFor(background) {
  const rgb = parseHexColor(background);
  if (!rgb) return '#000000';
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

function resolvePalette(tokens) {
  const background = String(tokens.backgroundColor || DEFAULT_THEME_TOKENS.backgroundColor);
  const foreground = String(tokens.foregroundColor || DEFAULT_THEME_TOKENS.foregroundColor);
  const primary = String(tokens.primaryColor || DEFAULT_THEME_TOKENS.primaryColor);
  const surface = String(tokens.surfaceColor || DEFAULT_THEME_TOKENS.surfaceColor);
  const radius = `${tokens.defaultBorderRadius || DEFAULT_THEME_TOKENS.defaultBorderRadius}px`;
  const font = String(tokens.defaultPrimaryFontFamily || DEFAULT_THEME_TOKENS.defaultPrimaryFontFamily);
  return {
    '--bg-primary': background,
    '--bg-surface': surface,
    '--text-primary': foreground,
    '--text-secondary': rgba(foreground, 0.76),
    '--text-tertiary': rgba(foreground, 0.62),
    '--text-strong': rgba(foreground, 0.92),
    '--accent-primary': primary,
    '--button-primary-bg': primary,
    '--button-primary-text': readableTextFor(primary),
    '--border-primary': rgba(primary, 0.24),
    '--glass-bg-secondary': rgba(primary, 0.08),
    '--glass-bg-hover': rgba(primary, 0.14),
    '--surface-base': background,
    '--radius-default': radius,
    '--font-primary': font,
  };
}

function renderDocumentShell(input) {
  const metadataTags = Object.entries(input.metadata)
    .map(([key, value]) => `<meta property="${htmlEscape(key)}" content="${htmlEscape(value)}" />`)
    .join('\n  ');
  const jsonLdTag = input.jsonLd ? `\n  <script type="application/ld+json">${input.jsonLd}</script>` : '';
  return `<!DOCTYPE html>
<html lang="${htmlEscape(input.language)}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${htmlEscape(input.title)}</title>
  <meta name="description" content="${htmlEscape(input.description.slice(0, 160))}" />
  <link rel="canonical" href="${htmlEscape(input.canonicalUrl)}" />
  ${metadataTags}${jsonLdTag}
  <style>
    :root { ${input.cssVars}; --max-content-width: 720px; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-primary), system-ui, -apple-system, sans-serif;
      line-height: 1.7;
      font-size: 16px;
    }
    article { max-width: var(--max-content-width); margin: 0 auto; padding: 3rem 2rem; }
    h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 1.5rem; line-height: 1.2; }
    h2 { font-size: 1.875rem; font-weight: 700; margin: 2rem 0 1rem; line-height: 1.25; }
    p { margin-bottom: 1.25rem; color: var(--text-secondary); }
    ul, ol { margin-left: 1.5rem; margin-bottom: 1.25rem; }
    li { margin-bottom: 0.5rem; }
    blockquote { border-left: 4px solid var(--border-primary); padding-left: 1rem; margin: 1.5rem 0; color: var(--text-tertiary); font-style: italic; }
    code { background-color: var(--glass-bg-secondary); color: var(--accent-primary); padding: 0.25rem 0.5rem; border-radius: 4px; font-family: Monaco, Courier New, monospace; font-size: 0.9em; }
    pre { background-color: var(--surface-base); border: 1px solid var(--border-primary); border-radius: var(--radius-default); padding: 1rem; overflow-x: auto; margin-bottom: 1.25rem; }
    pre code { background-color: transparent; color: var(--text-secondary); padding: 0; border-radius: 0; }
    figure { margin: 1.5rem 0; text-align: center; }
    img { max-width: 100%; height: auto; border-radius: var(--radius-default); }
    .prose-section, .generic-block { margin: 1.25rem 0; }
    @media (max-width: 640px) {
      article { padding: 1.5rem 1rem; }
      h1 { font-size: 1.875rem; }
      h2 { font-size: 1.5rem; }
    }
  </style>
</head>
<body>
  <article>
    <h1>${htmlEscape(input.title)}</h1>
    ${input.body}
  </article>
</body>
</html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [envelopePath, outputPath] = process.argv.slice(2);
  if (!envelopePath) {
    console.error('Give the path of the envelope file: node render-public-page.mjs ENVELOPE.json [OUTPUT.html]');
    process.exit(1);
  }
  try {
    const output = renderRecordPublicationProjection(JSON.parse(readFileSync(envelopePath, 'utf8')));
    if (outputPath) {
      writeFileSync(outputPath, output.artifact.bytes);
      const { bytes, ...facts } = output.artifact;
      console.log(JSON.stringify({ artifact: { ...facts, byte_length: Buffer.byteLength(bytes) }, proof: output.proof, written: outputPath }));
    } else {
      console.log(JSON.stringify(output));
    }
  } catch (error) {
    console.error(`The page could not be written: ${error.message}. Check that the envelope is JSON with publication_descriptor and source_record.`);
    process.exit(1);
  }
}
