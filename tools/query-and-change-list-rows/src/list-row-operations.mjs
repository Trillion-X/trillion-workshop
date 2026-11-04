// src/list-row-operations.mjs
//
// Purpose: the row operations a person (or their AI) asks of a list that are more than "put these rows": put a row by
// who it IS (match_on: the row already holding this email is the row), act on a whole selection without naming a
// thousand ids (select: a saved view's rows, less the ones left out), fold two rows that are one thing into one
// (mergeRows), copy rows into the same list or another (duplicateRows), ask which rows of which lists point at this one
// (backlinks) and which still point at rows just removed (withDangling), and follow a file to its new name in every file
// field that named it (fileReferences, rewriteFileNames). Each is built over the list owner's
// own read / putRows / all (src/lists.mjs), whichever store the list lives in, so authority, validation, links and
// settles are the list owner's, and a list kept in a database answers the same as one in the account's own records.
//
// Non-Negotiable Invariants:
//   1. Nothing here writes a record itself: every change is a putRows to the list that owns the row, so a refusal
//      (a settled value, a required link, a cycle) is the owner's refusal.
//   2. What varies is DATA (src/lists.json: normalizers, limits). The matching key is the first field of match_on the
//      row gives a value for; its shared form (src/list-identity.mjs) is compared, and the raw spelling is kept.
//   3. A selection is edges over a list, not ids: the view (or the whole list), the ids left out and the ids added. A
//      call applies at most limits.select_rows_per_call rows and answers the cursor that continues, in the list's own
//      id order, so rows that stop matching because of what was just written are neither skipped nor met twice.
//   4. A merge writes the survivor first, then the links that pointed at the row that goes, then removes it, so a merge
//      cut short leaves two rows and no dangling link, and asking again finishes it.
//   5. A copy is made field by field as the list's DATA says (src/lists.json `duplicate`), and never copies the basis or the
//      merge history of its source.
//   6. Reading who points at a row asks the store's own record of what holds what (participation, kept on every write)
//      and reads rows only for a field whose record is still being built, within limits.backlink_scan_rows rows; at most
//      limits.backlinks_returned are returned and it says when it is not complete, never reporting a partial answer as the whole.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { matchable, normalizedKeys, normalizerOf } from './list-identity.mjs';
import { listSay as say } from './list-refusals.mjs';

const { limits } = data;
const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const idOf = value => typeof value === 'string' && value && value.length <= 200 && !value.includes('/');
const slugOf = id => String(id).replace(/^list:/, '');
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const listValue = value => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []);

// Every row of a list a page at a time, up to `most` rows; says whether the end was reached.
async function* pages(lists, id, options, most) {
  let cursor;
  let seen = 0;
  for (;;) {
    const page = await lists.read(id, { ...options, limit: limits.read_page_rows, ...(cursor ? { cursor } : {}) });
    seen += page.rows.length;
    yield { rows: page.rows, complete: page.page?.complete !== false, reached: seen };
    if (page.page?.complete !== false) return;
    if (seen >= most) return;
    cursor = page.page.next_cursor;
  }
}

// ---- match_on: a row put by who it is -------------------------------------------------------------------------------

