// tools/calendar/read-data/time-blocks.mjs
//
// Turns any records that have a start and an end into time blocks, and any records that describe an account into
// calendar accounts, by reading each record through a lens the person wrote. A lens is data: it names the field (or the
// column of a row given as a list of cells) that holds the identity, the start, the end, the title and so on, so a new
// kind of record that happens in time is one more lens, never a change here. Nothing here names a kind of record, a
// provider, a state or a colour.
//
// Rules:
//   - A selector is a path ("window.from"), a list of path keys, or { path | column, fallback_path?, fallback? }. The
//     fallback path is tried when the first yields nothing, so an open-ended window can end where it starts.
//   - A row without an identity, a start or an end is skipped and counted; it never stops the others.
//   - Two lenses over the same rows give two sets of blocks: the block id carries the owner, the lens and the row.
//   - Blocks are ordered by start, then end, then id.

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => value !== undefined && value !== null && value !== '';
const pathKeys = path => (Array.isArray(path) ? path : String(path).split('.').filter(Boolean));

function valueAt(row, path) {
  let current = row;
  for (const key of pathKeys(path)) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function readSelector(row, selector) {
  if (!selector) return undefined;
  if (typeof selector === 'string' || Array.isArray(selector)) return valueAt(row, selector);
  const selected = typeof selector.column === 'number'
    ? row[String(selector.column)]
    : selector.path ? valueAt(row, selector.path) : undefined;
  if (present(selected)) return selected;
  if (selector.fallback_path) {
    const second = valueAt(row, selector.fallback_path);
    if (present(second)) return second;
  }
  return selector.fallback;
}

export function asText(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return false;
}

export function asTextList(value) {
  if (typeof value === 'string') {
    if (!value) return [];
    try { return asTextList(JSON.parse(value)); } catch { return [value]; }
  }
  if (!Array.isArray(value)) return [];
  return value.map(item => asText(item)).filter(Boolean);
}

/** Rows as given: records, or lists of cells (the Nth cell is column N). Anything else is not a row. */
export function rowsOf(feed) {
  if (!Array.isArray(feed)) return [];
  return feed.flatMap(row => {
    if (isRecord(row)) return [row];
    if (Array.isArray(row)) return [Object.fromEntries(row.map((cell, index) => [String(index), cell]))];
    return [];
  });
}

/** Why a lens cannot be used, or an empty list. `kind` is the record kind the lens must say it is. */
export function lensProblems(lens, kind, selectorNames) {
  if (!isRecord(lens)) return ['is not a record'];
  const problems = [];
  if (lens.kind !== kind) problems.push(`kind must be ${kind}`);
  for (const name of ['lens_id', 'input_address']) if (typeof lens[name] !== 'string' || !lens[name]) problems.push(`${name} is missing`);
  if (kind === 'time-block-lens' && (typeof lens.owner_ref !== 'string' || !lens.owner_ref)) problems.push('owner_ref is missing');
  if (!isRecord(lens.selectors)) return [...problems, 'selectors is missing'];
  for (const name of selectorNames) if (lens.selectors[name] === undefined) problems.push(`selectors.${name} is missing`);
  return problems;
}

export function projectTimeBlock(lens, row) {
  const rowRef = asText(readSelector(row, lens.selectors.identity));
  const start = asText(readSelector(row, lens.selectors.start));
  const end = asText(readSelector(row, lens.selectors.end));
  if (!rowRef || !start || !end) return null;
  const relations = Object.fromEntries(Object.entries(lens.relations ?? {})
    .map(([key, selector]) => [key, asTextList(readSelector(row, selector))]));
  return {
    id: `${lens.owner_ref}:${lens.lens_id}:${rowRef}`,
    source: { lensId: lens.lens_id, inputAddress: lens.input_address, ownerRef: lens.owner_ref, rowRef },
    interval: {
      start,
      end,
      allDay: asBoolean(readSelector(row, lens.selectors.all_day)),
      timezone: asText(readSelector(row, lens.selectors.timezone), 'local'),
    },
    display: {
      title: asText(readSelector(row, lens.selectors.title), 'Untitled'),
      color: asText(readSelector(row, lens.selectors.color), ''),
      ownerLabel: lens.owner_label ?? lens.owner_ref,
    },
    state: {
      ref: asText(readSelector(row, lens.selectors.state), 'ready'),
      lane: asText(readSelector(row, lens.selectors.lane), 'default'),
    },
    relations,
  };
}

export const byStart = (left, right) => left.interval.start.localeCompare(right.interval.start)
  || left.interval.end.localeCompare(right.interval.end)
  || left.id.localeCompare(right.id);

/**
 * @param {object[]} lenses time-block-lens records
 * @param {Record<string, unknown[]>} feeds the rows each lens reads, by the lens's input_address
 * @returns {{ blocks: object[], diagnostics: { lensCount: number, rowCount: number, skippedRowCount: number }, issues: object[] }}
 */
export function readTimeBlocks(lenses, feeds) {
  const blocks = [];
  const issues = [];
  let rowCount = 0;
  let skippedRowCount = 0;
  let lensCount = 0;
  for (const lens of lenses) {
    const problems = lensProblems(lens, 'time-block-lens', ['identity', 'start', 'end']);
    if (problems.length) {
      issues.push({ id: `lens-unusable:${asText(lens?.lens_id, 'unnamed')}`, tone: 'warning', label: 'A lens could not be used.', detail: problems.join('; ') });
      continue;
    }
    lensCount += 1;
    if (!Array.isArray(feeds[lens.input_address])) {
      issues.push({ id: `lens-has-no-rows:${lens.lens_id}`, tone: 'warning', label: `${lens.owner_label ?? lens.owner_ref} has no rows to read.`, detail: `No rows were given under ${lens.input_address}.` });
      continue;
    }
    const rows = rowsOf(feeds[lens.input_address]);
    rowCount += rows.length;
    for (const row of rows) {
      const block = projectTimeBlock(lens, row);
      if (block) blocks.push(block);
      else skippedRowCount += 1;
    }
  }
  if (skippedRowCount > 0) {
    issues.push({ id: 'rows-skipped', tone: 'warning', label: `${skippedRowCount} item(s) could not be shown.`, detail: 'Some items were missing an identity, a start or an end time.' });
  }
  return { blocks: blocks.sort(byStart), diagnostics: { lensCount, rowCount, skippedRowCount }, issues };
}

/** One account per row of an account lens: who it is, whether it is shown, and the calendars it holds. */
export function projectAccount(lens, row) {
  const id = asText(readSelector(row, lens.selectors.identity));
  const label = asText(readSelector(row, lens.selectors.label), id);
  if (!id || !label) return null;
  const color = asText(readSelector(row, lens.selectors.color), '');
  const visible = asBoolean(readSelector(row, lens.selectors.visible) ?? true);
  const listed = readSelector(row, lens.selectors.calendars);
  const calendars = (Array.isArray(listed) ? listed : []).filter(isRecord)
    .map(item => ({
      id: asText(item.id),
      label: asText(item.label),
      color: asText(item.color, color),
      visible: asBoolean(item.visible ?? visible),
      readOnly: asBoolean(item.readOnly ?? item.read_only),
    }))
    .filter(item => item.id && item.label);
  return {
    id,
    label,
    color,
    status: asText(readSelector(row, lens.selectors.status), 'connected'),
    statusLabel: asText(readSelector(row, lens.selectors.status_label), 'Connected'),
    visible,
    calendars: calendars.length ? calendars : [{ id: `${id}:primary`, label, color, visible }],
  };
}

export function readAccounts(lenses, feeds) {
  const accounts = [];
  const issues = [];
  let rowCount = 0;
  let skippedRowCount = 0;
  let lensCount = 0;
  for (const lens of lenses) {
    const problems = lensProblems(lens, 'calendar-account-lens', ['identity', 'label']);
    if (problems.length) {
      issues.push({ id: `account-lens-unusable:${asText(lens?.lens_id, 'unnamed')}`, tone: 'warning', label: 'An account lens could not be used.', detail: problems.join('; ') });
      continue;
    }
    lensCount += 1;
    const rows = rowsOf(feeds[lens.input_address]);
    rowCount += rows.length;
    for (const row of rows) {
      const account = projectAccount(lens, row);
      if (account) accounts.push(account);
      else skippedRowCount += 1;
    }
  }
  accounts.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  return { accounts, diagnostics: { lensCount, rowCount, skippedRowCount }, issues };
}

// A change waiting to be written, and a change that clashed with what is already there, are shown as blocks too. Each
// is read through the same projection, so a queued change shows where it would land, never as saved.
const QUEUED_LENS = {
  kind: 'time-block-lens', lens_id: 'queued-change', input_address: 'calendar.queued-changes', owner_ref: 'calendar', owner_label: 'Calendar',
  selectors: {
    identity: 'id',
    start: { path: 'proposed_start', fallback: '' },
    end: { path: 'proposed_end', fallback: '' },
    title: { path: 'label', fallback: 'Waiting to sync' },
    state: { path: 'queue_state', fallback: 'waiting-to-sync' },
    lane: { path: 'affected_block_ref', fallback: 'queued' },
  },
  relations: { affectedBlock: 'affected_block_ref' },
};

const CONFLICT_LENS = {
  kind: 'time-block-lens', lens_id: 'conflict', input_address: 'calendar.conflicts', owner_ref: 'calendar', owner_label: 'Calendar',
  selectors: {
    identity: 'id',
    start: 'proposed_start',
    end: 'proposed_end',
    title: { path: 'label', fallback: 'Resolve conflict' },
    state: { path: 'conflict_state', fallback: 'conflict' },
    lane: { path: 'affected_block_ref', fallback: 'conflict' },
  },
  relations: { affectedBlock: 'affected_block_ref', ownerMessage: 'owner_message_ref' },
};

export function readSyncStates(queuedChanges, conflicts) {
  const queuedBlocks = queuedChanges.map(record => projectTimeBlock(QUEUED_LENS, record)).filter(Boolean);
  const conflictBlocks = conflicts.flatMap(record => {
    const block = projectTimeBlock(CONFLICT_LENS, record);
    if (!block) return [];
    block.relations.originalInterval = [asText(record.original_start), asText(record.original_end)];
    return [block];
  });
  return { queuedBlocks, conflictBlocks, diagnostics: { queuedCount: queuedBlocks.length, conflictCount: conflictBlocks.length } };
}
