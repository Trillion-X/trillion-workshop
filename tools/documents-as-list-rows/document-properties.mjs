// src/document-properties.mjs
//
// Purpose: a folder of the person's text documents as the rows of a list, so a saved view queries documents live the
// way it queries rows (Obsidian Bases over a vault). A list names the folder with row_sources [{ source: 'documents',
// of: '/notes' }]; each document is a row whose values are named by namespace and key (src/lists.json
// source_namespaces.documents): its own properties (note.status), written in the document itself as frontmatter; the
// facts of its file (file.name, file.folder, file.mtime, file.size, file.links, file.backlinks, file.tags ...,
// src/document-properties.json file_facts); and the folder's formulas (formula.late), worked out by the formula engine
// from the other two. Each property's kind and the folder's formulas are one small sidecar file at the top of the
// folder (sidecar_name), so the documents, their types and their formulas are plain files any tool can read and write.
//
// Non-Negotiable Invariants:
//   1. The documents stay where they are. A row is read from the person's Namespace through its own routes (listing,
//      contents, entry) under the request's own Namespace rights; nothing is copied into list records.
//   2. A property change rewrites only that property's frontmatter lines, and the new bytes are named only if the
//      document is still what was read (the Namespace's expected_identity), so a change made meanwhile is never lost: the
//      change is made again on what the document now says, at most limits.write_attempts times. A caller that names the
//      identity it read (if_identity) is refused instead when the document changed.
//   3. A value is written only if it fits its property's kind (src/lists.json field_kinds); file facts and formulas are
//      worked out and never written; a document is removed as a file, never as a row.
//   4. A formula may read another formula; each row's formulas are worked out once each (a per-row cache), and a formula
//      that reaches itself is refused with the formulas it passed through, both when the sidecar is saved and when it is
//      read (a sidecar written by hand is checked the same way).
//   5. Parsed documents are kept by content identity: a document's bytes never change under one identity, so nothing kept
//      is stale. Every read is bounded by DATA (documents_per_read, bytes_per_document ...) and says complete: false
//      when it stopped short.
//
// Frontmatter is the YAML block between the first two `---` lines. What is read: `key: value` lines whose value is a
// JSON value, a quoted or plain scalar, or a [a, b] list, and `key:` followed by `- item` lines. A key whose value is
// anything else (a nested mapping) reads as its text and is kept byte for byte when another key changes. What is
// written is the same subset: plain scalars when unambiguous, JSON-quoted strings otherwise, and `- item` lists.
//
//   documentRowSources({ files, evaluateBinding, index? }) → { sources, declared } for withRowSources (src/lists.mjs); `index` is
//     the persistent metadata index (src/document-meta-index.mjs) a read consults before reading a document's bytes
//   namespaceFiles(http) → the Namespace reads and the conditional write this file uses, over its HTTP routes
//   readDocumentTypes(files, folder) / saveDocumentTypes(files, folder, { types, formulas, expected_identity })
//   readFrontmatter(text) / writeFrontmatter(text, { set, remove })
import data from '../query-and-change-list-rows/src/document-properties.json' with { type: 'json' };
import listsData from '../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from '../query-and-change-list-rows/src/list-refusals.mjs';

const { limits } = data;
const NS = listsData.source_namespaces[data.source];
const KINDS = new Map(listsData.field_kinds.map(kind => [kind.id, kind]));
const PROPERTY_KINDS = new Set(data.property_kinds);
const KEY = new RegExp(data.property_key);
const EXTENSIONS = new Set(data.document_extensions.map(ext => ext.toLowerCase()));
const LINKS = data.links.map(row => ({ ...row, re: new RegExp(row.pattern, 'g') }));
const INLINE_TAG = new RegExp(data.inline_tag, 'g');
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const lower = keys => new Set(keys.map(key => key.toLowerCase()));
const TAG_KEYS = lower(data.tag_keys);
const ALIAS_KEYS = lower(data.alias_keys);

// ---- frontmatter --------------------------------------------------------------------------------------------------

const FENCE = /^---[ \t]*\r?$/;
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*\r?$/;
const ITEM_LINE = /^[ \t]+-[ \t]+(.*?)[ \t]*\r?$|^-[ \t]+(.*?)[ \t]*\r?$/;