async function matchRows(lists, id, list, rows, matchOn, modeName) {
  const modes = data.keys.match_modes;
  if (modeName !== undefined && (typeof modeName !== 'string' || modeName.startsWith('_') || !Object.hasOwn(modes, modeName)))
    throw say('bad_match_mode', { modes: Object.keys(modes).join(', '), what: JSON.stringify(modeName) });
  const mode = modes[modeName ?? 'create_or_update'];
  // Without match_on, a row is matched by the list's identity keys (its unique fields, in field order).
  const keys = matchOn ?? list.fields.filter(field => field.unique === true).map(field => field.id);
  if (!Array.isArray(keys) || !keys.length || keys.length > limits.fields_per_list) throw say('bad_match', { list_id: list.id, what: JSON.stringify(matchOn) });
  const fields = keys.map(fieldId => list.fields.find(field => field.id === fieldId));
  fields.forEach((field, index) => { if (!field || !matchable(field)) throw say('bad_match', { list_id: list.id, what: JSON.stringify(keys[index]) }); });
  // A row with no id is matched by the first field of match_on it gives a value for (the fields are in priority order).
  const keyOf = row => {
    if (!isObject(row) || row.id !== undefined || !isObject(row.values)) return null;
    for (const field of fields) {
      const forms = normalizedKeys(row.values[field.id], normalizerOf(field));
      if (forms.length) return { field, keys: forms };
    }
    return null;
  };
  const wanted = rows.map(keyOf);
  if (!wanted.some(Boolean)) return { rows, matches: [] };
  // held: field id -> shared form -> ids of the rows holding it. A unique field whose keys are ready answers by one point
  // read per value (src/list-keys.mjs); otherwise one walk of the list reads only the match fields.
  const held = new Map(fields.map(field => [field.id, new Map()]));
  let complete = true;
  const asked = fields.map(field => ({ field, values: [...new Set(rows.filter((_, index) => wanted[index]?.field === field).map(row => row.values[field.id]))] }));
  const byKey = typeof lists.keyHolders === 'function' && asked.every(({ field, values }) => !values.length || field.unique === true)
    ? await Promise.all(asked.map(({ field, values }) => (values.length ? lists.keyHolders(id, { field_id: field.id, values }) : { ready: true, holders: [] })))
    : null;
  if (byKey && byKey.every(answer => answer.ready)) {
    asked.forEach(({ field }, index) => {
      for (const { value, row_id: rowId, row_ids: rowIds } of byKey[index].holders) {
        const ids = rowIds ?? (rowId ? [rowId] : []);
        for (const form of normalizedKeys(value, normalizerOf(field))) held.get(field.id).set(form, ids);
      }
    });
  } else {
    for await (const page of pages(lists, id, { only: fields.map(field => field.id) }, limits.match_scan_rows)) {
      for (const row of page.rows) for (const field of fields) for (const key of normalizedKeys(row.values[field.id], normalizerOf(field))) {
        const ids = held.get(field.id).get(key) ?? [];
        ids.push(row.id);
        held.get(field.id).set(key, ids);
      }
      complete = page.complete;
    }
  }
  const out = [];
  const matches = [];
  const at = new Map();
  rows.forEach((row, index) => {
    const key = wanted[index];
    if (!key) { out.push(row); return; }
    const ids = [...new Set(key.keys.flatMap(form => held.get(key.field.id).get(form) ?? []))];
    const value = JSON.stringify(row.values[key.field.id]);
    if (ids.length > 1) throw say('match_ambiguous', { list_id: list.id, field_id: key.field.id, value, count: ids.length, ids: ids.join(', ') });
    if (!ids.length && !complete) throw say('match_too_large', { list_id: list.id, limit: limits.match_scan_rows, field_id: key.field.id });
    if (ids.length && !mode.update) throw say('match_exists', { list_id: list.id, field_id: key.field.id, value, row_id: ids[0], mode: modeName });
    if (!ids.length && !mode.create) throw say('match_none', { list_id: list.id, field_id: key.field.id, value, mode: modeName });
    // The same thing named twice in one request is one row: the second naming merges into the first.
    const shared = ids.length ? `row\u0000${ids[0]}` : `${key.field.id}\u0000${key.keys[0]}`;
    if (at.has(shared)) {
      const first = out[at.get(shared)];
      first.values = { ...first.values, ...(ids.length ? without(row.values, key.field.id) : row.values) };
      matches.push(said(index, key, row, ids[0] ?? null, !ids.length));
      return;
    }
    at.set(shared, out.length);
    if (!ids.length) { out.push({ ...row }); matches.push(said(index, key, row, null, true)); return; }
    // The spelling already kept stays: the matching field is not written again.
    const { basis } = row;
    out.push({ ...row, id: ids[0], values: without(row.values, key.field.id), ...(basis ? { basis: without(basis, key.field.id) } : {}) });
    matches.push(said(index, key, row, ids[0], false));
  });
  return { rows: out, matches };
}
// What one row's match says before anything is written: which request row (index), the value it was matched by (matched,
// as given) and the shared form compared (form), the row it found (row_id) or that it makes one (created).
const said = (index, key, row, rowId, created) => ({ index, field_id: key.field.id, matched: row.values[key.field.id], form: key.keys[0], row_id: rowId, created });
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

