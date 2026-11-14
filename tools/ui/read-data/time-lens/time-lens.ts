// packages/ui/read-data/time-lens/time-lens.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE shared time-lens leaf: one selector grammar that projects ANY record rows
// into normalized time blocks, consumed by every time-axis geometry — the
// calendar grid, the visual-database timeline stream, and any graph time-filter.
// A lens is pure DATA: {lens_id, input_address, selectors} — which kinds appear
// on a time axis is one DATA row, never a code branch.
//
// This is the co-owned normalizer both the calendar and knowledge-graph plans
// name: calendar's read-calendar-time-blocks.ts carries the identical grammar;
// whichever consumer migrates next consumes THIS leaf rather than forking the
// grammar.
//
// Pure computation, zero I/O, zero package vocabulary: rows and feeds are
// supplied by the caller; the leaf never reads addresses itself. Selector
// misses SKIP the row (counted in diagnostics) — never a crash, never a
// fabricated block.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export type TimeLensRow = Record<string, unknown>;

/** A selector points into a row: a dot-path string, a path array, or an object
 *  with a fallback value. Arrays are the canonical machine-readable form. */
export type TimeLensSelector = string | string[] | {
  path?: string | string[];
  column?: number;
  fallback?: unknown;
};

export type TimeLensDescriptor = {
  kind: 'time-block-lens';
  lens_id: string;
  input_address: string;
  owner_ref: string;
  owner_label?: string;
  selectors: {
    identity: TimeLensSelector;
    start: TimeLensSelector;
    /** May be omitted for instant events (a message, a post): no end = start. */
    end?: TimeLensSelector;
    title?: TimeLensSelector;
    all_day?: TimeLensSelector;
    timezone?: TimeLensSelector;
    color?: TimeLensSelector;
    state?: TimeLensSelector;
    lane?: TimeLensSelector;
  };
  relations?: Record<string, TimeLensSelector>;
};

/** The normalized block every geometry renders. No source vocabulary: a
 *  renderer sees {start, title, color, lane, source} shapes only. */
export type TimeLensBlock = {
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
};

export type TimeLensWindow = {
  /** Inclusive ISO lower bound; blocks ending before it are excluded. */
  start?: string;
  /** Exclusive ISO upper bound; blocks starting at/after it are excluded. */
  end?: string;
  /** Bound the result to the most recent N blocks — a frontier read for
   *  sources that cannot be windowed at the engine. */
  mostRecent?: number;
};

