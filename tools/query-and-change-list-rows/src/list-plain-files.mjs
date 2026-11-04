// src/list-plain-files.mjs
//
// Purpose: a list as plain files any tool can read and write without Trillion's API (Obsidian keeps properties as
// frontmatter, their types in one small sidecar and graphs as id-keyed JSON). An export writes one document per row
// (its values as frontmatter, its first long-text field as the words), the folder's sidecar (src/document-properties.json
// sidecar_name: each property's kind, plus the list's own definition so an import makes the same list) and one link
// graph (plain_files.links_name); an import reads the same folder back into a list through the list owner.
//
// Non-Negotiable Invariants:
//   1. Every value goes through its owner: rows are written by the list owner's putRows (match_on, when given, names rows
//      by who they are: src/list-row-operations.mjs planRowRequest), files by the Namespace's own routes
//      (src/document-properties.mjs namespaceFiles). Nothing here keeps a value of its own.
//   2. A link has one home: the graph. A row's frontmatter never repeats it. On import an edge whose end is not a node of
//      the graph is dropped (Obsidian drops a canvas edge whose node is gone), and links are written after every row
//      exists, so an edge between two imported rows always lands.
//   3. An export writes only into an empty folder or one holding an earlier export of the same list (its sidecar says
//      so); the earlier export's row files that no longer match a row are removed, so the folder is the list as it is.
//   4. Worked-out values (computed fields) are not exported: they are worked out again where the list is read.
//   5. Bounded and resumable: at most limits.plain_file_rows rows a call (src/document-properties.json). A longer list
//      says complete: false and a `next_cursor` (export) or `next_after` (import) that the next call names to carry on
//      where this one stopped; the links graph grows across the calls, the first call starts it, and row files the list
//      no longer holds are removed by the call that finishes. A match_on import cannot span calls (which row a file became
//      is not kept between calls), so one that does not fit in a call is refused, never half done.
//
//   exportListFiles(lists, listId, { folder, cursor? }, { files }) → { list_id, folder, rows, files, complete, next_cursor? }
//   importListFiles(lists, { folder, list_id?, match_on?, after? }, { files, actor }) → { list_id, folder, kept, links, dropped_edges, complete, next_after? }
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import data from './document-properties.json' with { type: 'json' };
import listsData from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';
import { planRowRequest } from './list-row-operations.mjs';
import { checkDocumentTypes, parseDocument, readFrontmatter, readSidecar, writeFrontmatter } from '../../documents-as-list-rows/document-properties.mjs';

const { limits, plain_files: plain } = data;
const KINDS = new Map(listsData.field_kinds.map(kind => [kind.id, kind]));
const PROPERTY_KINDS = new Set(data.property_kinds);
const isLink = field => Boolean(KINDS.get(field.kind)?.links);
const isWorkedOut = field => KINDS.get(field.kind)?.value === 'computed';
const isWords = field => Boolean(KINDS.get(field.kind)?.document);
const folderKey = folder => {
  const trimmed = String(folder ?? '').trim().replace(/\/+$/, '');
  if (!trimmed.startsWith('/') || trimmed === '') throw say('bad_plain_files', { what: `a folder name starting with / (not ${JSON.stringify(folder)})` });
  return trimmed;
};
const asIds = value => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []).filter(id => typeof id === 'string');
const edgeId = (from, field, to) => `e-${bytesToHex(blake3(utf8ToBytes(JSON.stringify([from, field, to])))).slice(0, 32)}`;
const rowFile = (folder, rowId) => `${folder}/${encodeURIComponent(rowId)}.${plain.row_extension}`;
const rowIdOf = (folder, name) => {
  const prefix = `${folder}/`, suffix = `.${plain.row_extension}`;
  if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.slice(prefix.length).includes('/')) return null;
  try { return decodeURIComponent(name.slice(prefix.length, -suffix.length)); } catch { return null; }
};

// The names directly in one folder (not the folders under it), every page of them, in the listing's order.
async function namesIn(files, folder) {
  const names = [];
  let after = '';
  do {
    const page = await files.list(folder, after, limits.listing_page);
    names.push(...(page.names ?? []).filter(row => row.identity));
    after = page.next_after ?? null;
  } while (after);
  return names;
}

// The list's own rows from `cursor` on, at most plain_file_rows, through its paged reads (a source's rows are the source's,
// never exported): { rows, next_cursor } where next_cursor is null once the list is read to its end.
async function ownRows(lists, listId, cursor = null) {
  const rows = [];
  let next = cursor;
  for (;;) {
    const page = await lists.read(listId, { limit: Math.min(listsData.limits.read_page_rows, limits.plain_file_rows - rows.length), ...(next ? { cursor: next } : {}) });
    rows.push(...page.rows.filter(row => !row.source));
    next = page.page?.next_cursor ?? null;
    if (!next || rows.length >= limits.plain_file_rows) return { rows, next_cursor: next };
  }
}