// ---- select: a whole selection by its edges ------------------------------------------------------------------------

const SELECT_KEYS = new Set(['view_id', 'snapshot_id', 'except', 'include', 'cursor', 'values', 'remove']);

async function selectRows(lists, id, select, readView) {
  if (!isObject(select) || Object.keys(select).some(key => !SELECT_KEYS.has(key))) throw say('bad_select', { what: JSON.stringify(Object.keys(select ?? {}).find(key => !SELECT_KEYS.has(key)) ?? 'it') });
  const named = key => select[key] === undefined ? [] : select[key];
  const except = named('except'), include = named('include');
  if (!Array.isArray(except) || !Array.isArray(include) || [...except, ...include].some(item => !idOf(item)) || except.length > limits.rows_per_read || include.length > limits.rows_per_write
    || (select.view_id !== undefined && typeof select.view_id !== 'string') || (select.snapshot_id !== undefined && (typeof select.snapshot_id !== 'string' || select.view_id !== undefined)) || (select.cursor !== undefined && typeof select.cursor !== 'string')
    || (select.remove !== undefined && select.remove !== true) || (select.remove === true) === (select.values !== undefined) || (select.values !== undefined && !isObject(select.values)))
    throw say('bad_select', { what: 'that combination' });
  const left = new Set(except);
  const picked = [];
  let cursor = select.cursor;
  let complete = false;
  if (select.snapshot_id !== undefined) {
    // A selection of a snapshot's rows (take_list_snapshot): the ids it held still, from the cursor (a place in them), so rows
    // written meanwhile neither join nor leave what the person selected.
    const held = await lists.readSnapshot(id, { snapshot_id: select.snapshot_id });
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw say('bad_select', { what: 'that cursor' });
    let at = start;
    for (; at < held.ids.length && picked.length < limits.select_rows_per_call; at += 1) if (!left.has(held.ids[at])) picked.push(held.ids[at]);
    const reached = at >= held.ids.length;
    // A row removed since is left out (put by its id it would be made again).
    const alive = picked.length ? new Set((await lists.read(id, { row_ids: picked })).rows.map(row => row.id)) : new Set();
    const ids = picked.filter(rowId => alive.has(rowId));
    if (select.cursor === undefined) for (const rowId of include) if (!left.has(rowId) && !ids.includes(rowId)) ids.push(rowId);
    return { ids, next_cursor: reached ? null : String(at), complete: reached && held.complete };
  }
  while (picked.length < limits.select_rows_per_call) {
    const options = { limit: limits.read_page_rows, ...(cursor ? { cursor } : {}) };
    const page = select.view_id ? await readView({ list_id: id, view_id: select.view_id, ...options }) : await lists.read(id, options);
    for (const row of page.rows) if (!left.has(row.id)) picked.push(row.id);
    cursor = page.page?.next_cursor ?? null;
    if (page.page?.complete !== false || !cursor) { complete = true; break; }
  }
  // Rows added by name are taken once, on the first call (no cursor yet), whatever the view says of them.
  if (select.cursor === undefined) for (const rowId of include) if (!left.has(rowId) && !picked.includes(rowId)) picked.push(rowId);
  return { ids: picked, next_cursor: complete ? null : cursor, complete };
}

/**
 * One row request that names rows by who they are (match_on) or by a selection (select), as the plain
 * { rows, remove } requests the list owner writes (each at most rows_per_write), plus what was matched and selected.
 * `readView({ list_id, view_id, limit, cursor })` reads a saved view's page (the caller's view evaluator).
 */
