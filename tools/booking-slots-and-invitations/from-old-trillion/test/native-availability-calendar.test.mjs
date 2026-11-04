import test from 'node:test';
import assert from 'node:assert/strict';
import { workshopTaskId } from '../../../keep-and-wake-ai-sessions-on-this-computer/src/typed-operation-contract.mjs';
import { calendarSelectionSourceId } from '../../../keep-my-calendar-in-my-accounts-own-records-with-its-lists-files/src/calendar-connections.mjs';
import { createNativeAvailabilityCalendar } from '../src/native-availability-calendar.mjs';

const primary = { source_id: 'provider-a', connection_id: 'connection-a', connected_at: '2026-10-14T00:00:00.000Z', calendar_id: 'primary' };
const cohost = { source_id: 'provider-b', connection_id: 'connection-b', connected_at: '2026-10-14T01:00:00.000Z', calendar_id: 'team' };
const primarySourceId = calendarSelectionSourceId(primary);
const roleDeclaration = { readable_roles: ['owner', 'writer', 'reader', 'freeBusyReader'], writable_roles: ['owner', 'writer'] };
const exactSettings = { sources: ['provider-a', 'provider-b'].map(id => ({ id, calendar_connection: roleDeclaration,
  rows: ['items'], fields: {
    id: [['id']], ical_uid: [['iCalUID']], organizer_email: [['organizer', 'email']], attendees: [['attendees']],
    attendee_email: [['email']], original_starts_at: [['originalStartTime', 'dateTime'], ['originalStartTime', 'date']],
    starts_at: [['start', 'dateTime'], ['start', 'date']], ends_at: [['end', 'dateTime'], ['end', 'date']],
  } })) };

const invitedMeeting = (overrides = {}) => ({
  id: 'primary-event-id', iCalUID: 'meeting-series@example.com', organizer: { email: 'organizer@example.com' },
  start: { dateTime: '2026-10-15T10:00:00Z' }, end: { dateTime: '2026-10-15T10:30:00Z' },
  originalStartTime: { dateTime: '2026-10-15T10:00:00Z' },
  attendees: [{ email: 'cohost@example.com' }, { email: 'guest@example.com' }], ...overrides,
});

function fixture({ sourceFor = selection => ({ id: calendarSelectionSourceId(selection), base_source: selection.source_id,
  tool: `bound:${selection.source_id}:events`, input: { calendar_id: selection.calendar_id, time_min: '{from}', time_max: '{to}' }, read_mode: 'events',
  calendar_actions: { create: { tool: 'tool:create', input_defaults: { calendar_id: selection.calendar_id } },
    move: { tool: 'tool:move', input_defaults: { calendar_id: selection.calendar_id } },
    cancel: { tool: 'tool:cancel', input_defaults: { calendar_id: selection.calendar_id } } } }), run = async () => ({ state: 'completed', output: { items: [] } }), snapshot = async () => ({}) } = {}) {
  const calls = [], bindings = new Map();
  const calendarOwner = { async invoke(operation, input) {
    calls.push([operation, input]);
    if (operation === 'calendar:connections:build') return input.selections.map(selection => ({
      ...sourceFor(selection), selection: { source_id: selection.source_id, connection_id: selection.connection_id,
        connected_at: selection.connected_at, calendar_id: selection.calendar_id },
      access_role: selection.access_role ?? 'owner', writable: (selection.access_role ?? 'owner') === 'owner',
    }));
    throw new Error(`Unexpected operation ${operation}`);
  } };
  const workshop = { async run(input) { calls.push(['run', input]); return run(input); }, async snapshot(input) { calls.push(['snapshot', input]); return snapshot(input); } };
  return { adapter: createNativeAvailabilityCalendar({ calendarOwner, workshop, settings: exactSettings,
    readEffectBinding: id => bindings.get(id) ?? null,
    keepEffectBinding: (id, value) => { if (!bindings.has(id)) bindings.set(id, structuredClone(value)); return bindings.get(id); } }), calls, bindings };
}