function scalar(raw) {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('"') || (text.startsWith('{') && text.endsWith('}'))) { try { return JSON.parse(text); } catch { return text; } }
  if (text.length > 1 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith('[') && text.endsWith(']')) {
    try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed; } catch { /* a YAML flow list of plain scalars */ }
    const inner = text.slice(1, -1).trim();
    return inner ? inner.split(',').map(scalar) : [];
  }
  return text;
}

/** The frontmatter of a document: { properties, blocks: [{ key, from, to }] (line ranges), head: { from, to } | null, lines }. */
export function readFrontmatter(text) {
  const lines = String(text).split('\n');
  if (!FENCE.test(lines[0] ?? '')) return { properties: {}, blocks: [], head: null, lines };
  const end = lines.findIndex((line, index) => index > 0 && (FENCE.test(line) || /^\.\.\.[ \t]*\r?$/.test(line)));
  if (end < 0 || lines.slice(0, end).join('\n').length > limits.frontmatter_chars) return { properties: {}, blocks: [], head: null, lines };
  const blocks = [];
  for (let index = 1; index < end; index += 1) {
    const match = KEY_LINE.exec(lines[index]);
    if (match) blocks.push({ key: match[1], inline: match[2] ?? '', from: index, to: index + 1 });
    else if (blocks.length) blocks.at(-1).to = index + 1;
  }
  const properties = {};
  for (const block of blocks.slice(0, limits.properties_per_document)) {
    const rest = lines.slice(block.from + 1, block.to).filter(line => line.trim() && !line.trim().startsWith('#'));
    if (block.inline !== '') properties[block.key] = scalar(block.inline);
    else if (!rest.length) properties[block.key] = null;
    else if (rest.every(line => ITEM_LINE.test(line))) properties[block.key] = rest.map(line => { const match = ITEM_LINE.exec(line); return scalar(match[1] ?? match[2]); });
    else properties[block.key] = rest.map(line => line.replace(/\r$/, '')).join('\n');
  }
  return { properties, blocks, head: { from: 0, to: end + 1 }, lines };
}

