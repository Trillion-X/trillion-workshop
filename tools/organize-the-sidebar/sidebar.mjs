// src/sidebar.mjs
//
// Purpose
//   The person's sidebar for their AIs: what lists it shows and the rows in each (read), a note on any list or row
//   (a highlight, a count, a short message and screens to open, which the open page draws on that list or row, in its
//   hover card, and rings in the bell), and changing the lists themselves (make, name, delete a list; add, take out,
//   order or move a row). The open page follows the same records live (src/workspace/records.ts), so a note or a list
//   an AI writes shows without a reload.
//
//   GET  /sidebar               { lists: [{ list_id, name, inside, rows: [{ row_id, label }] }], rows, notes, said }
//   POST /sidebar/note          { on, message?, count?, highlight?, opens? }   { note, said }  (nothing but `on` clears it)
//   POST /sidebar/change        { changes: [{ do, ... }] }                     { lists, said }
//
// Non-negotiable invariants
//   1. The lists are the page's lists, read the way the page reads them: the app's lists (surfaces.json through
//      src/workspace/sidebar-lists.ts) with the person's saved copies laid over them (parts/sidebar
//      merge-surface-collections.ts), from the same group records. Nothing here names a list, a row or a screen.
//   2. Every list change is the sidebar's own ops (parts/sidebar/do-work/surface-collection-ops.ts) applied by the
//      group's own transitions (parts/group/do-work/group-op-transitions.ts) and written as the group's own records
//      (parts/group/do-work/group-mutation-writes.ts): the same records the page writes when the person drags a row.
//   3. A note names something the person's sidebar shows (a list or a row); anything else is refused, saying where to
//      find the ids. One note per list or row: a new one replaces it.
//   4. A note with a message tells the person (src/tell-the-person.mjs, kind sidebar-note), once per message.
//   5. A row's colour and the place it is kept (`style`) are this person's own record (`sidebar-looks`, by row id),
//      laid over the app's row by the page (src/workspace/main.tsx); null puts back what the app gives.
//   6. The person's own lists may hold rows by a rule and a list or a row of it may show only while a rule holds
//      (make_list, set_rule), kept in the list's own records and decided as the page decides them
//      (parts/sidebar/read-data/apply-list-rules.ts, the formula engine); a rule naming an unknown fact or comparison
//      is refused. read answers the lists shown now, and under not_shown_now the person's lists whose rule does not.
//

import inputs from './workspace/inputs.json' with { type: 'json' };
import surfaces from './workspace/screens.mjs';
import settings from './sidebar.json' with { type: 'json' };
import spaceSettings from './space-settings.json' with { type: 'json' };
import { sidebarCollections } from './workspace/sidebar-lists.ts';
import { pursuitNavigationRows } from './workspace/pursuit-navigation-rows.mjs';
import { oneRowPerId } from './workspace/one-row-per-id.mjs';
import { decideSidebarRules } from './workspace/sidebar-rules.mjs';
import { applyDecidedRules, ruleListsOf } from '../parts/sidebar/read-data/apply-list-rules.ts';
import { compileRules, ruleVocabulary } from '../parts/formula-engine/rules/compile-rules.mjs';
import ruleOperators from '../parts/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { readSurfaceCollections } from '../parts/sidebar/read-data/read-surface-collections.ts';
import { isSpaceRow } from '../parts/sidebar/read-data/space-row.ts';
import { mergeSurfaceCollections } from '../parts/sidebar/read-data/merge-surface-collections.ts';
import { addRowOps, createListOps, deleteListOps, patchListOps, patchRowOps, removeRowOps, reorderRowOps, rowMemberId } from '../parts/sidebar/do-work/surface-collection-ops.ts';
import { applyGroupOp } from '../parts/group/do-work/group-op-transitions.ts';
import { buildGroupWriteBatch } from '../parts/group/do-work/group-mutation-writes.ts';
import { foldGroupRecords } from '../parts/group/read-data/group-eeaf.ts';
import { failureOf } from './failure.mjs';

