// Native Calendar composes the existing Calendar algorithms with the current
// addressed resource's record, List, Workshop, Namespace, model and connection
// owners.  It owns no parallel calendar store and never forwards to PersonStore.
import calendarSettings from './calendar.json' with { type: 'json' };
import taskSettings from '../../plan-tasks-and-todo-lists/calendar-tasks.json' with { type: 'json' };
import { readCalendar, isCalendarPath } from './calendar.mjs';
import { runCalendarAction } from './calendar-actions.mjs';
import { buildCalendarSources, listSelectableCalendars, validateCalendarSelections,
  validateCalendarRouteChoice, calendarSelectionSourceId } from './calendar-connections.mjs';
import { readCalendarTasks, readCalendarTaskCollections, handleCalendarTasksRequest } from '../../plan-tasks-and-todo-lists/calendar-tasks.mjs';
import { handleTaskProposalRequest, isTaskProposalPath } from './task-proposals.mjs';
import { shiftChoices, isDateShiftPath } from '../../move-a-dated-plan/src/date-shift.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Build Calendar operations against one admitted native resource context.
 * `route` and `connectionIO` are adapters to the resource's installed shared
 * owners; they must not be account-wide/PersonStore fallbacks.  All calls are
 * gated through `current` using the actual operation and input.
 */
