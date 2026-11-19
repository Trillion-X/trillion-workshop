// tools/keep-my-calendar-in-my-accounts-own-records-with-its-lists-files/src/calendar-route.mjs
//
// PURPOSE
//   The page's calendar routes as one Workshop route tool the engine runs for the page's account (workshop-routes):
//   GET /calendar?from=&to=, GET and POST /calendar/tasks, and the task proposal and date-shift routes under
//   /calendar/. Each is answered by old trillion's own owner, moved here unchanged: src/native-calendar-owner.mjs
//   `calendar:request` (tag old-trillion-before-worker-retire, bound in src/standalone-resource-behavior.mjs:1139 and
//   reached from src/worker.mjs:1203-1207), over the person's lists (keep-lists-of-rows/lists.mjs makeLists).
//
//   The person's own records are not reached by this tool. The caller reads the rows the run needs from the person's
//   own store and hands them in as `records` ([{ id, type, value }]); the owner runs over those rows in memory. What
//   the run would write comes back as `keep` ([{ id, type, value }], value null removes) for the caller to keep where
//   the person keeps it, and the run writes nothing itself.
//
//   input  { path, method, query, body, browser, records }      output { status, body, keep }
//
// NON-NEGOTIABLE INVARIANTS
//   1. The answers are the moved owner's: its status, its body and its refusals in its words. Nothing here decides.
//   2. The owner's `route` reaches the person's own routes. Inside this run the one such route it can answer is its own
//      /calendar/tasks (the personal-tasks source), answered by the same owner over the same rows; any other source
//      route (meetings, given, posts) has no owner a run can reach, so the reader says that source in its own words as
//      unread and still answers the others (calendar.mjs invariant 2).
//   3. A run reaches no Workshop tool, so a source read by a tool (a connected calendar) is said unread the same way, and
//      /calendar/actions and /calendar/availability, which only a tool runner or the availability owner can answer, are
//      not answered here (404).
//   4. The recurrence wake the old owner armed after a task change (`arm`) is the engine's wake; nothing is armed here.
//   5. Only the rows given are there: a row the caller did not hand in reads as absent. Every write is answered in
//      `keep`; the caller keeps it, conditional on the rows it read.
//
import calendarSettings from './calendar.json' with { type: 'json' };

import listsData from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { nativeCalendarOwner } from './native-calendar-owner.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';

const NOT_HERE = new Set(['/calendar/actions', '/calendar/availability', '/calendar/connections']);

// Every record kind the lists keep beside a list (lists.json: the list itself and each `*_type` it names), plus the
// person's workspace preference: a record's kind is named from its id (`record:<row type>:<id>` is `record:<row type>`).
const listKinds = () => {
  const kinds = new Set([listsData.record_type, 'workspace-preference']);
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith('type') && typeof item === 'string') kinds.add(item); else walk(item);
    }
  };
  walk(listsData);
  return [...kinds].sort((a, b) => b.length - a.length);
};
const KINDS = listKinds();
const kindOf = id => {
  if (id.startsWith('record:')) return `record:${id.split(':')[1]}`;
  return KINDS.find(kind => id.startsWith(`${kind}:`)) ?? id.split(':')[0];
};

const queryString = query => new URLSearchParams(Object.entries(query && typeof query === 'object' ? query : {})
  .filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => [name, String(value)])).toString();

// The rows handed in, as the synchronous record book the lists and the owner read (read, readMany, ids, typeOf, write,
// atomically, indexReady). Reads and writes stay in memory; `kept()` is what the run wrote and changed.
function givenRecords(given) {
  const held = new Map((Array.isArray(given) ? given : []).filter(row => row && typeof row.id === 'string')
    .map(row => [row.id, { type: row.type ?? kindOf(row.id), value: structuredClone(row.value ?? null) }]));
  const written = new Map();
  const current = id => (written.has(id) ? written.get(id) : held.get(id));
  const typeOf = id => (current(id)?.value != null ? current(id).type : null);
  const eeaf = {
    read(id) {
      const one = current(id);
      return one?.value == null ? null : structuredClone(one.value);
    },
    readMany(ids) { return new Map(ids.map(id => [id, eeaf.read(id)])); },
    ids(type, { prefix = '', before, limit } = {}) {
      const found = [...new Set([...held.keys(), ...written.keys()])].filter(id => kindOf(id) === type && id.startsWith(prefix)
        && current(id)?.value != null && (before === undefined || id < before)).sort();
      return limit === undefined && before === undefined ? found : found.reverse().slice(0, Math.max(1, Math.floor(Number(limit) || 1000)));
    },
    typeOf,
    write(rows) {
      for (const row of rows) {
        if (typeof row?.id !== 'string' || !row.id) throw new TypeError('A record needs an id.');
        written.set(row.id, { type: row.type ?? kindOf(row.id), value: row.value == null ? null : structuredClone(row.value) });
      }
    },
    atomically: change => change(),
    transaction: change => change(),
    indexReady: () => false,
    forgetCached() {},
    kept() {
      return [...written].filter(([id, one]) => JSON.stringify(one.value) !== JSON.stringify(held.get(id)?.value ?? null))
        .map(([id, one]) => ({ id, type: one.type, value: one.value }));
    },
  };
  return eeaf;
}

/** The page's calendar route, answered by the moved owner over the rows the caller hands in. */
export async function answerTheCalendarRoute(input = {}) {
  const { path, method = 'GET', query, body, records } = input && typeof input === 'object' ? input : {};
  if (typeof path !== 'string' || !(path === '/calendar' || path.startsWith('/calendar/')) || NOT_HERE.has(path)) return { status: 404, body: { error: 'Not found' } };
  const asked = queryString(query);
  const at = Date.now();
  try {
    const eeaf = givenRecords(records);
    const lists = makeLists({ eeaf, newId: () => crypto.randomUUID() });
    let owner;
    // The person's own routes, as the owner reads its sources: its own tasks route, answered by this same owner.
    const route = async address => {
      const url = new URL(address, 'https://native');
      if (url.pathname !== '/calendar/tasks') throw new Error(`No owner answers ${url.pathname} here.`);
      const answer = await owner.operations['calendar:request']({ path: `${url.pathname}${url.search}`, method: 'GET' });
      if (answer.status >= 400) throw new Error(answer.body?.error ?? `${url.pathname} answered ${answer.status}`);
      return answer.body;
    };
    const workshop = { run: async () => { throw new Error('No Workshop tool runs inside this run.'); } };
    owner = nativeCalendarOwner({ records: eeaf, workshop, route, taskListOwner: lists, settings: calendarSettings, now: () => at });
    const answer = await owner.operations['calendar:request']({ path: `${path}${asked ? `?${asked}` : ''}`, method, ...(method === 'GET' ? {} : { body: body ?? {} }) });
    return { status: answer.status, body: answer.body, keep: eeaf.kept() };
  } catch (error) {
    return { status: 500, body: { error: String(error?.message ?? error) }, keep: [] };
  }
}