// Every id of the list's own rows, a page at a time.
async function allRowIds(lists, listId) {
  const ids = new Set();
  let cursor = null;
  do {
    const page = await ownRows(lists, listId, cursor);
    for (const row of page.rows) ids.add(row.id);
    cursor = page.next_cursor;
  } while (cursor);
  return ids;
}

/** Writes a list into a folder as plain files (invariants 2-5). */
export async function exportListFiles(lists, listId, { folder, cursor = null } = {}, { files }) {
  const at = folderKey(folder);
  const list = await lists.find(listId);
  if (!list) throw say('no_list', { list_id: listId });
  const earlier = await readSidecar(files, at);
  const present = await namesIn(files, at);
  if (present.length && earlier?.list?.id !== list.id) throw say('bad_plain_files', { what: `nothing in it yet, or an earlier export of ${list.id} (${at} holds other files)` });
  const fields = list.fields ?? [];
  const words = fields.find(isWords);
  const links = fields.filter(isLink);
  const shown = fields.filter(field => !isLink(field) && !isWorkedOut(field) && field !== words);
  const { rows, next_cursor: nextCursor } = await ownRows(lists, list.id, cursor);
  const written = [];
  // A call that carries on adds to the graph the earlier calls wrote; the first call starts it.
  const graph = `${at}/${plain.links_name}`;
  const kept = cursor ? present.find(row => row.name === graph) : null;
  const { nodes, edges } = kept ? { nodes: {}, edges: {}, ...JSON.parse((await files.read(kept.identity, limits.sidecar_bytes * 16)).text) } : { nodes: {}, edges: {} };
  for (const row of rows) {
    const set = Object.fromEntries(shown.filter(field => row.values[field.id] !== undefined && row.values[field.id] !== null).map(field => [field.id, row.values[field.id]]));
    const name = rowFile(at, row.id);
    await files.write(name, writeFrontmatter(words ? String(row.values[words.id] ?? '') : '', { set }), 'text/markdown; charset=utf-8');
    written.push(name);
    nodes[row.id] = { list: list.id };
    for (const field of links) for (const to of asIds(row.values[field.id])) {
      nodes[to] ??= { list: field.links_to };
      edges[edgeId(row.id, field.id, to)] = { from: row.id, field: field.id, to };
    }
  }
  await files.write(graph, `${JSON.stringify({ nodes, edges }, null, 2)}\n`, 'application/json');
  // The sidecar: property kinds of the fields written as frontmatter, and the list as it is defined.
  const types = Object.fromEntries(shown.filter(field => PROPERTY_KINDS.has(field.kind)).map(field => [field.id, field.kind]));
  const definition = { id: list.id, label: list.label, title_field: list.title_field ?? null, fields };
  const sidecarAt = `${at}/${data.sidecar_name}`;
  const sidecar = { ...(earlier ?? {}), list: definition, ...checkDocumentTypes({ types, formulas: earlier?.formulas ?? {} }) };
  await files.write(sidecarAt, `${JSON.stringify(sidecar, null, 2)}\n`, 'application/json');
  // The call that finishes removes an earlier export's row files that are not rows now (invariant 3), by the list's own
  // row ids read to their end.
  const leftOver = nextCursor ? [] : present.map(row => row.name).filter(name => rowIdOf(at, name) !== null);
  const held = leftOver.length ? await allRowIds(lists, list.id) : null;
  const stale = leftOver.filter(name => !held.has(rowIdOf(at, name)));
  if (stale.length) await files.remove(stale);
  return { list_id: list.id, folder: at, rows: rows.length, files: [...written, graph, sidecarAt], removed: stale, complete: !nextCursor, ...(nextCursor ? { next_cursor: nextCursor } : {}) };
}