test('fresh busy reads include primary and cohost calendars and exclude only the exact moved event', async () => {
  const { adapter, calls } = fixture({
    sourceFor: selection => selection.source_id === 'provider-a'
      ? { id: 'a', base_source: 'provider-a', tool: 'bound:a', input: {}, read_mode: 'events',
        calendar_actions: {}, }
      : { id: 'b', base_source: 'provider-b', tool: 'bound:b', input: {}, read_mode: 'events', calendar_actions: {} },
    run: async ({ tool_id }) => ({ state: 'completed', output: { items: [{ id: 'moving', start: { dateTime: '2026-10-15T10:00:00Z' }, end: { dateTime: '2026-10-15T10:30:00Z' } },
      { id: 'other', start: { dateTime: '2026-10-15T10:00:00Z' }, end: { dateTime: '2026-10-15T10:30:00Z' } }] } }),
  });
  const result = await adapter.readBusy({ link: { calendar: primary, cohosts: [{ calendar: cohost }] }, from_ms: Date.parse('2026-10-15T00:00:00Z'), to_ms: Date.parse('2026-10-16T00:00:00Z'),
    exclude_event: { calendar: primary, event_id: 'moving' } });
  assert.equal(result.status, 'read');
  assert.equal(result.busy.length, 3, 'the matching event is removed from the primary read, while its other event and both cohost rows remain');
  const builds = calls.filter(([operation]) => operation === 'calendar:connections:build').map(([, input]) => input.selections);
  assert.deepEqual(builds[0], [primary, cohost]);
  assert.deepEqual(builds.at(-1), [primary, cohost], 'the whole selection is revalidated after all busy reads');
  assert.equal(calls.filter(([operation]) => operation === 'run').length, 2);
});

test('an exact invited cohost copy is excluded by the provider correlation tuple despite a different event id', async () => {
  const primaryEvent = invitedMeeting();
  const cohostCopy = invitedMeeting({ id: 'different-provider-event-id' });
  const { adapter } = fixture({ run: async ({ tool_id }) => ({ state: 'completed', output: {
    items: [tool_id === 'bound:provider-a:events' ? primaryEvent : cohostCopy],
  } }) });
  const result = await adapter.readBusy({ link: { calendar: primary, cohosts: [{ calendar: cohost, email: 'cohost@example.com' }] },
    from_ms: Date.parse('2026-10-15T09:00:00Z'), to_ms: Date.parse('2026-10-15T11:00:00Z'),
    exclude_event: { calendar: primary, event_id: primaryEvent.id } });
  assert.deepEqual(result, { status: 'read', busy: [] });
});

test('matching non-recurring copies correlate when neither provider row has originalStartTime', async () => {
  const primaryEvent = invitedMeeting(), cohostCopy = invitedMeeting({ id: 'nonrecurring-copy-id' });
  delete primaryEvent.originalStartTime;
  delete cohostCopy.originalStartTime;
  const { adapter } = fixture({ run: async ({ tool_id }) => ({ state: 'completed', output: {
    items: [tool_id === 'bound:provider-a:events' ? primaryEvent : cohostCopy],
  } }) });
  const result = await adapter.readBusy({ link: { calendar: primary, cohosts: [{ calendar: cohost, email: 'cohost@example.com' }] },
    from_ms: Date.parse('2026-10-15T09:00:00Z'), to_ms: Date.parse('2026-10-15T11:00:00Z'),
    exclude_event: { calendar: primary, event_id: primaryEvent.id } });
  assert.deepEqual(result, { status: 'read', busy: [] });
});

test('same ids and incomplete or mismatched meeting evidence keep cohost intervals busy', async () => {
  const primaryEvent = invitedMeeting();
  const unrelatedOrMismatched = [
    invitedMeeting({ id: primaryEvent.id, iCalUID: 'unrelated@example.com' }),
    invitedMeeting({ id: 'copy-start-mismatch', start: { dateTime: '2026-10-15T10:15:00Z' }, end: { dateTime: '2026-10-15T10:45:00Z' } }),
    invitedMeeting({ id: 'copy-organizer-mismatch', organizer: { email: 'other@example.com' } }),
    invitedMeeting({ id: 'copy-original-occurrence-mismatch', originalStartTime: { dateTime: '2026-10-15T09:30:00Z' } }),
    invitedMeeting({ id: 'copy-invitation-mismatch', attendees: [{ email: 'someone-else@example.com' }] }),
  ];
  for (const cohostCopy of unrelatedOrMismatched) {
    const { adapter } = fixture({ run: async ({ tool_id }) => ({ state: 'completed', output: {
      items: [tool_id === 'bound:provider-a:events' ? primaryEvent : cohostCopy],
    } }) });
    const result = await adapter.readBusy({ link: { calendar: primary, cohosts: [{ calendar: cohost, email: 'cohost@example.com' }] },
      from_ms: Date.parse('2026-10-15T09:00:00Z'), to_ms: Date.parse('2026-10-15T11:00:00Z'),
      exclude_event: { calendar: primary, event_id: primaryEvent.id } });
    assert.deepEqual(result, { status: 'read', busy: [{ startMs: Date.parse(cohostCopy.start.dateTime), endMs: Date.parse(cohostCopy.end.dateTime) }] });
  }
});

