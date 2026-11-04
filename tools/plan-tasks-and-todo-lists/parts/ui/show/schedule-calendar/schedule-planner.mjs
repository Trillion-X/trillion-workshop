// The bounded, read-only planner for placing unscheduled work into a calendar.
// It works with local wall-clock hours supplied by the caller and returns proposals only.
import { addDays, dayKey, dayStart, isWholeDay, timeAt } from './schedule-placement.mjs';
import data from './schedule-planner.json' with { type: 'json' };

const MAX_TASKS = 200;
const MAX_EVENTS = 3000;
const MAX_HORIZON_DAYS = 60;
const MINUTE_MS = 60_000;
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(dayStart(value).getTime()) && dayKey(dayStart(value)) === value;
const instant = value => {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

function lowerBound(intervals, start) {
  let low = 0, high = intervals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (intervals[middle].start < start) low = middle + 1;
    else high = middle;
  }
  return low;
}

function addBusy(busyByDay, day, start, end) {
  if (!(end > start)) return;
  const intervals = busyByDay.get(day) ?? [];
  insertBusy(intervals, start, end);
  busyByDay.set(day, intervals);
}

function insertBusy(intervals, start, end) {
  let index = lowerBound(intervals, start);
  if (index > 0 && intervals[index - 1].end >= start) {
    index -= 1;
    start = Math.min(start, intervals[index].start);
    end = Math.max(end, intervals[index].end);
    intervals.splice(index, 1);
  }
  while (index < intervals.length && intervals[index].start <= end) {
    start = Math.min(start, intervals[index].start);
    end = Math.max(end, intervals[index].end);
    intervals.splice(index, 1);
  }
  intervals.splice(index, 0, { start, end });
}

function overlaps(intervals, start, end) {
  const index = lowerBound(intervals, start);
  return Boolean((index > 0 && intervals[index - 1].end > start) || (intervals[index] && intervals[index].start < end));
}

function addTimedEvent(busyByDay, item, defaultEventMinutes, rangeStart, rangeEnd) {
  const givenStart = instant(item.starts_at ?? item.at);
  const givenEnd = instant(item.ends_at);
  if (givenStart === null) return;
  const start = Math.max(givenStart, rangeStart);
  const end = Math.min(givenEnd ?? (givenStart + (Number.isSafeInteger(item.minutes) && item.minutes > 0 ? item.minutes : defaultEventMinutes) * MINUTE_MS), rangeEnd);
  if (start === null || end === null || end <= start) return;
  let day = dayKey(new Date(start));
  const lastDay = dayKey(new Date(end - 1));
  while (day <= lastDay) {
    const dayStartMs = dayStart(day).getTime();
    const nextStartMs = dayStart(addDays(day, 1)).getTime();
    addBusy(busyByDay, day, Math.max(start, dayStartMs), Math.min(end, nextStartMs));
    day = addDays(day, 1);
  }
}

function addAllDayEvent(busyByDay, item, rangeStart, rangeEnd) {
  const givenStart = item.day ?? (isWholeDay(item.starts_at) ? item.starts_at : null);
  if (!validDay(givenStart)) return;
  const givenEnd = item.day_end ?? (isWholeDay(item.ends_at) ? item.ends_at : addDays(givenStart, 1));
  if (!validDay(givenEnd)) return;
  const startDay = givenStart < rangeStart ? rangeStart : givenStart;
  const endDay = givenEnd > rangeEnd ? rangeEnd : givenEnd;
  if (endDay <= startDay) return;
  for (let day = startDay; day < endDay; day = addDays(day, 1)) {
    addBusy(busyByDay, day, dayStart(day).getTime(), dayStart(addDays(day, 1)).getTime());
  }
}

function dueBefore(task) {
  if (task.due === null || task.due === undefined || task.due === '') return null;
  if (isWholeDay(task.due)) return validDay(task.due) ? dayStart(addDays(task.due, 1)).getTime() : NaN;
  return instant(task.due) ?? NaN;
}

function startOnOf(task) {
  if (task.start_on === null || task.start_on === undefined || task.start_on === '') return null;
  if (isWholeDay(task.start_on)) return validDay(task.start_on) ? dayStart(task.start_on).getTime() : NaN;
  return instant(task.start_on) ?? NaN;
}

