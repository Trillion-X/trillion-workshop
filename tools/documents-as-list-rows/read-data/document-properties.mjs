// tools/documents-as-list-rows/read-data/document-properties.mjs
//
// Purpose: a folder of a person's text documents as the rows of a list, so a saved view queries documents live the
// way it queries rows (Obsidian Bases over a vault). A list names the folder with row_sources [{ source: 'documents',
// of: '/notes' }]; each document is a row whose values are named by namespace and key (document-properties.json
// namespaces): its own properties (note.status), written in the document itself as frontmatter; the facts of its file
// (file.name, file.folder, file.mtime, file.size, file.links, file.backlinks, file.tags ..., file_facts); and the
// folder's formulas (formula.late), worked out by the caller's formula engine from the other two. Each property's kind
// and the folder's formulas are one small sidecar file at the top of the folder (sidecar_name), so the documents,
// their types and their formulas are plain files any tool can read and write.
//
// Ported from the lists' documents row source of the earlier Trillion app (src/document-properties.mjs there). What
// changed in the port: the files the rows are read from are any `files` (folder-files.mjs for a folder on the person's
// computer), a read is a page of the folder in name order with no cap on the folder's size, and the refusal words and
// the field kinds' value shapes are this tool's own DATA.
//
// Non-Negotiable Invariants:
//   1. The documents stay where they are. A row is read from the files through `files`; nothing is copied into list
//      records.
//   2. A property change rewrites only that property's frontmatter lines, and the new bytes are named only if the
//      document is still what was read (`files.writeIfUnchanged` with the identity read), so a change made meanwhile is
//      never lost: the change is made again on what the document now says, at most limits.write_attempts times. A
//      caller that names the identity it read (if_identity) is refused instead when the document changed.
//   3. A value is written only if it fits its property's kind (kind_values); file facts and formulas are worked out and
//      never written; a document is removed as a file, never as a row.
//   4. A formula may read another formula; each row's formulas are worked out once each (a per-row cache), and a formula
//      that reaches itself is refused with the formulas it passed through, both when the sidecar is saved and when it is
//      read (a sidecar written by hand is checked the same way).
//   5. Every read is bounded by DATA (listing_page, bytes_per_document ...). A page holds at most its limit of rows and
//      says next_cursor while more remain, so a folder of any size is read a page at a time. Backlinks need every
//      document's links, so a read works them out only when it is asked for them (`backlinks: true`).
//
// Frontmatter is the YAML block between the first two `---` lines. What is read: `key: value` lines whose value is a
// JSON value, a quoted or plain scalar, or a [a, b] list, and `key:` followed by `- item` lines. A key whose value is
// anything else (a nested mapping) reads as its text and is kept byte for byte when another key changes. What is
// written is the same subset: plain scalars when unambiguous, JSON-quoted strings otherwise, and `- item` lists.
//
//   documentRowSources({ files, evaluateBinding? }) → { sources: { documents: read } }, read({ source, limit, cursor,
//     row_ids, backlinks }) → { rows, next_cursor }, read.fields({ source, ids }), read.write({ list, source, rows })
//   readDocumentTypes(files, folder) / saveDocumentTypes(files, folder, { types, formulas, expected_identity })
//   readFrontmatter(text) / writeFrontmatter(text, { set, remove }) / parseDocument(text)
import data from './document-properties.json' with { type: 'json' };

const { limits } = data;
const NS = data.namespaces;
const KIND_VALUES = new Map(Object.entries(data.kind_values));
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

/** A refusal in this tool's words (document-properties.json refusals), its `code` the refusal's name. */
export function say(code, values = {}) {
  const words = (data.refusals[code] ?? code).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  return Object.assign(new Error(words), { code });
}

// ---- frontmatter --------------------------------------------------------------------------------------------------

const FENCE = /^---[ \t]*\r?$/;
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*\r?$/;
const ITEM_LINE = /^[ \t]+-[ \t]+(.*?)[ \t]*\r?$|^-[ \t]+(.*?)[ \t]*\r?$/;

