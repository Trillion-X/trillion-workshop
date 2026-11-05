// tools/keep-my-calendar-in-my-accounts-own-records-with-its-lists-files/src/calendar-route.mjs
//
// PURPOSE
//   The page's calendar routes as one Workshop route tool the engine runs for the page's account (workshop-routes):
//   GET /calendar?from=&to=, GET and POST /calendar/tasks, and the task proposal and date-shift routes under
//   /calendar/. Each is answered by old trillion's own owner, moved here unchanged: src/native-calendar-owner.mjs
//   `calendar:request` (tag old-trillion-before-worker-retire, bound in src/standalone-resource-behavior.mjs:1139 and
//   reached from src/worker.mjs:1203-1207), over the person's lists (keep-lists-of-rows/lists.mjs makeLists) read and
//   written through the records door (keep-lists-of-rows/lists-over-the-records-door.mjs).
//
//   input  { path, method, query, body, browser }      output { status, body }
//
// NON-NEGOTIABLE INVARIANTS
//   1. The answers are the moved owner's: its status, its body and its refusals in its words. Nothing here decides.
//   2. The owner's `route` reaches the person's own routes. Inside this run the one such route it can answer is its own
//      /calendar/tasks (the personal-tasks source), answered by the same owner over the same records; any other source
//      route (meetings, given, posts) has no owner a run can reach, so the reader says that source in its own words as
//      unread and still answers the others (calendar.mjs invariant 2).
//   3. A run reaches no Workshop tool, so a source read by a tool (a connected calendar) is said unread the same way, and
//      /calendar/actions and /calendar/availability, which only a tool runner or the availability owner can answer, are
//      not answered here (404).
//   4. The recurrence wake the old owner armed after a task change (`arm`) is the engine's wake; nothing is armed here.
//
import calendarSettings from './calendar.json' with { type: 'json' };

import listsData from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { nativeCalendarOwner } from './native-calendar-owner.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { overTheRecordsDoor, kindOfId } from '../../keep-lists-of-rows/lists-over-the-records-door.mjs';

const NOT_HERE = new Set(['/calendar/actions', '/calendar/availability', '/calendar/connections']);

// Every record kind the lists keep beside a list (lists.json: the list itself and each `*_type` it names).
const listKinds = () => {
  const kinds = new Set([listsData.record_type]);
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith('type') && typeof item === 'string') kinds.add(item); else walk(item);
    }
  };
  walk(listsData);
  return [...kinds];
};
const typeOf = kindOfId([...listKinds(), 'workspace-preference']);

const queryString = query => new URLSearchParams(Object.entries(query && typeof query === 'object' ? query : {})
  .filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => [name, String(value)])).toString();

/** The page's calendar route, answered by the moved owner over the person's records. */
export async function answerTheCalendarRoute(input, { door }) {
  const { path, method = 'GET', query, body } = input && typeof input === 'object' ? input : {};
  if (typeof path !== 'string' || !(path === '/calendar' || path.startsWith('/calendar/')) || NOT_HERE.has(path)) return { status: 404, body: { error: 'Not found' } };
  const asked = queryString(query);
  const at = Date.now();
  try {
    const { result } = await overTheRecordsDoor(door, async (eeaf, { newId }) => {
      const lists = makeLists({ eeaf, newId });
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
      return owner.operations['calendar:request']({ path: `${path}${asked ? `?${asked}` : ''}`, method, ...(method === 'GET' ? {} : { body: body ?? {} }) });
    }, { typeOf });
    return { status: result.status, body: result.body };
  } catch (error) {
    return { status: 500, body: { error: String(error?.message ?? error) } };
  }
}