const NOTES = inputs['sidebar-notes'].address;
const LOOKS = inputs['sidebar-looks'].address;
const COLOURS = spaceSettings.colours.map(colour => colour.id);
const GROUP_RECORD = 'package::group::group::';
// The app's lists are projected under the host's name, and the person's lists are indexed in its scope, as the page
// does both (src/workspace/main.tsx HOST_PACKAGE, from the same `placeable-surface-list::<host>` address).
const HOST = String(surfaces.address_label).split('::').at(-1);
const text = value => (typeof value === 'string' ? value.trim() : '');
// The facts a rule may name, for rows and for lists (surfaces.json sidebar_row_facts `on`).
const FACTS = surfaces.sidebar_row_facts ?? [];
const VOCABULARY = ruleVocabulary(ruleOperators);
const factsOn = on => FACTS.filter(fact => (fact.on ?? ['rows']).includes(on));
// A rule a person's AI gives must be finished: each rule names a fact of the kind given and a comparison it offers.
function ruleTree(value, on, field) {
  if (value === null) return null;
  const facts = factsOn(on);
  const named = facts.map(fact => `${fact.id} (${fact.kind})`).join(', ');
  if (!value || typeof value !== 'object' || value.kind !== 'group') throw new Error(`${field} is a rule tree { kind: "group", combinator: "and" | "or", negate: false, rules: [{ kind: "rule", field, operator, params }] } over ${named}, or null.`);
  const { binding, incomplete } = compileRules(value, { fields: facts.map(fact => ({ id: fact.id, kind: fact.kind })), vocabulary: VOCABULARY });
  if (!binding || incomplete.length) throw new Error(`${field} has a rule that is not finished (${JSON.stringify(incomplete[0] ?? {})}): each rule names one of ${named} and an operator of rule-operators.json its kind offers, with its params.`);
  return value;
}
function orderBy(value) {
  if (value === null) return null;
  if (!Array.isArray(value?.path) || !value.path.every(key => typeof key === 'string')) throw new Error('order_by is { path: [keys into a row, such as "listed_on"], descending?: true }, or null.');
  return { path: value.path, descending: value.descending === true };
}


/**
 * records: { read() → { label: value }, write([{ address_label, payload }]) } (the person's workspace records)
 * rows:    async () → the screen rows this person is offered beyond surfaces.json (their tools' screens)
 * tell:    async notice → told (src/tell-the-person.mjs tell)
 * now:     () → Date
 * filterRows: the formula engine's row filter ({ tree, fields, rows } → { matches }), which decides the lists a rule
 *          fills (src/workspace/sidebar-rules.mjs) as the page decides them
 */