export function scalar(raw) {
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
export const formatScalar = value => {
  if (typeof value !== 'string') return JSON.stringify(value);
  const read = scalar(value);
  return PLAIN.test(value) && !/\s$/.test(value) && read === value ? value : JSON.stringify(value);
};
export const formatBlock = (key, value) => Array.isArray(value)
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
      if (Object.hasOwn(set, block.key)) {
        if (!done.has(block.key)) head.push(...formatBlock(block.key, set[block.key]));
        // A comment written under the key is the person's note, not the old value: it stays.
        head.push(...read.lines.slice(block.from + 1, block.to).filter(line => line.trim().startsWith('#')));
        done.add(block.key);
        continue;
      }
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
  const shape = KIND_VALUES.get(kind);
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
      let target;
      try { target = decodeURI(match[1].trim()); } catch { target = match[1].trim(); }
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
export const folderKey = folder => {
  const trimmed = String(folder ?? '/').trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed || '/' : `/${trimmed}`;
};

/** A folder's sidecar: { folder, name, identity (null when there is none), types, formulas }. */
export async function readDocumentTypes(files, folder) {
  const at = folderKey(folder);
  const name = sidecarName(at);
  const entry = await files.entry(name);
  if (!entry || entry.folder) return { folder: at, name, identity: null, types: {}, formulas: {} };
  const read = await files.read(entry.identity, limits.sidecar_bytes, name);
  let parsed;
  try { parsed = JSON.parse(read.text); } catch { throw say('bad_document_types', { kinds: [...PROPERTY_KINDS].join(', '), formulas: limits.formulas_per_folder, what: `${name} (not JSON)` }); }
  return { folder: at, name, identity: entry.identity, ...checkDocumentTypes(parsed) };
}

/** Writes a folder's sidecar (the whole of it, so a type or formula left out is removed), if it is still what was read. */
export async function saveDocumentTypes(files, folder, { types, formulas, expected_identity } = {}) {
  const at = folderKey(folder);
  const checked = checkDocumentTypes({ types, formulas });
  const name = sidecarName(at);
  const entry = await files.entry(name);
  const expected = expected_identity === undefined ? entry?.identity ?? null : expected_identity;
  let rest = {};
  if (entry && !entry.folder) {
    try { const parsed = JSON.parse((await files.read(entry.identity, limits.sidecar_bytes, name)).text); if (isObject(parsed)) rest = parsed; } catch { /* rewritten whole */ }
  }
  rest = Object.fromEntries(Object.entries(rest).filter(([key]) => key !== 'types' && key !== 'formulas'));
  const written = await files.writeIfUnchanged(name, `${JSON.stringify({ ...rest, ...checked }, null, 2)}\n`, expected, 'application/json');
  if (written.conflict) throw say('document_changed', { document: name, expected: expected ?? 'nothing', current: written.current ?? 'nothing' });
  return { folder: at, name, identity: written.identity, ...checked };
}

// ---- documents as rows -------------------------------------------------------------------------------------------------

// Every document name in a folder and the folders under it, in name order: the listing only, no document is read.
async function names(files, folder) {
  const folders = [...new Set([folder, ...(await files.foldersUnder(folder))])].sort();
  const found = [];
  for (const at of folders) {
    let after = '';
    do {
      const page = await files.list(at, after, limits.listing_page);
      for (const row of page.names ?? []) if (isDocument(row.name)) found.push(row);
      after = page.next_after ?? null;
    } while (after);
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const iso = value => {
  if (value === null || value === undefined) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

// One document's file facts, its links resolved among `byStem` (all the folder's documents when backlinks were asked
// for, else the page's own).
function factsOf(row, doc, identity, resolve) {
  const links = [...new Set(doc.links.filter(link => !link.embed).map(link => resolve(row.name, link)))];
  const embeds = [...new Set(doc.links.filter(link => link.embed).map(link => resolve(row.name, link)))];
  return { name: row.name, leaf: leafOf(row.name), stem: stemOf(row.name), extension: extensionOf(row.name), folder: folderOf(row.name),
    byte_length: row.byte_length ?? null, named_at: iso(row.named_at), modified_at_ms: iso(row.modified_at_ms), identity,
    links, embeds, tags: doc.tags, aliases: doc.aliases, complete: doc.complete };
}

async function parsedOf(files, row) {
  const read = await files.read(row.identity ?? null, limits.bytes_per_document, row.name);
  // A listing that gives names only (a computer folder) leaves the size and times to the read of the bytes.
  return { identity: read.identity, doc: { ...parseDocument(read.text), complete: read.complete }, row: { ...read.facts, ...row } };
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
  return { id: name, title: fact.stem, identity: fact.identity, values };
}

const sourceFolder = source => folderKey(source?.of ?? '/');

/** A test for a glob on a path: `*` any characters but /, `**` any characters, `?` one character but /. */
export function globTest(glob) {
  if (!glob) return () => true;
  const pattern = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  const re = new RegExp(`^${pattern}$`);
  return path => re.test(path);
}
const unprefixed = (values, namespace) => Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith(`${namespace}.`)).map(([key, value]) => [key.slice(namespace.length + 1), value]));

/**
 * The `documents` row source: rows read from the folder a list names (`of`), a page at a time, the kind of each value
 * it names (`fields`), and property changes written into the documents themselves (`write`).
 */
export function documentRowSources({ files, evaluateBinding = null } = {}) {
  const read = async ({ source, limit = limits.page_rows, cursor = null, row_ids = null, backlinks = false }) => {
    if (!(Number.isInteger(limit) && limit >= 1 && limit <= limits.page_rows_most)) throw say('bad_page', { most: limits.page_rows_most });
    const folder = sourceFolder(source);
    const sidecar = await readDocumentTypes(files, folder);
    if (source?.paths_file !== undefined) {
      if (typeof source.paths_file !== 'string' || !source.paths_file.startsWith('/') || source.paths !== undefined) throw say('bad_input', { what: 'paths_file names one JSON positive catalogue under the granted root, instead of paths.' });
      const entry = await files.entry(source.paths_file);
      if (!entry || entry.folder) throw say('bad_input', { what: `The positive catalogue ${source.paths_file} is missing.` });
      const read = await files.read(entry.identity, limits.bytes_per_document, source.paths_file);
      if (!read.complete) throw say('bad_input', { what: `The positive catalogue ${source.paths_file} exceeds the existing ${limits.bytes_per_document}-byte document read bound.` });
      if (read.identity !== entry.identity) throw say('document_changed', { document: source.paths_file, expected: entry.identity, current: read.identity });
      let paths;
      try { paths = JSON.parse(read.text); } catch { throw say('bad_input', { what: `The positive catalogue ${source.paths_file} is not JSON.` }); }
      source = { ...source, paths };
    }
    // A source may keep only the documents whose path under its folder fits a glob (`match`, as */SKILL.md).
    const fits = globTest(source?.match);
    if (source?.exclude !== undefined && (!Array.isArray(source.exclude) || source.exclude.some(pattern => typeof pattern !== 'string'))) throw say('bad_input', { what: 'exclude is an array of document-path glob strings.' });
    const excluded = (source?.exclude ?? []).map(globTest);
    if (source?.text_extensions !== undefined && (!Array.isArray(source.text_extensions) || source.text_extensions.some(extension => typeof extension !== 'string' || !/^[a-z0-9]*$/.test(extension)))) throw say('bad_input', { what: 'text_extensions is an array of lowercase text-file extensions for explicitly named paths; an empty string explicitly admits extensionless text files.' });
    const explicitExtensions = new Set(source?.text_extensions ?? data.document_extensions);
    if (source?.paths !== undefined && (!Array.isArray(source.paths) || source.paths.some(name => typeof name !== 'string' || !name.startsWith('/') || !explicitExtensions.has(extensionOf(name).toLowerCase()) || (folder !== '/' && !name.startsWith(`${folder}/`))))) throw say('bad_input', { what: 'paths is an array of exact document names under this source folder, with explicitly declared text extensions.' });
    // An explicit catalogue reads only its named files, without walking unrelated folders. The files owner still
    // resolves and checks every name against the granted root, including symlinks.
    const everything = source?.paths ? [...new Set(source.paths)].sort().map(name => ({ name })) : await names(files, folder);
    const fitsSource = row => {
      const path = folder === '/' ? row.name.slice(1) : row.name.slice(folder.length + 1);
      return fits(path) && !excluded.some(test => test(path));
    };
    const wanted = row_ids ? new Set(row_ids) : null;
    const inPage = row => wanted ? wanted.has(row.name) : !cursor || row.name > cursor;
    const existing = [];
    if (source?.paths && !backlinks) {
      // Select names before probing files. Presence needs facts only, never the bytes of every other document in a
      // large catalogue. One extra present name establishes continuation even when selected files were removed.
      for (const row of everything.filter(row => fitsSource(row) && inPage(row))) {
        if (await files.entry(row.name, { identity: false })) existing.push(row);
        if (!wanted && existing.length > limit) break;
      }
    } else {
      // Backlinks deliberately need the complete admitted collection; ordinary folder listings read names only.
      for (const row of everything) if (!source?.paths || await files.entry(row.name)) existing.push(row);
    }
    const chosen = existing.filter(row => fitsSource(row) && inPage(row));
    const page = wanted ? chosen : chosen.slice(0, limit);
    // Links resolve by a document's name without folder or extension (and its aliases) among the documents read.
    const parsed = new Map();
    // The documents are read `reads_at_once` at a time: a read waits on the disk, so reading one after another costs a
    // page its rows times the disk's wait (measured 2026-10-30: about 120 ms a row inside the engine's sandbox).
    const toRead = backlinks ? existing : page;
    for (let from = 0; from < toRead.length; from += limits.reads_at_once) {
      const batch = toRead.slice(from, from + limits.reads_at_once);
      const read = await Promise.all(batch.map(row => parsedOf(files, row)));
      batch.forEach((row, at) => parsed.set(row.name, read[at]));
    }
    const byStem = new Map();
    for (const [name, { doc }] of parsed) {
      for (const key of [stemOf(name), leafOf(name), ...(doc.aliases ?? [])].map(item => item.toLowerCase())) if (!byStem.has(key)) byStem.set(key, name);
    }
    const resolve = (from, link) => {
      if (link.resolve === 'path') {
        const path = joinPath(folderOf(from), link.target.split('#')[0]);
        return parsed.has(path) ? path : parsed.has(`${path}.md`) ? `${path}.md` : path;
      }
      return byStem.get(link.target.toLowerCase()) ?? link.target;
    };
    const facts = new Map();
    for (const row of backlinks ? existing : page) facts.set(row.name, factsOf(parsed.get(row.name).row, parsed.get(row.name).doc, parsed.get(row.name).identity, resolve));
    if (backlinks) {
      const from = new Map();
      for (const [name, fact] of facts) for (const target of fact.links) if (facts.has(target) && target !== name) from.set(target, [...(from.get(target) ?? []), name]);
      for (const [name, fact] of facts) fact.backlinks = [...new Set(from.get(name) ?? [])].sort();
    }
    const rows = [];
    for (const row of page) {
      const out = rowOf(row.name, parsed.get(row.name).doc, facts.get(row.name), sidecar.types);
      if (Object.keys(sidecar.formulas).length) {
        if (!evaluateBinding) throw say('bad_document_types', { kinds: [...PROPERTY_KINDS].join(', '), formulas: limits.formulas_per_folder, what: 'formulas here (no formula engine)' });
        const input = { [NS.properties]: unprefixed(out.values, NS.properties), [NS.facts]: unprefixed(out.values, NS.facts), now: Date.now() };
        for (const [key, value] of Object.entries(await formulaValues(sidecar.formulas, input, evaluateBinding))) if (value !== null && value !== undefined) out.values[`${NS.formulas}.${key}`] = value;
      }
      rows.push(out);
    }
    return { rows, next_cursor: !wanted && chosen.length > page.length ? page.at(-1).name : null };
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
  read.write = async ({ source, rows = [], remove = [] }) => {
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
        const now = await files.read(entry.identity, limits.bytes_per_document, name);
        if (!now.complete) throw say('not_a_document', { document: `${name} (longer than ${limits.bytes_per_document} bytes)` });
        const written = await files.writeIfUnchanged(name, writeFrontmatter(now.text, { set, remove: gone }), entry.identity, 'text/markdown; charset=utf-8');
        if (!written.conflict) { identity = written.identity; break; }
        if (row.if_identity !== undefined || attempt >= limits.write_attempts) throw say('document_changed', { document: name, expected: entry.identity, current: written.current ?? 'nothing' });
      }
      kept.push({ name, identity });
    }
    // What each changed document now says, read back once for all of them.
    const after = new Map((await read({ source, row_ids: kept.map(row => row.name) })).rows.map(row => [row.id, row.values]));
    return { kept: kept.map(row => ({ id: row.name, values: after.get(row.name) ?? {}, identity: row.identity })), removed: [] };
  };
  return { sources: { [data.source]: read } };
}