const rankIn = (list, value) => {
  const index = list.indexOf(value);
  return index < 0 ? list.length : index;
};

// One comparator per name `order_by` may list. A name is looked up here, so the order itself is DATA.
const comparators = {
  due: (a, b) => a.due - b.due,
  priority: (a, b) => a.priority - b.priority,
  duration: (a, b) => b.duration - a.duration,
  input: (a, b) => a.index - b.index,
};

const pickReason = reasons => data.reason_precedence.find(reason => reasons.has(reason));

/** One day's override, checked and normalized: switch the day off, start it later (`start_minute`), end it early
 *  (`end_minute`), and block hours (`blocks`). The one place a day override is understood, for the planner and for
 *  whatever stores one. */
export function dayOverrideOf(row) {
  const minuteOk = value => Number.isSafeInteger(value) && value >= 0 && value <= 1440;
  if (!row || typeof row !== 'object' || !validDay(row.day)) throw new TypeError('A day override names one local date.');
  const blocks = row.blocks ?? [];
  if ((row.off !== undefined && typeof row.off !== 'boolean')
    || (row.start_minute != null && !minuteOk(row.start_minute)) || (row.end_minute != null && !minuteOk(row.end_minute))
    || (row.start_minute != null && row.end_minute != null && row.end_minute <= row.start_minute)
    || !Array.isArray(blocks) || blocks.length > data.limits.blocks_per_day
    || blocks.some(block => !block || !minuteOk(block.start_minute) || !minuteOk(block.end_minute) || block.end_minute <= block.start_minute)) {
    throw new TypeError('A day override needs off, start_minute, end_minute or blocks in whole minutes of the day.');
  }
  return { day: row.day, off: row.off === true, start_minute: row.start_minute ?? 0, end_minute: row.end_minute ?? 1440,
    blocks: blocks.map(block => ({ start_minute: block.start_minute, end_minute: block.end_minute })) };
}

function normalizeOverrides(list) {
  if (list === undefined) return new Map();
  if (!Array.isArray(list) || list.length > data.limits.day_overrides) throw new RangeError('day_overrides must be a bounded list.');
  const byDay = new Map();
  for (const row of list) {
    const override = dayOverrideOf(row);
    if (byDay.has(override.day)) throw new TypeError('Each day override names one local date once.');
    byDay.set(override.day, override);
  }
  return byDay;
}

function normalizeCapacity(capacity) {
  if (capacity === undefined || capacity === null) return null;
  const ok = value => Number.isSafeInteger(value) && value >= 1 && value <= 1440;
  const weekdays = capacity.weekdays ?? {};
  const band = capacity.caution_band_minutes ?? 0;
  if (typeof capacity !== 'object' || Array.isArray(capacity) || (capacity.default_minutes != null && !ok(capacity.default_minutes))
    || !Number.isSafeInteger(band) || band < 0 || band > 1440 || typeof weekdays !== 'object'
    || Object.entries(weekdays).some(([weekday, minutes]) => !/^[0-6]$/.test(weekday) || !ok(minutes))) {
    throw new TypeError('capacity needs default_minutes, weekdays {0-6: minutes} and caution_band_minutes in whole minutes.');
  }
  return { default_minutes: capacity.default_minutes ?? null, weekdays, band };
}

/**
 * Suggest slots for unscheduled tasks without changing either input.
 * `working_hours` is local wall time: either the legacy `{ start_minute, end_minute, weekdays }`
 * shape or `{ days: [{ weekday, intervals: [{ start_minute, end_minute }] }] }`, with Sunday = 0.
 *
 * A task is `{ id, title, duration_minutes, due?, deadline_type?, priority?, start_on?, blocked_by?, starts_at?,
 * ends_at?, pinned_until?, auto_placed? }`. `deadline_type` and `priority` are independent: the type (a row of
 * schedule-planner.json `deadline_types`) says whether `due` binds and whether the task may be placed after it
 * (`late`); priority only ranks tasks among each other. `blocked_by` names tasks that must end first. A task that
 * already has `starts_at` is kept where it is (and its time counts as busy), unless it is `auto_placed` and has no
 * live pin: a pin (`pinned_until` still in the future) holds an automatically placed task until the pin passes, and
 * after that the planner takes it back. `options.blockers` gives the end (`ends_at`) or `done` of blockers that are not
 * in this plan, `options.day_overrides` start later, stop early, block hours or switch off one day, and
 * `options.capacity` caps the planned minutes of a day.
 */
