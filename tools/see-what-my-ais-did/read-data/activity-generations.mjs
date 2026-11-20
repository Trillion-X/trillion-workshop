// tools/see-what-my-ais-did/read-data/activity-generations.mjs
//
// The rules of a person's AI activity record, ported from tools/shared-code/src/activity.mjs: what a kept row holds, its links
// (made, used, for), the generations that hold the rows (the newest two are read; when the newest is full a new one starts and
// every older one is dropped whole), the list read and the trace read. The store is passed in: the do-work command opens the
// person's Postgres database, the test passes an in-memory store with the same methods. This file names no database.
//
// The store has these methods (all async):
//   generations()                 the generation numbers present, oldest first
//   createGeneration(n)           creates generation n's tables (IF NOT EXISTS)
//   refreshViews(gens)            points the activity and activity_links views at gens
//   roll(previous, next)          creates next, refreshes the views over [previous, next], drops every generation below previous
//   count(n)                      rows held by generation n
//   maxSeq()                      newest seq over the visible generations, 0 when none
//   insertRow(n, row)             row = { seq, at, app, row, ok }
//   insertLinks(n, seq, links)    links = [{ id, role }]
//   bumpCounts(n, ids)            one more call for each id in ids (activity_counts_g<n>)
//   list({ before, app, failed, forIds, limit })   newest first: [{ seq, row }]
//   links({ id, roles, newest, limit })            [{ seq, role }] by seq, ascending unless newest
//   rowsBySeq(seqs)               Map of seq -> row
//
// KEEP is activity-marks.json `keep`; a test checks the two agree.

export const KEEP = 5000;
export const TRACE_STEPS = 200;
const DEFAULT_DEPTH = 4;
const MAX_DEPTH = 8;
const LIST_DEFAULT = 200;
const LIST_MAX = 500;

export class ActivityError extends Error {}

/** The row a call left (what activityRow returns), checked: its tool and its time are required, its id lists must be lists. */
export function checkRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ActivityError('Give row, one activity row (what the AI call left).');
  if (typeof row.tool !== 'string' || !row.tool) throw new ActivityError('row.tool must name the tool the call ran.');
  if (typeof row.at !== 'string' || !row.at) throw new ActivityError('row.at must be the time the call was made.');
  for (const name of ['uses', 'for']) {
    if (row[name] !== undefined && !Array.isArray(row[name])) throw new ActivityError(`row.${name} must be a list of ids.`);
  }
  return row;
}

/** The links a row keeps beside it: the item it made (made), its execution reference (used), what it used and what it was done for. */
export function linksOf(row) {
  return [
    [row.item, 'made'],
    [row.execution_ref, 'used'],
    ...(row.uses ?? []).map(id => [id, 'used']),
    ...(row.for ?? []).map(id => [id, 'for']),
  ].filter(([id]) => typeof id === 'string' && id).map(([id, role]) => ({ id, role }));
}

/** Makes sure the store has a generation to write to and its views point at the newest two. */
export async function openActivity(store) {
  let generations = await store.generations();
  if (!generations.length) {
    await store.createGeneration(1);
    generations = [1];
  }
  await store.refreshViews(generations.slice(-2));
  return generations;
}

/** Keeps one row in the newest generation (starting a new one when it holds `keep` rows). Returns where it went. */
export async function keepRow(store, row, keep = KEEP) {
  checkRow(row);
  const generations = await openActivity(store);
  let current = generations.at(-1);
  if (await store.count(current) >= keep) {
    await store.roll(current, current + 1);
    current += 1;
  }
  const seq = (await store.maxSeq()) + 1;
  await store.insertRow(current, { seq, at: row.at, app: typeof row.app === 'string' ? row.app : null, row, ok: row.ok === false ? 0 : 1 });
  const links = linksOf(row);
  if (links.length) await store.insertLinks(current, seq, links);
  const ids = [...new Set(links.map(({ id }) => id))];
  if (ids.length) await store.bumpCounts(current, ids);
  return { generation: current, seq };
}

const truthy = value => value === true || value === 'true' || value === '1';

/** The newest kept rows, `limit` at a time. `before` is the seq of the last row already read; `for` is one id or a list. */
export async function listRows(store, { before = null, limit = LIST_DEFAULT, app = null, for: forId = null, failed = false } = {}) {
  await openActivity(store);
  const size = Math.min(Math.max(Number(limit) || LIST_DEFAULT, 1), LIST_MAX);
  const older = before === null || before === undefined || before === '' ? null : Number(before);
  const forIds = (Array.isArray(forId) ? forId : [forId]).filter(id => typeof id === 'string' && id);
  const found = await store.list({ before: Number.isInteger(older) ? older : null, app: typeof app === 'string' && app ? app : null,
    failed: truthy(failed), forIds, limit: size + 1 });
  const items = found.slice(0, size).map(({ seq, row }) => ({ seq, ...row }));
  return { items, next_before: found.length > size ? items.at(-1).seq : null };
}

/**
 * How `item` came about and what came of it: the calls that made it, then, hop by hop up to `depth`, the calls that made what
 * they used, then the calls that used the item or were done for it. Each step is the kept row plus link, about, because, depth.
 */
export async function traceItem(store, { item, depth = DEFAULT_DEPTH } = {}) {
  await openActivity(store);
  const id = typeof item === 'string' ? item.trim() : '';
  if (!id) return { item: null, steps: [] };
  const hops = Math.min(Math.max(Number.isInteger(Number(depth)) ? Number(depth) : DEFAULT_DEPTH, 0), MAX_DEPTH);
  const steps = [];
  const seenRows = new Set();
  const seenIds = new Set([id]);
  let limited = false;
  const read = async (about, roles, newest = false) => {
    const found = await store.links({ id: about, roles, newest, limit: TRACE_STEPS + 1 });
    if (found.length > TRACE_STEPS) limited = true;
    const selected = found.slice(0, TRACE_STEPS);
    const rows = await store.rowsBySeq(selected.map(link => link.seq));
    return selected.filter(link => rows.has(link.seq)).map(link => ({ seq: link.seq, role: link.role, row: rows.get(link.seq) }));
  };
  let wave = [{ about: id, because: null }];
  for (let level = 0; level <= hops && wave.length && steps.length < TRACE_STEPS; level += 1) {
    const next = [];
    for (const { about, because } of wave) {
      for (const { seq, row } of await read(about, ['made'])) {
        if (seenRows.has(seq) || steps.length >= TRACE_STEPS) continue;
        seenRows.add(seq);
        steps.push({ seq, ...row, link: 'made', about, because, depth: level });
        for (const used of row.uses ?? []) {
          if (seenIds.has(used)) continue;
          if (seenIds.size >= TRACE_STEPS) { limited = true; break; }
          seenIds.add(used);
          next.push({ about: used, because: seq });
        }
      }
    }
    wave = next;
  }
  for (const { seq, role, row } of await read(id, ['used', 'for'], true)) {
    if (seenRows.has(seq) || steps.length >= TRACE_STEPS) continue;
    seenRows.add(seq);
    steps.push({ seq, ...row, link: role, about: id, because: null, depth: 1 });
  }
  return { item: id, steps, coverage: { source: 'bounded_activity_feed', step_limit: TRACE_STEPS, depth_limit: hops,
    limit_reached: limited || steps.length >= TRACE_STEPS || wave.length > 0, historical_origin: 'captured_receipts_only' } };
}
