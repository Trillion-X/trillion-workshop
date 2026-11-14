import type { CalendarActionDescriptorTemplate, CalendarTimeBlock } from '../read-data/read-calendar-time-blocks';
import type { CalendarStatusTone } from '../read-data/read-calendar-accounts';
import {
  BUILTIN_VIEW_DESCRIPTORS,
  DEFAULT_VIEW_ID,
  type CalendarViewDescriptor,
} from '../read-data/read-calendar-view-descriptors';

// A view is DATA (a `calendar-view-descriptor` row), never a closed enum. `viewId`
// is an open string keyed against the descriptor list; the surface renders the
// picker from that list and dispatches the body through the geometry registry.
export type CalendarRenderMode = 'desktop' | 'mobile';
export type CalendarSurfaceState = 'empty-no-accounts' | 'empty-connected' | 'sparse' | 'dense' | 'loading' | 'error' | 'offline' | 'conflict';

export type CalendarAccountModel = {
  id: string;
  label: string;
  color: string;
  status: string;
  statusTone: CalendarStatusTone;
  statusLabel: string;
  visible: boolean;
  calendars: CalendarListModel[];
  actions: CalendarActionDescriptorTemplate[];
};

export type CalendarListModel = {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  readOnly?: boolean;
};

export type CalendarActionModel = CalendarActionDescriptorTemplate & {
  label: string;
  disabledReason?: string;
};

export type CalendarScreenModel = {
  state: CalendarSurfaceState;
  renderMode: CalendarRenderMode;
  /** Open view id; resolves to `activeView` against `viewDescriptors`. */
  viewId: string;
  /** The DATA-driven view set that feeds the picker (shipped rows + any live). */
  viewDescriptors: CalendarViewDescriptor[];
  /** The descriptor selected by `viewId` (or the first available). */
  activeView: CalendarViewDescriptor;
  timezone: string;
  title: string;
  dateLabel: string;
  rangeStart: string;
  rangeEnd: string;
  accounts: CalendarAccountModel[];
  blocks: CalendarTimeBlock[];
  allDayBlocks: CalendarTimeBlock[];
  timedBlocks: CalendarTimeBlock[];
  selectedBlockId: string | null;
  selectedBlock: CalendarTimeBlock | null;
  actions: CalendarActionModel[];
  issues: CalendarIssueModel[];
  availabilityBlocks: CalendarTimeBlock[];
  conflictBlocks: CalendarTimeBlock[];
  waitingBlocks: CalendarTimeBlock[];
};

export type CalendarIssueModel = {
  id: string;
  tone: 'info' | 'warning' | 'error' | 'success';
  label: string;
  detail?: string;
  action?: CalendarActionModel;
};

export type CalendarScreenInput = Partial<{
  state: CalendarSurfaceState;
  renderMode: CalendarRenderMode;
  viewId: string;
  viewDescriptors: CalendarViewDescriptor[];
  timezone: string;
  title: string;
  dateLabel: string;
  rangeStart: string;
  rangeEnd: string;
  accounts: CalendarAccountModel[];
  blocks: CalendarTimeBlock[];
  selectedBlockId: string | null;
  actions: CalendarActionModel[];
  issues: CalendarIssueModel[];
  serviceConnections: unknown;
}>;

const DEFAULT_RANGE_START = '2026-06-22T08:00:00.000Z';
const DEFAULT_RANGE_END = '2026-06-22T18:00:00.000Z';

const STATE_LABELS: Record<string, string> = {
  ready: 'Saved',
  available: 'Available',
  busy: 'Busy',
  tentative: 'Tentative',
  syncing: 'Syncing',
  'waiting-to-sync': 'Waiting to sync',
  error: 'Could not save',
  conflict: 'Resolve conflict',
  offline: 'Waiting to sync',
};

function isCalendarAction(value: unknown): value is CalendarActionModel {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as CalendarActionModel).id === 'string'
    && typeof (value as CalendarActionModel).target === 'string'
    && typeof (value as CalendarActionModel).definition_id === 'string';
}

type ServiceConnectionCursor = {
  rowCount: number;
  cellText(rowIndex: number, columnIndex: number): string | null;
};

type CalendarScopedConnection = {
  id: string;
  name: string;
  serviceVendor: string;
  status: string;
  scopes: string[];
};

