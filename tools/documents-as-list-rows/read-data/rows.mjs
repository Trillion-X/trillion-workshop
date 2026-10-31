// tools/documents-as-list-rows/read-data/rows.mjs
//
// Purpose: the functions a Workshop row runs (do-work/documents.mjs --stdin calls each with the row's input):
// a page of a folder's documents as rows, a change of some documents' properties, and a split of long documents into
// one document per item. `root` is the folder on the person's computer the person granted the tool (the row fills it
// from the run's grant); every other path is under it.
//
// Non-Negotiable Invariants:
//   1. Nothing outside `root` is read or written (folder-files.mjs refuses it).
//   2. These functions only shape input and answers; the rows, the writes and the split are document-properties.mjs
//      and split.mjs.
//
//   readDocumentRows({ root, folder?, match?, after?, limit?, backlinks?, most_bytes? }) → { rows, next }
//   readNamespaceDocumentRows({ folder?, match?, after?, limit?, backlinks?, most_bytes? }, { door }) → { rows, next }
//   changeDocumentRows({ root, folder?, rows: [{ id, values: { 'note.<key>': value | null }, if_identity? }] }) → { kept }
//   splitIntoDocuments({ root, mapping, out?, leftover?, check? }) → the split's report
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { documentRowSources, documentSelection, folderKey, say } from './document-properties.mjs';
import { folderFiles } from './folder-files.mjs';
import { namespaceFiles } from './namespace-files.mjs';
import { itemDocument, orderedIds, splitDocuments } from './split.mjs';
import { contentRows } from './content-rows.mjs';
import data from './document-properties.json' with { type: 'json' };

const needRoot = root => {
  if (typeof root !== 'string' || !root.startsWith('/')) throw say('bad_input', { what: 'root must be the absolute path of the folder the tool was granted.' });
  return root;
};

// `most_bytes` bounds the answer's JSON: a caller whose answer travels in a bounded message (a door answers a run in
// one MCP message) names its room, and the page ends at the last row that fits, its `next` going on from there. A first
// row bigger than the room is refused, never cut.
export async function readDocumentRows({ root, ...page } = {}) {
  return pageOf(await folderFiles(needRoot(root)), page);
}

/** Resolve metadata selection through the same bounded catalogue parser as document rows. No folder listing or document body read. */
export async function readDocumentSelection({ root, source = {}, allow_relative_paths = false } = {}) {
  const selected = await documentSelection(await folderFiles(needRoot(root)), source, { allow_relative_paths });
  return { folder: selected.of, match: selected.match ?? null, exclude: selected.exclude ?? [], paths: selected.paths ?? null,
    paths_file: selected.paths_file ?? null };
}

// The same page over the person's Namespace files, through the run's records door (run-an-export.mjs hands `door`; the
// row's files right is the folder the run may read). `folder` is a Namespace folder.
export async function readNamespaceDocumentRows(page = {}, { door } = {}) {
  if (typeof door?.files !== 'function') throw say('bad_input', { what: 'This run was handed no records door with files.' });
  return pageOf(namespaceFiles((operation, input) => door.files(operation, input)), page);
}

async function pageOf(files, { folder = '/', match, exclude, paths, paths_file, text_extensions, after = null, limit = data.limits.page_rows, backlinks = false, most_bytes, content = false } = {}) {
  const read = documentRowSources({ files }).sources.documents;
  if (content !== false) return contentRows(files, read, { folder: folderKey(folder), match, exclude, paths, paths_file, text_extensions, after, limit, backlinks: Boolean(backlinks), most_bytes, content });
  const page = await read({ source: { of: folderKey(folder), match, exclude, paths, paths_file, text_extensions }, cursor: after, limit, backlinks: Boolean(backlinks) });
  const answer = { rows: page.rows, next: page.next_cursor };
  if (most_bytes === undefined) return answer;
  if (!Number.isSafeInteger(most_bytes) || most_bytes < 1) throw say('bad_input', { what: 'most_bytes must be a whole number of bytes from 1.' });
  // The answer is {"rows":[r1,r2,...],"next":"<id>"}: each row's bytes once, the commas between them and the envelope.
  const bytes = answer.rows.map(row => Buffer.byteLength(JSON.stringify(row)));
  const envelope = next => Buffer.byteLength(JSON.stringify({ rows: [], next }));
  let kept = answer.rows.length, total = bytes.reduce((sum, one) => sum + one, 0) + Math.max(kept - 1, 0);
  const fits = () => total + envelope(kept === answer.rows.length ? answer.next : answer.rows[kept - 1].id) <= most_bytes;
  while (kept > 0 && !fits()) { kept -= 1; total -= bytes[kept] + (kept > 0 ? 1 : 0); }
  if (kept === answer.rows.length) return answer;
  if (kept === 0) throw say('bad_input', { what: `the first document is bigger than most_bytes (${most_bytes}).` });
  const rows = answer.rows.slice(0, kept);
  return { rows, next: rows.at(-1).id };
}

export async function changeDocumentRows({ root, folder = '/', rows } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw say('bad_input', { what: 'rows must name at least one document and its values.' });
  const read = documentRowSources({ files: await folderFiles(needRoot(root)) }).sources.documents;
  return read.write({ source: { of: folderKey(folder) }, rows });
}

export async function splitIntoDocuments({ root, mapping, out, leftover, check = false } = {}) {
  const base = needRoot(root);
  const files = await folderFiles(base);
  const plan = typeof mapping === 'string' ? JSON.parse(await readFile(join(base, mapping), 'utf8')) : mapping;
  const result = await splitDocuments(plan, async file => (await files.read(null, Infinity, `/${file}`)).text);
  if (check) return result.report;
  if (!out || !leftover) throw say('bad_input', { what: 'A split writes into `out` and `leftover`, or only reports with `check`.' });
  const into = resolve(base, out), rest = resolve(base, leftover);
  for (const path of [into, rest]) if (!path.startsWith(`${base}/`)) throw say('bad_input', { what: `${path} is not under the granted folder.` });
  await mkdir(into, { recursive: true });
  if ((await readdir(into)).length) throw say('bad_input', { what: `${out} is not empty: split into an empty folder.` });
  await mkdir(rest, { recursive: true });
  for (const id of orderedIds(plan, result.items.keys())) await writeFile(join(into, `${id}.md`), itemDocument(id, result.items.get(id), plan.field_order));
  // A JSON document's leftover is JSON (the document without its list); a markdown one's is markdown.
  const extension = plan.items_at ? 'json' : 'md';
  for (const [name, lines] of Object.entries(result.leftover)) await writeFile(join(rest, `${name}.${extension}`), lines.join('\n'));
  return result.report;
}
