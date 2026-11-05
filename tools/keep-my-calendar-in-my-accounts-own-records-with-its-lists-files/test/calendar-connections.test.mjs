import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../src/calendar.json' with { type: 'json' };
import { readCalendar } from '../src/calendar.mjs';
import {
  buildCalendarSources,
  calendarConnectionLimits,
  calendarSelectionSourceId,
  listSelectableCalendars,
  validateCalendarRouteChoice,
  validateCalendarSelections,
} from '../src/calendar-connections.mjs';

const connectedAt = '2026-10-12T12:00:00.000Z';
const account = (overrides = {}) => ({
  connection_id: 'service_connection:google-calendar:personal',
  vendor: 'google-calendar', service: 'Google Calendar', account_label: 'Personal',
  status: 'connected', can_send: true, connected_at: connectedAt, ...overrides,
});
const calendar = (id, accessRole = 'writer', overrides = {}) => ({ id, summary: id, accessRole, ...overrides });

test('calendar discovery binds each exact connected account and follows every page', async () => {
  const bound = [];
  const calls = [];
  const result = await listSelectableCalendars({
    connections: async () => ({ connections: [account(), account({ connection_id: 'service_connection:google-calendar:away', status: 'away' }), account({ connection_id: 'service_connection:google-account', vendor: 'google-account' })] }),
    bind: async (...args) => { bound.push(args); return `bound:${args[0]}:${args[1].connection_id}`; },
    runTool: async (...args) => {
      calls.push(args);
      if (args[0].includes('list_colors')) return { state: 'completed', output: { event: { '7': { background: '#46d6db', foreground: '#1d1d1d' } } } };
      return args[1].page_token
        ? { state: 'completed', output: { items: [calendar('team', 'owner', { primary: true, timeZone: 'America/Los_Angeles' })] } }
        : { state: 'completed', output: { items: [calendar('read-only', 'reader'), calendar('busy-only', 'freeBusyReader'), calendar('personal')], nextPageToken: 'next' } };
    },
  });
  assert.deepEqual(bound, ['tool:google-calendar-list_calendars', 'tool:google-calendar-list_colors'].map(tool => [tool, { connection_id: account().connection_id, connected_at: connectedAt }]));
  assert.equal(calls.length, 3);
  assert.equal(calls[1][1].page_token, 'next');
  assert.deepEqual(result, { accounts: [{
    source_id: 'google-calendar', provider_vendor: 'google-calendar',
    connection_id: account().connection_id, account_label: 'Personal', connected_at: connectedAt,
    event_colors: [{ value: '7', label: 'Color 7', color: '#46d6db' }],
    calendars: [
      { id: 'team', summary: 'team', primary: true, access_role: 'owner', writable: true, read_mode: 'events', time_zone: 'America/Los_Angeles' },
      { id: 'busy-only', summary: 'busy-only', access_role: 'freeBusyReader', writable: false, read_mode: 'busy' },
      { id: 'personal', summary: 'personal', access_role: 'writer', writable: true, read_mode: 'events' },
      { id: 'read-only', summary: 'read-only', access_role: 'reader', writable: false, read_mode: 'events' },
    ],
  }] });
});

test('failed optional palette reads preserve readable calendars and never offer guessed colors', async () => {
  const found = await listSelectableCalendars({
    connections: async () => [account()], bind: async tool => tool,
    runTool: async tool => tool.endsWith('list_colors') ? { state: 'failed' }
      : { state: 'completed', output: { items: [calendar('primary', 'owner')] } },
  });
  assert.equal(found.accounts[0].unavailable, undefined);
  assert.equal(found.accounts[0].event_colors_unavailable, true);
  assert.equal(found.accounts[0].calendars[0].id, 'primary');
  assert.equal(found.accounts[0].event_colors, undefined);
});