test('ambiguous cohost copies and a missing primary provider row remain busy', async () => {
  const primaryEvent = invitedMeeting();
  const cohostCopy = invitedMeeting({ id: 'copy-event-id' });
  const link = { calendar: primary, cohosts: [{ calendar: cohost, email: 'cohost@example.com' }] };
  const ambiguous = fixture({ run: async ({ tool_id }) => ({ state: 'completed', output: { items: tool_id === 'bound:provider-a:events'
    ? [primaryEvent] : [cohostCopy, structuredClone(cohostCopy)] } }) });
  const ambiguousResult = await ambiguous.adapter.readBusy({ link, from_ms: Date.parse('2026-10-15T09:00:00Z'), to_ms: Date.parse('2026-10-15T11:00:00Z'),
    exclude_event: { calendar: primary, event_id: primaryEvent.id } });
  assert.deepEqual(ambiguousResult, { status: 'read', busy: [
    { startMs: Date.parse(cohostCopy.start.dateTime), endMs: Date.parse(cohostCopy.end.dateTime) },
    { startMs: Date.parse(cohostCopy.start.dateTime), endMs: Date.parse(cohostCopy.end.dateTime) },
  ] });

  const missing = fixture({ run: async ({ tool_id }) => ({ state: 'completed', output: { items: tool_id === 'bound:provider-a:events'
    ? [] : [cohostCopy] } }) });
  const missingResult = await missing.adapter.readBusy({ link, from_ms: Date.parse('2026-10-15T09:00:00Z'), to_ms: Date.parse('2026-10-15T11:00:00Z'),
    exclude_event: { calendar: primary, event_id: primaryEvent.id } });
  assert.deepEqual(missingResult, { status: 'read', busy: [
    { startMs: Date.parse(cohostCopy.start.dateTime), endMs: Date.parse(cohostCopy.end.dateTime) },
  ] });
});

test('free/busy cohost reads require complete source-declared rows through the exact bound tool', async () => {
  const selection = { ...primary, access_role: 'freeBusyReader' }, main={...cohost,access_role:'owner'};
  const busySource={ rows:['calendars','primary','busy'],required_rows:true,fields:{starts_at:[['start']],ends_at:[['end']]} };
  const settings={sources:[{id:'provider-a',calendar_connection:{...roleDeclaration,busy_role:'freeBusyReader',busy_source:busySource}},exactSettings.sources[1]]};
  const calls=[];
  const calendarOwner={async invoke(_operation,input){return input.selections.map(value=>value.source_id==='provider-a'
    ? {id:'selected',base_source:'provider-a',tool:'bound:busy',input:{calendar_id:'primary'},read_mode:'busy',selection:value,access_role:'freeBusyReader',writable:false,busy_source:busySource}
    : {id:'main',base_source:'provider-b',tool:'bound:main',input:{},read_mode:'events',selection:value,access_role:'owner',writable:true});}};
  const workshop={async run(input){calls.push(['run',input]);return {state:'completed',output:input.tool_id==='bound:main'?{items:[]}:{calendars:{primary:{busy:[{start:'2026-10-15T10:00:00Z',end:'2026-10-15T10:30:00Z'}]}}}};},async snapshot(){}};
  const adapter=createNativeAvailabilityCalendar({calendarOwner,workshop,settings,readEffectBinding:()=>null,keepEffectBinding:(_id,value)=>value});
  const result=await adapter.readBusy({link:{calendar:main,cohosts:[{calendar:selection}]},from_ms:Date.parse('2026-10-15T00:00:00Z'),to_ms:Date.parse('2026-10-16T00:00:00Z')});
  assert.deepEqual(result,{status:'read',busy:[{startMs:Date.parse('2026-10-15T10:00:00Z'),endMs:Date.parse('2026-10-15T10:30:00Z')}]});
  assert.equal(calls.some(([,input])=>input.tool_id==='bound:busy'),true);
});

