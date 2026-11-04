// src/placed-lists.mjs
//
// Purpose: a list whose rows are kept in one of the account's databases rather than in the account's own records. The
// account keeps only the list record, with its `placement` (src/lists.mjs checkPlacement); every call for the list's
// rows runs in the store that keeps them, by the same list owner over that store's records (src/database-list-calls.mjs),
// so the rows of one list live in a store of their own and a large list never fills the account's one store. A list can
// move from wherever it is kept to another database, a page at a time, and links reach between lists kept apart.
//
// Non-Negotiable Invariants:
//   1. One store answers for a list's rows: its home (`placement.database`, or the account's own records when none).
//      Reads, views, order and search go there and never fall back to another store.
//   2. A database has a list's definition before the account's list record names it, so a list never names a store
//      that cannot answer it; a failed save there leaves the account's record as it was.
//   3. A link to a list kept in another store is read through that list's own home, under the same request's command:
//      its titles come from the rows where they live, a required target is checked there before the write, and when
//      target rows are removed the rows that link to them are detached (or the removal refused) in their own home.
//      Links within one store keep that store's own checks.
//   4. A move never holds a request longer than one page: `move` starts it and copies one page, `continueMoves` (the
//      resource's alarm) copies one more page of each moving list; where it has reached is kept in the list record, so
//      an interrupted move resumes there. While it moves, the old home still answers and every write lands in both, so
//      no write is lost; once the last page is copied the home flips to the new store (checked against the record as it
//      is then), and the old store's copies are retired a page at a time without touching what links to them. The old
//      store keeps the rows' history before the flip, and the record names it in `earlier`.
//   5. Nothing here decides who may call: `command` is the admitted database command of the current request
//      (src/database-resource-composition.mjs), so each call is checked against the caller's current claims, metered and
//      journaled there; nothing here keeps a capability between calls.
//
//   6. One answer to "is this a list this person keeps?" (keptList): a list in this store, or one the account's placement
//      keeps in another of its stores (`elsewhere`). A new link is checked by it, whether a list is made by save_list
//      or by make_lists; a link to a list in another of the account's own stores takes no required target.
//   7. Work spanning several lists is split per store that keeps them, one call per store: a search across lists asks each
//      database once with every asked list it keeps, and a page's link titles are read once per linked list.
//
//   8. A pair (`pairs_with`, src/list-pairs.mjs) whose two lists keep their rows in different stores is two writes kept
//      whole together: an INTENT row naming the request is kept first (`pairs`, the resource's own row), then the
//      list's write is made, then the other side's rows are changed in their own store. Each step can be made again
//      without changing the result (the other side is worked out as "this row is in that link", set, never added), so
//      a crash between the two writes only leaves the intent open: `continueMoves` (the resource's alarm) finishes it,
//      and the intent is let go once both sides hold. Every list the pair touches must be writable by the actor before
//      the intent row is kept (`mayWrite`); a write the other store refuses by rights or by a link limit is reported
//      in the answer (`pairs.refused`) and never retried, any other failure is retried by the alarm.
//
//   withPlacedLists(lists, { command, now, moves, pairs, mayWrite, elsewhere }) → lists, plus
//     elsewhere async (list_id) → the account's list kept in another of its stores, or null
//     moves     { read() → [list_id], write([list_id]) }: the resource's own row of which lists still move
//     move(list_id, database) → { list_id, placement }        start a move and copy its first page
//     continueMoves({ most }) → [{ list_id, placement }]       one page of each moving list, at most `most` lists
//     nextAt() → epoch ms | null                               when a list still has a move to continue
//   command(database, operation, input) → Promise<answer>   (operation one of DATABASE_LIST_CALLS)
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DATABASE_LIST_CALLS, HOMED_LIST_CALLS } from './database-list-calls.mjs';
import { ListsError, listSay as say } from '../../query-and-change-list-rows/src/list-refusals.mjs';
import listSettings from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const KINDS = new Map(listSettings.field_kinds.map(kind => [kind.id, kind]));
const { limits } = listSettings;
const failed = (message, status = 409) => Object.assign(new Error(message), { status });
const ids = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item) : [];
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, at) => items.slice(at * size, at * size + size));
const stored = list => (list.fields ?? []).filter(field => KINDS.get(field.kind)?.value !== 'computed').map(field => field.id);
const valuesOf = (list, values = {}) => Object.fromEntries(stored(list).filter(field => values[field] !== undefined).map(field => [field, values[field]]));

