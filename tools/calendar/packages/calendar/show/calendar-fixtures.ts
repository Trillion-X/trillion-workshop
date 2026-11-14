import { createCalendarScreenModel, type CalendarAccountModel, type CalendarScreenModel, type CalendarSurfaceState } from './calendar-screen-model';
import type { CalendarTimeBlock } from '../read-data/read-calendar-time-blocks';

const action = (id: string, label: string) => ({
  id,
  label,
  target: 'slot::workflow',
  definition_id: `action:calendar.${id}`,
});

const accounts: CalendarAccountModel[] = [
  {
    id: 'account-personal',
    label: 'Personal',
    color: '#2563eb',
    status: 'connected',
    visible: true,
    calendars: [
      { id: 'home', label: 'Home', color: '#2563eb', visible: true },
      { id: 'family', label: 'Family', color: '#0f766e', visible: true },
    ],
    actions: [action('manage-accounts', 'Manage accounts')],
  },
  {
    id: 'account-work',
    label: 'Work',
    color: '#7c3aed',
    status: 'syncing',
    visible: true,
    calendars: [
      { id: 'focus', label: 'Focus', color: '#7c3aed', visible: true },
      { id: 'team', label: 'Team', color: '#d97706', visible: true, readOnly: true },
    ],
    actions: [action('retry-sync', 'Retry sync')],
  },
];

function block(id: string, start: string, end: string, title: string, state = 'ready', color = '#2563eb', relations: Record<string, string[]> = {}): CalendarTimeBlock {
  return {
    id,
    source: {
      lensId: 'fixture',
      inputAddress: 'calendar.fixture',
      ownerRef: 'fixture',
      rowRef: id,
    },
    interval: {
      start,
      end,
      allDay: false,
      timezone: 'America/Chicago',
    },
    display: {
      title,
      color,
      ownerLabel: 'Calendar',
    },
    state: {
      ref: state,
      lane: relations.account?.[0] ?? 'default',
    },
    relations,
    actions: [
      action('move', 'Move'),
      action('resize', 'Resize'),
      action('details', 'Details'),
    ],
  };
}

const sparseBlocks = [
  block('calendar:event:planning', '2026-06-22T14:00:00.000Z', '2026-06-22T15:00:00.000Z', 'Planning review', 'ready', '#2563eb', {
    account: ['account-personal'],
    linkedRecord: ['task:launch-plan'],
  }),
];

const denseBlocks = [
  block('calendar:event:standup', '2026-06-22T13:00:00.000Z', '2026-06-22T13:30:00.000Z', 'Team standup', 'ready', '#7c3aed', { account: ['account-work'] }),
  block('calendar:event:review', '2026-06-22T13:15:00.000Z', '2026-06-22T14:10:00.000Z', 'Review notes', 'ready', '#d97706', { account: ['account-work'] }),
  block('calendar:event:planning', '2026-06-22T14:00:00.000Z', '2026-06-22T15:00:00.000Z', 'Planning review', 'ready', '#2563eb', { linkedRecord: ['task:launch-plan'] }),
  block('calendar:task:write', '2026-06-22T15:00:00.000Z', '2026-06-22T15:45:00.000Z', 'Write follow-up task', 'tentative', '#0f766e', { linkedRecord: ['task:follow-up'] }),
  block('calendar:audio-note:clip', '2026-06-22T16:00:00.000Z', '2026-06-22T16:20:00.000Z', 'Audio note task', 'ready', '#0891b2', { linkedRecord: ['audio-note:lesson'] }),
  block('calendar:availability:window', '2026-06-22T17:00:00.000Z', '2026-06-22T17:45:00.000Z', 'Available', 'available', '#16a34a'),
  block('calendar:booking:hold', '2026-06-22T17:30:00.000Z', '2026-06-22T18:00:00.000Z', 'Booking hold', 'busy', '#db2777'),
];

const loadingBlocks = [
  block('calendar:loading:one', '2026-06-22T14:00:00.000Z', '2026-06-22T15:00:00.000Z', 'Loading events', 'syncing', '#64748b'),
];