export function planSchedule(tasks, events, {
  start_day = dayKey(new Date()), horizon_days = 21, working_hours,
  slot_minutes = 15, max_tasks = MAX_TASKS, max_events = MAX_EVENTS, default_event_minutes = 30,
  earliest_at = null, order_by = data.order_by, priority_order = data.priority_order,
  day_overrides, capacity, blockers = {},
} = {}) {
  if (!Array.isArray(tasks) || !Array.isArray(events)) throw new TypeError('tasks and events must be arrays.');
  if (!Number.isSafeInteger(max_tasks) || max_tasks < 1 || !Number.isSafeInteger(max_events) || max_events < 1) {
    throw new RangeError('task and event limits must be positive whole numbers.');
  }
  if (tasks.length > Math.min(MAX_TASKS, max_tasks) || events.length > Math.min(MAX_EVENTS, max_events)) {
    throw new RangeError('The schedule plan exceeds its task or event limit.');
  }
  if (!validDay(start_day)) throw new TypeError('start_day must be a local date key.');
  if (!Number.isSafeInteger(horizon_days) || horizon_days < 1 || horizon_days > MAX_HORIZON_DAYS) {
    throw new RangeError(`horizon_days must be between 1 and ${MAX_HORIZON_DAYS}.`);
  }
  const schedules = normalizeWorkingHours(working_hours);
  if (!Number.isSafeInteger(slot_minutes) || slot_minutes < 5 || slot_minutes > 120) {
    throw new RangeError('slot_minutes must be between 5 and 120.');
  }
  if (!Number.isSafeInteger(default_event_minutes) || default_event_minutes < 1 || default_event_minutes > 1440) {
    throw new RangeError('default_event_minutes must be between 1 and 1440.');
  }
  if (!Array.isArray(order_by) || order_by.some(name => !Object.hasOwn(comparators, name))) {
    throw new TypeError('order_by names comparators from the planner: due, priority, duration, input.');
  }
  if (!Array.isArray(priority_order)) throw new TypeError('priority_order must be a list of priority names.');
  if (!blockers || typeof blockers !== 'object' || Array.isArray(blockers)) throw new TypeError('blockers must map a task id to { ends_at } or { done }.');
  const overrides = normalizeOverrides(day_overrides);
  const limits = normalizeCapacity(capacity);

  const horizonEnd = addDays(start_day, horizon_days);
  const earliest = earliest_at === null ? dayStart(start_day).getTime() : instant(earliest_at);
  if (earliest === null) throw new TypeError('earliest_at must be a valid instant.');
  const busyByDay = new Map();
  for (const item of events) {
    if (item?.all_day || item?.day || isWholeDay(item?.starts_at)) addAllDayEvent(busyByDay, item ?? {}, start_day, horizonEnd);
    else addTimedEvent(busyByDay, item ?? {}, default_event_minutes, dayStart(start_day).getTime(), dayStart(horizonEnd).getTime());
  }
  for (const [day, override] of overrides) {
    for (const block of override.blocks) addBusy(busyByDay, day, Date.parse(timeAt(day, block.start_minute)), Date.parse(timeAt(day, block.end_minute)));
  }
  const workIntervalsOn = day => {
    const base = schedules.get(dayStart(day).getDay()) ?? [];
    const override = overrides.get(day);
    if (!override) return base;
    if (override.off) return [];
    return base.map(({ start_minute, end_minute }) => ({
      start_minute: Math.max(start_minute, override.start_minute), end_minute: Math.min(end_minute, override.end_minute),
    })).filter(interval => interval.end_minute > interval.start_minute);
  };

  // Tasks already on the calendar: fixed ones (and pinned automatic ones) stay and count as busy; an automatic one
  // without a live pin goes back into the plan, and says so when its pin has just run out.
  const kept = [];
  const released = [];
  const minutesByDay = new Map();
  const placedEnd = new Map();
  const planned = [];
  for (const [index, task] of tasks.entries()) {
    const startMs = instant(task?.starts_at);
    if (startMs === null) { planned.push({ task, index }); continue; }
    const pinnedUntil = instant(task.pinned_until);
    const pinLive = pinnedUntil !== null && pinnedUntil > earliest;
    if (task.auto_placed === true && !pinLive) {
      if (pinnedUntil !== null && typeof task.id === 'string') released.push(task.id);
      planned.push({ task: { ...task, starts_at: null, ends_at: null }, index, was_at: task.starts_at });
      continue;
    }
    const endMs = instant(task.ends_at) ?? startMs + (Number.isSafeInteger(task.duration_minutes) && task.duration_minutes > 0 ? task.duration_minutes : default_event_minutes) * MINUTE_MS;
    addTimedEvent(busyByDay, { starts_at: new Date(startMs).toISOString(), ends_at: new Date(endMs).toISOString() }, default_event_minutes, dayStart(start_day).getTime(), dayStart(horizonEnd).getTime());
    const day = dayKey(new Date(startMs));
    minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + Math.round((endMs - startMs) / MINUTE_MS));
    if (typeof task.id === 'string') placedEnd.set(task.id, endMs);
    kept.push({ task_id: typeof task.id === 'string' ? task.id : null, title: typeof task.title === 'string' ? task.title : '', starts_at: new Date(startMs).toISOString(), ends_at: new Date(endMs).toISOString(), reason: pinLive ? 'pinned' : 'fixed', ...(pinLive ? { pinned_until: new Date(pinnedUntil).toISOString() } : {}) });
  }

  const entries = planned.map(({ task, index, was_at }) => {
    const type = task?.deadline_type ?? data.default_deadline_type;
    const rule = Object.hasOwn(data.deadline_types, type) ? data.deadline_types[type] : null;
    const due = dueBefore(task ?? {});
    return {
      task, index, was_at, rule, due: rule?.binds && due !== null && Number.isFinite(due) ? due : Infinity, rawDue: due,
      priority: rankIn(priority_order, task?.priority), duration: task?.duration_minutes ?? 0,
      id: typeof task?.id === 'string' ? task.id : '',
    };
  }).sort((a, b) => {
    for (const name of order_by) {
      const difference = comparators[name](a, b);
      if (difference) return difference;
    }
    return 0;
  });
  const inPlan = new Set(entries.map(entry => entry.id).filter(Boolean));
  const unscheduledIds = new Set();
  const proposals = [];
  const unscheduled = [];
  let maxWorkInterval = 0;
  for (const intervals of schedules.values()) {
    for (const interval of intervals) maxWorkInterval = Math.max(maxWorkInterval, interval.end_minute - interval.start_minute);
  }
  const thresholdOn = day => {
    if (!limits) return null;
    return limits.weekdays[dayStart(day).getDay()] ?? limits.default_minutes;
  };
  const failed = (entry, reason, extra = {}) => {
    if (entry.id) unscheduledIds.add(entry.id);
    unscheduled.push({ task_id: entry.id || null, title: typeof entry.task?.title === 'string' ? entry.task.title : '', reason, ...(entry.was_at ? { was_at: entry.was_at } : {}), ...extra });
  };

  // A task waits until every blocker that is in this plan has been handled; what is left over blocks itself in a ring.
  const queue = [...entries];
  const handled = new Set();
  while (queue.length) {
    const next = queue.findIndex(entry => (Array.isArray(entry.task?.blocked_by) ? entry.task.blocked_by : []).every(id => !inPlan.has(id) || handled.has(id)));
    if (next === -1) {
      for (const entry of queue) failed(entry, 'blocker_cycle', { blocker_ids: entry.task.blocked_by.filter(id => inPlan.has(id)) });
      break;
    }
    const entry = queue.splice(next, 1)[0];
    if (entry.id) handled.add(entry.id);
    const { task, due: bindingDue, rawDue, rule, id, duration, was_at } = entry;
    const reasons = new Set();
    if (!id) reasons.add('missing_task_id');
    else if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1440) reasons.add('invalid_duration');
    if (!rule || (rawDue !== null && !Number.isFinite(rawDue))) reasons.add('invalid_due');
    const startOn = startOnOf(task ?? {});
    if (startOn !== null && !Number.isFinite(startOn)) reasons.add('invalid_start');
    const blockerIds = task?.blocked_by === undefined ? [] : task.blocked_by;
    if (!Array.isArray(blockerIds) || blockerIds.length > data.limits.blockers_per_task || blockerIds.some(blocker => typeof blocker !== 'string' || !blocker)) {
      throw new RangeError(`blocked_by is a list of at most ${data.limits.blockers_per_task} task ids.`);
    }
    if (!reasons.size) {
      if (rule && !rule.may_place_late && bindingDue !== Infinity && bindingDue <= dayStart(start_day).getTime()) reasons.add('due_passed');
      else if (maxWorkInterval > 0 && duration > maxWorkInterval && !(Number.isSafeInteger(task.minimum_duration_minutes) && task.minimum_duration_minutes >= data.limits.shortest_slice_minutes && task.minimum_duration_minutes <= maxWorkInterval)) reasons.add('duration_exceeds_workday');
    }
    let notBefore = Math.max(earliest, startOn ?? -Infinity);
    const waitingOn = [];
    const unknown = [];
    for (const blocker of blockerIds) {
      const given = blockers[blocker];
      if (given && typeof given === 'object') {
        if (given.done === true) continue;
        const ends = instant(given.ends_at);
        if (ends !== null) notBefore = Math.max(notBefore, ends);
        else unknown.push(blocker);
      } else if (placedEnd.has(blocker)) notBefore = Math.max(notBefore, placedEnd.get(blocker));
      else if (unscheduledIds.has(blocker)) waitingOn.push(blocker);
      else unknown.push(blocker);
    }
    if (waitingOn.length) reasons.add('blocked_by_unscheduled');
    if (unknown.length) reasons.add('blocker_unknown');
    if (reasons.size) {
      const reason = pickReason(reasons);
      failed(entry, reason, reason === 'blocked_by_unscheduled' ? { blocker_ids: waitingOn } : reason === 'blocker_unknown' ? { blocker_ids: unknown } : {});
      continue;
    }

    const title = typeof task.title === 'string' ? task.title : '';
    // A list's preferred times narrow the day's working hours for its tasks only.
    const windowed = windowOf(task.preferred_window);
    const intervalsFor = day => {
      const base = workIntervalsOn(day);
      return windowed ? clipToWindow(base, windowed, dayStart(day).getDay()) : base;
    };
    const search = deadline => {
      const seen = new Set();
      for (let day = start_day; day < horizonEnd; day = addDays(day, 1)) {
        const workIntervals = intervalsFor(day);
        if (!workIntervals.length) { if (windowed && workIntervalsOn(day).length) seen.add('window_blocked'); continue; }
        seen.add('workday');
        const intervals = busyByDay.get(day) ?? [];
        const threshold = thresholdOn(day);
        for (const { start_minute, end_minute } of workIntervals) {
          if (duration > end_minute - start_minute) continue;
          const windowStartMs = Date.parse(timeAt(day, start_minute));
          const windowEndMs = Date.parse(timeAt(day, end_minute));
          if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) continue;
          for (let minute = start_minute; minute + duration <= end_minute; minute += slot_minutes) {
            const startAt = timeAt(day, minute);
            const startMs = Date.parse(startAt);
            // `setHours` normalizes a nonexistent spring-forward wall time. Skip that wall time instead of silently
            // proposing a different local time; the next valid slot remains available.
            const local = new Date(startMs);
            if (dayKey(local) !== day || local.getHours() * 60 + local.getMinutes() !== minute) continue;
            const endMs = startMs + duration * MINUTE_MS;
            if (startMs < Math.max(windowStartMs, notBefore) || endMs > windowEndMs || dayKey(new Date(endMs - 1)) !== day) continue;
            if (overlaps(intervals, startMs, endMs)) continue;
            if (threshold !== null && (minutesByDay.get(day) ?? 0) + duration > threshold) { seen.add('capacity'); continue; }
            if (deadline !== Infinity && endMs > deadline) { seen.add('deadline'); continue; }
            insertBusy(intervals, startMs, endMs);
            busyByDay.set(day, intervals);
            minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + duration);
            return { seen, placed: { startMs, endMs } };
          }
        }
      }
      return { seen, placed: null };
    };

    const sliceSearch = deadline => {
      const least = task.minimum_duration_minutes;
      // Slices are tried against copies of the day's busy time and minutes, put back untouched when they do not all fit.
      const savedBusy = new Map([...busyByDay].map(([day, rows]) => [day, rows.map(row => ({ ...row }))]));
      const savedMinutes = new Map(minutesByDay);
      const pieces = [];
      let remaining = duration;
      const free = (day, minute, length, intervals, windowStartMs, windowEndMs) => {
        const startMs = Date.parse(timeAt(day, minute));
        const local = new Date(startMs);
        const endMs = startMs + length * MINUTE_MS;
        return Number.isFinite(startMs) && dayKey(local) === day && local.getHours() * 60 + local.getMinutes() === minute
          && startMs >= Math.max(windowStartMs, notBefore) && endMs <= windowEndMs && dayKey(new Date(endMs - 1)) === day
          && !overlaps(intervals, startMs, endMs) && (deadline === Infinity || endMs <= deadline);
      };
      for (let day = start_day; day < horizonEnd && remaining > 0; day = addDays(day, 1)) {
        const threshold = thresholdOn(day);
        for (const { start_minute, end_minute } of intervalsFor(day)) {
          const intervals = busyByDay.get(day) ?? [];
          const windowStartMs = Date.parse(timeAt(day, start_minute)), windowEndMs = Date.parse(timeAt(day, end_minute));
          for (let minute = start_minute; minute + least <= end_minute && remaining > 0; minute += slot_minutes) {
            const room = threshold === null ? Infinity : threshold - (minutesByDay.get(day) ?? 0);
            let length = 0;
            while (length + slot_minutes <= Math.min(remaining, room, end_minute - minute) && free(day, minute, length + slot_minutes, intervals, windowStartMs, windowEndMs)) length += slot_minutes;
            // The last slice may be shorter than a whole step when the task's length is not a multiple of it.
            if (length + slot_minutes > remaining && length < remaining && remaining <= room && free(day, minute, remaining, intervals, windowStartMs, windowEndMs)) length = remaining;
            if (length < least) continue;
            let take = Math.min(length, remaining);
            if (remaining - take > 0 && remaining - take < least) take = remaining - least;
            if (take < least) continue;
            const startMs = Date.parse(timeAt(day, minute));
            insertBusy(intervals, startMs, startMs + take * MINUTE_MS);
            busyByDay.set(day, intervals);
            minutesByDay.set(day, (minutesByDay.get(day) ?? 0) + take);
            pieces.push({ startMs, endMs: startMs + take * MINUTE_MS });
            remaining -= take;
            minute += Math.ceil(take / slot_minutes) * slot_minutes - slot_minutes;
          }
        }
      }
      if (remaining === 0 && pieces.length <= data.limits.slices_per_task) return pieces;
      busyByDay.clear(); for (const [day, rows] of savedBusy) busyByDay.set(day, rows);
      minutesByDay.clear(); for (const [day, minutes] of savedMinutes) minutesByDay.set(day, minutes);
      return null;
    };

    let attempt = search(bindingDue);
    let late = false;
    // A soft deadline is a wish: when it cannot be met the task still gets the first time that is free, marked late.
    if (!attempt.placed && rule.may_place_late && bindingDue !== Infinity) {
      attempt = search(Infinity);
      late = Boolean(attempt.placed);
    }
    if (attempt.placed) {
      const { startMs, endMs } = attempt.placed;
      placedEnd.set(id, endMs);
      proposals.push({
        task_id: id, title, starts_at: new Date(startMs).toISOString(), ends_at: new Date(endMs).toISOString(), duration_minutes: duration,
        status: late ? 'late' : 'scheduled', late, ...(was_at ? { was_at } : {}),
      });
      continue;
    }
    // A task that will not fit whole but has a smallest useful slice (`minimum_duration_minutes`) is placed in slices
    // no shorter than that, earliest first; all of them or none.
    const slice = task.minimum_duration_minutes;
    if (Number.isSafeInteger(slice) && slice >= data.limits.shortest_slice_minutes && slice < duration) {
      let pieces = sliceSearch(bindingDue);
      if (!pieces && rule.may_place_late && bindingDue !== Infinity) { pieces = sliceSearch(Infinity); late = Boolean(pieces); }
      if (pieces) {
        placedEnd.set(id, pieces.at(-1).endMs);
        pieces.forEach((piece, index) => proposals.push({
          task_id: id, title, starts_at: new Date(piece.startMs).toISOString(), ends_at: new Date(piece.endMs).toISOString(),
          duration_minutes: Math.round((piece.endMs - piece.startMs) / MINUTE_MS), status: late ? 'late' : 'scheduled', late,
          chunk_index: index + 1, chunk_count: pieces.length, ...(was_at ? { was_at } : {}),
        }));
        continue;
      }
    }
    const why = new Set();
    if (!attempt.seen.has('workday')) why.add(attempt.seen.has('window_blocked') ? 'outside_preferred_times' : 'no_workdays');
    else {
      why.add('no_free_slot_before_horizon');
      if (attempt.seen.has('capacity')) why.add('over_capacity');
      if (attempt.seen.has('deadline')) why.add('no_free_slot_before_deadline');
    }
    failed(entry, pickReason(why));
  }

  const result = { start_day, horizon_days, proposals, unscheduled, kept, released };
  if (limits) {
    result.days = [];
    for (let day = start_day; day < horizonEnd; day = addDays(day, 1)) {
      const threshold = thresholdOn(day);
      if (threshold === null) continue;
      const minutes = minutesByDay.get(day) ?? 0;
      result.days.push({ day, planned_minutes: minutes, threshold_minutes: threshold,
        level: minutes > threshold ? data.capacity_levels.over : limits.band > 0 && minutes >= threshold - limits.band ? data.capacity_levels.caution : data.capacity_levels.ok });
    }
  }
  return result;
}

