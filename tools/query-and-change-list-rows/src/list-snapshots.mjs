// src/list-snapshots.mjs
//
// Purpose: a view's rows held still while a person scrolls, selects and totals them. Taking a snapshot evaluates the
// view (or the whole list) once and keeps only the ids it held, in its order, under a snapshot id; pages are then ranges
// of those ids (rows read fresh by id), totals are read by the snapshot id (src/list-aggregates.mjs), and a select-all
// is the snapshot id, so rows written meanwhile neither jump between pages nor change what was counted.
//
// Non-Negotiable Invariants:
//   1. A snapshot holds ids only (the list owner keeps it, src/lists.mjs keepSnapshot); values are always read now, by id,
//      from the list that owns the rows.
//   2. It is bounded: at most limits.snapshot_rows ids (`complete: false` when the view held more), snapshots.minutes long,
//      limits.snapshots_kept per list. A page is at most limits.snapshot_page_rows ids.
//   3. A row removed since the snapshot was taken is left out of its page and named in `gone`, never shown as empty.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const { limits } = data;

/** Evaluates a list or one of its saved views once and keeps the ids it holds: { snapshot_id, total, complete, expires_at }. */
export async function takeSnapshot(lists, id, { view_id } = {}, { readView, actor } = {}) {
  const slug = String(id).replace(/^list:/, '');
  if (view_id !== undefined && (typeof view_id !== 'string' || !readView)) throw say('bad_snapshot', { limit: limits.snapshot_rows });
  const ids = [];
  let cursor;
  let complete = false;
  while (ids.length < limits.snapshot_rows) {
    const options = { limit: limits.read_page_rows, ...(cursor ? { cursor } : {}) };
    const page = view_id ? await readView({ list_id: slug, view_id, ...options }) : await lists.read(slug, options);
    ids.push(...page.rows.map(row => row.id));
    cursor = page.page?.next_cursor ?? null;
    if (page.page?.complete !== false || !cursor) { complete = true; break; }
  }
  return lists.keepSnapshot(slug, { view_id: view_id ?? null, ids: ids.slice(0, limits.snapshot_rows), complete: complete && ids.length <= limits.snapshot_rows }, { actor });
}

/** One range of a snapshot's ids with their rows as they are now: { rows, gone, from, total, next_cursor }. */
export async function readSnapshot(lists, id, { snapshot_id, from = 0, count = limits.snapshot_page_rows } = {}) {
  const slug = String(id).replace(/^list:/, '');
  const start = Number(from), size = Math.min(Number(count), limits.snapshot_page_rows);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1) throw say('bad_row', { index: 'from or count' });
  const held = await lists.readSnapshot(slug, { snapshot_id });
  const range = held.ids.slice(start, start + size);
  const read = range.length ? await lists.read(slug, { row_ids: range }) : { rows: [] };
  const byId = new Map(read.rows.map(row => [row.id, row]));
  const next = start + range.length;
  return {
    list_id: slug, snapshot_id, view_id: held.view_id ?? null, total: held.ids.length, complete: held.complete, expires_at: held.expires_at, from: start,
    rows: range.filter(rowId => byId.has(rowId)).map(rowId => byId.get(rowId)), gone: range.filter(rowId => !byId.has(rowId)),
    next_cursor: next < held.ids.length ? String(next) : null,
  };
}

/** The page reader list-aggregates asks for a snapshot: its ids a page at a time, as a list read would answer them. */
export const snapshotPages = lists => async ({ list_id, snapshot_id, limit, cursor }) => {
  const page = await readSnapshot(lists, list_id, { snapshot_id, from: cursor === undefined ? 0 : Number(cursor), count: limit });
  return { rows: page.rows, page: { scanned: page.rows.length + page.gone.length, next_cursor: page.next_cursor, complete: page.next_cursor === null } };
};