const errorBlocks = [
  block('calendar:error:save', '2026-06-22T14:00:00.000Z', '2026-06-22T15:00:00.000Z', 'Could not save', 'error', '#dc2626'),
];

const offlineBlocks = [
  block('calendar:offline:move', '2026-06-22T14:30:00.000Z', '2026-06-22T15:30:00.000Z', 'Waiting to sync', 'waiting-to-sync', '#d97706'),
];

const conflictBlocks = [
  block('calendar:conflict:move', '2026-06-22T14:30:00.000Z', '2026-06-22T15:30:00.000Z', 'Resolve conflict', 'conflict', '#dc2626', {
    originalInterval: ['2026-06-22T13:30:00.000Z', '2026-06-22T14:30:00.000Z'],
    affectedBlock: ['calendar:event:planning'],
  }),
];

const issueByState: Partial<Record<CalendarSurfaceState, Parameters<typeof createCalendarScreenModel>[0]['issues']>> = {
  loading: [{ id: 'loading-events', tone: 'info', label: 'Loading calendars', detail: 'Checking event changes and availability.' }],
  error: [{ id: 'save-error', tone: 'error', label: 'Could not save', detail: 'Keep the item visible and retry when ready.', action: action('retry-sync', 'Retry sync') }],
  offline: [{ id: 'offline', tone: 'warning', label: 'Waiting to sync', detail: 'Edits stay visible until sync confirms.', action: action('retry-sync', 'Retry sync') }],
  conflict: [{ id: 'conflict', tone: 'error', label: 'Resolve conflict', detail: 'Compare the original time with the proposed time.', action: action('resolve-conflict', 'Resolve conflict') }],
};

export const calendarFixtures: Record<CalendarSurfaceState | 'mobile' | 'desktop', CalendarScreenModel> = {
  'empty-no-accounts': createCalendarScreenModel({
    state: 'empty-no-accounts',
    accounts: [],
    blocks: [],
    actions: [action('connect-calendar', 'Connect calendar')],
  }),
  'empty-connected': createCalendarScreenModel({
    state: 'empty-connected',
    accounts,
    blocks: [],
    actions: [action('new-event', 'New event')],
  }),
  sparse: createCalendarScreenModel({
    state: 'sparse',
    accounts,
    blocks: sparseBlocks,
    selectedBlockId: sparseBlocks[0].id,
  }),
  dense: createCalendarScreenModel({
    state: 'dense',
    accounts,
    blocks: denseBlocks,
    selectedBlockId: denseBlocks[1].id,
    actions: [action('new-event', 'New event'), action('create-booking-link', 'Create booking link')],
  }),
  loading: createCalendarScreenModel({
    state: 'loading',
    accounts,
    blocks: loadingBlocks,
    issues: issueByState.loading,
  }),
  error: createCalendarScreenModel({
    state: 'error',
    accounts,
    blocks: errorBlocks,
    issues: issueByState.error,
  }),
  offline: createCalendarScreenModel({
    state: 'offline',
    accounts,
    blocks: offlineBlocks,
    issues: issueByState.offline,
  }),
  conflict: createCalendarScreenModel({
    state: 'conflict',
    accounts,
    blocks: [...sparseBlocks, ...conflictBlocks],
    selectedBlockId: conflictBlocks[0].id,
    issues: issueByState.conflict,
  }),
  mobile: createCalendarScreenModel({
    state: 'dense',
    renderMode: 'mobile',
    viewId: 'agenda',
    accounts,
    blocks: denseBlocks,
    selectedBlockId: denseBlocks[0].id,
    actions: [action('new-event', 'New event')],
  }),
  desktop: createCalendarScreenModel({
    state: 'dense',
    renderMode: 'desktop',
    viewId: 'week',
    accounts,
    blocks: denseBlocks,
    selectedBlockId: denseBlocks[1].id,
    actions: [action('new-event', 'New event'), action('create-booking-link', 'Create booking link')],
  }),
};