test('event reads enforce one total row ceiling across provider pages', async () => {
  const settings = { sources: [{ ...exactSettings.sources[0], pagination: {
    max_pages: 2, max_rows: 2, next_cursor: ['nextPageToken'], input_field: 'page_token',
  } }, exactSettings.sources[1]] };
  const runs = [];
  const configured = createNativeAvailabilityCalendar({
    calendarOwner: { invoke: async (_operation, input) => input.selections.map(selection => ({
      id: 'selected', base_source: 'provider-a', tool: 'bound:events', input: {}, read_mode: 'events', writable: true,
      access_role: 'owner', selection: { source_id: selection.source_id, connection_id: selection.connection_id,
        connected_at: selection.connected_at, calendar_id: selection.calendar_id },
    })) },
    workshop: { run: async call => {
      runs.push(call);
      const page = call.input.page_token;
      return { state: 'completed', output: page
        ? { items: [{ id: 'third', start: { dateTime: '2026-10-15T12:00:00Z' }, end: { dateTime: '2026-10-15T12:30:00Z' } }] }
        : { items: [
          { id: 'first', start: { dateTime: '2026-10-15T10:00:00Z' }, end: { dateTime: '2026-10-15T10:30:00Z' } },
          { id: 'second', start: { dateTime: '2026-10-15T11:00:00Z' }, end: { dateTime: '2026-10-15T11:30:00Z' } },
        ], nextPageToken: 'page-two' } };
    }, snapshot: async () => ({}) },
    settings,
    readEffectBinding: () => null,
    keepEffectBinding: (_id, value) => value,
  });
  const result = await configured.readBusy({ link: { calendar: primary },
    from_ms: Date.parse('2026-10-15T00:00:00Z'), to_ms: Date.parse('2026-10-16T00:00:00Z') });
  assert.deepEqual(result, { status: 'unknown', busy: [], error: 'calendar-event-read-row-limit' });
  assert.equal(runs.length, 2, 'the second page is fetched only to detect the aggregate overflow');
});

test('known invalid calendar selections return a typed, useful result', async () => {
  const { adapter } = fixture();
  const result = await adapter.readBusy({ link: { calendar: { source_id: 'provider-a' } },
    from_ms: Date.parse('2026-10-15T00:00:00Z'), to_ms: Date.parse('2026-10-16T00:00:00Z') });
  assert.equal(result.status, 'invalid-selection');
  assert.equal(result.code, 'calendar-selection-invalid');
  assert.match(result.error, /exact source, account, calendar and connection incarnation/);
  await assert.rejects(adapter.validateLink({ calendar: { source_id: 'provider-a' } }), error => error.status === 409 && error.code === 'calendar-selection-invalid');
});

test('link validation rejects malformed cohost invitation emails', async () => {
  const { adapter } = fixture();
  await assert.rejects(adapter.validateLink({calendar:primary,cohosts:[{calendar:cohost}]}),error=>error.status===409&&error.code==='invalid-cohost-email');
  await assert.rejects(adapter.validateLink({ calendar: primary, cohosts: [{ calendar: cohost, email: 'not-an-email' }] }),
    error => error.status === 409 && error.read_status === 'invalid-selection' && error.code === 'invalid-cohost-email');
});

test('effects use the durable original binding and reconciliation only snapshots its original task', async () => {
  const selection = primary;
  const { adapter, calls } = fixture({
    sourceFor: () => ({ id: primarySourceId, base_source: 'provider-a', tool: 'bound:events', input: {}, read_mode: 'events',
      calendar_actions: { create: { tool: 'tool:create', input_defaults: { calendar_id: 'primary' } } } }),
    run: async () => ({ task_id: 'task:created', state: 'completed', output: { id: 'event:created' } }),
    snapshot: async input => ({ task_id: input.task_id, tool_id: 'tool:create', request_key: `calendar:${primarySourceId}:create:availability:operation:one`, state: 'completed', output: { id: 'event:created' } }),
  });
  const link = { id: 'link:one', title: 'Coffee', calendar: selection, timezone: 'America/Los_Angeles', repeat: false, windows: [], duration_min: 30, step_min: 30 };
  const reservation = { id: 'reservation:one', start_ms: Date.parse('2026-10-15T10:00:00Z'), end_ms: Date.parse('2026-10-15T10:30:00Z'), recipient: { email: 'guest@example.com' } };
  const operation = { id: 'operation:one', kind: 'reserve', requested_start_ms: reservation.start_ms, requested_end_ms: reservation.end_ms, effect_input: { link, reservation } };
  assert.deepEqual(await adapter.effects.ensure({ operation, link, reservation, request_key: operation.id }), { state: 'completed', external_event_id: 'event:created' });
  const write = calls.find(([kind]) => kind === 'run')[1];
  assert.equal(write.tool_id, 'tool:create');
  assert.equal(write.input.title, 'Coffee');
  assert.equal(write.input.time_zone, 'America/Los_Angeles');
  assert.deepEqual(write.input.attendees, [{ email: 'guest@example.com' }]);
  assert.equal(write.input.calendar_id, 'primary');
  const originalBinding = structuredClone(write);
  // A later connection rebuild must not alter the already-admitted operation.
  const originalBuildCount = calls.filter(([kind]) => kind === 'calendar:connections:build').length;
  assert.equal(originalBuildCount, 1);
  assert.deepEqual(await adapter.effects.reconcile({ operation, link, reservation }), { state: 'completed', external_event_id: 'event:created' });
  const snapshot = calls.find(([kind]) => kind === 'snapshot')[1];
  assert.equal(snapshot.task_id, workshopTaskId({ tool_id: 'tool:create', request_key: `calendar:${primarySourceId}:create:availability:operation:one` }));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 1, 'reconciliation does not redispatch');
  assert.equal(calls.filter(([kind]) => kind === 'calendar:connections:build').length, originalBuildCount,
    'reconciliation reads the durable original binding without rediscovering the current connection');
  assert.deepEqual(originalBinding, write);
});

