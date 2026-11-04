// src/workspace/sidebar-rules.mjs
//
// NO PRIOR: the sidebar's lists that hold rows by a rule, shared by the page (sidebar-rules-live.ts) and the person
// store (src/sidebar.mjs, what an AI reads).
//
// PURPOSE
//   A list in surfaces.json `sidebar_collections` may hold rows by a rule tree in the formula engine's shape
//   (`holds: { rules }`, parts/formula-engine/rules/compile-rules.mjs) and may itself show only while a rule holds
//   (`shown_when`). The rules name the row facts surfaces.json `sidebar_row_facts` declares: a fact reads a path of
//   the row, or of one of the person's records kept by row id (`from`, an inputs.json name such as the notes their AI
//   left), and may be measured against now (`time`: days since or days until that moment). The formula engine decides
//   every rule; this file only reads facts, hands them over and works out when an answer can next change, so a list
//   that holds what is new, or that shows only until a date, follows the clock without anyone refreshing it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list, a row, a fact or a record: all of them are DATA.
//   2. The formula engine decides (`filterRows({ tree, fields, rows }) -> { matches }`, tool:filter-rows-by-rules);
//      a fact that cannot be read is null, which no comparison matches.
//   3. `now` is handed in; nothing here reads a clock. `next_change_at` is the earliest moment ahead at which a rule
//      measured against now can turn, or null when none can. A fact with `clock` is now itself (a date), so a rule
//      "now is before <date>" turns at that date.
//   4. Any list may be decided: the app's lists in DATA, or the person's own lists (`lists`), each carrying `holds`,
//      `shown_when` and `rows_shown_when` ({ row id: rule }, a row shown in that list only while its rule holds).
//

const DAY_MS = 86_400_000;
const at = (value, path = []) => path.reduce((held, key) => (held && typeof held === 'object' ? held[key] : undefined), value);
const timeOf = value => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
// How far a moment is from now, in days, by the fact's `time` (the two directions of time).
const MEASURES = {
  days_since: (moment, now) => (now - moment) / DAY_MS,
  days_until: (moment, now) => (moment - now) / DAY_MS,
};
// The moment at which a measure equals `days`: when a comparison against it turns.
const TURNS = {
  days_since: (moment, days) => moment + days * DAY_MS,
  days_until: (moment, days) => moment - days * DAY_MS,
};

/** Every list at any depth, with the list it sits in. */
function everyList(lists, out = []) {
  for (const list of lists ?? []) { out.push(list); everyList(list.collections, out); }
  return out;
}

/** Every rule (not group) in a tree. */
export function rulesIn(tree, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (tree.kind === 'rule') out.push(tree);
  for (const child of tree.rules ?? []) rulesIn(child, out);
  return out;
}

/**
 * The facts one thing (a row or a list) has, by fact id. `readRecord(name)` answers the person's record an inputs.json
 * name stands for (an object kept by row id), or null.
 */
export function factsOf(thing, facts, readRecord, now) {
  return Object.fromEntries(facts.map(fact => {
    if (fact.clock) return [fact.id, now];
    const base = fact.from ? at(readRecord(fact.from), [thing.id]) : thing;
    const value = at(base, fact.path);
    if (!fact.time) return [fact.id, value ?? fact.default ?? null];
    const moment = timeOf(value);
    return [fact.id, Number.isFinite(moment) && MEASURES[fact.time] ? MEASURES[fact.time](moment, now) : null];
  }));
}

/** The moment ahead at which a rule over a measured fact can turn for this thing, or null. Show rules
 *  (show-rules.mjs) read their things' facts and turns through this same reader. */
export function nextTurn(thing, tree, facts, readRecord, now) {
  let next = null;
  for (const rule of rulesIn(tree)) {
    const fact = facts.find(one => one.id === rule.field);
    // A rule on the clock itself turns at the moment it names.
    if (fact?.clock) {
      for (const moment of [rule.params?.value, rule.params?.min, rule.params?.max]) if (typeof moment === 'number' && moment > now && (next === null || moment < next)) next = moment;
      continue;
    }
    if (!fact?.time || !TURNS[fact.time]) continue;
    const moment = timeOf(at(fact.from ? at(readRecord(fact.from), [thing.id]) : thing, fact.path));
    if (!Number.isFinite(moment)) continue;
    for (const days of [rule.params?.value, rule.params?.min, rule.params?.max]) {
      if (typeof days !== 'number') continue;
      const turn = TURNS[fact.time](moment, days);
      if (turn > now && (next === null || turn < next)) next = turn;
    }
  }
  return next;
}

/**
 * Which rows each rule-holding list holds, which lists are hidden by their own rule, and which rows of a list are hidden
 * by theirs.
 * data:       surfaces.json ({ sidebar_collections, sidebar_row_facts })
 * lists:      the lists to decide, when not data's own (the person's lists, parts/sidebar/read-data/apply-list-rules.ts)
 * rows:       the rows the sidebar can hold
 * readRecord: name -> the person's record kept by row id, or null
 * filterRows: the formula engine's row filter
 * Answers { holds: { list id: [row id] }, hidden: [list id], hidden_rows: { list id: [row id] }, next_change_at }.
 */
export async function decideSidebarRules({ data, lists: given, rows, readRecord, now, filterRows }) {
  const facts = data.sidebar_row_facts ?? [];
  const fields = facts.map(fact => ({ id: fact.id, kind: fact.kind }));
  const lists = given ?? everyList(data.sidebar_collections);
  const holds = {};
  const hidden = [];
  const hiddenRows = {};
  let next = null;
  const sooner = moment => { if (moment !== null && (next === null || moment < next)) next = moment; };
  const table = rows.map(row => factsOf(row, facts, readRecord, now));
  for (const list of lists) {
    if (list.holds?.rules) {
      const { matches } = await filterRows({ tree: list.holds.rules, fields, rows: table });
      holds[list.id] = matches.map(index => rows[index].id);
      for (const row of rows) sooner(nextTurn(row, list.holds.rules, facts, readRecord, now));
    }
    if (list.shown_when) {
      const { matches } = await filterRows({ tree: list.shown_when, fields, rows: [factsOf(list, facts, readRecord, now)] });
      if (!matches.length) hidden.push(list.id);
      sooner(nextTurn(list, list.shown_when, facts, readRecord, now));
    }
    for (const [rowId, tree] of Object.entries(list.rows_shown_when ?? {})) {
      const row = rows.find(one => one.id === rowId) ?? { id: rowId };
      const { matches } = await filterRows({ tree, fields, rows: [factsOf(row, facts, readRecord, now)] });
      if (!matches.length) (hiddenRows[list.id] ??= []).push(rowId);
      sooner(nextTurn(row, tree, facts, readRecord, now));
    }
  }
  return { holds, hidden, hidden_rows: hiddenRows, next_change_at: next };
}

/** Whether any list holds rows by a rule or shows by one (only then is there anything to decide). */
export const hasSidebarRules = data => everyList(data.sidebar_collections).some(list => list.holds?.rules || list.shown_when);
