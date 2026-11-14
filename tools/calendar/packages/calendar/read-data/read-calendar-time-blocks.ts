export type CalendarRow = Record<string, unknown>;

export type CalendarCursor = {
  rowCount: number;
  cellText(rowIndex: number, columnIndex: number): string | null;
};

export type CalendarSelector = string | string[] | {
  path?: string | string[];
  column?: number;
  /** Second path tried when the primary path yields nothing (e.g. an open-ended
   *  window whose `end` falls back to its `start`). Pure DATA — no source branch. */
  fallback_path?: string | string[];
  fallback?: unknown;
};

export type CalendarActionDescriptorTemplate = {
  id: string;
  label?: string;
  target: string;
  definition_id: string;
  input?: Record<string, CalendarSelector | unknown>;
};

export type CalendarTimeBlockLens = {
  kind: 'time-block-lens';
  lens_id: string;
  input_address: string;
  owner_ref: string;
  owner_label?: string;
  selectors: {
    identity: CalendarSelector;
    start: CalendarSelector;
    end: CalendarSelector;
    title?: CalendarSelector;
    all_day?: CalendarSelector;
    timezone?: CalendarSelector;
    color?: CalendarSelector;
    state?: CalendarSelector;
    lane?: CalendarSelector;
  };
  relations?: Record<string, CalendarSelector>;
  actions?: CalendarActionDescriptorTemplate[];
};

export type CalendarTimeBlock = {
  id: string;
  source: {
    lensId: string;
    inputAddress: string;
    ownerRef: string;
    rowRef: string;
  };
  interval: {
    start: string;
    end: string;
    allDay: boolean;
    timezone: string;
  };
  display: {
    title: string;
    color: string;
    ownerLabel: string;
  };
  state: {
    ref: string;
    lane: string;
  };
  relations: Record<string, string[]>;
  actions: CalendarActionDescriptorTemplate[];
};

export type CalendarTimeBlockReadResult = {
  blocks: CalendarTimeBlock[];
  diagnostics: {
    lensCount: number;
    rowCount: number;
    skippedRowCount: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCursor(value: unknown): value is CalendarCursor {
  return isRecord(value)
    && typeof value.rowCount === 'number'
    && typeof value.cellText === 'function';
}

function splitPath(path: string | string[]): string[] {
  return Array.isArray(path) ? path : path.split('.').filter(Boolean);
}

function parseCell(value: string): unknown {
  if (!value) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function getPathValue(row: CalendarRow, path: string | string[]): unknown {
  let current: unknown = row;
  for (const key of splitPath(path)) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function readCalendarSelector(row: CalendarRow, selector: CalendarSelector | undefined): unknown {
  if (!selector) return undefined;
  if (typeof selector === 'string' || Array.isArray(selector)) return getPathValue(row, selector);
  const selected = typeof selector.column === 'number'
    ? row[String(selector.column)]
    : selector.path
      ? getPathValue(row, selector.path)
      : undefined;
  if (selected !== undefined && selected !== null && selected !== '') return selected;
  if (selector.fallback_path) {
    const secondary = getPathValue(row, selector.fallback_path);
    if (secondary !== undefined && secondary !== null && secondary !== '') return secondary;
  }
  return selector.fallback;
}

export function asCalendarText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asCalendarBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return false;
}

export function asCalendarTextArray(value: unknown): string[] {
  if (typeof value === 'string') {
    if (!value) return [];
    try {
      return asCalendarTextArray(JSON.parse(value) as unknown);
    } catch {
      return [value];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asCalendarText(item))
    .filter(Boolean);
}

export function rowsFromCalendarFeed(feed: unknown): CalendarRow[] {
  if (Array.isArray(feed)) return feed.filter(isRecord);
  if (!isCursor(feed)) return [];

  const rows: CalendarRow[] = [];
  for (let rowIndex = 0; rowIndex < feed.rowCount; rowIndex += 1) {
    const row: CalendarRow = {};
    for (let columnIndex = 0; ; columnIndex += 1) {
      const text = feed.cellText(rowIndex, columnIndex);
      if (text === null && columnIndex > 64) break;
      row[String(columnIndex)] = parseCell(text ?? '');
      if (columnIndex > 64) break;
    }
    rows.push(row);
  }
  return rows;
}

function actionTemplates(actions: CalendarActionDescriptorTemplate[] | undefined): CalendarActionDescriptorTemplate[] {
  return Array.isArray(actions) ? actions.map((action) => ({ ...action })) : [];
}

export function projectCalendarTimeBlock(
  lens: CalendarTimeBlockLens,
  row: CalendarRow,
): CalendarTimeBlock | null {
  const rowRef = asCalendarText(readCalendarSelector(row, lens.selectors.identity));
  const start = asCalendarText(readCalendarSelector(row, lens.selectors.start));
  const end = asCalendarText(readCalendarSelector(row, lens.selectors.end));
  if (!rowRef || !start || !end) return null;

  const relations = Object.fromEntries(
    Object.entries(lens.relations ?? {}).map(([key, selector]) => [
      key,
      asCalendarTextArray(readCalendarSelector(row, selector)),
    ]),
  );

  return {
    id: `${lens.owner_ref}:${lens.lens_id}:${rowRef}`,
    source: {
      lensId: lens.lens_id,
      inputAddress: lens.input_address,
      ownerRef: lens.owner_ref,
      rowRef,
    },
    interval: {
      start,
      end,
      allDay: asCalendarBoolean(readCalendarSelector(row, lens.selectors.all_day)),
      timezone: asCalendarText(readCalendarSelector(row, lens.selectors.timezone), 'local'),
    },
    display: {
      title: asCalendarText(readCalendarSelector(row, lens.selectors.title), 'Untitled'),
      color: asCalendarText(readCalendarSelector(row, lens.selectors.color), ''),
      ownerLabel: lens.owner_label ?? lens.owner_ref,
    },
    state: {
      ref: asCalendarText(readCalendarSelector(row, lens.selectors.state), 'ready'),
      lane: asCalendarText(readCalendarSelector(row, lens.selectors.lane), 'default'),
    },
    relations,
    actions: actionTemplates(lens.actions),
  };
}

export function readCalendarTimeBlocks(
  lenses: CalendarTimeBlockLens[],
  feedsByAddress: Record<string, unknown>,
): CalendarTimeBlockReadResult {
  const blocks: CalendarTimeBlock[] = [];
  let rowCount = 0;
  let skippedRowCount = 0;

  for (const lens of lenses) {
    const rows = rowsFromCalendarFeed(feedsByAddress[lens.input_address]);
    rowCount += rows.length;
    for (const row of rows) {
      const block = projectCalendarTimeBlock(lens, row);
      if (block) blocks.push(block);
      else skippedRowCount += 1;
    }
  }

  blocks.sort((left, right) =>
    left.interval.start.localeCompare(right.interval.start)
    || left.interval.end.localeCompare(right.interval.end)
    || left.id.localeCompare(right.id),
  );

  return {
    blocks,
    diagnostics: {
      lensCount: lenses.length,
      rowCount,
      skippedRowCount,
    },
  };
}
