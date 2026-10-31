// tools/calendar/read-data/calendar-views.mjs
//
// Lays time blocks out for a view. A view is a record the person keeps (kind calendar-view-descriptor): it names one of
// three geometries (a time grid of day columns, a month grid, an agenda list) and the numbers that geometry reads (how
// many day columns, whether weekends are dropped, how many blocks a month cell shows). "3 days", "work week" or
// "quarter" are one more record, never a change here. An unknown geometry is answered with a notice, not a failure.
//
// Rules:
//   - Days are the person's own days: every instant is moved by `utc_offset_minutes` (0 when not given) before it is
//     cut into a day. An all-day block is a date, not an instant, and is never moved.
//   - A block belongs to the day it starts on. A timed block that runs past midnight ends at the day's last minute.
//   - Blocks that overlap in time share the day column: each cluster (blocks that overlap, directly or through
//     another) splits it into equal columns in start order, and every block in a cluster has the same column count.
//     Ties order by start, then end, then id.
//   - There is no clock here. The anchor day comes from the caller, the selected block, the first block or the range.

const MINUTE = 60_000;
const DAY = 86_400_000;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export function parseViewDescriptor(value) {
  if (!isRecord(value) || value.kind !== 'calendar-view-descriptor') return null;
  if (typeof value.view_id !== 'string' || !value.view_id) return null;
  if (typeof value.layout !== 'string' || !value.layout) return null;
  const keep = {};
  for (const name of ['day_count', 'window_start_minute', 'window_end_minute', 'hour_height_px', 'max_chips_per_cell']) {
    if (number(value[name]) !== undefined) keep[name] = value[name];
  }
  if (typeof value.skip_weekends === 'boolean') keep.skip_weekends = value.skip_weekends;
  return {
    view_id: value.view_id,
    label: typeof value.label === 'string' && value.label ? value.label : value.view_id,
    layout: value.layout,
    order: number(value.order) ?? 1000,
    ...keep,
  };
}

/** The valid views, ordered, and the one asked for (the first when none is asked for or the id is unknown). */
export function chooseView(descriptors, viewId) {
  const byId = new Map();
  for (const view of descriptors.map(parseViewDescriptor).filter(Boolean)) byId.set(view.view_id, view);
  const unique = [...byId.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  return { views: unique, active: unique.find(view => view.view_id === viewId) ?? unique[0] ?? null };
}

function instant(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

const dayKeyOf = shifted => new Date(Math.floor(shifted / DAY) * DAY).toISOString().slice(0, 10);

/** Where a block starts for the person: its day, its minute in that day, and where it ends in that day. */
export function placeOnDay(block, offsetMinutes) {
  const start = instant(block.interval.start);
  if (start === null) return null;
  if (block.interval.allDay) return { day: dayKeyOf(start), startMinute: 0, endMinute: 1440 };
  const shifted = start + offsetMinutes * MINUTE;
  const end = instant(block.interval.end);
  const startMinute = Math.floor((shifted - Math.floor(shifted / DAY) * DAY) / MINUTE);
  const length = end === null ? 0 : Math.max(0, Math.round((end - start) / MINUTE));
  return { day: dayKeyOf(shifted), startMinute, endMinute: Math.min(1440, startMinute + length) };
}

/** Overlapping blocks as clusters, each block with its column. Input: { id, startMinute, endMinute }. */
function packClusters(inputs) {
  const sorted = [...inputs].sort((left, right) => left.startMinute - right.startMinute
    || left.endMinute - right.endMinute || left.id.localeCompare(right.id));
  const clusters = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  let columnEnds = [];
  const flush = () => {
    if (cluster.length) clusters.push({ columnCount: columnEnds.length || 1, members: cluster });
    cluster = [];
    columnEnds = [];
  };
  for (const item of sorted) {
    if (item.startMinute >= clusterEnd) {
      flush();
      clusterEnd = item.endMinute;
    } else clusterEnd = Math.max(clusterEnd, item.endMinute);
    let column = columnEnds.findIndex(end => end <= item.startMinute);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.endMinute);
    } else columnEnds[column] = item.endMinute;
    cluster.push({ item, column });
  }
  flush();
  return clusters;
}

export function packOverlappingBlocks(inputs) {
  return packClusters(inputs).flatMap(({ columnCount, members }) => members
    .map(({ item, column }) => ({ id: item.id, column, columnCount })));
}

/** Clusters of two or more blocks that are on the same day at the same time. */
export function clashesOf(inputs) {
  return packClusters(inputs).filter(({ members }) => members.length > 1).map(({ members }) => members.map(({ item }) => item.id));
}