export async function planRowRequest(lists, id, input, { readView } = {}) {
  const slug = slugOf(id);
  const body = isObject(input) ? input : {};
  const requests = [];
  let selection = null;
  let matches = [];
  let rows = Array.isArray(body.rows) ? body.rows : [];
  const remove = Array.isArray(body.remove) ? body.remove : [];
  if (body.match_on !== undefined || body.match_mode !== undefined) {
    const list = await lists.find(slug);
    if (!list) throw say('no_list', { list_id: slug });
    ({ rows, matches } = await matchRows(lists, slug, list, rows, body.match_on, body.match_mode));
  }
  const base = { rows, remove };
  if (body.select !== undefined) {
    if (!readView && body.select.view_id !== undefined) throw say('bad_select', { what: 'view_id here' });
    const chosen = await selectRows(lists, slug, body.select, readView);
    const toWrite = body.select.remove === true ? { rows: [], remove: chosen.ids } : { rows: chosen.ids.map(rowId => ({ id: rowId, values: body.select.values })), remove: [] };
    selection = { matched: chosen.ids.length, complete: chosen.complete, next_cursor: chosen.next_cursor };
    for (const part of [...chunks(toWrite.rows, limits.rows_per_write).map(group => ({ rows: group, remove: [] })), ...chunks(toWrite.remove, limits.rows_per_write).map(group => ({ rows: [], remove: group }))]) requests.push(part);
  }
  if (base.rows.length || base.remove.length || !requests.length) requests.unshift(base);
  return { requests, matches, selection };
}

/** Folds the answers of a plan's requests into the one answer put_list_rows gives. */
export const joinAnswers = (answers, plan) => {
  if (answers.length === 1 && !plan.matches.length && !plan.selection) return answers[0];
  const first = answers[0] ?? {};
  const joined = { ...first, kept: answers.flatMap(answer => answer.kept ?? []), removed: answers.flatMap(answer => answer.removed ?? []) };
  for (const key of ['settled', 'conflicts']) {
    const all = answers.flatMap(answer => answer[key] ?? []);
    if (all.length) joined[key] = all; else delete joined[key];
  }
  if (plan.matches.length) joined.matches = plan.matches;
  if (plan.selection) joined.selection = plan.selection;
  return joined;
};

// ---- backlinks: who points at this row -----------------------------------------------------------------------------

/** The link fields of every list that name `slug`: [{ list, field }]. */
async function linkingFields(lists, slug) {
  const all = await lists.all();
  return all.lists.flatMap(list => (list.fields ?? []).filter(field => KINDS.get(field.kind)?.links && field.links_to === slug).map(field => ({ list, field })));
}

/**
 * The links that point at some rows of one list: [{ list_id, field_id, row_id, target }] and whether every linking list was
 * read to its end. Each linking field is asked of its list's own record of what holds what (lists.linkHolders: the store's
 * participation, kept on every write, so the answer costs the links found); a field whose record is still being built is
 * read the old way, a page at a time, within limits.backlink_scan_rows rows.
 */
async function pointersTo(lists, slug, rowIds, most = limits.backlinks_returned) {
  const wanted = new Set(rowIds);
  const found = [];
  let budget = limits.backlink_scan_rows;
  let complete = true;
  for (const { list, field } of await linkingFields(lists, slug)) {
    if (found.length >= most) { complete = false; break; }
    const indexed = typeof lists.linkHolders === 'function' ? await lists.linkHolders(list.id, { field_id: field.id, target_list: slug, row_ids: [...wanted] }) : null;
    if (indexed?.complete) {
      for (const holder of indexed.holders) found.push({ list_id: list.id, field_id: field.id, row_id: holder.row_id, target: holder.target });
      continue;
    }
    if (budget <= 0) { complete = false; break; }
    for await (const page of pages(lists, list.id, { only: [field.id] }, budget)) {
      budget -= page.rows.length;
      for (const row of page.rows) for (const target of listValue(row.values[field.id])) if (wanted.has(target)) found.push({ list_id: list.id, field_id: field.id, row_id: row.id, target });
      if (!page.complete && budget <= 0) complete = false;
      if (found.length >= most) { complete = false; break; }
    }
  }
  return { links: found.slice(0, most), complete };
}

/**
 * The rows of every list that link to one row: { backlinks: [{ list_id, field_id, row_id, title }], complete }.
 * Returns at most limits.backlinks_returned and says complete: false when it stopped before the end.
 */