test('event palette choices include only provider-declared color IDs and valid RGB values', async () => {
  const found = await listSelectableCalendars({
    connections: async () => [account()], bind: async tool => tool,
    runTool: async tool => tool.endsWith('list_colors')
      ? { state: 'completed', output: { event: {
        '7': { background: '#46d6db' }, '12': { background: '#aa00ff' },
        bogus: { background: '#aabbcc' }, '8': { background: 'url(unsafe)' },
      } } }
      : { state: 'completed', output: { items: [calendar('primary', 'owner')] } },
  });
  assert.deepEqual(found.accounts[0].event_colors, [{ value: '7', label: 'Color 7', color: '#46d6db' }]);
});

test('selected writable calendars use only their current account palette while readers retain display colors', async () => {
  const index = { accounts: [{ connection_id: account().connection_id, connected_at: connectedAt, account_label: 'Personal',
    event_colors: [{ value: '7', label: 'Color 7', color: '#46d6db' }],
    calendars: [{ id: 'write', summary: 'Write', access_role: 'owner' }, { id: 'read', summary: 'Read', access_role: 'reader' }] }] };
  const built = await buildCalendarSources({ selections: ['write', 'read'].map(calendar_id => ({ connection_id: account().connection_id, calendar_id })),
    accountIndex: index, io: { bind: async tool => tool } });
  assert.equal(built[0].event_properties.color.choices.at(-1).color, '#46d6db');
  assert.deepEqual(built[1].event_colors, index.accounts[0].event_colors);
  assert.equal(built[1].event_properties, undefined);
  assert.deepEqual(built[1].calendar_actions, {});
});

test('calendar discovery fails closed for incomplete or failed account reads', async () => {
  const io = {
    connections: async () => [account()], bind: async () => 'bound',
    runTool: async () => ({ state: 'failed', output: { items: [] } }),
  };
  assert.equal((await listSelectableCalendars(io)).accounts[0].unavailable, true);
  assert.equal((await listSelectableCalendars({ ...io, runTool: async () => ({ state: 'completed', output: { items: [], nextPageToken: 'loop' } }) })).accounts[0].unavailable, true);
});

test('selection validation requires a current connected account and writable calendar', () => {
  const index = { accounts: [{
    connection_id: account().connection_id, account_label: 'Personal', connected_at: connectedAt,
    calendars: [{ id: 'primary', summary: 'Primary', access_role: 'owner' }, { id: 'read', summary: 'Read', access_role: 'reader' }],
  }] };
  assert.deepEqual(validateCalendarSelections([{ connection_id: account().connection_id, calendar_id: 'primary' }], index), [{
    source_id: 'google-calendar', connection_id: account().connection_id, connected_at: connectedAt, calendar_id: 'primary',
    account_label: 'Personal', calendar_label: 'Primary', access_role: 'owner',
  }]);
  assert.equal(validateCalendarSelections([{ connection_id: account().connection_id, calendar_id: 'read' }], index)[0].access_role, 'reader');
  assert.throws(() => validateCalendarSelections([{ connection_id: 'service_connection:google-calendar:gone', calendar_id: 'primary' }], index), /no longer connected/);
  assert.throws(() => validateCalendarSelections(Array.from({ length: calendarConnectionLimits.max_selections + 1 }, (_, i) => ({ connection_id: account().connection_id, calendar_id: String(i) })), index), /at most/);
});

test('selected sources bind reads and writes to the exact account and calendar', async () => {
  const index = { accounts: [{
    connection_id: account().connection_id, account_label: 'Personal', connected_at: connectedAt,
    calendars: [{ id: 'primary', summary: 'Personal Calendar', access_role: 'owner' }],
  }] };
  const bound = [];
  const io = { bind: async (tool, binding) => { bound.push([tool, binding]); return `bound:${tool}`; } };
  const [source] = await buildCalendarSources({
    selections: [{ connection_id: account().connection_id, calendar_id: 'primary' }], accountIndex: index, io, settings,
  });
  assert.equal(source.id, calendarSelectionSourceId({ connection_id: account().connection_id, calendar_id: 'primary' }));
  assert.equal(source.base_source, 'google-calendar');
  assert.deepEqual(source.selection, { source_id: 'google-calendar', connection_id: account().connection_id, connected_at: connectedAt, calendar_id: 'primary' });
  assert.equal(source.input.calendar_id, 'primary');
  assert.equal(source.calendar_actions.create.input_defaults.calendar_id, 'primary');
  assert.equal(source.tool, 'bound:tool:google-calendar-list_events_between');
  assert.equal(bound.length, 1 + Object.keys(settings.sources.find(row => row.id === 'google-calendar').calendar_actions).length);
  assert.ok(bound.every(([, binding]) => binding.connection_id === account().connection_id && binding.connected_at === connectedAt));
  assert.equal(validateCalendarRouteChoice({ source_id: source.id, connection_id: source.selection.connection_id, calendar_id: source.selection.calendar_id }, [source]), source);
  assert.throws(() => validateCalendarRouteChoice({ source_id: source.id, connection_id: source.selection.connection_id, calendar_id: 'other' }, [source]), /does not match/);
});