/** A task's preferred times `{ start_minute, end_minute, weekdays? }`, or null when it has none or they are not usable. */
function windowOf(window) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null;
  const { start_minute, end_minute, weekdays } = window;
  if (!Number.isSafeInteger(start_minute) || !Number.isSafeInteger(end_minute) || start_minute < 0 || end_minute > 1440 || end_minute <= start_minute) return null;
  return { start_minute, end_minute, weekdays: Array.isArray(weekdays) ? weekdays : null };
}

function clipToWindow(intervals, window, weekday) {
  if (window.weekdays && !window.weekdays.includes(weekday)) return [];
  return intervals.map(({ start_minute, end_minute }) => ({
    start_minute: Math.max(start_minute, window.start_minute), end_minute: Math.min(end_minute, window.end_minute),
  })).filter(interval => interval.end_minute > interval.start_minute);
}

function normalizeWorkingHours(hours) {
  const invalid = () => { throw new TypeError('working_hours must be a valid legacy schedule or a days schedule.'); };
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) invalid();
  const hasDays = Object.hasOwn(hours, 'days');
  const hasLegacy = ['start_minute', 'end_minute', 'weekdays'].some(key => Object.hasOwn(hours, key));
  const schedules = new Map();
  const validMinute = value => Number.isSafeInteger(value) && value >= 0 && value <= 1440;

  if (hasDays) {
    if (hasLegacy || !Array.isArray(hours.days)) invalid();
    for (const day of hours.days) {
      if (!day || typeof day !== 'object' || Array.isArray(day)
        || !Number.isSafeInteger(day.weekday) || day.weekday < 0 || day.weekday > 6
        || !Array.isArray(day.intervals) || schedules.has(day.weekday)) invalid();
      let previousEnd = -1;
      const intervals = day.intervals.map(interval => {
        if (!interval || typeof interval !== 'object' || Array.isArray(interval)
          || !validMinute(interval.start_minute) || !validMinute(interval.end_minute)
          || interval.end_minute <= interval.start_minute || interval.start_minute < previousEnd) invalid();
        previousEnd = interval.end_minute;
        return { start_minute: interval.start_minute, end_minute: interval.end_minute };
      });
      schedules.set(day.weekday, intervals);
    }
    return schedules;
  }

  if (!hasLegacy || !validMinute(hours.start_minute) || !validMinute(hours.end_minute)
    || hours.end_minute <= hours.start_minute || !Array.isArray(hours.weekdays) || !hours.weekdays.length) invalid();
  for (const weekday of hours.weekdays) {
    if (!Number.isSafeInteger(weekday) || weekday < 0 || weekday > 6 || schedules.has(weekday)) invalid();
    schedules.set(weekday, [{ start_minute: hours.start_minute, end_minute: hours.end_minute }]);
  }
  return schedules;
}