export async function backlinks(lists, id, rowId) {
  const slug = slugOf(id);
  if (!idOf(rowId)) throw say('bad_row', { index: 'row_id' });
  if (!(await lists.find(slug))) throw say('no_list', { list_id: slug });
  const { links, complete } = await pointersTo(lists, slug, [rowId]);
  const titled = await Promise.all(links.map(async ({ target: _target, ...link }) => {
    const read = await lists.read(link.list_id, { row_ids: [link.row_id] });
    return { ...link, title: read.rows[0]?.title ?? link.row_id };
  }));
  return { list_id: slug, row_id: rowId, backlinks: titled, complete };
}

/**
 * Where references to rows of any lists point now: `refs` each { address: "<list>/<row>" }, { list_id, row_id } or
 * { list_id, key: { field_id, value } }, answered in the order given as the list owner's resolve (src/lists.mjs). A row is
 * addressed by its list as well as its id, so the same id in two lists is two addresses.
 */
export async function resolveRows(lists, { refs } = {}) {
  const limit = data.limits.resolve_refs;
  if (!Array.isArray(refs) || !refs.length || refs.length > limit) throw say('bad_ref', { limit, index: 'refs' });
  const parsed = refs.map((ref, index) => {
    if (typeof ref?.address === 'string') {
      const at = ref.address.indexOf('/');
      const [list, rowId] = at > 0 ? [ref.address.slice(0, at), ref.address.slice(at + 1)] : [];
      if (!list || !idOf(rowId)) throw say('bad_ref', { limit, index });
      return { list_id: slugOf(list), ref: { row_id: rowId } };
    }
    if (!idOf(slugOf(ref?.list_id ?? ''))) throw say('bad_ref', { limit, index });
    return { list_id: slugOf(ref.list_id), ref: ref.key ? { key: ref.key } : { row_id: ref.row_id } };
  });
  const answers = new Map();
  for (const listId of new Set(parsed.map(item => item.list_id))) {
    const asked = parsed.filter(item => item.list_id === listId);
    const { resolved } = await lists.resolve(listId, { refs: asked.map(item => item.ref) });
    asked.forEach((item, index) => answers.set(item, resolved[index]));
  }
  return { resolved: parsed.map(item => ({ list_id: item.list_id, ...answers.get(item) })) };
}

/**
 * A put's answer with the links still pointing at the rows it removed (`dangling`: [{ list_id, field_id, row_id, target }],
 * and dangling_complete: false when not every linking list could be read to its end). A link field that detaches on
 * removal, or a paired one, has already let go and is never named here.
 */
export async function withDangling(lists, id, answer) {
  if (!answer?.removed?.length) return answer;
  const { links, complete } = await pointersTo(lists, slugOf(id), answer.removed);
  return { ...answer, ...(links.length ? { dangling: links } : {}), ...(complete ? {} : { dangling_complete: false }) };
}

// ---- merge: two rows that are one thing ----------------------------------------------------------------------------

const MULTI = new Set(['texts', 'row-ids']);

/**
 * Folds the row `base_id` into the row `target_id` of one list and answers { list_id, kept, removed, relinked, merged_from }.
 *  - each field takes the value only one row holds, the value both agree on, a value both hold as a list (the union),
 *    a settled value, or - where both hold different values - the one `prefer` ("base" or "target") or `values` names;
 *    with neither, the merge is refused naming the field;
 *  - every link to the base row in any list becomes a link to the target (a link the target would hold to itself is dropped);
 *  - the target row records where the base row went (_merged_from), and the base row is removed.
 */