// The writes committed with their own part of the answer through `commit` (a write and that part kept under the command's
// receipt, src/standalone-resource-behavior.mjs routeReceipts). A change's answer also shows the lists read after it
// (afterChange), read again when the receipt answers.
export const SIDEBAR_RECEIPTED_WRITES = Object.freeze(['sidebar:note', 'sidebar:change']);
/** A change's answer: its own part (kept with its write) and the lists as they are after it. */
export const sidebarChangeAnswer = async (sidebar, made) => ({ lists: (await sidebar.read()).lists, ...made });
export function makeSidebar({ records, rows, pursuits = async () => [], tell, filterRows, now = () => new Date(), commit = change => change() }) {
  const readRecords = () => records.read({ labels: [...new Set([NOTES, LOOKS, ...FACTS.map(fact => inputs[fact.from]?.address).filter(Boolean)])], prefixes: [GROUP_RECORD] });
  const groupGraph = current => foldGroupRecords(Object.entries(current)
    .filter(([label]) => label.startsWith(GROUP_RECORD))
    .map(([address, value]) => ({ address, value_json: value })));
  // Every row the sidebar can hold: the app's screens a list may show, and the person's tool screens.
  async function offered() {
    const [extra, privatePursuits] = await Promise.all([rows().catch(() => []), pursuits()]);
    return oneRowPerId([...surfaces.surfaces.filter(row => row.listed !== false && !row.sidebar_place), ...extra, ...pursuitNavigationRows(privatePursuits, surfaces.surfaces)]);
  }
  // The lists as the page draws them (invariant 1).
  async function shown() {
    const current = readRecords();
    const all = await offered();
    const readRecord = name => { const value = current[inputs[name]?.address]; return value && typeof value === 'object' && !Array.isArray(value) ? value : null; };
    const decided = await decideSidebarRules({ data: surfaces, rows: all, readRecord, now: now().getTime(), filterRows });
    const projected = readSurfaceCollections(sidebarCollections(all, surfaces, HOST, decided));
    const saved = readSurfaceCollections({ graph: groupGraph(current) });
    const merged = mergeSurfaceCollections(projected, saved);
    // The person's own lists and rows that hold or show by a rule, decided now as the page decides them.
    const ruleLists = ruleListsOf(merged);
    const lists = ruleLists.length
      ? applyDecidedRules(merged, await decideSidebarRules({ data: surfaces, lists: ruleLists, rows: all, readRecord, now: now().getTime(), filterRows }), all)
      : merged;
    return { lists, merged, all, current };
  }
  const flatten = (lists, inside = null, out = []) => {
    for (const list of lists) {
      out.push({ list, inside });
      for (const member of list.members) if (member.childCollection) flatten([member.childCollection], list.id, out);
    }
    return out;
  };
  const describe = (lists, all) => {
    const labels = new Map(all.map(row => [row.id, typeof row.label === 'string' ? row.label : row.id]));
    return flatten(lists).map(({ list, inside }) => ({
      list_id: list.id,
      name: list.name,
      inside,
      ...(list.meta.holds ? { holds: list.meta.holds } : {}),
      ...(list.meta.order_by ? { order_by: list.meta.order_by } : {}),
      ...(list.meta.shown_when ? { shown_when: list.meta.shown_when } : {}),
      // A row the page cannot draw (its screen is no longer offered: uninstalled, or a tool that took over a shipped
      // screen's id) is skipped as the page skips it (parts/sidebar/show/CollectionSections.ts), never shown by its id.
      rows: list.members.filter(member => member.kind === 'surface' && member.presentation?.removed !== true && (labels.has(member.surfaceId) || isSpaceRow(member.surfaceId)))
        .map(member => ({ row_id: member.surfaceId, label: labels.get(member.surfaceId) ?? member.surfaceId, ...(member.presentation?.shown_when ? { shown_when: member.presentation.shown_when } : {}) })),
    }));
  };
  const looksOf = current => {
    const value = current[LOOKS];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  const notesOf = current => {
    const value = current[NOTES];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };

  async function read() {
    const { lists, merged, all, current } = await shown();
    const described = describe(lists, all);
    const showing = new Set(described.map(list => list.list_id));
    return {
      lists: described,
      // The person's lists whose own rule does not hold now: they come back by themselves when it does.
      not_shown_now: describe(merged, all).filter(list => !showing.has(list.list_id)).map(({ rows: _rows, ...list }) => list),
      rows: all.map(row => ({ row_id: row.id, label: typeof row.label === 'string' ? row.label : row.id })),
      notes: notesOf(current),
      // What a list's or a row's rule may name (make_list, set_rule).
      facts: FACTS.map(fact => ({ id: fact.id, label: fact.label ?? fact.id, kind: fact.kind, on: fact.on ?? ['rows'] })),
      looks: looksOf(current),
      said: `${described.length} lists and ${all.length} rows the sidebar can show.`,
    };
  }

  async function note(input = {}) {
    const on = text(input.on);
    const { lists, all, current } = await shown();
    const listIds = new Set(flatten(lists).map(({ list }) => list.id));
    const row = all.find(one => one.id === on);
    if (!on || (!listIds.has(on) && !row)) throw new Error(`Say which list or row with on: a list_id or row_id from read_sidebar${on ? `; ${on} is neither` : ''}.`);
    const message = text(input.message).slice(0, settings.message_max);
    const count = Number.isInteger(input.count) && input.count > 0 ? Math.min(input.count, settings.count_max) : null;
    const opens = (Array.isArray(input.opens) ? input.opens : []).map(text).filter(id => all.some(one => one.id === id)).slice(0, settings.opens_max);
    const highlight = input.highlight === true;
    let notes = { ...notesOf(current) };
    let earlier = notes[on] ?? null;
    if (!message && count === null && !highlight && !opens.length) return commit(() => {
      if (records.update) {
        const changed = records.update(NOTES, value => {
          notes = { ...notesOf({ [NOTES]: value }) };
          earlier = notes[on] ?? null;
          delete notes[on];
          return notes;
        });
        notes = changed.value;
      } else {
        delete notes[on];
        records.write([{ address_label: NOTES, payload: notes }]);
      }
      return { note: null, said: earlier ? 'The note is taken off.' : 'There was no note there.' };
    }, { operation: 'sidebar:note' });
    const by = text(input.by) || null;
    const kept = { ...(message ? { message } : {}), ...(count !== null ? { count } : {}), ...(highlight ? { highlight } : {}), ...(opens.length ? { opens } : {}), ...(by ? { by } : {}), at: now().toISOString() };
    const answer = commit(() => {
      if (records.update) {
        const changed = records.update(NOTES, value => {
          notes = { ...notesOf({ [NOTES]: value }) };
          earlier = notes[on] ?? null;
          if (!(on in notes) && Object.keys(notes).length >= settings.notes_max) throw new Error(`The sidebar holds at most ${settings.notes_max} notes; take one off first (note with only on).`);
          notes[on] = kept;
          return notes;
        });
        notes = changed.value;
      } else {
        if (!(on in notes) && Object.keys(notes).length >= settings.notes_max) throw new Error(`The sidebar holds at most ${settings.notes_max} notes; take one off first (note with only on).`);
        notes[on] = kept;
        records.write([{ address_label: NOTES, payload: notes }]);
      }
      return { note: { on, ...kept }, said: `The note is on ${on}.` };
    }, { operation: 'sidebar:note' });
    // Invariant 4: the person hears of a new message once; the same words on the same place again ring nothing.
    if (message && message !== earlier?.message) {
      const name = row ? (typeof row.label === 'string' ? row.label : row.id) : flatten(lists).find(({ list }) => list.id === on).list.name;
      const path = Array.isArray(row?.route_paths) && typeof row.route_paths[0] === 'string' ? row.route_paths[0] : '/';
      await tell({ kind: settings.notice_kind, title: `${by ?? 'Your AI'}: ${name}`, body: message, refs: { open: path }, key: `sidebar-note:${on}:${kept.at}` }).catch(() => null);
    }
    return answer;
  }

  // One change in the AI's words, as the sidebar's own ops (invariant 2).
  const changeOps = {
    make_list: (change, lists) => {
      const name = text(change.name);
      if (!name) throw new Error('make_list needs name: what the list is called.');
      const id = text(change.list_id) || `list-${crypto.randomUUID()}`;
      if (lists.has(id)) throw new Error(`There is already a list ${id}.`);
      const holds = change.holds == null ? null : ruleTree(change.holds, 'rows', 'holds');
      const shownWhen = change.shown_when == null ? null : ruleTree(change.shown_when, 'lists', 'shown_when');
      const order = change.order_by == null ? null : orderBy(change.order_by);
      const meta = { made_at: now().toISOString(), ...(holds ? { holds: { rules: holds } } : {}), ...(order ? { order_by: order } : {}), ...(shownWhen ? { shown_when: shownWhen } : {}) };
      // A list made in this change can take rows in a later change of the same call.
      lists.set(id, { id, name, members: [], meta });
      return createListOps(id, name, HOST, meta);
    },
    // Rules on one of the person's own lists, or on a row of it (shown_when only); null takes one off.
    set_rule: (change, lists) => {
      const list = listNamed(lists, change.list_id);
      if (list.appList) throw new Error(`${list.name} is one of Trillion's own lists, whose rules are Trillion's; make a list of your own (make_list) to give it rules.`);
      if (text(change.row_id)) {
        if (change.shown_when === undefined) throw new Error('set_rule on a row takes shown_when: a rule over the row\'s facts, or null.');
        return patchRowOps(list.id, memberIn(list, change.row_id), { shown_when: ruleTree(change.shown_when, 'rows', 'shown_when') });
      }
      const presentation = {};
      if (change.shown_when !== undefined) presentation.shown_when = ruleTree(change.shown_when, 'lists', 'shown_when');
      if (change.holds !== undefined) presentation.holds = change.holds === null ? null : { rules: ruleTree(change.holds, 'rows', 'holds') };
      if (change.order_by !== undefined) presentation.order_by = orderBy(change.order_by);
      if (!Object.keys(presentation).length) throw new Error('set_rule needs shown_when, holds or order_by.');
      return patchListOps(list, presentation);
    },
    rename_list: (change, lists) => { const list = listNamed(lists, change.list_id); return touched(list, patchListOps(list, { name: required(change.name, 'rename_list', 'name') })); },
    remove_list: (change, lists) => {
      const list = listNamed(lists, change.list_id);
      if (list.appList) throw new Error(`${list.name} is one of Trillion's own lists; take its rows out instead.`);
      return deleteListOps(list.id, HOST);
    },
    add: (change, lists, all) => {
      const list = listNamed(lists, change.list_id);
      const row = rowNamed(all, change.row_id);
      if (memberOf(list, row)) throw new Error(`${row} is already in ${list.name}.`);
      return touched(list, addRowOps(list.id, row, list, placementOf(change, list)), { add: row });
    },
    remove: (change, lists) => {
      const list = listNamed(lists, change.list_id);
      return touched(list, removeRowOps(list.id, memberIn(list, change.row_id), list), { remove: text(change.row_id) });
    },
    order: (change, lists) => {
      const list = listNamed(lists, change.list_id);
      const placement = placementOf(change, list);
      if (!placement) throw new Error('order needs before or after (a row_id in the same list), or at: "start" or "end".');
      return touched(list, reorderRowOps(list.id, memberIn(list, change.row_id), placement, list));
    },
    // A row's colour and where it is kept, for this person (invariant 5): `colour` a palette hue, `place` a region of
    // the sidebar; null puts either back to what the app gives it.
    style: (change, _lists, all, looks, stylePatches) => {
      const row = rowNamed(all, change.row_id);
      const look = { ...(looks[row] ?? {}) };
      const patch = { ...(stylePatches.get(row) ?? {}) };
      for (const [field, allowed] of [['colour', COLOURS], ['place', settings.places]]) {
        if (!(field in change)) continue;
        if (change[field] === null) { delete look[field]; patch[field] = null; continue; }
        if (!allowed.includes(change[field])) throw new Error(`style ${field} is one of ${allowed.join(', ')}, or null.`);
        look[field] = change[field];
        patch[field] = change[field];
      }
      if (Object.keys(look).length) looks[row] = look; else delete looks[row];
      stylePatches.set(row, patch);
      return [];
    },
    move: (change, lists, all) => {
      const from = listNamed(lists, change.from_list_id);
      const to = listNamed(lists, change.list_id);
      const row = rowNamed(all, change.row_id);
      if (memberOf(to, row)) throw new Error(`${row} is already in ${to.name}.`);
      return [
        ...touched(from, removeRowOps(from.id, memberIn(from, row), from), { remove: row }),
        ...touched(to, addRowOps(to.id, row, to, placementOf(change, to)), { add: row }),
      ];
    },
  };
  const required = (value, verb, field) => { const said = text(value); if (!said) throw new Error(`${verb} needs ${field}.`); return said; };
  function listNamed(lists, id) {
    const list = lists.get(text(id));
    if (!list) throw new Error(`There is no list ${text(id) || '(none named)'}; read_sidebar gives every list_id.`);
    return list;
  }
  function rowNamed(all, id) {
    const row = all.find(one => one.id === text(id));
    if (!row) throw new Error(`There is no row ${text(id) || '(none named)'}; read_sidebar gives every row_id.`);
    return row.id;
  }
  const memberOf = (list, rowId) => list.members.find(one => one.kind === 'surface' && one.surfaceId === text(rowId) && one.presentation?.removed !== true);
  function memberIn(list, rowId) {
    const member = memberOf(list, rowId);
    if (!member) throw new Error(`${text(rowId) || 'That row'} is not in ${list.name}.`);
    return member.memberId;
  }
  // before/after name a row; the list's own member id for it is what the group orders by.
  const placementOf = (change, list) => (text(change.before) ? { before: memberIn(list, change.before) }
    : text(change.after) ? { after: memberIn(list, change.after) }
      : ['start', 'end'].includes(change.at) ? { at: change.at } : undefined);
  // Later changes in the same call see this one: the list is saved now, and holds or lost the row.
  function touched(list, ops, { add, remove } = {}) {
    if (list.appList) list.appList = { saved: true };
    if (add) list.members = [...list.members, { kind: 'surface', memberId: rowMemberId(add), surfaceId: add, presentation: {} }];
    if (remove) list.members = list.members.map(one => (one.kind === 'surface' && one.surfaceId === remove ? { ...one, presentation: { ...one.presentation, removed: true } } : one));
    return ops;
  }

  async function change(input = {}) {
    const changes = Array.isArray(input.changes) ? input.changes : [];
    if (!changes.length || changes.length > settings.changes_max) throw new Error(`Send between 1 and ${settings.changes_max} changes, each { do, ... }.`);
    // A list whose rule does not hold now can still be changed (its rule taken off).
    const { merged: lists, all, current } = await shown();
    const byId = new Map(flatten(lists).map(({ list }) => [list.id, list]));
    const looks = { ...looksOf(current) };
    const stylePatches = new Map();
    const ops = changes.flatMap((one, at) => {
      const verb = changeOps[text(one?.do)];
      if (!verb) throw new Error(`Change ${at + 1}: do is one of ${Object.keys(changeOps).join(', ')}.`);
      return verb(one, byId, all, looks, stylePatches);
    });
    const before = groupGraph(current);
    const after = ops.reduce((graph, op) => applyGroupOp(graph, op), before);
    const { payload } = buildGroupWriteBatch(before, after);
    const made = commit(() => {
      if (stylePatches.size && records.update) records.update(LOOKS, value => {
        const latest = { ...looksOf({ [LOOKS]: value }) };
        for (const [row, patch] of stylePatches) {
          const look = { ...(latest[row] ?? {}) };
          for (const [field, setting] of Object.entries(patch)) { if (setting === null) delete look[field]; else look[field] = setting; }
          if (Object.keys(look).length) latest[row] = look; else delete latest[row];
        }
        return latest;
      });
      else if (stylePatches.size) records.write([{ address_label: LOOKS, payload: looks }]);
      if (payload.writes.length) records.write(payload.writes.map(write => ({ address_label: write.address_label, payload: write.payload })));
      return { said: `${changes.length} change${changes.length === 1 ? '' : 's'} made to the sidebar.` };
    }, { operation: 'sidebar:change' });
    return sidebarChangeAnswer({ read }, made);
  }

  return { read, note, change };
}

/** The account's /sidebar routes over `sidebar` (makeSidebar), answered in its own records resource
 * (src/native-owner-routes.json). */
export async function handleSidebarRequest(sidebar, request) {
  const path = new URL(request.url).pathname;
  const verb = path === '/sidebar' ? 'read' : path.slice('/sidebar/'.length);
  if (!Object.hasOwn(sidebar, verb) || (request.method === 'GET') !== (verb === 'read')) return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    return Response.json(await sidebar[verb](request.method === 'GET' ? {} : await request.json().catch(() => ({}))));
  } catch (error) {
    // A failure that tries again later is the shared failure owner's to answer, never a refusal of this request.
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: error.message }, { status: 400 });
  }
}