/** Reads a folder of plain files back into a list (invariants 1-2). */
export async function importListFiles(lists, { folder, list_id: listId, match_on: matchOn, after = null } = {}, { files, actor } = {}) {
  const at = folderKey(folder);
  const sidecar = await readSidecar(files, at);
  if (!sidecar?.list || typeof sidecar.list.id !== 'string' || !Array.isArray(sidecar.list.fields)) throw say('bad_plain_files', { what: `a ${data.sidecar_name} naming its list ({ list: { id, label, fields } })` });
  const target = listId ?? sidecar.list.id;
  let list = await lists.find(target);
  // A list made under another id links to itself where the exported list linked to itself.
  const ownFields = sidecar.list.fields.map(field => (isLink(field) && field.links_to === sidecar.list.id ? { ...field, links_to: target } : field));
  if (!list) list = (await lists.save({ id: target, label: sidecar.list.label ?? target, fields: ownFields, ...(sidecar.list.title_field ? { title_field: sidecar.list.title_field } : {}) }, { actor })).list;
  const fields = new Map((list.fields ?? []).map(field => [field.id, field]));
  const words = (list.fields ?? []).find(isWords);
  const present = await namesIn(files, at);
  // The row files in a stable order, from just after `after` (the last file a call before this one read): at most
  // plain_file_rows of them a call, with where the next call starts when more remain.
  const rowFiles = present.filter(entry => rowIdOf(at, entry.name) !== null).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rest = after ? rowFiles.filter(entry => entry.name > after) : rowFiles;
  const taken = rest.slice(0, limits.plain_file_rows);
  const nextAfter = rest.length > taken.length ? taken.at(-1).name : null;
  if (matchOn && (after || nextAfter)) throw say('bad_plain_files', { what: `at most ${limits.plain_file_rows} row files to import by match_on in one call (it names rows by who they are, which is not kept between calls); import by id instead` });
  const rows = [];
  for (const entry of taken) {
    const rowId = rowIdOf(at, entry.name);
    const text = (await files.read(entry.identity, limits.bytes_per_document)).text;
    const { properties } = parseDocument(text);
    const read = readFrontmatter(text);
    const values = Object.fromEntries(Object.entries(properties).filter(([key]) => fields.has(key) && !isLink(fields.get(key)) && !isWorkedOut(fields.get(key))));
    const body = (read.head ? read.lines.slice(read.head.to).join('\n') : text).replace(/^\n/, '');
    if (words && body.trim()) values[words.id] = body;
    rows.push({ file: rowId, values });
  }
  // Rows first, without links; with match_on each is named by who it is and its file id is not its row id.
  const kept = [], matches = [];
  for (let index = 0; index < rows.length; index += listsData.limits.rows_per_write) {
    const group = rows.slice(index, index + listsData.limits.rows_per_write);
    const planned = await planRowRequest(lists, list.id, matchOn ? { rows: group.map(row => ({ values: row.values })), match_on: matchOn } : { rows: group.map(row => ({ id: row.file, values: row.values })) });
    matches.push(...planned.matches);
    for (const request of planned.requests) kept.push(...((await lists.putRows(list.id, request, { actor })).kept ?? []));
  }
  // Which kept row each file became: by id, or by the first match_on field whose value it gave.
  // Without match_on a file is the row of its own id, in this call or an earlier one.
  const finalId = new Map(matchOn ? [] : rowFiles.map(entry => [rowIdOf(at, entry.name), rowIdOf(at, entry.name)]));
  rows.forEach((row, index) => {
    if (!matchOn) return;
    const key = matchOn.find(fieldId => row.values[fieldId] !== undefined && row.values[fieldId] !== null);
    const found = key ? kept.find(item => JSON.stringify(item.values?.[key]) === JSON.stringify(row.values[key])) : kept[index];
    if (found) finalId.set(row.file, found.id);
  });
  // Then links, from the graph (invariant 2), once every row of the folder is in: the call that finishes.
  if (nextAfter) return { list_id: list.id, folder: at, kept: kept.length, links: 0, dropped_edges: 0, complete: false, next_after: nextAfter };
  const graphEntry = present.find(row => row.name === `${at}/${plain.links_name}`);
  let graph = { nodes: {}, edges: {} };
  if (graphEntry) { try { graph = JSON.parse((await files.read(graphEntry.identity, limits.sidecar_bytes * 16)).text); } catch { throw say('bad_plain_files', { what: `a ${plain.links_name} that is JSON { nodes, edges }` }); } }
  const linked = new Map();
  let dropped = 0;
  for (const edge of Object.values(graph.edges ?? {})) {
    const field = fields.get(edge?.field);
    const from = finalId.get(edge?.from);
    const toNode = graph.nodes?.[edge?.to];
    if (!field || !isLink(field) || !from || !toNode) { dropped += 1; continue; }
    const to = toNode.list === sidecar.list.id ? finalId.get(edge.to) : edge.to;
    if (!to) { dropped += 1; continue; }
    const values = linked.get(from) ?? {};
    values[field.id] = [...(values[field.id] ?? []), to];
    linked.set(from, values);
  }
  const linkRows = [...linked].map(([id, values]) => ({ id, values }));
  for (let index = 0; index < linkRows.length; index += listsData.limits.rows_per_write) await lists.putRows(list.id, { rows: linkRows.slice(index, index + listsData.limits.rows_per_write) }, { actor });
  return { list_id: list.id, folder: at, kept: kept.length, links: linkRows.length, dropped_edges: dropped, complete: true, ...(matches.length ? { matches } : {}) };
}