export async function mergeRows(lists, id, input, { actor } = {}) {
  const slug = slugOf(id);
  const allowed = new Set(['base_id', 'target_id', 'prefer', 'values']);
  if (!isObject(input) || Object.keys(input).some(key => !allowed.has(key)) || !idOf(input.base_id) || !idOf(input.target_id)
    || (input.prefer !== undefined && input.prefer !== 'base' && input.prefer !== 'target') || (input.values !== undefined && !isObject(input.values)))
    throw say('bad_merge', { what: 'that request' });
  if (input.base_id === input.target_id) throw say('merge_same');
  const list = await lists.find(slug);
  if (!list) throw say('no_list', { list_id: slug });
  const read = await lists.read(slug, { row_ids: [input.base_id, input.target_id] });
  const base = read.rows.find(row => row.id === input.base_id), target = read.rows.find(row => row.id === input.target_id);
  if (!base) throw say('merge_missing', { row_id: input.base_id, list_id: slug });
  if (!target) throw say('merge_missing', { row_id: input.target_id, list_id: slug });
  const given = input.values ?? {};
  const values = {};
  const basis = {};
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  for (const field of list.fields) {
    const kind = KINDS.get(field.kind);
    // A paired link follows from the other side: relinking the rows that point at the base row (step 2) moves them here.
    if (!kind || kind.carries || kind.value === 'computed' || field.pairs_with !== undefined) continue;
    const [fromBase, fromTarget] = [base.values[field.id], target.values[field.id]];
    const [hasBase, hasTarget] = [fromBase !== undefined && fromBase !== null && fromBase !== '', fromTarget !== undefined && fromTarget !== null && fromTarget !== ''];
    if (Object.hasOwn(given, field.id)) { values[field.id] = given[field.id]; continue; }
    if (!hasBase) continue;
    if (!hasTarget) { values[field.id] = fromBase; if (base.values._basis?.[field.id]) basis[field.id] = base.values._basis[field.id]; continue; }
    if (same(fromBase, fromTarget)) continue;
    if (MULTI.has(kind.value)) { values[field.id] = [...new Set([...listValue(fromTarget), ...listValue(fromBase)])]; continue; }
    if (field.settles?.includes(fromTarget)) continue;
    if (field.settles?.includes(fromBase)) { values[field.id] = fromBase; continue; }
    if (input.prefer === 'base') { values[field.id] = fromBase; continue; }
    if (input.prefer === 'target') continue;
    throw say('merge_conflict', { field_id: field.id, base: JSON.stringify(fromBase), target: JSON.stringify(fromTarget) });
  }
  const lineage = [input.base_id, ...listValue(base.values._merged_from)];
  const options = actor ? { actor } : {};
  // 1. The survivor holds everything first.
  const kept = await lists.putRows(slug, { rows: [{ id: input.target_id, values, ...(Object.keys(basis).length ? { basis: Object.fromEntries(Object.entries(basis).map(([fieldId, entry]) => [fieldId, { confidence: entry.confidence, ...(entry.reasoning ? { reasoning: entry.reasoning } : {}), ...(entry.sources ? { sources: entry.sources } : {}) }])) } : {}), merged_from: lineage }] }, options);
  // 2. Every link to the base row, in every list, now points at the survivor.
  const relinked = [];
  for (const { list: holder, field } of await linkingFields(lists, slug)) {
    const rows = [];
    let budget = limits.backlink_scan_rows;
    for await (const page of pages(lists, holder.id, { only: [field.id] }, budget)) {
      budget -= page.rows.length;
      for (const row of page.rows) {
        const current = listValue(row.values[field.id]);
        if (!current.includes(input.base_id) || (holder.id === slug && row.id === input.base_id)) continue;
        const own = holder.id === slug && row.id === input.target_id;
        const next = [...new Set(current.flatMap(item => item === input.base_id ? (own ? [] : [input.target_id]) : [item]))];
        rows.push({ id: row.id, values: { [field.id]: next.length ? next : null } });
      }
      if (!page.complete && budget <= 0) throw say('match_too_large', { list_id: holder.id, limit: limits.backlink_scan_rows, field_id: field.id });
    }
    for (const group of chunks(rows, limits.rows_per_write)) await lists.putRows(holder.id, { rows: group }, options);
    if (rows.length) relinked.push({ list_id: holder.id, field_id: field.id, rows: rows.length });
  }
  // 3. The row that goes goes last.
  const removed = await lists.putRows(slug, { remove: [input.base_id] }, options);
  return { list_id: slug, kept: kept.kept, removed: removed.removed, relinked, merged_from: lineage };
}