export function withPlacedLists(lists, { command, now = () => new Date().toISOString(), moves = null, pairs = null, mayWrite = null, elsewhere = null } = {}) {
  if (typeof command !== 'function') return lists;
  const call = (database, operation, input) => {
    if (!Object.hasOwn(DATABASE_LIST_CALLS, operation)) throw new Error(`${operation} is not a call a placed list answers.`);
    return command(database, operation, input);
  };
  const find = id => {
    try { return typeof id === 'string' ? lists.find(id) : null; } catch { return null; }
  };
  // Invariant 6: the one answer to "is this a list this person keeps?".
  const keptList = async id => find(id) ?? (typeof id === 'string' && typeof elsewhere === 'function' ? await elsewhere(id) ?? null : null);
  // The lists a definition's link fields name that the person keeps only in another of their stores (lists.save
  // kept_elsewhere). A list with more fields than a list holds is left to lists.save to refuse.
  const keptElsewhere = async list => {
    const found = [];
    if (!Array.isArray(list?.fields) || list.fields.length > limits.fields_per_list) return found;
    for (const field of list.fields) {
      const id = KINDS.get(field?.kind)?.links && typeof field.links_to === 'string' ? field.links_to.replace(/^list:/, '') : null;
      if (!id || id === String(list.id ?? '').replace(/^list:/, '') || found.includes(id) || find(id)) continue;
      if (await keptList(id)) found.push(id);
    }
    return found;
  };
  const placementOf = id => find(id)?.placement ?? null;
  // Invariant 1: the store that answers for a list's rows (null: the account's own records).
  const homeOf = id => placementOf(id)?.database ?? null;
  const movingTo = id => placementOf(id)?.moving?.to ?? null;
  // One store's list calls, the same for the account's own records and for a database.
  const store = database => database ? {
    read: (id, options = {}) => call(database, 'lists:read', { list_id: id, options }),
    putRows: (id, input) => call(database, 'lists:putRows', { list_id: id, rows: input.rows ?? [], remove: input.remove ?? [] }),
    previewRows: (id, input) => call(database, 'lists:previewRows', { list_id: id, rows: input.rows ?? [], remove: input.remove ?? [] }),
    retire: (id, rowIds) => call(database, 'lists:retire', { list_id: id, row_ids: rowIds }),
    find: id => call(database, 'lists:find', { list_id: id }),
    save: list => call(database, 'lists:save', { list }),
    saveView: (id, view) => call(database, 'lists:saveView', { list_id: id, view }),
    removeView: (id, viewId) => call(database, 'lists:removeView', { list_id: id, view_id: viewId }),
    moveRow: (id, move) => call(database, 'lists:moveRow', { list_id: id, move }),
  } : {
    read: (id, options) => lists.read(id, options),
    putRows: (id, input, options) => lists.putRows(id, input, options),
    previewRows: (id, input, options) => lists.previewRows(id, input, options),
    retire: (id, rowIds, options) => lists.retire(id, rowIds, options),
    find: id => lists.find(id),
    save: (list, options) => lists.save(list, options),
    saveView: (id, view, options) => lists.saveView(id, view, options),
    removeView: (id, viewId, options) => lists.removeView(id, viewId, options),
    moveRow: (id, move, options) => lists.moveRow(id, move, options),
  };
  const crossLinks = (list, home) => (list.fields ?? []).filter(field => field.links_to && homeOf(field.links_to) !== home);

  // Invariant 3: what a database keeps of a list whose links reach another store. A required target is checked here,
  // where the target lives, so the database keeps the link without that check; it keeps a short definition of each
  // linked list (no rows) so its own link fields stay valid.
  const definitionFor = (list, home) => {
    const { placement: _placement, rows: _rows, ...definition } = list;
    const crossed = new Set(crossLinks(list, home).map(field => field.id));
    if (!definition.fields || !crossed.size) return definition;
    return { ...definition, fields: definition.fields.map(field => {
      if (!crossed.has(field.id)) return field;
      // The other side of a pair kept in another store is written by invariant 8, not by this store's own write.
      const { pairs_with: _pairs, ...plain } = field;
      if (!plain.link_constraints) return plain;
      const { require_target: _required, acyclic: _acyclic, ...kept } = plain.link_constraints;
      return Object.keys(kept).length ? { ...plain, link_constraints: kept } : (({ link_constraints: _gone, ...rest }) => rest)(plain);
    }) };
  };
  const ensureLinkedDefinitions = async (list, database) => {
    for (const field of crossLinks(list, database)) {
      if (field.links_to === list.id) continue;
      if (await call(database, 'lists:find', { list_id: field.links_to })) continue;
      const target = await keptList(field.links_to);
      if (!target) throw say('bad_link', { field_id: field.id, links_to: field.links_to });
      const title = (target.fields ?? []).find(item => item.id === target.title_field && !item.links_to && KINDS.get(item.kind)?.value !== 'computed');
      await call(database, 'lists:save', { list: { id: target.id, label: target.label, row_type: target.row_type,
        ...(title ? { title_field: title.id, fields: [title] } : { fields: [{ id: 'title', label: 'Title', kind: 'text' }] }) } });
    }
  };
  const titlesIn = async (targetId, rowIds) => {
    const titles = new Map();
    for (const part of chunks([...new Set(rowIds)], limits.read_page_rows)) {
      const answer = await wrapped.read(targetId, { row_ids: part, links: false });
      for (const row of answer.rows ?? []) titles.set(row.id, row.title ?? row.id);
    }
    return titles;
  };
  const withLinks = async (list, answer, home, options) => {
    if (options.links === false) return answer;
    const fields = crossLinks(list, home);
    if (!fields.length || !answer.rows?.length) return answer;
    // Invariant 7: one read per linked list, however many of this list's fields link to it.
    const byTarget = new Map();
    for (const field of fields) {
      const named = answer.rows.flatMap(row => ids(row.values?.[field.id]));
      if (named.length > limits.read_page_links) throw say('page_links_too_large');
      if (named.length) byTarget.set(field.links_to, [...(byTarget.get(field.links_to) ?? []), ...named]);
    }
    const titlesOf = new Map();
    for (const [target, named] of byTarget) titlesOf.set(target, await titlesIn(target, named));
    const linked = new Map(fields.filter(field => titlesOf.has(field.links_to)).map(field => [field.id, titlesOf.get(field.links_to)]));
    return { ...answer, rows: answer.rows.map(row => ({ ...row, links: { ...(row.links ?? {}), ...Object.fromEntries([...linked].map(([fieldId, titles]) =>
      [fieldId, ids(row.values?.[fieldId]).map(id => ({ id, title: titles.get(id) ?? id }))]).filter(([fieldId]) => Array.isArray(row.values?.[fieldId]))) } })) };
  };
  // Rows of `list` whose `field` names one of `removed`, a page at a time from where the list lives.
  const holders = async function* (list, field, removed) {
    let cursor = null;
    do {
      const page = await store(homeOf(list.id)).read(list.id, { limit: limits.read_page_rows, ...(cursor ? { cursor } : {}) });
      const held = (page.rows ?? []).filter(row => ids(row.values?.[field.id]).some(id => removed.has(id)));
      if (held.length) yield held;
      const next = page.page?.complete ? null : page.page?.next_cursor ?? null;
      if (next !== null && next === cursor) throw new Error('A list read did not advance its cursor.');
      cursor = next;
    } while (cursor);
  };
  const incoming = (id, home) => (lists.all().lists ?? []).flatMap(other => other.id === id || homeOf(other.id) === home ? []
    : (other.fields ?? []).filter(field => field.links_to === id && (field.on_target_remove === 'detach' || field.link_constraints?.require_target)).map(field => ({ list: other, field })));

  // Which lists still move: one kept row (`moves`, the resource's own setting) that each change of a placement here
  // keeps current, so the alarm asking when to continue reads one row however many lists there are. Without one, the
  // list records are read.
  let movingIds = null;
  const movingNow = () => {
    if (moves) return moves.read() ?? [];
    movingIds ??= (lists.all().lists ?? []).filter(list => list.placement?.moving || list.placement?.retiring).map(list => list.id);
    return movingIds;
  };
  const keepMoving = ids => { if (moves) moves.write(ids); else movingIds = ids; };
  const wrapped = Object.create(lists);
  wrapped.read = async (id, options = {}) => {
    const list = find(id);
    const home = homeOf(id);
    const { keep, links: _links, ...sent } = options;
    let answer;
    if (!home) answer = await lists.read(id, options);
    else {
      answer = await store(home).read(id, sent);
      // A row filter is the caller's own function; it runs here over the rows the database answered.
      if (keep) answer = { ...answer, rows: answer.rows.filter(row => keep(row.values, row.id)) };
    }
    return list ? withLinks(list, answer, home, options) : answer;
  };
  // Row calls answered only where a list's rows live (identity keys, who links to a row, removed rows, a field as it was,
  // snapshots): one store answers for each, its home (invariant 1).
  for (const [method, operation] of Object.entries(HOMED_LIST_CALLS)) wrapped[method] = (id, input = {}, options = {}) => {
    const home = homeOf(id);
    return home ? call(home, operation, { list_id: id, input }) : lists[method](id, input, options);
  };
  wrapped.row = async (id, rowId) => {
    const home = homeOf(id);
    if (!home) return lists.row(id, rowId);
    const answer = await store(home).read(id, { row_ids: [rowId] });
    const found = answer.rows.find(row => row.id === rowId);
    return found ? { id: found.id, values: found.values } : null;
  };
  // Invariant 3: a required target in another store is checked where it lives, before anything is written; a row removed
  // while another list requires it is refused. A preview makes the same checks, so it says what the write would.
  async function checkBeforeWriting(list, home, input) {
    for (const field of crossLinks(list, home).filter(field => field.link_constraints?.require_target)) {
      const named = (input.rows ?? []).flatMap(row => ids(row.values?.[field.id]).map(target => ({ row_id: row.id, target })));
      if (!named.length) continue;
      const found = await titlesIn(field.links_to, named.map(item => item.target));
      const missing = named.find(item => !found.has(item.target));
      if (missing) throw say('link_target_missing', { row_id: missing.row_id, field_id: field.id, target_id: missing.target });
    }
    const removing = ids(input.remove);
    if (removing.length) await refuseRequiredIncoming(list, home, removing);
    return removing;
  }
  wrapped.previewRows = async (id, input = {}, options = {}) => {
    const list = find(id);
    if (!list) return lists.previewRows(id, input, options);
    try { await checkBeforeWriting(list, homeOf(id), input); }
    catch (error) {
      if (!(error instanceof ListsError)) throw error;
      return { list_id: list.id, dry_run: true, ok: false, refused: { message: error.message, ...(error.detail ?? {}) } };
    }
    return store(homeOf(id)).previewRows(id, input, options);
  };
  wrapped.putRows = async (id, input = {}, options = {}) => {
    const list = find(id);
    const home = homeOf(id);
    const to = movingTo(id);
    if (!list) return lists.putRows(id, input, options);
    const removing = await checkBeforeWriting(list, home, input);
    const apart = pairedApart(list, home);
    if (apart.length) return writeWithPairs(list, home, apart, home ? { rows: input.rows ?? [], remove: removing } : input, options);
    const answer = await store(home).putRows(id, home ? { rows: input.rows ?? [], remove: removing } : input, options);
    // Invariant 4: while a list moves, what was kept and removed lands in its new store as well.
    if (to) await store(to).putRows(id, { rows: (answer.kept ?? []).map(row => ({ id: row.id, values: valuesOf(list, row.values) })), remove: answer.removed ?? [] });
    if (answer.removed?.length) await detachIncoming(list, home, answer.removed);
    return answer;
  };
  // Invariant 8: the pair fields of a list whose other list keeps its rows in another store.
  const pairedApart = (list, home) => (list.fields ?? []).filter(field => field.pairs_with !== undefined && field.links_to && find(field.links_to) && homeOf(field.links_to) !== home);
  let openPairs = null;
  const pairsNow = () => pairs ? pairs.read() ?? [] : (openPairs ??= []);
  const keepPairs = intents => { if (pairs) pairs.write(intents); else openPairs = intents; };
  const intentId = (listId, input, before) => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([listId, input, before]))));
  const closeIntent = intent => keepPairs(pairsNow().filter(item => item.id !== intent.id));
  const saveIntent = intent => keepPairs([...pairsNow().filter(item => item.id !== intent.id), intent]);
  // The links the rows named hold now, in the home that keeps them: row id -> field id -> ids.
  const linksHeld = async (list, home, apart, rowIds) => {
    const held = {};
    for (const part of chunks([...new Set(rowIds)], limits.read_page_rows)) {
      const answer = await store(home).read(list.id, { row_ids: part, links: false });
      for (const row of answer.rows ?? []) held[row.id] = Object.fromEntries(apart.map(field => [field.id, ids(row.values?.[field.id])]));
    }
    return held;
  };
  // What the write changed on the other side: for each row of the other list, the holder rows to add to or drop from
  // its link. `after` is the row as written (null: removed).
  const changesOf = (apart, before, after) => {
    const found = new Map();
    const note = (field, target, holder, adding) => {
      const key = `${field.links_to}\u0000${target}\u0000${field.pairs_with}`;
      if (!found.has(key)) found.set(key, { list_id: field.links_to, row_id: target, field_id: field.pairs_with, add: [], drop: [] });
      const entry = found.get(key);
      const [into, out] = adding ? [entry.add, entry.drop] : [entry.drop, entry.add];
      if (!into.includes(holder)) into.push(holder);
      const at = out.indexOf(holder);
      if (at >= 0) out.splice(at, 1);
    };
    for (const [rowId, held] of Object.entries(after)) for (const field of apart) {
      const was = new Set(before[rowId]?.[field.id] ?? []);
      const now = new Set(held ? held[field.id] ?? [] : []);
      for (const target of now) if (!was.has(target)) note(field, target, rowId, true);
      for (const target of was) if (!now.has(target)) note(field, target, rowId, false);
    }
    return [...found.values()];
  };
  // Write 2 of one change: the row on the other side holds (or no longer holds) the holders, whatever it held when this
  // is made again. Answers null when done, or the words of a refusal that retrying cannot change.
  const applyChange = async (change, options) => {
    const target = find(change.list_id);
    if (!target) return null;
    const away = homeOf(target.id);
    const answer = await store(away).read(target.id, { row_ids: [change.row_id], links: false });
    const row = (answer.rows ?? []).find(item => item.id === change.row_id);
    if (!row) return null;
    const held = ids(row.values?.[change.field_id]);
    const next = [...held.filter(item => !change.drop.includes(item)), ...change.add.filter(item => !held.includes(item))];
    if (next.length === held.length && next.every((item, index) => item === held[index])) return null;
    const field = (target.fields ?? []).find(item => item.id === change.field_id);
    const most = field?.link_constraints?.max_links;
    if (most !== undefined && next.length > most) return say('link_too_many', { row_id: change.row_id, field_id: change.field_id, limit: most }).message;
    try {
      await store(away).putRows(target.id, { rows: [{ id: change.row_id, values: { ...valuesOf(target, row.values), [change.field_id]: next } }] }, options);
    } catch (error) {
      if (error instanceof ListsError) return error.message;
      throw error;
    }
    return null;
  };
  // Both writes of one intent, from wherever it stands: the list's own write (again if the changes are not yet kept),
  // then each change. Answers { answer, refused } and lets the intent go once every change holds or is refused.
  const finishIntent = async (intent, options = {}) => {
    const list = find(intent.list_id);
    const home = list ? homeOf(list.id) : null;
    let answer = null;
    if (!intent.changes) {
      const to = list ? movingTo(list.id) : null;
      answer = await store(home).putRows(intent.list_id, intent.input, options);
      if (to) await store(to).putRows(intent.list_id, { rows: (answer.kept ?? []).map(row => ({ id: row.id, values: valuesOf(list, row.values) })), remove: answer.removed ?? [] });
      const after = Object.fromEntries([...(answer.kept ?? []).map(row => [row.id, Object.fromEntries(intent.fields.map(field => [field, ids(row.values?.[field])]))]), ...(answer.removed ?? []).map(rowId => [rowId, null])]);
      const apart = (list?.fields ?? []).filter(field => intent.fields.includes(field.id));
      intent = { ...intent, changes: changesOf(apart, intent.before, after) };
      saveIntent(intent);
    }
    const refused = [];
    for (const change of intent.changes) {
      const reason = await applyChange(change, options);
      if (reason) refused.push({ list_id: change.list_id, row_id: change.row_id, field_id: change.field_id, reason });
    }
    closeIntent(intent);
    return { answer, refused };
  };
  async function writeWithPairs(list, home, apart, input, options) {
    // Every list the pair reaches is asked before anything is kept (invariant 8).
    if (mayWrite) for (const listId of new Set([list.id, ...apart.map(field => field.links_to)])) if (!mayWrite(listId, options?.actor ?? null)) throw say('no_write_right', { list_id: listId });
    const named = [...(input.rows ?? []).map(row => row.id).filter(Boolean), ...ids(input.remove)];
    const before = await linksHeld(list, home, apart, named);
    const intent = { id: intentId(list.id, input, before), list_id: list.id, input, before, fields: apart.map(field => field.id), changes: null };
    saveIntent(intent);
    let outcome;
    try { outcome = await finishIntent(intent, options); }
    catch (error) {
      // Nothing of the list's own write landed when it is refused: the intent is let go. Anything else stays for the alarm.
      if (error instanceof ListsError && !(pairsNow().find(item => item.id === intent.id)?.changes)) closeIntent(intent);
      throw error;
    }
    const { answer, refused } = outcome;
    const pending = pairsNow().some(item => item.id === intent.id);
    if (answer?.removed?.length) await detachIncoming(list, home, answer.removed);
    return { ...answer, pairs: { ...(pending ? { pending: true } : {}), ...(refused.length ? { refused } : {}) } };
  }

  async function refuseRequiredIncoming(list, home, removing) {
    const removed = new Set(removing);
    for (const { list: source, field } of incoming(list.id, home).filter(row => row.field.on_target_remove !== 'detach'))
      for await (const held of holders(source, field, removed)) {
        const row = held[0];
        throw say('link_target_missing', { row_id: row.id, field_id: field.id, target_id: ids(row.values[field.id]).find(id => removed.has(id)) });
      }
  }
  async function detachIncoming(list, home, removedIds) {
    const removed = new Set(removedIds);
    for (const { list: source, field } of incoming(list.id, home).filter(row => row.field.on_target_remove === 'detach'))
      for await (const held of holders(source, field, removed))
        await wrapped.putRows(source.id, { rows: held.map(row => ({ id: row.id, values: { ...valuesOf(source, row.values),
          [field.id]: ids(row.values[field.id]).filter(target => !removed.has(target)) } })) });
  }

  // The account's record keeps the definition with its own link checks, the views and the placement.
  const keepRecord = (list, placement, options, fields = null) => {
    const { rows: _rows, ...definition } = list;
    const answer = lists.save({ ...definition, ...(fields ? { fields } : {}), placement }, options);
    const still = Boolean(placement?.moving || placement?.retiring);
    const ids = movingNow();
    if (still !== ids.includes(list.id)) keepMoving(still ? [...ids, list.id] : ids.filter(id => id !== list.id));
    return answer;
  };
  for (const method of ['saveView', 'removeView', 'moveRow']) {
    wrapped[method] = async (id, value, options) => {
      const home = homeOf(id);
      const to = movingTo(id);
      if (!home && !to) return lists[method](id, value, options);
      const answer = await store(home)[method](id, value, options);
      if (to) await store(to)[method](id, value);
      if (home && method !== 'moveRow') {
        const account = find(id);
        keepRecord(await store(home).find(id), account.placement, options, account.fields);
      }
      return answer;
    };
  }
  wrapped.save = async (input, given = {}) => {
    const existing = input?.id ? find(input.id) : null;
    const requested = input?.placement?.database ?? null;
    if (input?.remove === true) return lists.save(input, given);
    const { placement: _placement, ...definition } = input ?? {};
    const elsewhereIds = await keptElsewhere({ ...definition, id: definition.id ?? existing?.id });
    const options = elsewhereIds.length ? { ...given, kept_elsewhere: elsewhereIds } : given;
    const home = existing ? homeOf(existing.id) : requested;
    // A list given another store moves there with its rows (invariant 4), never left behind.
    if (existing && requested && requested !== home) {
      await wrapped.save(definition, given);
      await wrapped.move(existing.id, requested, given);
      return { list: find(existing.id) };
    }
    const to = existing ? movingTo(existing.id) : null;
    if (!home) {
      const answer = lists.save(definition, options);
      if (to) await saveIn(to, answer.list);
      return answer;
    }
    const merged = { ...(existing ?? {}), ...definition };
    await saveIn(home, merged, definition);
    if (to) await saveIn(to, merged, definition);
    const kept = await store(home).find(merged.id);
    return keepRecord(kept, existing?.placement ?? { database: home }, options, definition.fields ?? existing?.fields ?? null);
  };
  async function saveIn(database, list, sent = list) {
    await ensureLinkedDefinitions(list, database);
    const { fields: _fields, ...rest } = sent;
    const definition = definitionFor({ ...rest, id: list.id, ...(sent.fields ? { fields: sent.fields } : {}) }, database);
    return call(database, 'lists:save', { list: definition });
  }

  // The write a list call makes when it stays in the account's own records with nothing to do after it: one synchronous
  // write a caller can commit with its command's receipt. null when the call reaches another store, a list kept
  // elsewhere, a list moving, or rows other lists hold by a link.
  const localDefinition = input => {
    if (!object(input)) return true;
    const own = String(input.id ?? '').replace(/^list:/, '');
    const fields = Array.isArray(input.fields) ? input.fields : [];
    return fields.length > limits.fields_per_list || fields.every(field => {
      const id = KINDS.get(field?.kind)?.links && typeof field.links_to === 'string' ? field.links_to.replace(/^list:/, '') : null;
      return !id || id === own || Boolean(find(id));
    });
  };
  wrapped.localWrite = (method, ...args) => {
    if (method === 'save') {
      const [input, given = {}] = args;
      if (input?.remove === true) return () => lists.save(input, given);
      const existing = input?.id ? find(input.id) : null;
      if (existing?.placement || input?.placement?.database || !localDefinition(input)) return null;
      const { placement: _placement, ...definition } = input ?? {};
      return () => lists.save(definition, given);
    }
    if (method === 'ensure') {
      const [input, given = {}] = args;
      const existing = typeof input?.id === 'string' ? find(input.id) : null;
      return existing?.placement || input?.placement?.database || !existing && !localDefinition(input) ? null : () => lists.ensure.call(lists, input, given);
    }
    if (method === 'putRows') {
      const [id, input = {}, options] = args;
      const list = find(id);
      if (!list) return () => lists.putRows(id, input, options);
      if (list.placement || crossLinks(list, null).some(field => field.link_constraints?.require_target)
        || ids(input.remove).length && incoming(list.id, null).length) return null;
      return () => lists.putRows(id, input, options);
    }
    if (['saveView', 'removeView', 'saveFilter', 'removeFilter', 'moveRow', 'moveView', 'restoreRows', 'noteUse', 'proposeChanges', 'decideProposal'].includes(method)) {
      const [id, value, options] = args;
      return homeOf(id) || movingTo(id) ? null : () => lists[method](id, value, options);
    }
    return null;
  };

  // ensure answers synchronously when the list stays in the account's own records, as the command's own write does; a list
  // placed in a database answers once that store's save has landed (lists.ensure waits on the save it returns).
  wrapped.ensure = (input, given = {}) => {
    const local = wrapped.localWrite('ensure', input, given);
    return local ? local() : lists.ensure.call(wrapped, input, given);
  };

  // Each placed list's rows are counted where they are kept.
  wrapped.all = async () => {
    const answer = lists.all();
    const homes = [...new Set((answer.lists ?? []).map(list => list.placement?.database).filter(Boolean))];
    if (!homes.length) return answer;
    const counted = new Map();
    for (const database of homes) for (const list of (await call(database, 'lists:all', {}))?.lists ?? []) counted.set(`${database}\u0000${list.id}`, list.rows);
    return { ...answer, lists: answer.lists.map(list => list.placement?.database ? { ...list, rows: counted.get(`${list.placement.database}\u0000${list.id}`) ?? 0 } : list) };
  };
  wrapped.search = async (input = {}) => {
    const own = await lists.search(input);
    const q = String(input?.q ?? '').trim();
    const named = Array.isArray(input?.lists) && input.lists.length ? input.lists : (lists.all().lists ?? []).map(list => list.id);
    const placed = named.slice(0, limits.search_lists).map(id => [id, homeOf(id)]).filter(([, database]) => database);
    if (!placed.length) return own;
    // Invariant 7: one search per store, naming every asked list that store keeps.
    const perStore = new Map();
    for (const [id, database] of placed) perStore.set(database, [...(perStore.get(database) ?? []), id]);
    const found = [];
    for (const [database, named] of perStore) {
      const answer = await call(database, 'lists:search', { search: { ...input, q, lists: named } });
      if (object(answer)) found.push(...(answer.rows ?? []));
    }
    const most = Math.min(Number(input?.limit) || limits.search_default, limits.search_most);
    return { ...own, rows: [...(own.rows ?? []), ...found].slice(0, most) };
  };

  // Invariant 4: a move, one page per call.
  wrapped.move = async (id, database, options = {}) => {
    const list = find(id);
    if (!list) throw failed(`There is no list ${id}.`, 404);
    const placement = list.placement ?? null;
    if (placement?.moving || placement?.retiring) {
      if (placement.moving?.to !== database) throw failed(`${list.id} is still moving to its own store; move it again once that finishes.`);
      return step(list.id, options);
    }
    if ((placement?.database ?? null) === database) return { list_id: list.id, placement };
    await saveIn(database, list);
    keepRecord(list, { ...(placement?.database ? { database: placement.database } : {}), moving: { to: database, cursor: null, copied: 0 },
      ...(placement?.earlier ? { earlier: placement.earlier } : {}) }, options, list.fields);
    return step(list.id, options);
  };
  async function step(id, options = {}) {
    const list = find(id);
    const placement = list?.placement;
    if (!placement?.moving && !placement?.retiring) return { list_id: id, placement: placement ?? null };
    // Each step is checked against the record as it is now, so two steps at once never move a list twice.
    const advance = next => {
      const current = find(id);
      if (JSON.stringify(current?.placement ?? null) !== JSON.stringify(placement)) return { list_id: id, placement: current?.placement ?? null };
      keepRecord(current, next, options, current.fields);
      return { list_id: id, placement: next };
    };
    const from = placement.database ?? null;
    if (placement.moving) {
      const { to, cursor, copied } = placement.moving;
      const page = await store(from).read(id, { limit: limits.read_page_rows, ...(cursor ? { cursor } : {}) });
      const rows = (page.rows ?? []).map(row => ({ id: row.id, values: valuesOf(list, row.values) }));
      if (rows.length) await store(to).putRows(id, { rows });
      const next = page.page?.complete ? null : page.page?.next_cursor ?? null;
      if (next !== null && next === cursor) throw new Error('A list read did not advance its cursor.');
      if (next !== null) return advance({ ...placement, moving: { to, cursor: next, copied: copied + rows.length } });
      const until = now();
      const { moving: _moving, ...rest } = placement;
      return advance({ ...rest, database: to, retiring: { ...(from ? { database: from } : {}), until },
        earlier: [...(placement.earlier ?? []), { ...(from ? { database: from } : {}), until }].slice(-limits.placement_earlier) });
    }
    const source = placement.retiring.database ?? null;
    const page = await store(source).read(id, { limit: limits.read_page_rows, only: [] });
    const rowIds = (page.rows ?? []).map(row => row.id);
    if (rowIds.length) {
      await store(source).retire(id, rowIds, options);
      return { list_id: id, placement };
    }
    const { retiring: _retiring, ...settled } = placement;
    return advance(settled);
  }
  const moving = () => movingNow().map(id => ({ id }));
  wrapped.continueMoves = async ({ most = 4 } = {}, options = {}) => {
    const done = [];
    for (const list of moving().slice(0, most)) done.push(await step(list.id, options));
    // Invariant 8: an intent a crash left open is finished here, the other side made to hold.
    for (const intent of pairsNow().slice(0, most)) {
      try { const { refused } = await finishIntent(intent, options); done.push({ list_id: intent.list_id, pair_intent: intent.id, ...(refused.length ? { refused } : {}) }); }
      catch (error) { done.push({ list_id: intent.list_id, pair_intent: intent.id, retry: error.message }); }
    }
    return done;
  };
  wrapped.nextAt = () => moving().length || pairsNow().length ? Date.now() : null;
  return wrapped;
}
