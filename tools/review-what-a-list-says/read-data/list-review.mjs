// src/list-review.mjs
//
// Purpose: keeping what a list says true, and noticing what nobody uses. A list set up for review gives each row an owner,
// a review state and a date by which it must be checked again (src/lists.json `review`), and saved views that decide,
// with the formula engine's rules, which rows need review and why: never checked or flagged, past their date, empty. A
// person or their AI marks rows checked, outdated or asking to be checked, or names their owner (reviewRows), and each
// owner reads the rows they must look at (rowsNeedingReview). Every row also gathers use heat that halves with time
// (lists.json `use_heat`): useRows adds to it (src/lists.mjs noteUse), and coldRows lists the rows nobody has used,
// leaving out those whose review is current.
//
// Non-Negotiable Invariants:
//   1. Nothing new keeps truth: the review is ordinary fields of the row written by putRows, the decision of which rows
//      need review is the list's own saved views run by the formula engine, and heat is one small record per row.
//   2. Every role, state, action, view, reason, limit and decay constant is DATA (src/lists.json `review`, `use_heat`);
//      nothing here names a list or a state.
//   3. Reads are bounded (review.scan_rows, use_heat.scan_rows) and say complete: false with a cursor when they stop
//      early, so a short answer is never mistaken for the whole.
//
import data from './lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const { review, use_heat: heat, limits } = data;
const DAY = 86_400_000;
const idOf = value => typeof value === 'string' && value && value.length <= 200 && !value.includes('/');
const slugOf = id => String(id).replace(/^list:/, '');

/** A row's heat as of `now` (ms) from its kept heat record ({ heat, at }), halving every half_life_days. */
export const heatNow = (kept, now) => (kept && Number.isFinite(kept.heat) && Number.isFinite(Date.parse(kept.at))
  ? kept.heat * 0.5 ** ((now - Date.parse(kept.at)) / (heat.half_life_days * DAY)) : 0);

/** The heat record a use leaves on a row, or null when the row was used within min_gap_minutes (nothing is written). */
export function usedHeat(kept, now) {
  if (kept && now - Date.parse(kept.at) < heat.min_gap_minutes * 60_000) return null;
  return { heat: Math.round((heatNow(kept, now) + heat.add) * 1000) / 1000, at: new Date(now).toISOString() };
}

// The field ids of a list's review roles: its own fields with the role's id, or the list's title field for `title`.
const roleIds = list => ({ ...Object.fromEntries(Object.entries(review.fields).map(([role, field]) => [role, field.id])), title: list.title_field });
const hasReview = list => Object.values(review.fields).every(field => list.fields.some(item => item.id === field.id));

// A view template with each { role } replaced by the list's field id for it.
const resolved = (value, roles) => (Array.isArray(value) ? value.map(item => resolved(item, roles))
  : value && typeof value === 'object' ? (Object.keys(value).length === 1 && typeof value.role === 'string' ? roles[value.role]
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolved(item, roles)]))) : value);

/**
 * One review action on a list (lists.json review.actions), through the list owner's own save and putRows:
 *   set_up  { expires_days? }  adds the review fields and views a list lacks (fields it already has are kept as they are)
 *   <action> { row_ids, owner? } sets the state, due date, checker or owner the action names on each row
 * Answers what changed.
 */
export async function reviewRows(lists, id, input = {}, { actor } = {}) {
  const slug = slugOf(id);
  const list = await lists.find(slug);
  if (!list) throw say('no_list', { list_id: slug });
  const actions = Object.keys(review.actions).filter(name => !name.startsWith('_'));
  if (input.action === 'set_up') {
    const days = input.expires_days ?? list.review?.expires_days ?? review.expires_days;
    if (!Number.isFinite(days) || days <= 0) throw say('bad_review', { actions: ['set_up', ...actions].join(', ') });
    const missing = Object.values(review.fields).filter(field => !list.fields.some(item => item.id === field.id));
    const roles = roleIds(list);
    const views = review.views.filter(view => !(list.views ?? []).some(kept => kept.id === view.id))
      .map(({ reason: _reason, ...view }) => resolved(view, roles));
    await lists.save({ id: slug, fields: [...list.fields, ...missing], views: [...(list.views ?? []), ...views], review: { expires_days: days } }, { actor });
    return { list_id: slug, set_up: true, fields_added: missing.map(field => field.id), views_added: views.map(view => view.id), expires_days: days };
  }
  const action = review.actions[input.action];
  if (!action || String(input.action).startsWith('_')) throw say('bad_review', { actions: ['set_up', ...actions].join(', ') });
  if (!hasReview(list)) throw say('no_review', { list_id: slug });
  if (!Array.isArray(input.row_ids) || !input.row_ids.length || input.row_ids.length > limits.rows_per_write || !input.row_ids.every(idOf))
    throw say('bad_row', { index: 'row_ids' });
  if (action.owner === 'set' && (typeof input.owner !== 'string' || !input.owner.trim())) throw say('bad_review', { actions: actions.join(', ') });
  const roles = roleIds(list);
  const now = Date.now();
  const days = list.review?.expires_days ?? review.expires_days;
  const values = {
    ...(action.state !== undefined ? { [roles.state]: action.state } : {}),
    ...(action.due === 'set' ? { [roles.due]: new Date(now + days * DAY).toISOString() } : action.due === 'clear' ? { [roles.due]: null } : {}),
    ...(action.by === 'set' ? { [roles.by]: actor?.by ?? null } : {}),
    ...(action.owner === 'set' ? { [roles.owner]: input.owner.trim() } : {}),
  };
  const answer = await lists.putRows(slug, { rows: input.row_ids.map(rowId => ({ id: rowId, values })) }, { actor });
  return { list_id: slug, action: input.action, kept: answer.kept.map(row => row.id), ...(answer.conflicts ? { conflicts: answer.conflicts } : {}), ...(answer.settled ? { settled: answer.settled } : {}) };
}