test('co-host invitation emails join the verified recipient through Google attendee body data', async () => {
  const { adapter, calls } = fixture({
    sourceFor: selection => ({ id: primarySourceId, base_source: 'provider-a', tool: 'bound:events', input: {}, read_mode: 'events',
      calendar_actions: { create: { tool: 'tool:create', input_defaults: { calendar_id: 'primary' } } } }),
    run: async () => ({ state: 'completed', output: { id: 'event:created' } }),
  });
  const link = { id: 'link:one', title: 'Coffee', calendar: primary, cohosts: [
    { calendar: cohost, email: ' HOST@example.com ' }, { calendar: cohost, email: 'host@example.com' },
    { calendar: cohost, email: 'not-an-email' },
  ], timezone: 'America/Los_Angeles' };
  const reservation = { id: 'reservation:one', start_ms: Date.parse('2026-10-15T10:00:00Z'), end_ms: Date.parse('2026-10-15T10:30:00Z'), recipient: { email: 'guest@example.com' } };
  const operation = { id: 'operation:cohost', kind: 'reserve', effect_input: { link, reservation } };
  assert.equal((await adapter.effects.ensure({ operation, link, reservation, request_key: operation.id })).state, 'completed');
  assert.deepEqual(calls.find(([kind]) => kind === 'run')[1].input.attendees,
    [{ email: 'guest@example.com' }, { email: 'HOST@example.com' }]);
});

test('a saved operation without its first task binding recovers the frozen invocation under its stable key', async () => {
  const { adapter, calls } = fixture({
    sourceFor: () => ({ id: primarySourceId, base_source: 'provider-a', tool: 'bound:events', input: {}, read_mode: 'events',
      calendar_actions: { create: { tool: 'tool:create', input_defaults: { calendar_id: 'primary' } } } }),
    run: async input => ({ task_id: workshopTaskId(input), state: 'completed', output: { id: 'event:recovered' } }),
  });
  const link = { id: 'link:one', title: 'Coffee', calendar: primary, timezone: 'America/Los_Angeles' };
  const reservation = { id: 'reservation:one', start_ms: Date.parse('2026-10-15T10:00:00Z'), end_ms: Date.parse('2026-10-15T10:30:00Z') };
  const operation = { id: 'operation:crash-before-binding', kind: 'reserve', effect_input: { link, reservation } };
  assert.deepEqual(await adapter.effects.ensure({ operation, link, reservation, request_key:operation.id }), { state: 'completed', external_event_id: 'event:recovered' });
  const dispatch = calls.find(([kind]) => kind === 'run')[1];
  assert.equal(dispatch.request_key, `calendar:${primarySourceId}:create:availability:${operation.id}`);
  assert.equal(dispatch.input.calendar_id, primary.calendar_id);
});

