import { tableGeneration } from '../../../keep-and-wake-ai-sessions-on-this-computer/src/table-generation.mjs';
// The ordered entries of a large mixed share. The grant remains the access authority;
// these rows are only references and never contain file bytes or storage credentials.
// Each row is a bounded page, so an indexed media read touches one page regardless
// of how many other files, workflows, links or words the share contains.

const PAGE_ITEMS = 32;
const PAGE_BYTES = 128 * 1024;
const opened = new WeakMap();
const byteLength = value => new TextEncoder().encode(value).byteLength;

function ready(sql) {
  if (opened.get(sql) === tableGeneration(sql)) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS share_collection_pages (
    share_id TEXT NOT NULL,
    page_no INTEGER NOT NULL,
    ordinal_start INTEGER NOT NULL,
    leaf_start INTEGER NOT NULL,
    leaf_count INTEGER NOT NULL,
    entries_json TEXT NOT NULL,
    PRIMARY KEY (share_id, page_no)
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS share_collection_pages_leaf ON share_collection_pages (share_id, leaf_start)');
  sql.exec('CREATE INDEX IF NOT EXISTS share_collection_pages_ordinal ON share_collection_pages (share_id, ordinal_start)');
  opened.set(sql, tableGeneration(sql));
}

// Open outside the membership/grant transaction. SQLite rolls DDL back with that transaction;
// the in-process prepared marker must never outlive a rolled-back first table creation.
export const openCollectionStore = ready;

/** Append one bounded batch after the already-kept entries. The caller owns the transaction with the grant row. */
export function appendCollectionPages(sql, shareId, entries, leafCounts, { pageCount, entryCount, leafCount }) {
  if (entries.length !== leafCounts.length || !entries.length) throw new Error('A collection batch needs its entries and leaf counts.');
  if (leafCounts.some(count => !Number.isSafeInteger(count) || count < 1)) throw new Error('A collection entry needs a positive leaf count.');
  if (![pageCount, entryCount, leafCount].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('A collection offset must be a safe count.');
  ready(sql);
  let page = pageCount;
  let ordinal = entryCount;
  let leaf = leafCount;
  let pending = [];
  let pendingBytes = 2;
  let replacing = false;
  if (pageCount > 0) {
    const last = sql.exec('SELECT page_no, ordinal_start, leaf_start, entries_json FROM share_collection_pages WHERE share_id = ? ORDER BY page_no DESC LIMIT 1', shareId).toArray()[0];
    const firstBytes = byteLength(JSON.stringify({ entry: entries[0], leaf_count: leafCounts[0] }));
    if (!last || last.page_no + 1 !== pageCount) throw new Error('This shared collection changed before the next batch.');
    const held = JSON.parse(last.entries_json);
    if (held.length < PAGE_ITEMS && byteLength(last.entries_json) + firstBytes + 1 <= PAGE_BYTES) {
      page = last.page_no;
      ordinal = last.ordinal_start;
      leaf = last.leaf_start;
      pending = held;
      pendingBytes = byteLength(last.entries_json);
      replacing = true;
    }
  }
  const flush = () => {
    if (!pending.length) return;
    const leaves = pending.reduce((sum, item) => sum + item.leaf_count, 0);
    if (!Number.isSafeInteger(leaves) || !Number.isSafeInteger(leaf + leaves)) throw new Error('This share has too many items to index safely.');
    if (replacing) sql.exec('UPDATE share_collection_pages SET leaf_count = ?, entries_json = ? WHERE share_id = ? AND page_no = ?', leaves, JSON.stringify(pending), shareId, page);
    else sql.exec('INSERT INTO share_collection_pages (share_id, page_no, ordinal_start, leaf_start, leaf_count, entries_json) VALUES (?, ?, ?, ?, ?, ?)',
      shareId, page, ordinal, leaf, leaves, JSON.stringify(pending));
    replacing = false;
    page += 1;
    ordinal += pending.length;
    leaf += leaves;
    pending = [];
    pendingBytes = 2;
  };
  for (let i = 0; i < entries.length; i += 1) {
    const kept = { entry: entries[i], leaf_count: leafCounts[i] };
    const encoded = JSON.stringify(kept);
    const size = byteLength(encoded) + (pending.length ? 1 : 0);
    if (size + 2 > PAGE_BYTES) throw new Error('One shared item is too large to keep.');
    if (pending.length >= PAGE_ITEMS || pendingBytes + size > PAGE_BYTES) flush();
    pending.push(kept);
    pendingBytes += size;
  }
  flush();
  if (![page, ordinal, leaf].every(Number.isSafeInteger)) throw new Error('This share has too many items to index safely.');
  return { page_count: page, entry_count: ordinal, leaf_count: leaf };
}

const unpack = row => row ? { ...row, entries: JSON.parse(row.entries_json) } : null;

/** Find one flattened leaf through the page's cumulative offsets, without reading earlier pages. */
export function collectionEntryAtLeaf(sql, shareId, index) {
  ready(sql);
  const row = unpack(sql.exec('SELECT leaf_start, entries_json FROM share_collection_pages WHERE share_id = ? AND leaf_start <= ? ORDER BY leaf_start DESC LIMIT 1', shareId, index).toArray()[0]);
  if (!row) return null;
  let offset = index - row.leaf_start;
  for (const kept of row.entries) {
    if (offset < kept.leaf_count) return { entry: kept.entry, inside: offset };
    offset -= kept.leaf_count;
  }
  return null;
}

/** Resolve a bounded run of flattened leaves through the few stored pages it crosses. */
export function collectionEntriesAtLeaves(sql, shareId, offset, limit) {
  ready(sql);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > PAGE_ITEMS) throw new Error('A collection page needs a bounded range.');
  if (!limit) return [];
  const first = sql.exec('SELECT page_no FROM share_collection_pages WHERE share_id = ? AND leaf_start <= ? ORDER BY leaf_start DESC LIMIT 1', shareId, offset).toArray()[0];
  if (!first) return [];
  const pages = sql.exec('SELECT leaf_start, entries_json FROM share_collection_pages WHERE share_id = ? AND page_no >= ? ORDER BY page_no LIMIT ?', shareId, first.page_no, limit).toArray();
  const found = [];
  let at = offset;
  for (const page of pages) {
    let start = page.leaf_start;
    for (const kept of JSON.parse(page.entries_json)) {
      const end = start + kept.leaf_count;
      while (at >= start && at < end && found.length < limit) {
        found.push({ entry: kept.entry, inside: at - start });
        at += 1;
      }
      if (found.length === limit) return found;
      start = end;
    }
  }
  return found;
}

/** Read a source occurrence for an idempotent append retry; this never expands a nested share. */
export function collectionEntryAtOrdinal(sql, shareId, ordinal) {
  ready(sql);
  const row = unpack(sql.exec('SELECT ordinal_start, entries_json FROM share_collection_pages WHERE share_id = ? AND ordinal_start <= ? ORDER BY ordinal_start DESC LIMIT 1', shareId, ordinal).toArray()[0]);
  return row?.entries[ordinal - row.ordinal_start]?.entry ?? null;
}
