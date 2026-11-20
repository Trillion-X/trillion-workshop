// tools/send-work-tasks-tours-and-instructions-from/do-work/work-for-ais-book.mjs
//
// The operator's per-row book of work: save, end and read, each row in its own record, and the list of shipped, kept and
// in-force rows. Ported from the old owner's src/work-for-ais.mjs at commit b6ae0ebf81 (the tag named in moved-from.json):
// makeWorkRow (lines 200-228), readWorkRows (230-240), workRowsOf (242-267) and workRowBookName (268). The row limit
// (200, from DATA) and the expired-row let-go on save are in planWorkRowSave (old lines 249-258). Built and tested, not
// wired, waits for the owner's word.
//
// Every store is handed in: `kv` is the published edge store (list and get and put and delete by key), `bookOf(id)` is the
// row's own record book (its list and put of the record kind 'row'), `now` the clock. The rules (limits, words, shipped rows)
// are the caller's, read from the owner's DATA file. The operator check and the operator's tools are not here: they belong to
// the route and tool rows, which are not built.
import { WorkForAisError, checkedRow, rowsInForce } from './work-for-ais-rules.mjs';

// The key prefix each row is published under in the edge store, and the name of a row's own record book.
export const PUBLISHED_PREFIX = 'work-row:';
export const workRowBookName = id => `${PUBLISHED_PREFIX}${id}`;

/** One row's own book (old makeWorkRow): it keeps the row in its record 'row' and publishes it under its key in the edge
 *  store, where every Worker reads it. Operations: save { row }, end { id, earlier } (earlier: the row in force being ended,
 *  a shipped one included), read { id }. `list(kind)` and `put(kind, row)` are the record book's own. */
export function makeWorkRow({ list, put, kv, now = () => new Date(), rules }) {
  const held = () => list('row')[0] ?? null;
  const publish = async row => { await kv.put(`${PUBLISHED_PREFIX}${row.id}`, JSON.stringify(row)); return row; };
  const own = id => { if (held() && held().id !== id) throw new WorkForAisError('This book keeps another row of work.'); };
  return {
    async run(operation, input = {}) {
      if (operation === 'save') {
        const checked = checkedRow(input.row, rules);
        own(checked.id);
        const row = { ...checked, saved_at: now().toISOString() };
        put('row', row);
        return publish(row);
      }
      if (operation === 'end') {
        own(input.id);
        const earlier = held() ?? input.earlier;
        if (!earlier || earlier.id !== input.id) throw new WorkForAisError(rules.words.nothing_to_end);
        const row = { ...earlier, ended_at: now().toISOString() };
        put('row', row);
        return publish(row);
      }
      if (operation === 'read') { own(input.id); return held(); }
      throw new WorkForAisError('Work for AIs can be listed, saved or ended.');
    },
  };
}

/** The kept rows, read from the edge store under the published prefix, every page. */
export async function readWorkRows(kv) {
  const rows = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: PUBLISHED_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) { const row = await kv.get(key.name, 'json'); if (row) rows.push(row); }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return rows;
}

/** What a save does to the rows kept now, before anything is written: the row checked (checkedRow throws first), the kept
 *  rows whose window has ended and which are let go (never a shipped id, never the row being saved), and whether the save is
 *  over the row limit. An expired row holds no place, so it is not counted. */
export function planWorkRowSave({ row, kept, shipped, nowMs, rules }) {
  const checked = checkedRow(row, rules);
  const shippedIds = new Set(shipped.map(item => item.id));
  const letGo = kept.filter(item => item.window?.until && Date.parse(item.window.until) <= nowMs && !shippedIds.has(item.id) && item.id !== checked.id).map(item => item.id);
  const holding = kept.length - letGo.length;
  const full = !kept.some(item => item.id === checked.id) && holding >= rules.limits.rows;
  return { checked, letGo, holding, full };
}

/** The operations on the rows (old workRowsOf): list, save, end. Each save or end reaches only the row's own book, and an
 *  expired row is let go from the edge store on save, as the old owner did (before the limit is judged). */
export function workRowsOf({ kv, bookOf, shipped = null, now = () => new Date(), rules }) {
  const ship = shipped ?? rules.rows;
  const kept = () => readWorkRows(kv);
  return {
    async list() { const rows = await kept(); return { shipped: ship, kept: rows, in_force: rowsInForce(ship, rows) }; },
    async save({ row } = {}) {
      const plan = planWorkRowSave({ row, kept: await kept(), shipped: ship, nowMs: now().getTime(), rules });
      for (const id of plan.letGo) await kv.delete(`${PUBLISHED_PREFIX}${id}`);
      if (plan.full) throw new WorkForAisError(`${rules.words.too_many} The most is ${rules.limits.rows}; ${plan.holding} are kept now.`);
      return bookOf(plan.checked.id).run('save', { row });
    },
    async end({ id } = {}) {
      const earlier = (await kept()).find(row => row.id === id) ?? ship.find(row => row.id === id);
      if (!earlier) throw new WorkForAisError(rules.words.nothing_to_end);
      return bookOf(id).run('end', { id, earlier });
    },
  };
}