test('selected source timezone comes from its exact current calendar metadata', async () => {
  const selection = { connection_id: account().connection_id, calendar_id: 'primary' };
  const build = (time_zone) => buildCalendarSources({ selections: [selection], settings,
    accountIndex: { accounts: [{ connection_id: selection.connection_id, connected_at: connectedAt,
      account_label: 'Personal', calendars: [
        { id: 'other', summary: 'Other', access_role: 'owner', time_zone: 'Asia/Tokyo' },
        { id: 'primary', summary: 'Primary', access_role: 'owner', ...(time_zone ? { time_zone } : {}) },
      ] }] }, io: { bind: async tool => tool } });
  assert.equal((await build('America/Los_Angeles'))[0].time_zone, 'America/Los_Angeles');
  assert.equal((await build('America/New_York'))[0].time_zone, 'America/New_York');
  assert.equal((await build(undefined))[0].time_zone, undefined);
});

test('a disconnected selection and an old account incarnation fail closed without hiding a healthy sibling', async () => {
  const healthyId = 'service_connection:google-calendar:work';
  const currentAt = '2026-10-12T13:00:00.000Z';
  const index = { accounts: [{
    connection_id: healthyId, account_label: 'Work', connected_at: currentAt,
    calendars: [{ id: 'team', summary: 'Team', access_role: 'writer' }],
  }, { connection_id: healthyId + '-old', account_label: 'Old', connected_at: currentAt, calendars: [{ id: 'team', summary: 'Team', access_role: 'writer' }] }] };
  const bound = [];
  const sources = await buildCalendarSources({
    selections: [
      { connection_id: account().connection_id, calendar_id: 'primary', connected_at: connectedAt },
      { connection_id: healthyId, calendar_id: 'team' },
      { connection_id: healthyId + '-old', calendar_id: 'team', connected_at: '2026-10-11T13:00:00.000Z' },
    ],
    accountIndex: index,
    settings,
    io: { bind: async (tool, binding) => { bound.push([tool, binding]); return `bound:${tool}`; } },
  });
  assert.equal(sources[0].unavailable, true);
  assert.equal(sources[0].writable, false);
  assert.deepEqual(sources[0].calendar_actions, {});
  assert.deepEqual(sources[0].actions, []);
  assert.equal(sources[1].unavailable, undefined);
  assert.equal(sources[1].writable, true);
  assert.equal(sources[2].unavailable, true);
  assert.ok(bound.every(([, binding]) => binding.connection_id === healthyId && binding.connected_at === currentAt));

  const readCalls = [];
  const result = await readCalendar({ from: '2026-10-12T00:00:00Z', to: '2026-10-13T00:00:00Z' }, {
    sources, now: () => 0,
    runTool: async (...args) => { readCalls.push(args); return { state: 'completed', output: { items: [] } }; },
  });
  assert.equal(readCalls.length, 1);
  assert.deepEqual(result.sources.map(({ read, complete }) => [read, complete]), [[false, false], [true, true], [false, false]]);
  assert.deepEqual(result.sources[0].calendar_actions, {});
  assert.deepEqual(result.sources[0].actions, []);
});

