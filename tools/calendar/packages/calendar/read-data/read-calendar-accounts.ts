import {
  asCalendarBoolean,
  asCalendarText,
  readCalendarSelector,
  rowsFromCalendarFeed,
  type CalendarActionDescriptorTemplate,
  type CalendarRow,
  type CalendarSelector,
} from './read-calendar-time-blocks';

export type CalendarStatusTone =
  | 'success'
  | 'warning'
  | 'error'
  | 'destructive'
  | 'info'
  | 'accent'
  | 'neutral'
  | 'secondary'
  | 'muted'
  | 'muted-outline';

export type CalendarAccountLens = {
  kind: 'calendar-account-lens';
  lens_id: string;
  input_address: string;
  selectors: {
    identity: CalendarSelector;
    label: CalendarSelector;
    color?: CalendarSelector;
    status?: CalendarSelector;
    status_tone?: CalendarSelector;
    status_label?: CalendarSelector;
    visible?: CalendarSelector;
    calendars?: CalendarSelector;
  };
  actions?: CalendarActionDescriptorTemplate[];
};

export type CalendarListProjection = {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  readOnly?: boolean;
};

export type CalendarAccountProjection = {
  id: string;
  label: string;
  color: string;
  status: string;
  statusTone: CalendarStatusTone;
  statusLabel: string;
  visible: boolean;
  calendars: CalendarListProjection[];
  actions: CalendarActionDescriptorTemplate[];
};

export type CalendarAccountReadResult = {
  accounts: CalendarAccountProjection[];
  diagnostics: {
    lensCount: number;
    rowCount: number;
    skippedRowCount: number;
  };
};

const STATUS_TONES = new Set<CalendarStatusTone>([
  'success',
  'warning',
  'error',
  'destructive',
  'info',
  'accent',
  'neutral',
  'secondary',
  'muted',
  'muted-outline',
]);

function actionTemplates(actions: CalendarActionDescriptorTemplate[] | undefined): CalendarActionDescriptorTemplate[] {
  return Array.isArray(actions) ? actions.map((action) => ({ ...action })) : [];
}

function tone(value: unknown): CalendarStatusTone {
  const candidate = asCalendarText(value, 'neutral') as CalendarStatusTone;
  return STATUS_TONES.has(candidate) ? candidate : 'neutral';
}

function projectedCalendars(raw: unknown, account: Pick<CalendarAccountProjection, 'id' | 'label' | 'color' | 'visible'>): CalendarListProjection[] {
  const rows = Array.isArray(raw) ? raw : [];
  const calendars = rows
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      id: asCalendarText(item.id),
      label: asCalendarText(item.label),
      color: asCalendarText(item.color, account.color),
      visible: asCalendarBoolean(item.visible ?? account.visible),
      readOnly: asCalendarBoolean(item.readOnly ?? item.read_only),
    }))
    .filter((item) => item.id && item.label);

  return calendars.length > 0
    ? calendars
    : [{ id: `${account.id}:primary`, label: account.label, color: account.color, visible: account.visible }];
}

export function projectCalendarAccount(
  lens: CalendarAccountLens,
  row: CalendarRow,
): CalendarAccountProjection | null {
  const id = asCalendarText(readCalendarSelector(row, lens.selectors.identity));
  const label = asCalendarText(readCalendarSelector(row, lens.selectors.label), id);
  if (!id || !label) return null;

  const account = {
    id,
    label,
    color: asCalendarText(readCalendarSelector(row, lens.selectors.color), ''),
    status: asCalendarText(readCalendarSelector(row, lens.selectors.status), 'connected'),
    statusTone: tone(readCalendarSelector(row, lens.selectors.status_tone)),
    statusLabel: asCalendarText(readCalendarSelector(row, lens.selectors.status_label), 'Connected'),
    visible: asCalendarBoolean(readCalendarSelector(row, lens.selectors.visible) ?? true),
    actions: actionTemplates(lens.actions),
  };

  return {
    ...account,
    calendars: projectedCalendars(readCalendarSelector(row, lens.selectors.calendars), account),
  };
}

export function readCalendarAccounts(
  lenses: CalendarAccountLens[],
  feedsByAddress: Record<string, unknown>,
): CalendarAccountReadResult {
  const accounts: CalendarAccountProjection[] = [];
  let rowCount = 0;
  let skippedRowCount = 0;

  for (const lens of lenses) {
    const rows = rowsFromCalendarFeed(feedsByAddress[lens.input_address]);
    rowCount += rows.length;
    for (const row of rows) {
      const account = projectCalendarAccount(lens, row);
      if (account) accounts.push(account);
      else skippedRowCount += 1;
    }
  }

  accounts.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));

  return {
    accounts,
    diagnostics: {
      lensCount: lenses.length,
      rowCount,
      skippedRowCount,
    },
  };
}