// ---- duplicate: a copy of rows, field by field as the list's DATA says -------------------------------------------

/**
 * Copies rows of one list into the same list, or into another (`to_list`): { list_id, to_list, copies: [{ from, id }],
 * kept, dropped }. Each field of the list copied into takes the field of the same id (or the one `map` names for it:
 * { field of to_list: field of this list }) and is kept, dropped, reset to what a new row starts with, or remapped (a link
 * to a row copied in the same request points at its copy), by the field's own `duplicate` or its kind's row in
 * src/lists.json `duplicate`. A value whose kind the other field cannot hold, or a link to another list than the one the
 * other field links to, does not travel and is named in `dropped`. The basis of the source's values and where earlier rows
 * were merged from are not copied; the copy keeps the row it came from (_copied_from: the row id, or <list>:<row> from
 * another list). `values` are put in every copy over what was copied.
 */
export async function duplicateRows(lists, id, input, { actor } = {}) {
  const slug = slugOf(id);
  const rules = data.duplicate;
  const ids = input?.row_ids;
  const refuse = what => say('bad_duplicate', { limit: limits.rows_per_write, what });
  if (!isObject(input) || Object.keys(input).some(key => !['row_ids', 'values', 'to_list', 'map'].includes(key)) || !Array.isArray(ids) || !ids.length || ids.length > limits.rows_per_write
    || !ids.every(idOf) || new Set(ids).size !== ids.length || (input.values !== undefined && !isObject(input.values))
    || (input.to_list !== undefined && typeof input.to_list !== 'string') || (input.map !== undefined && (!isObject(input.map) || Object.values(input.map).some(item => typeof item !== 'string'))))
    throw refuse('that request');
  const list = await lists.find(slug);
  if (!list) throw say('no_list', { list_id: slug });
  const toSlug = input.to_list === undefined ? slug : slugOf(input.to_list);
  const into = toSlug === slug ? list : await lists.find(toSlug);
  if (!into) throw say('no_list', { list_id: toSlug });
  if (input.map !== undefined && (toSlug === slug || Object.entries(input.map).some(([to, from]) => !into.fields.some(field => field.id === to) || !list.fields.some(field => field.id === from))))
    throw say('bad_copy', { limit: limits.rows_per_write, to_list: toSlug, what: JSON.stringify(input.map) });
  const read = await lists.read(slug, { row_ids: ids });
  const sources = new Map(read.rows.map(row => [row.id, row]));
  for (const rowId of ids) if (!sources.has(rowId)) throw say('merge_missing', { row_id: rowId, list_id: slug });
  const copyOf = new Map(ids.map(rowId => [rowId, crypto.randomUUID()]));
  // The field a manual order is kept in is the copy's own place at the end, never the source's.
  const ordered = new Set(into.ordering ? (into.indexes ?? []).filter(index => index.name === into.ordering.index).flatMap(index => index.fields) : []);
  const ruleOf = field => {
    if (ordered.has(field.id)) return 'drop';
    const named = field.duplicate ?? (field.pairs_with !== undefined ? rules.paired : undefined) ?? rules.by_kind[field.kind] ?? rules.default;
    return (named === 'keep' || named === 'remap') && (field.settles?.length || field.starts !== undefined) && field.duplicate === undefined ? 'reset' : named;
  };
  // Which field of this list each field of the list copied into takes its value from.
  const sourceOf = field => list.fields.find(item => item.id === (input.map?.[field.id] ?? field.id)) ?? null;
  const travels = (from, to) => from && KINDS.get(from.kind)?.value === KINDS.get(to.kind)?.value && (!from.links_to || from.links_to === to.links_to);
  const dropped = new Set();
  const rows = ids.map(rowId => {
    const source = sources.get(rowId);
    const values = {};
    const used = new Set();
    for (const field of into.fields) {
      const from = sourceOf(field);
      const held = from ? source.values[from.id] : undefined;
      if (held === undefined || KINDS.get(field.kind)?.value === 'computed') continue;
      if (!travels(from, field)) continue;
      used.add(from.id);
      const rule = ruleOf(field);
      if (rule === 'keep') values[field.id] = held;
      else if (rule === 'remap') values[field.id] = field.links_to === toSlug && toSlug === slug ? listValue(held).map(target => copyOf.get(target) ?? target) : held;
      else if (rule === 'reset' && field.starts !== undefined) values[field.id] = field.starts;
    }
    for (const field of list.fields) if (source.values[field.id] !== undefined && KINDS.get(field.kind)?.value !== 'computed' && !used.has(field.id)) dropped.add(field.id);
    return { id: copyOf.get(rowId), copied_from: toSlug === slug ? rowId : `${slug}:${rowId}`, values: { ...values, ...(input.values ?? {}) } };
  });
  const kept = [];
  for (const group of chunks(rows, limits.rows_per_write)) kept.push(...(await lists.putRows(toSlug, { rows: group }, actor ? { actor } : {})).kept);
  return { list_id: slug, ...(toSlug !== slug ? { to_list: toSlug } : {}), copies: ids.map(rowId => ({ from: rowId, id: copyOf.get(rowId) })), kept, ...(toSlug !== slug && dropped.size ? { dropped: [...dropped] } : {}) };
}