test('reader and busy-only calendars contribute conflicts without writable actions', async () => {
  const accountId = account().connection_id;
  const index = { accounts: [{
    connection_id: accountId, account_label: 'Personal', connected_at: connectedAt,
    calendars: [
      { id: 'read', summary: 'Read only', access_role: 'reader' },
      { id: 'busy', summary: 'Busy only', access_role: 'freeBusyReader' },
    ],
  }] };
  const bound = [];
  const sources = await buildCalendarSources({
    selections: [{ connection_id: accountId, calendar_id: 'read' }, { connection_id: accountId, calendar_id: 'busy' }],
    accountIndex: index, settings,
    io: { bind: async (tool, binding) => { bound.push([tool, binding]); return `bound:${tool}`; } },
  });
  assert.equal(sources[0].writable, false);
  assert.deepEqual(sources[0].calendar_actions, {});
  assert.deepEqual(sources[0].actions, []);
  assert.equal('move' in sources[0], false);
  assert.equal(sources[1].unavailable, undefined);
  assert.equal(sources[1].writable, false);
  assert.deepEqual(sources[1].calendar_actions, {});
  assert.deepEqual(sources[1].actions, []);
  assert.equal(bound.length, 2);
  assert.equal(sources[1].tool, 'bound:tool:google-calendar-read_busy_times');
  const result = await readCalendar({ from: '2026-10-12T00:00:00Z', to: '2026-10-13T00:00:00Z' }, {
    sources, runTool: async tool => ({ state: 'completed', output: tool.includes('busy_times') ? { calendars: { busy: { busy: [{ start: '2026-10-12T09:00:00Z', end: '2026-10-12T10:00:00Z' }] } } } : { items: [] } }),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Busy');
  assert.equal(result.items[0].may_move, false);
  assert.ok(result.sources.every(source => source.complete));
  const refused = await readCalendar({ from: '2026-10-12T00:00:00Z', to: '2026-10-13T00:00:00Z' }, {
    sources: [sources[1]], runTool: async () => ({ state: 'completed', output: { calendars: { busy: { busy: [], errors: [{ reason: 'notFound' }] } } } }),
  });
  assert.equal(refused.sources[0].complete, false);
});

test('unset selections retain the primary source; an explicit empty selection means none', async () => {
  const io = { bind: async tool => tool };
  const fallback = await buildCalendarSources({ selections: undefined, settings, io });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].id, 'google-calendar');
  assert.deepEqual(await buildCalendarSources({ selections: [], settings, io }), []);
  assert.throws(() => validateCalendarRouteChoice({ source_id: 'google-calendar', connection_id: 'other' }, fallback), /cannot be redirected/);
});


test('one revoked account calendar-list request leaves the healthy account selectable', async () => {
 const result = await listSelectableCalendars({ connections: async () => [account(), account({ connection_id: 'work' })], bind: async (_tool, binding) => binding.connection_id, runTool: async tool => tool === 'work' ? { state: 'completed', output: { items: [calendar('team')] } } : { state: 'failed' } });
 assert.equal(result.accounts.find(row => row.connection_id === 'work').calendars.length, 1);
 assert.equal(result.accounts.find(row => row.connection_id !== 'work').unavailable, true);
});