export type TimeLensReadResult = {
  blocks: TimeLensBlock[];
  diagnostics: {
    lensCount: number;
    rowCount: number;
    skippedRowCount: number;
    windowedOutCount: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function splitPath(path: string | string[]): string[] {
  return Array.isArray(path) ? path : path.split('.').filter(Boolean);
}

function getPathValue(row: TimeLensRow, path: string | string[]): unknown {
  let current: unknown = row;
  for (const key of splitPath(path)) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function readTimeLensSelector(row: TimeLensRow, selector: TimeLensSelector | undefined): unknown {
  if (!selector) return undefined;
  if (typeof selector === 'string' || Array.isArray(selector)) return getPathValue(row, selector);
  const selected = typeof selector.column === 'number'
    ? row[String(selector.column)]
    : selector.path
      ? getPathValue(row, selector.path)
      : undefined;
  return selected === undefined || selected === null || selected === ''
    ? selector.fallback
    : selected;
}

export function asTimeLensText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asTextArray(value: unknown): string[] {
  if (typeof value === 'string') {
    if (!value) return [];
    try {
      return asTextArray(JSON.parse(value) as unknown);
    } catch {
      return [value];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => asTimeLensText(item)).filter(Boolean);
}

/** Project one row through a lens. Null when identity or start are missing —
 *  the row is skipped, never guessed. No end selector → instant event
 *  (end = start), so message/post/purchase sources need only ONE time field. */
export function projectTimeLensBlock(lens: TimeLensDescriptor, row: TimeLensRow): TimeLensBlock | null {
  const rowRef = asTimeLensText(readTimeLensSelector(row, lens.selectors.identity));
  const start = asTimeLensText(readTimeLensSelector(row, lens.selectors.start));
  if (!rowRef || !start) return null;
  const end = asTimeLensText(readTimeLensSelector(row, lens.selectors.end), start) || start;

  const relations = Object.fromEntries(
    Object.entries(lens.relations ?? {}).map(([key, selector]) => [
      key,
      asTextArray(readTimeLensSelector(row, selector)),
    ]),
  );

  const allDayRaw = readTimeLensSelector(row, lens.selectors.all_day);
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
      allDay: allDayRaw === true || allDayRaw === 'true',
      timezone: asTimeLensText(readTimeLensSelector(row, lens.selectors.timezone), 'local'),
    },
    display: {
      title: asTimeLensText(readTimeLensSelector(row, lens.selectors.title), 'Untitled'),
      color: asTimeLensText(readTimeLensSelector(row, lens.selectors.color), ''),
      ownerLabel: lens.owner_label ?? lens.owner_ref,
    },
    state: {
      ref: asTimeLensText(readTimeLensSelector(row, lens.selectors.state), 'ready'),
      lane: asTimeLensText(readTimeLensSelector(row, lens.selectors.lane), 'default'),
    },
    relations,
  };
}

function inWindow(block: TimeLensBlock, window: TimeLensWindow | undefined): boolean {
  if (!window) return true;
  if (window.start && block.interval.end < window.start) return false;
  if (window.end && block.interval.start >= window.end) return false;
  return true;
}

/** Fold N lenses over their supplied row feeds into one merged, chronologically
 *  sorted block stream. The windowed-read law: callers pass the rows they
 *  already read (ideally already time-windowed at the source); this leaf
 *  applies the window again as the honest boundary and can bound to
 *  most-recent-N as a frontier read. Deterministic ordering (start, end, id). */
export function readTimeLensBlocks(
  lenses: readonly TimeLensDescriptor[],
  rowsByAddress: Record<string, readonly TimeLensRow[]>,
  window?: TimeLensWindow,
): TimeLensReadResult {
  const blocks: TimeLensBlock[] = [];
  let rowCount = 0;
  let skippedRowCount = 0;
  let windowedOutCount = 0;

  for (const lens of lenses) {
    const rows = rowsByAddress[lens.input_address] ?? [];
    rowCount += rows.length;
    for (const row of rows) {
      const block = projectTimeLensBlock(lens, row);
      if (!block) {
        skippedRowCount += 1;
        continue;
      }
      if (!inWindow(block, window)) {
        windowedOutCount += 1;
        continue;
      }
      blocks.push(block);
    }
  }

  blocks.sort((left, right) =>
    left.interval.start.localeCompare(right.interval.start)
    || left.interval.end.localeCompare(right.interval.end)
    || left.id.localeCompare(right.id),
  );

  const bounded = window?.mostRecent !== undefined && blocks.length > window.mostRecent
    ? blocks.slice(blocks.length - window.mostRecent)
    : blocks;
  windowedOutCount += blocks.length - bounded.length;

  return {
    blocks: bounded,
    diagnostics: {
      lensCount: lenses.length,
      rowCount,
      skippedRowCount,
      windowedOutCount,
    },
  };
}

/** Validate a candidate DATA record as a lens descriptor. Throws with a plain
 *  message so a mistyped lens row is caught before it is written — a blind
 *  engine drops mismatched DATA silently, so validation happens at authoring. */
export function validateTimeLensDescriptor(value: unknown): TimeLensDescriptor {
  if (!isRecord(value)) throw new Error('Time lens is missing.');
  if (value.kind !== 'time-block-lens') throw new Error('Time lens has the wrong kind.');
  for (const field of ['lens_id', 'input_address', 'owner_ref'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Time lens needs ${field}.`);
  }
  const selectors = value.selectors;
  if (!isRecord(selectors) || selectors.identity === undefined || selectors.start === undefined) {
    throw new Error('Time lens needs identity and start selectors.');
  }
  return value as TimeLensDescriptor;
}