test('a bound task with a missing snapshot stays unknown and is never redirected', async () => {
  const { adapter, calls, bindings } = fixture({
    sourceFor: () => ({ id: primarySourceId, base_source: 'provider-a', tool: 'bound:events', input: {}, read_mode: 'events',
      calendar_actions: { create: { tool: 'tool:create', input_defaults: { calendar_id: 'primary' } } } }),
    run: async input => ({ task_id: workshopTaskId(input), state: 'working' }),
    snapshot: async () => { throw new Error('task snapshot is not available'); },
  });
  const link = { id: 'link:one', title: 'Coffee', calendar: primary, timezone: 'America/Los_Angeles' };
  const reservation = { id: 'reservation:one', start_ms: Date.parse('2026-10-15T10:00:00Z'), end_ms: Date.parse('2026-10-15T10:30:00Z') };
  const operation = { id: 'operation:bound-uncertain', kind: 'reserve', effect_input: { link, reservation } };
  await adapter.effects.ensure({ operation, link, reservation, request_key: operation.id });
  const retained = structuredClone(bindings.get(operation.id));
  const result = await adapter.effects.reconcile({ operation, link, reservation });
  assert.equal(result.state, 'unknown');
  assert.deepEqual(bindings.get(operation.id), retained);
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 1, 'snapshot failure does not dispatch a second task');
});

test('selection loss during the busy read fails closed', async () => {
  let build = 0;
  const selection = { ...primary, access_role: 'owner' };
  const settings = { sources: [{ id: 'provider-a', calendar_connection: roleDeclaration, rows: ['items'],
    fields: { id: [['id']], starts_at: [['start', 'dateTime']], ends_at: [['end', 'dateTime']] } }] };
  const calendarOwner = { async invoke(operation, input) {
    if (operation !== 'calendar:connections:build') throw new Error('unexpected operation');
    build += 1;
    return input.selections.map(value => build >= 3 ? { unavailable: true } : ({ id: primarySourceId, base_source: 'provider-a', tool: 'bound', input: {}, read_mode: 'events', writable: true,
      access_role: 'owner', selection: { source_id: value.source_id, connection_id: value.connection_id, connected_at: value.connected_at, calendar_id: value.calendar_id } }));
  } };
  const workshop = { async run() { return { state: 'completed', output: { items: [] } }; }, async snapshot() {} };
  const adapter = createNativeAvailabilityCalendar({ calendarOwner, workshop, settings, readEffectBinding: () => null, keepEffectBinding: () => null });
  const lost = await adapter.readBusy({ link: { calendar: selection }, from_ms: Date.parse('2026-10-15T00:00:00Z'), to_ms: Date.parse('2026-10-16T00:00:00Z') });
  assert.equal(lost.status, 'invalid-selection');assert.equal(lost.code,'calendar-unavailable');assert.deepEqual(lost.busy,[]);
});

test('busy rows beyond the configured bound fail closed', async () => {
  const selection = { ...primary, access_role: 'freeBusyReader' };
  const settings = { sources: [{ id: 'provider-a', rows:['items'],calendar_connection: { ...roleDeclaration, busy_role: 'freeBusyReader',
    busy_source: { rows: ['busy'], max_rows: 1 } } }] };
  const calendarOwner = { async invoke(_operation, input) { return input.selections.map(value => ({ id: 'selected', base_source: 'provider-a',
    tool: value.calendar_id==='organizer'?'bound:events':'bound:busy', input: {}, read_mode: value.calendar_id==='organizer'?'events':'busy', access_role: value.calendar_id==='organizer'?'owner':'freeBusyReader', writable: value.calendar_id==='organizer',
    selection: { source_id: value.source_id, connection_id: value.connection_id, connected_at: value.connected_at, calendar_id: value.calendar_id },
    busy_source: { rows: ['busy'], max_rows: 1, fields: { starts_at: [['start']], ends_at: [['end']] } } })); } };
  const row = { start: '2026-10-15T10:00:00Z', end: '2026-10-15T10:30:00Z' };
  const workshop = { async run({tool_id}) { return { state: 'completed', output: tool_id==='bound:events'?{items:[]}:{busy: [row, row]} }; }, async snapshot() {} };
  const adapter = createNativeAvailabilityCalendar({ calendarOwner, workshop, settings, readEffectBinding: () => null, keepEffectBinding: () => null });
  const result = await adapter.readBusy({ link: { calendar: {...primary,calendar_id:'organizer'},cohosts:[{calendar:selection}] }, from_ms: Date.parse('2026-10-15T00:00:00Z'), to_ms: Date.parse('2026-10-16T00:00:00Z') });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.busy, []);
});