test('provider declarations supply vendor, tools, roles, and resource paths without provider branches', async () => {
  const googleSource = structuredClone(settings.sources.find(row => row.id === 'google-calendar'));
  const source = structuredClone(googleSource);
  source.id = 'team-calendar';
  source.input = { resource_id: 'default', time_min: '{from}', time_max: '{to}' };
  source.calendar_actions = { create: { tool: 'tool:team-create', input_defaults: { resource_id: 'default' } } };
  source.calendar_connection = {
    ...source.calendar_connection,
    source_id: 'team-calendar', vendor: 'team-calendar', label: 'Team Calendar',
    tools: { list_calendars: 'tool:team-list', list_events: 'tool:team-events' },
    readable_roles: ['admin', 'edit', 'view'], writable_roles: ['admin', 'edit'],
    calendar_id_path: ['resourceKey'], calendar_access_role_path: ['permission'],
    calendar_label_path: ['name'], calendar_primary_path: ['isDefault'], calendar_time_zone_path: ['timezone'],
    calendar_id_input_field: 'resource_id', items_path: ['results'], next_page_path: ['next'], page_input_field: 'cursor',
  };
  const mixedSettings = { ...settings, sources: [googleSource, source] };
  const bound = [];
  let connectionReads = 0;
  const io = {
    connections: async () => { connectionReads += 1; return [
      account(),
      account({ connection_id: 'service_connection:team-calendar:work', vendor: 'team-calendar', service: 'Team Calendar' }),
    ]; },
    bind: async (tool, binding) => { bound.push([tool, binding]); return `${tool}:${binding.connection_id}`; },
    runTool: async tool => ({ state: 'completed', output: tool.startsWith('tool:team-list:')
      ? { results: [{ resourceKey: 'workspace-calendar', permission: 'admin', name: 'Planning', isDefault: true, timezone: 'UTC' }] }
      : { items: [{ id: 'primary', accessRole: 'owner', summary: 'Personal' }] } }),
  };
  const mixed = await listSelectableCalendars(io, mixedSettings);
  assert.equal(connectionReads, 1);
  assert.equal(mixed.accounts.length, 2);
  const google = mixed.accounts.find(row => row.provider_vendor === 'google-calendar');
  const team = mixed.accounts.find(row => row.provider_vendor === 'team-calendar');
  assert.equal(google.source_id, 'google-calendar');
  assert.equal(google.calendars[0].id, 'primary');
  assert.equal(team.source_id, 'team-calendar');
  assert.equal(team.connection_id, 'service_connection:team-calendar:work');
  assert.deepEqual(team.calendars[0], {
    id: 'workspace-calendar',
    summary: 'Planning', primary: true, access_role: 'admin', writable: true, read_mode: 'events', time_zone: 'UTC',
  });
  assert.ok(bound.some(([tool]) => tool === 'tool:team-list'));
  assert.ok(bound.some(([tool]) => tool === 'tool:google-calendar-list_calendars'));
  assert.deepEqual((await buildCalendarSources({ selections: null, settings: mixedSettings, io: {} })).map(row => row.id), ['google-calendar', 'team-calendar']);
  const teamAccount = team;
  const selectedBound = [];
  const selections = await buildCalendarSources({
    selections: [
      { source_id: 'google-calendar', connection_id: google.connection_id, connected_at: connectedAt, calendar_id: 'primary' },
      { source_id: 'team-calendar', connection_id: teamAccount.connection_id, connected_at: connectedAt, calendar_id: 'workspace-calendar' },
      { source_id: 'google-calendar', connection_id: google.connection_id, connected_at: '2026-10-11T12:00:00.000Z', calendar_id: 'stale-primary' },
    ],
    accountIndex: mixed, settings: mixedSettings,
    io: { bind: async (tool, binding) => { selectedBound.push([tool, binding]); return `bound:${tool}:${binding.connection_id}`; } },
  });
  assert.equal(selections[0].base_source, 'google-calendar');
  assert.equal(selections[1].base_source, 'team-calendar');
  assert.equal(selections[1].selection.source_id, 'team-calendar');
  assert.equal(selections[0].input.calendar_id, 'primary');
  assert.equal(selections[1].input.resource_id, 'workspace-calendar');
  assert.equal(selections[1].input.calendar_id, undefined);
  assert.equal(selections[2].unavailable, true);
  assert.equal(selections[2].base_source, 'google-calendar');
  assert.equal(selections[2].selection.source_id, 'google-calendar');
  assert.ok(selectedBound.some(([tool, binding]) => tool === 'tool:google-calendar-list_events_between' && binding.connection_id === google.connection_id));
  assert.ok(selectedBound.some(([tool, binding]) => tool === 'tool:team-events' && binding.connection_id === teamAccount.connection_id));
  assert.ok(selectedBound.some(([tool, binding]) => tool === 'tool:team-create' && binding.connection_id === teamAccount.connection_id));
  assert.ok(selectedBound.every(([, binding]) => binding.connected_at === connectedAt));
});