export function nativeCalendarOwner({
  records, eeaf = records, workshop, namespace, models, connections,
  route, connectionIO, current = async () => {}, context = () => ({}),
  settings = calendarSettings, sources = settings.sources, revisionOf = () => '', now = () => Date.now(),
  availability = () => null, taskListOwner = null,
} = {}) {
  if (!eeaf || typeof eeaf.read !== 'function') throw new TypeError('The current native EEAF record owner is required.');
  if (!workshop || typeof workshop.run !== 'function') throw new TypeError('The current native Workshop owner is required.');
  if (typeof route !== 'function') throw new TypeError('The current native shared-route adapter is required.');

  const lists = taskListOwner ?? makeLists({ eeaf });
  const read = async (operation, input, fn) => {
    await current(operation, input);
    return fn();
  };
  const runTool = async (toolId, input, requestKey) => {
    try { return await workshop.run({ tool_id: toolId, input, request_key: requestKey, wait_seconds: 30 }); }
    catch(error) { return error?.missing_connection ? {connected:false} : {state:'failed',error:String(error.message??error)}; }
  };

  const currentSources = async () => {
    const selections = eeaf.read('workspace-preference:calendar-selections');
    if (!Array.isArray(selections)) return sources;
    const own = sources.filter(row => !row.calendar_connection);
    if (!selections.length) return own;
    const accountIndex = await listSelectableCalendars(connectionIO, settings);
    return [...own, ...await buildCalendarSources({ selections, accountIndex, io: connectionIO, settings })];
  };
  // Keeping (tasks, proposals, dates, selections) is the recipe's: this page route only reads.
  const keepingMoved = () => Response.json({ error: 'Keeping moved to workflow:keep-my-calendar-tasks-and-proposals; the calendar page route only reads.' }, { status: 405 });
  const request = async input => {
    await current('calendar:request', input);
    const url = new URL(input.path, 'https://native'), method = input.method ?? 'GET';
    let response;
    if (url.pathname === '/calendar/availability') {
      const owner = availability();
      if (!owner) throw new Error('The availability capability is not installed.');
      return owner.request(input);
    } else if (url.pathname === '/calendar/tasks') {
      response = method === 'GET' ? await handleCalendarTasksRequest(lists, new Request(url, { method })) : keepingMoved();
    } else if (isDateShiftPath(url.pathname)) {
      response = method === 'GET' ? Response.json(shiftChoices()) : keepingMoved();
    } else if (isTaskProposalPath(url.pathname)) {
      response = await handleTaskProposalRequest(lists, new Request(url, { method }));
    } else if (url.pathname === '/calendar/connections' && method === 'GET') {
      response = Response.json({ ...await listSelectableCalendars(connectionIO, settings), selections: eeaf.read('workspace-preference:calendar-selections') ?? null });
    } else if (url.pathname === '/calendar' && method === 'GET') {
      response = Response.json(await readCalendar(Object.fromEntries(url.searchParams), { route, runTool, readRecord: id => eeaf.read(id),
        sources: await currentSources(), revisionOf, now }));
    } else if (url.pathname === '/calendar/actions' && method === 'POST') {
      const result = await runCalendarAction(input.body, { runTool:(tool_id,input,request_key)=>workshop.run({tool_id,input,request_key,wait_seconds:30}), sources: await currentSources() });
      response = Response.json(result);
    } else response = Response.json({ error: 'Not found' }, { status: 404 });
    return { native_response: true, status: response.status, headers: { 'content-type':'application/json' }, body: await response.json() };
  };
  const operations = Object.freeze({
    'calendar:request': request,
    'calendar:read': input => read('calendar:read', input, async () => readCalendar(input, {
      route,
      runTool,
      readRecord: id => eeaf.read(id),
      sources: await currentSources(),
      revisionOf,
      now,
    })),
    'calendar:action': input => read('calendar:action', input, async () => runCalendarAction(input, {
      runTool:(tool_id,input,request_key)=>workshop.run({tool_id,input,request_key,wait_seconds:30}),
      sources: await currentSources(),
    })),
    'calendar:tasks:read': input => read('calendar:tasks:read', input, async () => await readCalendarTasks(lists, input)),
    'calendar:tasks:collections': input => read('calendar:tasks:collections', input, async () => await readCalendarTaskCollections(lists, input)),
    'calendar:connections:list': input => read('calendar:connections:list', input, () => {
      if (!connectionIO) throw new Error('The current native service-connections owner is unavailable.');
      return listSelectableCalendars(connectionIO, settings);
    }),
    'calendar:connections:validate': input => read('calendar:connections:validate', input, async () => {
      if (!connectionIO) throw new Error('The current native service-connections owner is unavailable.');
      const accountIndex = await listSelectableCalendars(connectionIO, settings);
      return validateCalendarSelections(input.selections, accountIndex, settings);
    }),
    'calendar:connections:build': input => read('calendar:connections:build', input, async () => {
      if (!connectionIO) throw new Error('The current native service-connections owner is unavailable.');
      const accountIndex = await listSelectableCalendars(connectionIO, settings);
      return buildCalendarSources({ ...input, accountIndex, io: connectionIO, settings });
    }),
    'calendar:connections:route': input => read('calendar:connections:route', input, async () =>
      validateCalendarRouteChoice(input.choice, await currentSources())),
    'calendar:connections:source-id': input => read('calendar:connections:source-id', input, () =>
      calendarSelectionSourceId(input.selection)),
  });

  return Object.freeze({
    operations,
    invoke(operation, input = {}) {
      if (!object(input)) throw new TypeError('Calendar input must be an object.');
      const implementation = operations[operation];
      if (!implementation) throw new Error('The native Calendar operation is not installed.');
      return implementation(input);
    },
    ownsPath: path => isCalendarPath(path) || path === '/calendar/tasks' || isTaskProposalPath(path) || isDateShiftPath(path) || path === '/calendar/availability',
    owners: Object.freeze({ records: eeaf, lists, workshop, namespace, models, connections }),
    http: Object.freeze({
      read: 'calendar:read',
      taskRead: 'calendar:tasks:read',
    }),
    mcp: Object.freeze({
      read: 'calendar:read',
      action: 'calendar:action',
      tasks: Object.freeze(['calendar:tasks:read', 'calendar:tasks:collections']),
      connections: Object.freeze(['calendar:connections:list', 'calendar:connections:validate', 'calendar:connections:build', 'calendar:connections:route']),
    }),
    taskSettings,
    context,
  });
}