const SERVICE_CONNECTION_COLUMNS = {
  id: 0,
  serviceName: 1,
  serviceVendor: 2,
  statusRef: 4,
  scopes: 5,
} as const;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCursor(value: unknown): value is ServiceConnectionCursor {
  return isRecordValue(value)
    && typeof value.rowCount === 'number'
    && typeof value.cellText === 'function';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function jsonList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    return jsonList(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function isCalendarScope(scope: string): boolean {
  return scope.toLowerCase().includes('calendar');
}

function isGoogleCalendarVendor(serviceVendor: string): boolean {
  return serviceVendor === 'google-account' || serviceVendor === 'google-calendar';
}

function hasCalendarCapability(scopes: readonly string[], serviceVendor: string): boolean {
  return scopes.some(isCalendarScope) || isGoogleCalendarVendor(serviceVendor);
}

function statusFromRef(statusRef: string, fallback: unknown): string {
  const status = text(fallback);
  if (status) return status;
  return statusRef === 'connection-status:connected' ? 'connected' : 'disconnected';
}

function calendarConnectionsFromCursor(cursor: ServiceConnectionCursor): CalendarScopedConnection[] {
  const rows: CalendarScopedConnection[] = [];
  for (let rowIndex = 0; rowIndex < cursor.rowCount; rowIndex += 1) {
    const scopes = jsonList(cursor.cellText(rowIndex, SERVICE_CONNECTION_COLUMNS.scopes));
    const statusRef = cursor.cellText(rowIndex, SERVICE_CONNECTION_COLUMNS.statusRef) ?? '';
    const status = statusFromRef(statusRef, '');
    const id = cursor.cellText(rowIndex, SERVICE_CONNECTION_COLUMNS.id) ?? '';
    const name = cursor.cellText(rowIndex, SERVICE_CONNECTION_COLUMNS.serviceName) ?? '';
    const serviceVendor = cursor.cellText(rowIndex, SERVICE_CONNECTION_COLUMNS.serviceVendor) ?? '';
    if (!id || !name || status !== 'connected' || !hasCalendarCapability(scopes, serviceVendor)) continue;
    rows.push({ id, name, serviceVendor, status, scopes });
  }
  return rows;
}

function calendarConnections(raw: unknown): CalendarScopedConnection[] {
  if (isCursor(raw)) return calendarConnectionsFromCursor(raw);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecordValue)
    .map((row): CalendarScopedConnection | null => {
      const scopes = jsonList(row.scopes);
      const status = statusFromRef(text(row.statusRef ?? row.status_ref), row.status);
      const id = text(row.id);
      const name = text(row.serviceName) || id;
      const serviceVendor = text(row.serviceVendor ?? row.service_vendor);
      if (!id || !name || status !== 'connected' || !hasCalendarCapability(scopes, serviceVendor)) return null;
      return { id, name, serviceVendor, status, scopes };
    })
    .filter((row): row is CalendarScopedConnection => !!row);
}

function accountsFromServiceConnections(raw: unknown): CalendarAccountModel[] {
  return calendarConnections(raw).map((connection, index) => {
    const color = ['#4285f4', '#34a853', '#fbbc05', '#ea4335'][index % 4];
    return {
      id: connection.id,
      label: connection.name,
      color,
      status: 'connected',
      statusTone: 'success' as const,
      statusLabel: 'Connected',
      visible: true,
      calendars: [
        {
          id: `${connection.id}:calendar:primary`,
          label: connection.name,
          color,
          visible: true,
        },
      ],
      actions: [],
    };
  });
}

function blockState(block: CalendarTimeBlock): string {
  return block.state.ref || 'ready';
}

export function labelForBlockState(state: string): string {
  return STATE_LABELS[state] ?? state.replace(/[-_]/g, ' ');
}

// A control is disabled when its owner action is missing or the owner action
// carries its own reason. Every disabled control returns a plain, human reason
// so a button is never silently dead. The reason is derived from what the
// surface can see (no connected account vs. an action that is not set up yet),
// not from a fixed list of control types.
export function calendarControlDisabledReason(
  action: CalendarActionModel | undefined,
  model: Pick<CalendarScreenModel, 'accounts'>,
): string {
  if (action) return action.disabledReason ?? '';
  if (model.accounts.length === 0) return 'Connect a calendar account first.';
  return 'This is not set up yet.';
}

export function isWaitingBlock(block: CalendarTimeBlock): boolean {
  const state = blockState(block);
  return state === 'waiting-to-sync' || state === 'offline' || state === 'syncing';
}

export function isConflictBlock(block: CalendarTimeBlock): boolean {
  return blockState(block) === 'conflict' || block.relations.conflict?.length > 0;
}

export function isAvailabilityBlock(block: CalendarTimeBlock): boolean {
  const state = blockState(block);
  return state === 'available' || state === 'busy';
}

export function createCalendarScreenModel(input: CalendarScreenInput = {}): CalendarScreenModel {
  const serviceAccounts = accountsFromServiceConnections(input.serviceConnections);
  const accounts = input.accounts && input.accounts.length > 0 ? input.accounts : serviceAccounts;
  const blocks = [...(input.blocks ?? [])].sort((left, right) =>
    left.interval.start.localeCompare(right.interval.start)
    || left.interval.end.localeCompare(right.interval.end)
    || left.id.localeCompare(right.id),
  );
  const allDayBlocks = blocks.filter((block) => block.interval.allDay);
  const timedBlocks = blocks.filter((block) => !block.interval.allDay);
  const conflictBlocks = blocks.filter(isConflictBlock);
  const waitingBlocks = blocks.filter(isWaitingBlock);
  const availabilityBlocks = blocks.filter(isAvailabilityBlock);
  const selectedBlock = blocks.find((block) => block.id === input.selectedBlockId) ?? blocks[0] ?? null;
  const actions = (input.actions ?? selectedBlock?.actions ?? [])
    .filter(isCalendarAction)
    .map((action) => ({ ...action, label: action.label ?? 'Use action' }));

  const explicitState = input.state === 'empty-no-accounts' && accounts.length > 0
    ? undefined
    : input.state;
  const derivedState: CalendarSurfaceState = explicitState
    ?? (accounts.length === 0 ? 'empty-no-accounts' : blocks.length === 0 ? 'empty-connected' : blocks.length > 6 ? 'dense' : 'sparse');
  const issues = (input.issues ?? []).filter((issue) => {
    // Once an account is connected, the "connect a calendar account" prompt is stale.
    if (accounts.length > 0 && issue.id === 'connect-calendar-account') return false;
    // With NO account connected, per-lens read failures ("… events could not load",
    // "N item(s) could not be shown") are noise for the same underlying cause: there is
    // nothing to reach yet. The single "connect an account" prompt already covers this
    // state, so suppress the read-failure issues to avoid stacking two banners.
    if (accounts.length === 0
      && (issue.id === 'calendar-lens-rows-skipped'
        || issue.id.startsWith('calendar-lens-read-failed'))) {
      return false;
    }
    return true;
  });

  // Views are DATA: use the supplied descriptor list (shipped rows unioned with
  // any live rows by the mount), falling back to the shipped set so the picker
  // and grid always paint. `activeView` is resolved by id, never by branch.
  const viewDescriptors = input.viewDescriptors && input.viewDescriptors.length > 0
    ? input.viewDescriptors
    : BUILTIN_VIEW_DESCRIPTORS;
  const requestedViewId = input.viewId ?? DEFAULT_VIEW_ID;
  const activeView = viewDescriptors.find((view) => view.view_id === requestedViewId)
    ?? viewDescriptors[0];

  return {
    state: derivedState,
    renderMode: input.renderMode ?? 'desktop',
    viewId: activeView.view_id,
    viewDescriptors,
    activeView,
    timezone: input.timezone ?? 'Local time',
    title: input.title ?? 'Calendar',
    dateLabel: input.dateLabel ?? 'Mon, Jun 22',
    rangeStart: input.rangeStart ?? DEFAULT_RANGE_START,
    rangeEnd: input.rangeEnd ?? DEFAULT_RANGE_END,
    accounts,
    blocks,
    allDayBlocks,
    timedBlocks,
    selectedBlockId: selectedBlock?.id ?? null,
    selectedBlock,
    actions,
    issues,
    availabilityBlocks,
    conflictBlocks,
    waitingBlocks,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createCalendarScreenModelFromLiveValue(
  value: unknown,
  serviceConnections?: unknown,
  viewDescriptors?: CalendarViewDescriptor[],
): CalendarScreenModel {
  if (Array.isArray(value)) {
    return createCalendarScreenModel({
      blocks: value.filter((item): item is CalendarTimeBlock => !!item && typeof item === 'object' && 'interval' in item),
      serviceConnections,
      viewDescriptors,
    });
  }

  const record = readRecord(value);
  return createCalendarScreenModel({
    state: record.state as CalendarSurfaceState | undefined,
    renderMode: record.renderMode as CalendarRenderMode | undefined,
    viewId: typeof record.viewId === 'string' ? record.viewId : undefined,
    viewDescriptors: viewDescriptors
      ?? (Array.isArray(record.viewDescriptors) ? record.viewDescriptors as CalendarViewDescriptor[] : undefined),
    timezone: typeof record.timezone === 'string' ? record.timezone : undefined,
    title: typeof record.title === 'string' ? record.title : undefined,
    dateLabel: typeof record.dateLabel === 'string' ? record.dateLabel : undefined,
    rangeStart: typeof record.rangeStart === 'string' ? record.rangeStart : undefined,
    rangeEnd: typeof record.rangeEnd === 'string' ? record.rangeEnd : undefined,
    accounts: Array.isArray(record.accounts) ? record.accounts as CalendarAccountModel[] : undefined,
    blocks: Array.isArray(record.blocks) ? record.blocks as CalendarTimeBlock[] : Array.isArray(record.timeBlocks) ? record.timeBlocks as CalendarTimeBlock[] : undefined,
    selectedBlockId: typeof record.selectedBlockId === 'string' ? record.selectedBlockId : null,
    actions: Array.isArray(record.actions) ? record.actions as CalendarActionModel[] : undefined,
    issues: Array.isArray(record.issues) ? record.issues as CalendarIssueModel[] : undefined,
    serviceConnections: record.serviceConnections ?? serviceConnections,
  });
}