/**
 * The rows of a list that need review, by owner: { owners: [{ owner, rows: [{ id, title, reasons }] }], complete }. Each
 * review view (lists.json review.views) is read through `readView(list_id, view_id, page)` (the saved view engine, so
 * the formula engine decides), at most review.scan_rows rows each; `owner` narrows to one owner.
 */
export async function rowsNeedingReview(lists, id, { owner } = {}, { readView } = {}) {
  const slug = slugOf(id);
  const list = await lists.find(slug);
  if (!list) throw say('no_list', { list_id: slug });
  if (!hasReview(list)) throw say('no_review', { list_id: slug });
  if (!readView) throw say('no_review', { list_id: slug });
  const roles = roleIds(list);
  const found = new Map();
  let complete = true;
  for (const view of review.views) {
    if (!(list.views ?? []).some(kept => kept.id === view.id)) continue;
    let cursor;
    let seen = 0;
    do {
      const page = await readView({ list_id: slug, view_id: view.id, limit: limits.read_page_rows, ...(cursor ? { cursor } : {}) });
      for (const row of page.rows) {
        const entry = found.get(row.id) ?? { id: row.id, title: row.title ?? row.id, owner: row.values?.[roles.owner] ?? null, reasons: [] };
        entry.reasons.push(view.reason);
        found.set(row.id, entry);
      }
      seen += page.rows.length;
      cursor = page.page && page.page.complete === false ? page.page.next_cursor : null;
      if (cursor && seen >= review.scan_rows) { complete = false; cursor = null; }
    } while (cursor);
  }
  const owners = new Map();
  for (const row of found.values()) {
    if (owner !== undefined && row.owner !== owner) continue;
    const key = row.owner ?? null;
    if (!owners.has(key)) owners.set(key, []);
    const rows = owners.get(key);
    if (rows.length < review.rows_listed) rows.push({ id: row.id, title: row.title, reasons: row.reasons });
    else complete = false;
  }
  return { list_id: slug, complete, owners: [...owners].map(([name, rows]) => ({ owner: name, rows })) };
}

/**
 * The rows of a list nobody uses: heat below use_heat.cold_below, leaving out rows whose review is current (verified and
 * not past their date). A page at a time: { rows: [{ id, title, heat, last_used }], next_cursor, complete }.
 */
export async function coldRows(lists, id, { owner, cursor } = {}) {
  const slug = slugOf(id);
  const list = await lists.find(slug);
  if (!list) throw say('no_list', { list_id: slug });
  const roles = roleIds(list);
  const now = Date.now();
  const out = [];
  let next = cursor ?? null;
  let seen = 0;
  do {
    const page = await lists.read(slug, { limit: limits.read_page_rows, ...(next ? { cursor: next } : {}) });
    const heats = await lists.heatOf(slug, { row_ids: page.rows.map(row => row.id) });
    for (const row of page.rows) {
      const values = row.values ?? {};
      if (owner !== undefined && values[roles.owner] !== owner) continue;
      const current = values[roles.state] === review.verified && Date.parse(values[roles.due] ?? '') > now;
      const kept = heats.heats[row.id] ?? null;
      const warmth = heatNow(kept, now);
      if (current || warmth >= heat.cold_below) continue;
      out.push({ id: row.id, title: row.title ?? row.id, heat: Math.round(warmth * 1000) / 1000, last_used: kept?.at ?? null });
    }
    seen += page.rows.length;
    next = page.page && page.page.complete === false ? page.page.next_cursor : null;
  } while (next && seen < heat.scan_rows && out.length < heat.rows_listed);
  return { list_id: slug, rows: out, complete: !next, ...(next ? { next_cursor: next } : {}) };
}