// ---- file names: a file field that names a file by where it is -----------------------------------------------------

const fileName = value => typeof value === 'string' && value.startsWith(data.file_moves.name_prefix) && value.length <= limits.text_chars && !value.includes('\u0000');

/** Every list's file fields that hold `name`, read a page at a time within limits.file_scan_rows rows. */
async function* fileHolders(lists, name) {
  let budget = limits.file_scan_rows;
  const all = await lists.all();
  for (const list of all.lists) for (const field of (list.fields ?? []).filter(item => KINDS.get(item.kind)?.media)) {
    const rows = [];
    for await (const page of pages(lists, list.id, { only: [field.id] }, budget)) {
      budget -= page.rows.length;
      for (const row of page.rows) if (row.values[field.id] === name) rows.push(row.id);
      if (!page.complete && budget <= 0) { yield { list, field, rows, complete: false }; return; }
    }
    yield { list, field, rows, complete: true };
  }
}

/** Which rows name a file by `name` in a file field: { name, references: [{ list_id, field_id, row_ids }], complete }. */
export async function fileReferences(lists, { name } = {}) {
  if (!fileName(name)) throw say('bad_file_name', { prefix: data.file_moves.name_prefix });
  const references = [];
  let complete = true;
  for await (const found of fileHolders(lists, name)) {
    if (found.rows.length) references.push({ list_id: found.list.id, field_id: found.field.id, row_ids: found.rows });
    complete &&= found.complete;
  }
  return { name, references, complete };
}

/**
 * A file moved or renamed from `from` to `to`: every row whose file field still holds `from` holds `to` instead, each
 * row only if it still holds `from` when written (if_values), so a row changed meanwhile is left and named under conflicts.
 * Answers { from, to, rewritten: [{ list_id, field_id, rows }], conflicts, complete }.
 */
export async function rewriteFileNames(lists, { from, to } = {}, { actor } = {}) {
  if (!fileName(from) || !fileName(to) || from === to) throw say('bad_file_name', { prefix: data.file_moves.name_prefix });
  const rewritten = [];
  const conflicts = [];
  let complete = true;
  for await (const found of fileHolders(lists, from)) {
    complete &&= found.complete;
    if (!found.rows.length) continue;
    let rows = 0;
    for (const group of chunks(found.rows, limits.rows_per_write)) {
      const answer = await lists.putRows(found.list.id, { rows: group.map(rowId => ({ id: rowId, values: { [found.field.id]: to }, if_values: { [found.field.id]: from } })) }, actor ? { actor } : {});
      rows += answer.kept?.length ?? 0;
      conflicts.push(...(answer.conflicts ?? []).map(conflict => ({ list_id: found.list.id, ...conflict })));
    }
    rewritten.push({ list_id: found.list.id, field_id: found.field.id, rows });
  }
  return { from, to, rewritten, ...(conflicts.length ? { conflicts } : {}), complete };
}