const dayStart = key => Date.parse(`${key}T00:00:00Z`);
const addDays = (key, days) => new Date(dayStart(key) + days * DAY).toISOString().slice(0, 10);
const weekday = key => new Date(dayStart(key)).getUTCDay();
const isWeekend = key => [0, 6].includes(weekday(key));
const mondayOf = key => addDays(key, weekday(key) === 0 ? -6 : 1 - weekday(key));
const dayRecord = (key, month) => ({ key, weekday: weekday(key), in_month: Number(key.slice(5, 7)) === month });

/** The one day-column generator for time grids: day, 3-day, week and work week are this function reading its descriptor. */
export function timeGridDays(anchorDay, descriptor) {
  const columns = Math.max(1, Math.floor(descriptor.day_count ?? 1));
  const start = columns >= 7 || descriptor.skip_weekends === true ? mondayOf(anchorDay) : anchorDay;
  const month = Number(anchorDay.slice(5, 7));
  const days = [];
  for (let step = 0; days.length < columns && step < columns + 14; step += 1) {
    const key = addDays(start, step);
    if (descriptor.skip_weekends && isWeekend(key)) continue;
    days.push(dayRecord(key, month));
  }
  return days;
}

/** Six Monday-first weeks that hold the anchor's month. */
export function monthGridDays(anchorDay) {
  const first = `${anchorDay.slice(0, 7)}-01`;
  const start = mondayOf(first);
  const month = Number(anchorDay.slice(5, 7));
  return Array.from({ length: 42 }, (_, index) => dayRecord(addDays(start, index), month));
}

function anchorDayOf(input, placed) {
  const given = instant(input.anchor);
  if (given !== null) return dayKeyOf(given + (input.utc_offset_minutes ?? 0) * MINUTE);
  const selected = placed.find(entry => entry.block.id === input.selected_block_id) ?? placed[0];
  if (selected) return selected.where.day;
  const range = instant(input.range_start);
  if (range !== null) return dayKeyOf(range + (input.utc_offset_minutes ?? 0) * MINUTE);
  return null;
}

/**
 * @param {{ blocks: object[], views: object[], view_id?: string, anchor?: string, range_start?: string,
 *           selected_block_id?: string, utc_offset_minutes?: number }} input
 */
export function layOutView(input) {
  const offset = input.utc_offset_minutes ?? 0;
  const { views, active } = chooseView(input.views, input.view_id);
  if (!active) return { view: null, views, days: [], clashes: [], skipped: [], notice: 'No view was given.' };
  const placed = [];
  const skipped = [];
  for (const block of [...input.blocks].sort((a, b) => a.interval.start.localeCompare(b.interval.start) || a.interval.end.localeCompare(b.interval.end) || a.id.localeCompare(b.id))) {
    const where = placeOnDay(block, offset);
    if (where) placed.push({ block, where });
    else skipped.push(block.id);
  }
  const answer = { view: active, views, days: [], clashes: [], skipped };
  const anchor = anchorDayOf(input, placed);
  if (anchor === null) return { ...answer, notice: 'Give an anchor or a range_start: there is no clock to pick the day.' };
  answer.anchor_day = anchor;
  const on = key => placed.filter(entry => entry.where.day === key);

  if (active.layout === 'time-grid') {
    for (const day of timeGridDays(anchor, active)) {
      const entries = on(day.key);
      const timed = entries.filter(entry => !entry.block.interval.allDay);
      const inputs = timed.map(({ block, where }) => ({ id: block.id, startMinute: where.startMinute, endMinute: where.endMinute }));
      const columns = new Map(packOverlappingBlocks(inputs).map(item => [item.id, item]));
      answer.days.push({
        ...day,
        all_day: entries.filter(entry => entry.block.interval.allDay).map(entry => entry.block.id),
        timed: inputs.map(item => ({ id: item.id, start_minute: item.startMinute, end_minute: item.endMinute, column: columns.get(item.id).column, column_count: columns.get(item.id).columnCount })),
      });
      for (const ids of clashesOf(inputs)) answer.clashes.push({ day: day.key, ids });
    }
  } else if (active.layout === 'month-grid') {
    const cap = Math.max(0, Math.floor(active.max_chips_per_cell ?? Infinity));
    for (const day of monthGridDays(anchor)) {
      const ids = on(day.key).map(entry => entry.block.id);
      answer.days.push({ ...day, shown: ids.slice(0, cap), more: Math.max(0, ids.length - cap) });
    }
  } else if (active.layout === 'agenda-list') {
    const keys = [...new Set(placed.map(entry => entry.where.day))].sort();
    for (const key of keys) answer.days.push({ key, weekday: weekday(key), blocks: on(key).map(entry => entry.block.id) });
  } else {
    answer.notice = `No layout is known for "${active.layout}".`;
  }
  return answer;
}