test('validateLink requires an exact writable primary incarnation and readable co-host roles', async () => {
  const { adapter } = fixture({ sourceFor: selection => ({ id: `source:${selection.connection_id}`, base_source: selection.source_id,
    tool: `bound:${selection.source_id}`, input: {}, read_mode: 'events', calendar_actions: {} }) });
  assert.equal(await adapter.validateLink({ calendar: primary, cohosts: [{ calendar: { ...cohost, access_role: 'reader' }, email: 'host@example.test' }] }), true);
  const { adapter: readOnlyPrimary } = fixture({ sourceFor: selection => ({ id: `source:${selection.connection_id}`, base_source: selection.source_id,
    tool: `bound:${selection.source_id}`, input: {}, read_mode: 'events', calendar_actions: {} }) });
  // The test fixture maps only owner to writable; a reader role cannot be the primary.
  await assert.rejects(readOnlyPrimary.validateLink({ calendar: { ...primary, access_role: 'reader' } }), /primary calendar is no longer writable/);
});

test('uncertain, missing-task and refused Workshop outcomes remain distinct', async () => {
  const link = { id: 'link:one', title: 'Coffee', calendar: primary, timezone: 'America/Los_Angeles' };
  const reservation = { id: 'reservation:one', start_ms: Date.parse('2026-10-15T10:00:00Z'), end_ms: Date.parse('2026-10-15T10:30:00Z') };
  const operation = { id: 'operation:one', kind: 'reserve', effect_input: { link, reservation } };
  const { adapter } = fixture({
    sourceFor: () => ({ id: primarySourceId, base_source: 'provider-a', tool: 'bound:events', input: {}, read_mode: 'events',
      calendar_actions: { create: { tool: 'tool:create', input_defaults: { calendar_id: 'primary' } } } }),
    snapshot: async () => ({ state: 'working', task_id: workshopTaskId({ tool_id: 'tool:create', request_key: `calendar:${primarySourceId}:create:availability:operation:one` }),
      tool_id: 'tool:create', request_key: `calendar:${primarySourceId}:create:availability:operation:one` }),
  });
  await adapter.effects.ensure({ operation, link, reservation, request_key: operation.id });
  assert.equal((await adapter.effects.reconcile({ operation, link, reservation })).state, 'pending');
  const refused = fixture({
    sourceFor: () => ({ id: primarySourceId, base_source: 'provider-a', tool: 'bound:events', input: {}, read_mode: 'events',
      calendar_actions: { create: { tool: 'tool:create', input_defaults: { calendar_id: 'primary' } } } }),
    run: async () => ({ state: 'refused', error: 'calendar capability is unavailable' }),
  });
  assert.equal((await refused.adapter.effects.ensure({ operation, link, reservation, request_key: operation.id })).state, 'refused');
  const thrown = fixture({
    sourceFor: () => ({ id: primarySourceId, base_source: 'provider-a', tool: 'bound:events', input: {}, read_mode: 'events',
      calendar_actions: { create: { tool: 'tool:create', input_defaults: { calendar_id: 'primary' } } } }),
    run: async () => { throw new Error('calendar capability unavailable after dispatch'); },
  });
  const thrownResult = await thrown.adapter.effects.ensure({ operation, link, reservation, request_key: operation.id });
  assert.equal(thrownResult.state, 'unknown', 'a thrown dispatch cannot prove that no effect happened');
});

test('crash after retaining a binding but before task admission recovers only explicit task absence', async () => {
  let missingTask;
  const {adapter,calls,bindings}=fixture({run:async input=>({task_id:workshopTaskId(input),state:'completed',output:{id:'event:recovered'}}),snapshot:async()=>{throw Object.assign(new Error('missing'),{code:'task-not-found',task_id:missingTask});}});
  const link={id:'link:one',title:'Coffee',calendar:primary,timezone:'America/Los_Angeles'},reservation={id:'reservation:one',start_ms:Date.parse('2026-10-15T10:00:00Z'),end_ms:Date.parse('2026-10-15T10:30:00Z')};
  const operation={id:'operation:retained-before-admission',kind:'reserve',effect_input:{link,reservation}};
  await adapter.effects.ensure({operation,link,reservation,request_key:operation.id});
  missingTask=bindings.get(operation.id).task_id;
  const before=structuredClone(bindings.get(operation.id));
  assert.equal((await adapter.effects.ensure({operation,link,reservation,request_key:operation.id})).state,'completed');
  assert.deepEqual(bindings.get(operation.id),before);
  assert.deepEqual(calls.filter(([kind])=>kind==='run').map(([,input])=>input),[calls.find(([kind])=>kind==='run')[1],calls.find(([kind])=>kind==='run')[1]]);
});