const PLAIN = /^[^\s"'[\]{}#&*!|>%@`,:?-][^:#\n]*$/;
const formatScalar = value => {
  if (typeof value !== 'string') return JSON.stringify(value);
  const read = scalar(value);
  return PLAIN.test(value) && !/\s$/.test(value) && read === value ? value : JSON.stringify(value);
};
const formatBlock = (key, value) => Array.isArray(value)
  ? (value.length ? [`${key}:`, ...value.map(item => `  - ${formatScalar(item)}`)] : [`${key}: []`])
  : [`${key}: ${formatScalar(value)}`];

/** The document with its frontmatter changed: `set` keys written (in place, or added at the end), `remove` keys left out. */
export function writeFrontmatter(text, { set = {}, remove = [] } = {}) {
  const read = readFrontmatter(text);
  const gone = new Set(remove);
  const head = [];
  const done = new Set();
  if (read.head) {
    let at = 1;
    for (const block of read.blocks) {
      head.push(...read.lines.slice(at, block.from));
      at = block.to;
      if (gone.has(block.key)) continue;
      if (Object.hasOwn(set, block.key)) { if (!done.has(block.key)) head.push(...formatBlock(block.key, set[block.key])); done.add(block.key); continue; }
      head.push(...read.lines.slice(block.from, block.to));
    }
    head.push(...read.lines.slice(at, read.head.to - 1));
  }
  for (const [key, value] of Object.entries(set)) if (!done.has(key) && !gone.has(key)) head.push(...formatBlock(key, value));
  const body = read.head ? read.lines.slice(read.head.to).join('\n') : String(text);
  const kept = head.filter(line => line.trim());
  return kept.length ? ['---', ...head, '---', body].join('\n') : body;
}

// ---- kinds ----------------------------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
// A value as its kind keeps it, or undefined when it is not one.
function fitted(kind, value) {
  if (value === null) return null;
  const shape = KINDS.get(kind)?.value;
  if (shape === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : undefined;
  if (shape === 'texts') {
    const items = Array.isArray(value) ? value : [value];
    return items.every(item => typeof item === 'string' || typeof item === 'number') ? items.map(String) : undefined;
  }
  if (kind === 'date') return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value === 'string' ? value : undefined;
}

// ---- links and tags -------------------------------------------------------------------------------------------------

/** What a document says about itself: { properties, links: [{ target, resolve, embed }], tags, aliases }. */
export function parseDocument(text) {
  const read = readFrontmatter(text);
  const body = read.head ? read.lines.slice(read.head.to).join('\n') : String(text);
  const links = [];
  for (const rule of LINKS) {
    rule.re.lastIndex = 0;
    for (const match of body.matchAll(rule.re)) {
      const target = decodeURI(match[1].trim());
      if (target && !SCHEME.test(target) && links.length < limits.links_per_document) links.push({ target, resolve: rule.resolve, embed: rule.embed });
    }
  }
  const listed = keys => [...new Set(Object.entries(read.properties).filter(([key]) => keys.has(key.toLowerCase()))
    .flatMap(([, value]) => (Array.isArray(value) ? value : value === null ? [] : String(value).split(/[,\s]+/)))
    .map(item => String(item).replace(/^#/, '').trim()).filter(Boolean))];
  const tags = new Set(listed(TAG_KEYS));
  INLINE_TAG.lastIndex = 0;
  for (const match of body.matchAll(INLINE_TAG)) tags.add(match[1]);
  return { properties: read.properties, links, tags: [...tags], aliases: listed(ALIAS_KEYS) };
}

const folderOf = name => name.slice(0, name.lastIndexOf('/')) || '/';
const leafOf = name => name.slice(name.lastIndexOf('/') + 1);
const extensionOf = name => { const leaf = leafOf(name); const dot = leaf.lastIndexOf('.'); return dot > 0 ? leaf.slice(dot + 1) : ''; };
const stemOf = name => { const leaf = leafOf(name); const dot = leaf.lastIndexOf('.'); return dot > 0 ? leaf.slice(0, dot) : leaf; };
const isDocument = name => EXTENSIONS.has(extensionOf(name).toLowerCase()) && leafOf(name) !== data.sidecar_name;
const joinPath = (folder, relative) => {
  const parts = (relative.startsWith('/') ? relative : `${folder}/${relative}`).split('/');
  const out = [];
  for (const part of parts) { if (!part || part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
  return `/${out.join('/')}`;
};

// ---- the sidecar: property kinds and formulas -------------------------------------------------------------------------

const formulaReads = binding => {
  const found = new Set();
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isObject(node)) return;
    if (isObject(node.select) && Array.isArray(node.select.path) && node.select.path[0] === NS.formulas && typeof node.select.path[1] === 'string') found.add(node.select.path[1]);
    Object.values(node).forEach(walk);
  };
  walk(binding);
  return [...found];
};

/** Refuses a formula that reaches itself, naming the formulas it passes through. */
function checkCycles(formulas) {
  const state = new Map();
  const visit = (name, trail) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'open') throw say('formula_cycle', { formula: name, through: [...trail.slice(trail.indexOf(name)), name].join(' → ') });
    state.set(name, 'open');
    for (const next of formulaReads(formulas[name].binding)) if (formulas[next]) visit(next, [...trail, name]);
    state.set(name, 'done');
  };
  for (const name of Object.keys(formulas)) visit(name, []);
}

/** A sidecar's { types, formulas }, checked: kinds from property_kinds, keys like a property, no formula reaching itself. */
export function checkDocumentTypes(input) {
  const refuse = what => say('bad_document_types', { kinds: [...PROPERTY_KINDS].join(', '), formulas: limits.formulas_per_folder, what });
  if (!isObject(input)) throw refuse('this sidecar');
  const types = input.types ?? {};
  const formulas = input.formulas ?? {};
  if (!isObject(types) || !isObject(formulas)) throw refuse('types or formulas');
  for (const [key, kind] of Object.entries(types)) if (!KEY.test(key) || !PROPERTY_KINDS.has(kind)) throw refuse(`${JSON.stringify(key)}: ${JSON.stringify(kind)}`);
  if (Object.keys(formulas).length > limits.formulas_per_folder) throw refuse(`${Object.keys(formulas).length} formulas`);
  for (const [name, formula] of Object.entries(formulas)) {
    if (!KEY.test(name) || !isObject(formula) || !isObject(formula.binding) || (formula.kind !== undefined && !PROPERTY_KINDS.has(formula.kind)))
      throw refuse(`the formula ${JSON.stringify(name)}`);
  }
  checkCycles(formulas);
  return { types: { ...types }, formulas: Object.fromEntries(Object.entries(formulas).map(([name, row]) => [name, { binding: row.binding, ...(row.kind ? { kind: row.kind } : {}) }])) };
}

const sidecarName = folder => `${folder === '/' ? '' : folder}/${data.sidecar_name}`;
const folderKey = folder => {
  const trimmed = String(folder ?? '/').trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed || '/' : `/${trimmed}`;
};

/** A folder's sidecar: { folder, name, identity (null when there is none), types, formulas }. */
export async function readDocumentTypes(files, folder) {
  const at = folderKey(folder);
  const name = sidecarName(at);
  const entry = await files.entry(name);
  if (!entry || entry.folder) return { folder: at, name, identity: null, types: {}, formulas: {} };
  const read = await files.read(entry.identity, limits.sidecar_bytes);
  let parsed;
  try { parsed = JSON.parse(read.text); } catch { throw say('bad_document_types', { kinds: [...PROPERTY_KINDS].join(', '), formulas: limits.formulas_per_folder, what: `${name} (not JSON)` }); }
  return { folder: at, name, identity: entry.identity, ...checkDocumentTypes(parsed) };
}

/** A folder's sidecar as written (every key), or null when there is none: for what else a sidecar keeps (src/list-plain-files.mjs). */
export async function readSidecar(files, folder) {
  const entry = await files.entry(sidecarName(folderKey(folder)));
  if (!entry || entry.folder) return null;
  try { const parsed = JSON.parse((await files.read(entry.identity, limits.sidecar_bytes)).text); return isObject(parsed) ? parsed : null; } catch { return null; }
}

/** Writes a folder's sidecar (the whole of it, so a type or formula left out is removed), if it is still what was read. */
export async function saveDocumentTypes(files, folder, { types, formulas, expected_identity } = {}) {
  const at = folderKey(folder);
  const checked = checkDocumentTypes({ types, formulas });
  const name = sidecarName(at);
  const entry = await files.entry(name);
  const expected = expected_identity === undefined ? entry?.identity ?? null : expected_identity;
  // What else the sidecar says (a list's own definition, src/list-plain-files.mjs) is kept as it is.
  const rest = Object.fromEntries(Object.entries((await readSidecar(files, at)) ?? {}).filter(([key]) => key !== 'types' && key !== 'formulas'));
  const written = await files.writeIfUnchanged(name, `${JSON.stringify({ ...rest, ...checked }, null, 2)}\n`, expected, 'application/json');
  if (written.conflict) throw say('document_changed', { document: name, expected: expected ?? 'nothing', current: written.current ?? 'nothing' });
  return { folder: at, name, identity: written.identity, ...checked };
}

// ---- the Namespace, through its own routes ------------------------------------------------------------------------------

const decode = page => page.encoding === 'base64' ? new TextDecoder().decode(Uint8Array.from(atob(page.content), char => char.charCodeAt(0))) : page.content;

/**
 * The Namespace reads and the conditional write over its HTTP routes (`http(path, method, body)` answers the route's
 * JSON, throwing with `.status` on a refusal: src/standalone-resource-behavior.mjs namespaceHttp).
 */
export function namespaceFiles(http) {
  return {
    foldersUnder: async folder => (await http('/namespace/folders-under', 'POST', { folder })).folders ?? [],
    list: (folder, after, limit) => http('/namespace/listing', 'POST', { collection: folder, after, limit }),
    entry: async name => (await http('/namespace/entry', 'POST', { name, metadata: 'file' })).entry ?? null,
    // The first `most` bytes of one file by its identity, as text: { identity, text, complete }.
    read: async (identity, most) => {
      let text = '', offset = 0, total = null;
      while (offset < most) {
        const page = await http('/namespace/contents/read', 'POST', { identity, offset, length: Math.min(262144, most - offset) });
        total = page.byte_length;
        if (!page.bytes_returned) break;
        text += decode(page);
        offset += page.bytes_returned;
        if (offset >= total) break;
      }
      return { identity, text, complete: total !== null && offset >= total };
    },
    write: (name, text, mediaType) => http('/namespace/write', 'POST', { name, text, media_type: mediaType }),
    remove: names => (names.length ? http('/namespace/names', 'POST', { names: names.map(name => ({ name, remove: true })) }) : { named: 0 }),
    // New bytes under a staging name, then the real name given them only if it still holds `expected` (null: no file),
    // the staging name removed in the same step: { identity } or { conflict: true, current }.
    writeIfUnchanged: async (name, text, expected, mediaType) => {
      const staging = `${name}${data.staging_suffix}`;
      const kept = await http('/namespace/write', 'POST', { name: staging, text, media_type: mediaType });
      try {
        await http('/namespace/names', 'POST', { names: [{ name, identity: kept.identity, expected_identity: expected }, { name: staging, remove: true }] });
        return { identity: kept.identity };
      } catch (error) {
        if (error?.status !== 409) throw error;
        await http('/namespace/names', 'POST', { names: [{ name: staging, remove: true }] });
        return { conflict: true, current: (await http('/namespace/entry', 'POST', { name, metadata: 'file' })).entry?.identity ?? null };
      }
    },
  };
}

// ---- documents as rows -------------------------------------------------------------------------------------------------

// Parsed documents by content identity, the oldest forgotten first past limits.parsed_kept: `kept` is one owner's own
// (documentRowSources), `index` the persistent one behind it.
async function parsedOf(files, identity, { kept: parsedKept, index }, fresh) {
  if (parsedKept.has(identity)) return parsedKept.get(identity);
  const indexed = index ? await index.get(identity) : null;
  const read = indexed ? null : await files.read(identity, limits.bytes_per_document);
  const parsed = indexed ?? { ...parseDocument(read.text), complete: read.complete };
  if (!indexed && index) fresh.push([identity, parsed]);
  parsedKept.set(identity, parsed);
  if (parsedKept.size > limits.parsed_kept) parsedKept.delete(parsedKept.keys().next().value);
  return parsed;
}

// Every document in a folder and the folders under it, by name, at most documents_per_read: { documents, complete }.
async function scan(files, folder) {
  const folders = [...new Set([folder, ...(await files.foldersUnder(folder))])].sort();
  const documents = [];
  let complete = folders.length <= limits.folders_per_read;
  for (const at of folders.slice(0, limits.folders_per_read)) {
    let after = '';
    do {
      const page = await files.list(at, after, limits.listing_page);
      for (const row of page.names ?? []) if (row.identity && isDocument(row.name)) documents.push(row);
      after = page.next_after ?? null;
      if (documents.length >= limits.documents_per_read) { complete = false; after = null; }
    } while (after);
    if (documents.length >= limits.documents_per_read) break;
  }
  documents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { documents: documents.slice(0, limits.documents_per_read), complete };
}

const iso = value => {
  if (value === null || value === undefined) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

// The file facts of every scanned document, links resolved among them and backlinks inverted.
async function documentsOf(files, folder, memory) {
  const { documents, complete } = await scan(files, folder);
  const parsed = new Map();
  const fresh = [];
  for (const row of documents) parsed.set(row.name, await parsedOf(files, row.identity, memory, fresh));
  if (fresh.length) await memory.index.add(fresh);
  const byStem = new Map();
  for (const row of documents) {
    for (const key of [stemOf(row.name), leafOf(row.name), ...(parsed.get(row.name).aliases ?? [])].map(item => item.toLowerCase())) {
      if (!byStem.has(key)) byStem.set(key, row.name);
    }
  }
  const resolve = (from, link) => {
    if (link.resolve === 'path') {
      const path = joinPath(folderOf(from), link.target.split('#')[0]);
      return parsed.has(path) ? path : parsed.has(`${path}.md`) ? `${path}.md` : path;
    }
    return byStem.get(link.target.toLowerCase()) ?? link.target;
  };
  const facts = new Map();
  const backlinks = new Map();
  for (const row of documents) {
    const doc = parsed.get(row.name);
    const links = [...new Set(doc.links.filter(link => !link.embed).map(link => resolve(row.name, link)))];
    const embeds = [...new Set(doc.links.filter(link => link.embed).map(link => resolve(row.name, link)))];
    for (const target of links) if (parsed.has(target) && target !== row.name) backlinks.set(target, [...(backlinks.get(target) ?? []), row.name]);
    facts.set(row.name, { name: row.name, leaf: leafOf(row.name), stem: stemOf(row.name), extension: extensionOf(row.name), folder: folderOf(row.name),
      byte_length: row.byte_length ?? null, named_at: iso(row.named_at), modified_at_ms: iso(row.modified_at_ms), identity: row.identity,
      links, embeds, tags: doc.tags, aliases: doc.aliases, complete: doc.complete });
  }
  for (const [name, from] of backlinks) facts.get(name).backlinks = [...new Set(from)].sort();
  return { documents, parsed, facts, complete };
}

const fieldOf = (namespace, key, kind) => ({ id: `${namespace}.${key}`, label: key, kind });

// What the engine answers as text ("8") is a number to the reader.
const answered = value => (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);

/** Each row's formulas worked out once each (a cache per row); one reaching itself is refused (invariant 4). */
async function formulaValues(formulas, input, evaluateBinding) {
  const RUNNING = Symbol('running');
  const cache = new Map();
  const valueOf = async (name, trail) => {
    if (cache.get(name) === RUNNING) throw say('formula_cycle', { formula: name, through: [...trail.slice(trail.indexOf(name)), name].join(' → ') });
    if (cache.has(name)) return cache.get(name);
    cache.set(name, RUNNING);
    const reached = {};
    for (const next of formulaReads(formulas[name].binding)) if (formulas[next]) reached[next] = await valueOf(next, [...trail, name]);
    const value = answered(await evaluateBinding(formulas[name].binding, { ...input, [NS.formulas]: reached }));
    cache.set(name, value);
    return value;
  };
  for (const name of Object.keys(formulas)) await valueOf(name, []);
  return Object.fromEntries(cache);
}

function rowOf(name, doc, fact, types) {
  const values = {};
  for (const [key, value] of Object.entries(doc.properties)) {
    const kind = types[key];
    const kept = kind ? fitted(kind, value) : value;
    values[`${NS.properties}.${key}`] = kept === undefined ? value : kept;
  }
  for (const row of data.file_facts) {
    const value = fact[row.from];
    if (value !== null && value !== undefined) values[`${NS.facts}.${row.key}`] = value;
  }
  if (!Object.hasOwn(values, `${NS.facts}.backlinks`)) values[`${NS.facts}.backlinks`] = [];
  return { id: name, title: fact.stem, values };
}

const sourceFolder = source => folderKey(source?.of ?? '/');
const unprefixed = (values, namespace) => Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith(`${namespace}.`)).map(([key, value]) => [key.slice(namespace.length + 1), value]));

/**
 * The `documents` row source (src/lists.mjs withRowSources): rows read from the folder a list names (`of`), the kind of
 * each value it names (`fields`), and property changes written into the documents themselves (`write`).
 */
export function documentRowSources({ files, evaluateBinding = null, index = null } = {}) {
  const memory = { kept: new Map(), index };
  const read = async ({ source, limit, cursor, row_ids }) => {
    const folder = sourceFolder(source);
    const sidecar = await readDocumentTypes(files, folder);
    const all = await documentsOf(files, folder, memory);
    const wanted = row_ids ? new Set(row_ids) : null;
    const names = all.documents.map(row => row.name).filter(name => (wanted ? wanted.has(name) : !cursor || name > cursor));
    const page = wanted ? names : names.slice(0, limit);
    const rows = [];
    for (const name of page) {
      const row = rowOf(name, all.parsed.get(name), all.facts.get(name), sidecar.types);
      if (Object.keys(sidecar.formulas).length) {
        if (!evaluateBinding) throw say('bad_document_types', { kinds: [...PROPERTY_KINDS].join(', '), formulas: limits.formulas_per_folder, what: 'formulas here (no formula engine)' });
        const input = { [NS.properties]: unprefixed(row.values, NS.properties), [NS.facts]: unprefixed(row.values, NS.facts), now: Date.now() };
        for (const [key, value] of Object.entries(await formulaValues(sidecar.formulas, input, evaluateBinding))) if (value !== null && value !== undefined) row.values[`${NS.formulas}.${key}`] = value;
      }
      rows.push(row);
    }
    return { rows, next_cursor: !wanted && names.length > page.length ? page.at(-1) : null, complete: all.complete };
  };
  // The kind of each value a view names: declared properties as the sidecar says, others as text; file facts as
  // file_facts says; formulas as each says (text when it does not).
  read.fields = async ({ source, ids }) => {
    const sidecar = await readDocumentTypes(files, sourceFolder(source));
    const known = new Map([
      ...Object.entries(sidecar.types).map(([key, kind]) => [`${NS.properties}.${key}`, fieldOf(NS.properties, key, kind)]),
      ...data.file_facts.map(row => [`${NS.facts}.${row.key}`, fieldOf(NS.facts, row.key, row.kind)]),
      ...Object.entries(sidecar.formulas).map(([key, row]) => [`${NS.formulas}.${key}`, fieldOf(NS.formulas, key, row.kind ?? 'text')]),
    ]);
    return ids.map(id => known.get(id) ?? (id.startsWith(`${NS.properties}.`) ? fieldOf(NS.properties, id.slice(NS.properties.length + 1), 'text') : null)).filter(Boolean);
  };
  // Property changes: each row { id: document name, values: { 'note.<key>': value | null }, if_identity? } (invariants 2-3).
  read.write = async ({ list, source, rows = [], remove = [] }) => {
    const refuse = what => say('bad_document_property', { properties: NS.properties, what });
    if (remove.length) throw refuse(`removing ${remove[0]}`);
    const folder = sourceFolder(source);
    const sidecar = await readDocumentTypes(files, folder);
    const kept = [];
    for (const row of rows) {
      const name = row?.id;
      if (typeof name !== 'string' || !isDocument(name) || !(folder === '/' || name.startsWith(`${folder}/`))) throw say('not_a_document', { document: JSON.stringify(name) });
      const set = {}, gone = [];
      for (const [id, value] of Object.entries(row.values ?? {})) {
        const key = id.startsWith(`${NS.properties}.`) ? id.slice(NS.properties.length + 1) : null;
        if (!key || !KEY.test(key)) throw refuse(id);
        if (value === null) { gone.push(key); continue; }
        const kind = sidecar.types[key];
        const fits = kind ? fitted(kind, value) : (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || (Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number')) ? value : undefined);
        if (fits === undefined) throw say('bad_property_value', { property: id, document: name, kind: kind ?? 'text or list of texts', value: JSON.stringify(value) });
        set[key] = fits;
      }
      let identity = null;
      for (let attempt = 1; ; attempt += 1) {
        const entry = await files.entry(name);
        if (!entry || entry.folder) throw say('not_a_document', { document: name });
        if (row.if_identity !== undefined && row.if_identity !== entry.identity) throw say('document_changed', { document: name, expected: row.if_identity, current: entry.identity });
        const now = await files.read(entry.identity, limits.bytes_per_document);
        if (!now.complete) throw say('not_a_document', { document: `${name} (longer than ${limits.bytes_per_document} bytes)` });
        const written = await files.writeIfUnchanged(name, writeFrontmatter(now.text, { set, remove: gone }), entry.identity, entry.media_type ?? 'text/markdown; charset=utf-8');
        if (!written.conflict) { identity = written.identity; break; }
        if (row.if_identity !== undefined || attempt >= limits.write_attempts) throw say('document_changed', { document: name, expected: entry.identity, current: written.current ?? 'nothing' });
      }
      kept.push({ name, identity });
    }
    // What each changed document now says, read back once for all of them.
    const after = new Map((await read({ source, row_ids: kept.map(row => row.name) })).rows.map(row => [row.id, row.values]));
    return { list_id: list.id, kept: kept.map(row => ({ id: `${source.source}~${row.name}`, values: after.get(row.name) ?? {}, identity: row.identity })), removed: [] };
  };
  return { sources: { [data.source]: read }, declared: () => null };
}

/** The folder of a list's documents source, or a refusal naming how to give it one. */
export function documentsFolderOf(list, listId = list?.id) {
  if (!list) throw say('no_list', { list_id: listId });
  const row = (list?.row_sources ?? []).find(item => item.source === data.source);
  if (!row) throw say('not_documents', { list_id: list?.id ?? '', source: data.source });
  return folderKey(row.of ?? '/');
}
