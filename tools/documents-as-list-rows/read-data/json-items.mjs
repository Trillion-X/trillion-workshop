// tools/documents-as-list-rows/read-data/json-items.mjs
//
// Purpose: the row source "json-items" (read-a-list-view list-view.json): one JSON file whose array at one path holds
// many items (rule rows, check rows, any objects with an id), each item one row of a list. It is the many-rows shape of
// the same copy the documents source gives a folder, so read-a-list-view's list-copy.mjs keeps a list and such a file
// the same in both directions without knowing which shape it settles: each item is a document named `/<its id>`, its
// text is the item's JSON (`copy.text`), its identity the BLAKE3 of that text (`copy.identity`), and its keys are the
// row's fields as they are, so a program that reads the list reads the same row the file holds. Fields under `copy.`
// and `file.` are the copy's own; a list keeps its own fields (list_only in its row source) off the file.
//
// Non-Negotiable Invariants:
//   1. Nothing outside `root` is read or written (folder-files.mjs refuses it).
//   2. Only the items at `at` change. Every other part of the file (its about, its settings) is kept as it is; the file
//      is written whole with `indent` spaces and a final newline, so a file that is a list's copy has one shape.
//   3. An item is written or removed only while it is still the one the caller read (`if_identity`; null: no item with
//      that id yet), and the file only while it is still the bytes this change read (folder-files writeIfUnchanged), so
//      a change made between the read and the write is never overwritten.
//   4. No file, path, key or field is named here: the list's row source says them.
//
//   readJsonItemRows({ root, file, at?, key?, paths?, after?, limit?, most_bytes? }) → { rows: [{ id, values }], next }
//   changeJsonItemRows({ root, file, at?, key?, indent?, rows: [{ id, text?, values?, if_identity }],
//     remove?: [{ id, if_identity }] }) → { kept, removed }
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { folderFiles } from './folder-files.mjs';

const META = ['copy.', 'file.'];
const meta = field => META.some(prefix => field.startsWith(prefix));
const MOST_ROWS = 500;
const say = (code, words) => Object.assign(new Error(words), { code });
const utf8 = new TextEncoder();
const identityOf = text => makeHashCodeHexFromBytes(utf8.encode(text));

const needRoot = root => {
  if (typeof root !== 'string' || !root.startsWith('/')) throw say('bad_input', 'root must be the absolute path of the folder the tool was granted.');
  return root;
};
const needFile = file => {
  if (typeof file !== 'string' || !file || file.includes('..')) throw say('bad_input', 'file must be a path under root.');
  return `/${file.replace(/^\/+/, '')}`;
};
const steps = at => (typeof at === 'string' && at ? at.split('.') : []);

/** The file as read: its parsed document, the array at `at`, its identity and when it was last changed. */
async function itemsOf(files, name, at) {
  const read = await files.read(null, Infinity, name).catch(error => {
    if (error.code === 'ENOENT') throw say('not_a_document', `${name} is not there.`);
    throw error;
  });
  let document;
  try { document = JSON.parse(read.text); } catch { throw say('not_a_document', `${name} is not JSON.`); }
  const items = steps(at).reduce((held, part) => (held && typeof held === 'object' ? held[part] : undefined), document);
  if (!Array.isArray(items)) throw say('not_a_document', `${name} holds no array at ${at || 'its top'}.`);
  return { document, items, identity: read.identity, changed: new Date(read.facts.modified_at_ms).toISOString() };
}

const idOf = (item, key) => (item && typeof item === 'object' && !Array.isArray(item) && typeof item[key] === 'string' && item[key] ? item[key] : null);

/** One item as a row: its own keys, its JSON text and that text's identity, and the file's change time. */
function rowOf(item, key, changed) {
  if (Object.keys(item).some(meta)) throw say('not_a_document', `The item ${item[key]} has a key under ${META.join(' or ')}.`);
  const text = JSON.stringify(item);
  return { id: `/${item[key]}`, values: { ...item, 'copy.text': text, 'copy.identity': identityOf(text), 'file.mtime': changed } };
}

export async function readJsonItemRows({ root, file, at = '', key = 'id', paths, after = null, limit = MOST_ROWS, most_bytes } = {}) {
  const files = await folderFiles(needRoot(root));
  const { items, changed } = await itemsOf(files, needFile(file), at);
  const seen = new Set();
  let rows = [];
  for (const item of items) {
    const id = idOf(item, key);
    if (!id) throw say('not_a_document', `An item of ${file} has no ${key}.`);
    if (seen.has(id)) throw say('not_a_document', `${file} holds the ${key} ${id} twice.`);
    seen.add(id);
    rows.push(rowOf(item, key, changed));
  }
  if (paths !== undefined) rows = rows.filter(row => paths.includes(row.id));
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const after_ = rows.filter(row => !after || row.id > after);
  let page = after_.slice(0, Math.min(limit, MOST_ROWS));
  if (most_bytes !== undefined) {
    while (page.length && Buffer.byteLength(JSON.stringify({ rows: page, next: page.at(-1).id })) > most_bytes) page = page.slice(0, -1);
    if (!page.length && after_.length) throw say('bad_input', `the first item is bigger than most_bytes (${most_bytes}).`);
  }
  return { rows: page, next: page.length < after_.length ? page.at(-1).id : null };
}

/** The item a row asks for: its whole JSON text, or the item it changes with its own values (null removes a key). */
function wanted(row, current, key) {
  let item;
  if (typeof row.text === 'string' && row.text.trim()) {
    try { item = JSON.parse(row.text); } catch { throw say('bad_input', `The text of ${row.id} is not JSON.`); }
  } else {
    item = { ...(current ?? {}) };
    for (const [field, value] of Object.entries(row.values ?? {})) {
      if (meta(field)) continue;
      if (value === null) delete item[field];
      else item[field] = value;
    }
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw say('bad_input', `${row.id} is not an object.`);
  if (`/${item[key] ?? ''}` !== row.id) throw say('bad_input', `${row.id} must keep its ${key} ${row.id.slice(1)}.`);
  return item;
}

export async function changeJsonItemRows({ root, file, at = '', key = 'id', indent = 2, rows = [], remove = [] } = {}) {
  if (!Array.isArray(rows) || !Array.isArray(remove) || !(rows.length + remove.length)) {
    throw say('bad_input', 'rows (each an item and its values or whole text) or remove must name at least one item.');
  }
  const files = await folderFiles(needRoot(root));
  const name = needFile(file);
  const { document, items, identity } = await itemsOf(files, name, at);
  const index = id => items.findIndex(item => `/${idOf(item, key)}` === id);
  const current = position => (position < 0 ? null : identityOf(JSON.stringify(items[position])));
  let kept = 0, removed = 0;
  for (const row of rows) {
    const position = index(row.id);
    if (row.if_identity !== undefined && row.if_identity !== current(position)) {
      throw say('document_changed', `${row.id} in ${file} changed after it was read.`);
    }
    const item = wanted(row, position < 0 ? null : items[position], key);
    if (position < 0) items.push(item);
    else items[position] = item;
    kept += 1;
  }
  for (const gone of remove) {
    const position = index(gone.id);
    if (position < 0 || gone.if_identity !== current(position)) throw say('document_changed', `${gone.id} in ${file} changed after it was read.`);
    items.splice(position, 1);
    removed += 1;
  }
  const written = await files.writeIfUnchanged(name, `${JSON.stringify(document, null, indent)}\n`, identity);
  if (written.conflict) throw say('document_changed', `${file} changed after it was read.`);
  return { kept, removed };
}