test('uncertain provider state wins over capability refusal language and never releases the hold',async()=>{
  const {adapter}=fixture({run:async()=>({state:'refused',error:'missing connection',effect:{state:'unknown'}})});
  const link={id:'link:one',title:'Coffee',calendar:primary,timezone:'America/Los_Angeles'},reservation={id:'reservation:one',start_ms:Date.parse('2026-10-15T10:00:00Z'),end_ms:Date.parse('2026-10-15T10:30:00Z')};
  const operation={id:'operation:uncertain-refusal',kind:'reserve',effect_input:{link,reservation}};
  assert.equal((await adapter.effects.ensure({operation,link,reservation,request_key:operation.id})).state,'unknown');
});

test('all-day busy uses the selected calendar zone and keeps the exclusive local end boundary', async () => {
  const settings = {sources:[{...exactSettings.sources[0],fields:{...exactSettings.sources[0].fields,starts_at:[['start','date']],ends_at:[['end','date']]}}]};
  const make = zone => createNativeAvailabilityCalendar({settings,calendarOwner:{invoke:async(_op,{selections})=>selections.map(selection=>({id:'exact',base_source:'provider-a',tool:'events',input:{},read_mode:'events',writable:true,access_role:'owner',selection,...(zone?{time_zone:zone}:{})}))},workshop:{run:async()=>({state:'completed',output:{items:[{id:'all-day',start:{date:'2026-10-15'},end:{date:'2026-10-16'}}]}}),snapshot:async()=>{}},readEffectBinding:()=>null,keepEffectBinding:()=>null});
  const range={link:{calendar:primary,timezone:'Asia/Tokyo'},from_ms:Date.parse('2026-10-15T00:00:00Z'),to_ms:Date.parse('2026-10-17T00:00:00Z')};
  assert.deepEqual(await make('America/Los_Angeles').readBusy(range),{status:'read',busy:[{startMs:Date.parse('2026-10-15T07:00:00Z'),endMs:Date.parse('2026-10-16T07:00:00Z')}]});
  const unknown=await make(null).readBusy(range);assert.equal(unknown.status,'unknown');assert.deepEqual(unknown.busy,[]);
  const invalid=await make('Not/AZone').readBusy(range);assert.equal(invalid.status,'unknown');assert.deepEqual(invalid.busy,[]);
});
test('calendar zone changing during an all-day read invalidates its entire busy result',async()=>{
 let reads=0;const settings={sources:[{...exactSettings.sources[0],fields:{starts_at:[['start','date']],ends_at:[['end','date']]}}]};
 const calendarOwner={invoke:async(_op,{selections})=>{reads++;return selections.map(selection=>({id:'exact',base_source:'provider-a',tool:'events',input:{},read_mode:'events',writable:true,access_role:'owner',selection,time_zone:reads>=3?'America/New_York':'America/Los_Angeles'}));}};
 const adapter=createNativeAvailabilityCalendar({settings,calendarOwner,workshop:{run:async()=>({state:'completed',output:{items:[{start:{date:'2026-10-15'},end:{date:'2026-10-16'}}]}}),snapshot:async()=>{}},readEffectBinding:()=>null,keepEffectBinding:()=>null});
 const result=await adapter.readBusy({link:{calendar:primary},from_ms:Date.parse('2026-10-15T00:00:00Z'),to_ms:Date.parse('2026-10-17T00:00:00Z')});assert.equal(result.status,'unknown');assert.deepEqual(result.busy,[]);assert.equal(result.error,'calendar-selection-changed-during-read');
});

test('a calendar timezone changing only at the provider read still invalidates busy', async () => {
  let reads = 0, dispatched = 0;
  const calendarOwner = { invoke: async (_op, { selections }) => {
    reads++;
    return selections.map(selection => ({ id: 'exact', base_source: 'provider-a', tool: 'events', input: {},
      read_mode: 'events', writable: true, access_role: 'owner', selection,
      time_zone: reads === 2 ? 'America/New_York' : 'America/Los_Angeles' }));
  } };
  const adapter = createNativeAvailabilityCalendar({ settings: exactSettings, calendarOwner,
    workshop: { run: async () => { dispatched++; return { state: 'completed', output: { items: [] } }; }, snapshot: async () => {} },
    readEffectBinding: () => null, keepEffectBinding: () => null });
  const result = await adapter.readBusy({ link: { calendar: primary }, from_ms: Date.parse('2026-10-15T00:00:00Z'),
    to_ms: Date.parse('2026-10-17T00:00:00Z') });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.busy, []);
  assert.equal(result.error, 'calendar-selection-changed-during-read');
  assert.equal(dispatched, 0);
});
