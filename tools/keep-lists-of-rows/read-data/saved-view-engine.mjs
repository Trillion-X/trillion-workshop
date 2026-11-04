// One saved view shape and projection for lists, workspace surfaces, and AI tools.
// Predicates remain formula-engine rule trees; this owner only resolves the view's
// context and hands the rule to that engine. No list or field name is special.

import { timeZoneName } from '../../run-work-later-or-on-a-repeat/do-work/wall-time.ts';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    if (/^-?\d{11,16}$/.test(value.trim())) return Number(value);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const words = value => Array.isArray(value) ? value.map(words).join(' ') : isObject(value) ? Object.values(value).map(words).join(' ') : String(value ?? '');
const compare = (left, right) => {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), undefined, {numeric: true, sensitivity: 'base'});
};
const calendarFormatters = new Map();
const calendarFormatter = timeZone => {
  if (!calendarFormatters.has(timeZone)) {
    if (calendarFormatters.size >= 32) calendarFormatters.delete(calendarFormatters.keys().next().value);
    calendarFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}));
  }
  return calendarFormatters.get(timeZone);
};
const calendarDay = (value, timeZone) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
  }
  const at = stamp(value);
  if (at === null) return null;
  const parts = calendarFormatter(timeZone).formatToParts(at);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
};
export const calendarBucket = (value, bucket, timeZone, now = Date.now()) => {
  const day = calendarDay(value, timeZone);
  if (!day) return 'Empty';
  if (bucket === 'month') return day.slice(0, 7);
  if (bucket === 'year') return day.slice(0, 4);
  const at = new Date(`${day}T00:00:00Z`);
  if (bucket === 'week') {
    at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
    return at.toISOString().slice(0, 10);
  }
  if (bucket === 'relative') {
    const today = new Date(`${calendarDay(now, timeZone)}T00:00:00Z`);
    const ago = Math.round((today.getTime() - at.getTime()) / 86400000);
    if (ago <= 0) return 'today';
    if (ago === 1) return 'yesterday';
    if (ago < 7) return 'week';
    if (ago < 30) return 'month';
    return day.slice(0, 7);
  }
  return day;
};

const shiftedCalendarDay = (day, amount) => {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + amount);
  return at.toISOString().slice(0, 10);
};
// Find the first instant on a calendar day in the selected zone. Searching
// calendar days avoids inventing an offset at a DST change or assuming that
// every midnight exists. A skipped calendar day starts at the next real day.
const startOfCalendarDay = (day, timeZone) => {
  const noon = Date.parse(`${day}T12:00:00Z`);
  let before = noon - 2 * 86400000, after = noon + 2 * 86400000;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (calendarDay(middle, timeZone) < day) before = middle;
    else after = middle;
  }
  return after;
};

/** A bucket's inclusive instant range, shared by rendered group headings and
 * their filter actions. `value` is a key returned by calendarBucket. */
export function calendarBucketSpan(value, bucket, timeZone, now = Date.now()) {
  if (value === 'Empty') return null;
  let start, end;
  const monthSpan = month => {
    const at = new Date(`${month}-01T00:00:00Z`);
    at.setUTCMonth(at.getUTCMonth() + 1);
    return [`${month}-01`, at.toISOString().slice(0, 10)];
  };
  if (bucket === 'relative') {
    const today = calendarDay(now, timeZone);
    if (value === 'today') [start, end] = [today, shiftedCalendarDay(today, 1)];
    else if (value === 'yesterday') [start, end] = [shiftedCalendarDay(today, -1), today];
    else if (value === 'week') [start, end] = [shiftedCalendarDay(today, -6), shiftedCalendarDay(today, -1)];
    else if (value === 'month') [start, end] = [shiftedCalendarDay(today, -29), shiftedCalendarDay(today, -6)];
    else [start, end] = monthSpan(value);
  } else if (bucket === 'month') [start, end] = monthSpan(value);
  else if (bucket === 'year') [start, end] = [`${value}-01-01`, `${String(Number(value) + 1).padStart(4, '0')}-01-01`];
  else [start, end] = [value, shiftedCalendarDay(value, bucket === 'week' ? 7 : 1)];
  return {start, end, min: startOfCalendarDay(start, timeZone), max: startOfCalendarDay(end, timeZone) - 1};
}

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
// Settings are plain JSON a view carries for the way it is drawn; nothing in them is run, so only the shape is checked.
const plainSettings = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(plainSettings);
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.keys(value).every(key => !unsafeKeys.has(key) && plainSettings(value[key]));
};
// `display` says how a saved view is drawn: `as` names any view the list offers, `settings` is that view's own choices.
// Shared surface choices travel beside the view's own settings. The field maps
// are checked against this list, and the numeric bounds match RecordViews' UI.
const normalizeSurface = (surface, known) => {
  const allowed = new Set(['columnWidths', 'compact', 'align', 'frozen', 'detail', 'timeline']);
  if (!isObject(surface) || !plainSettings(surface) || Object.keys(surface).some(key => !allowed.has(key))) throw new Error('Unknown view surface setting.');
  const mapped = (value, accepts) => {
    if (!isObject(value) || Object.entries(value).some(([key, item]) => !known.has(key) || !accepts(item))) throw new Error('View surface settings need available fields and valid values.');
    return {...value};
  };
  const out = {};
  if (surface.columnWidths !== undefined) out.columnWidths = mapped(surface.columnWidths, width => Number.isInteger(width) && width >= 64 && width <= 720);
  if (surface.align !== undefined) out.align = mapped(surface.align, align => ['left', 'center', 'right'].includes(align));
  if (surface.compact !== undefined) {
    if (typeof surface.compact !== 'boolean') throw new Error('Row density must be true or false.');
    out.compact = surface.compact;
  }
  if (surface.frozen !== undefined) {
    if (!Number.isInteger(surface.frozen) || surface.frozen < 0 || surface.frozen > known.size) throw new Error('Frozen columns must fit the available fields.');
    out.frozen = surface.frozen;
  }
  for (const key of ['detail', 'timeline']) if (surface[key] !== undefined) {
    if (surface[key] !== null && (typeof surface[key] !== 'string' || !surface[key].trim() || surface[key].length > 100 || unsafeKeys.has(surface[key]))) throw new Error('A view level needs an available name.');
    out[key] = surface[key];
  }
  return out;
};
const normalizeDisplay = (display, known) => {
  // Kept designed views use their row id (`design:uuid`), while built-in views
  // use a short name. Both name a registered renderer; neither is executable.
  if (!isObject(display) || typeof display.as !== 'string' || !/^[a-z][a-z0-9:_.-]{0,199}$/i.test(display.as) || unsafeKeys.has(display.as)) throw new Error('A view display needs a plain name such as chart.');
  if (display.settings !== undefined && (!isObject(display.settings) || !plainSettings(display.settings))) throw new Error('View display settings must be plain values.');
  return {as: display.as, ...(display.settings === undefined ? {} : {settings: display.settings}),
    ...(display.surface === undefined ? {} : {surface: normalizeSurface(display.surface, known)})};
};

export function normalizeSavedView(input, fieldIds) {
  if (!isObject(input) || typeof input.label !== 'string' || !input.label.trim()) throw new Error('A saved view needs a name.');
  const known = new Set(fieldIds);
  const field = id => {
    if (typeof id !== 'string' || !known.has(id)) throw new Error(`Unknown view field ${String(id)}.`);
    return id;
  };
  const fields = value => {
    if (!Array.isArray(value)) throw new Error('View fields must be a list.');
    return [...new Set(value.map(field))];
  };
  const sort = input.sort === undefined ? [] : input.sort;
  const groups = input.groups === undefined ? [] : input.groups;
  if (!Array.isArray(sort) || !Array.isArray(groups)) throw new Error('View sort and groups must be lists.');
  const columns = input.columns === undefined ? {} : input.columns;
  if (!isObject(columns)) throw new Error('View columns must be an object.');
  const time = input.time === null ? undefined : input.time;
  const timeZone = timeZoneName(input.time_zone ?? 'UTC');
  if (!timeZone) throw new Error('Unknown view time zone.');
  if (time !== undefined && (!isObject(time) || !time.field || (!time.after && !time.before))) throw new Error('A time range needs a field and a bound.');
  const point = value => {
    if (value === undefined) return undefined;
    if (!isObject(value) || (value.value === undefined && !isObject(value.binding))) throw new Error('A time bound needs a value or formula binding.');
    if (value.value !== undefined && stamp(value.value) === null) throw new Error('A time bound must be a date or time.');
    if (value.refs !== undefined && (!Array.isArray(value.refs) || value.refs.some(ref => !isObject(ref) || typeof ref.id !== 'string' || !ref.id.startsWith('record:') || !Array.isArray(ref.path) || !ref.path.every(part => typeof part === 'string' && !['__proto__', 'constructor', 'prototype'].includes(part)) || (ref.as !== undefined && (typeof ref.as !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(ref.as)))))) throw new Error('Time references need own record ids and safe paths.');
    return value;
  };
  const out = {
    id: input.id,
    label: input.label.trim(),
    search: typeof input.search === 'string' ? input.search : '',
    time_zone: timeZone,
    ...(input.rules ? {rules: input.rules} : {}),
    sort: sort.map(entry => {
      if (!isObject(entry) || !['asc', 'desc'].includes(entry.direction)) throw new Error('A sort needs a field and direction.');
      return {field: field(entry.field), direction: entry.direction};
    }),
    groups: groups.map(entry => ({field: field(entry?.field), ...(typeof entry?.bucket === 'string' ? {bucket: entry.bucket} : {}), ...(entry?.show_empty_choices === true ? {show_empty_choices: true} : {})})),
    columns: {order: columns.order === undefined ? [] : fields(columns.order), hidden: columns.hidden === undefined ? [] : fields(columns.hidden)},
    ...(time ? {time: {field: field(time.field), ...(time.after ? {after: point(time.after)} : {}), ...(time.before ? {before: point(time.before)} : {})}} : {}),
    ...(input.display ? {display: normalizeDisplay(input.display, known)} : {}),
  };
  if (input.rules && (!isObject(input.rules) || input.rules.kind !== 'group' || !Array.isArray(input.rules.rules))) throw new Error('View rules must be a rule group.');
  return out;
}

export async function resolveSavedViewTimeBound(point, {now, readRecord, evaluateBinding}) {
  if (!point) return null;
  if (point.value !== undefined) return stamp(point.value);
  if (!evaluateBinding) throw new Error('Formula time bounds need the formula evaluator.');
  const refs = Object.create(null);
  for (const ref of point.refs ?? []) {
    const record = await readRecord?.(ref.id);
    if (!record) throw new Error(`Time reference ${ref.id} is unavailable.`);
    let value = record;
    for (const part of ref.path) value = value?.[part];
    if (value === undefined || value === null) throw new Error(`Time reference ${ref.id} has no value at its path.`);
    refs[ref.as ?? ref.id] = value;
  }
  const result = await evaluateBinding(point.binding, {now, refs});
  const parsed = stamp(result);
  if (parsed === null) throw new Error('The time formula did not return a date or time.');
  return parsed;
}

export async function projectSavedView({view, fields, rows, filterRows, ruleKindOf = kind => kind, now = Date.now(), readRecord, evaluateBinding, resolveTimeBound}) {
  const ids = fields.map(field => field.id);
  const selected = normalizeSavedView(view, ids);
  for (const group of selected.groups) {
    const descriptor = fields.find(field => field.id === group.field);
    if (ruleKindOf(descriptor?.kind) === 'date' && group.bucket && !['day', 'week', 'month', 'year', 'relative'].includes(group.bucket))
      throw new Error(`Unknown date bucket ${group.bucket}.`);
  }
  let kept = [...rows];
  if (selected.rules) {
    if (!filterRows) throw new Error('The formula row filter is unavailable.');
    const answer = await filterRows({tree: selected.rules, fields: fields.map(field => ({id: field.id, kind: ruleKindOf(field.kind)})), rows: kept.map(row => row.values)});
    if (answer.incomplete?.length) throw new Error('The saved view has unfinished rules.');
    kept = answer.matches.map(index => kept[index]);
  }
  const query = selected.search.trim().toLocaleLowerCase();
  if (query) kept = kept.filter(row => `${row.title ?? ''} ${ids.map(id => words(row.values?.[id])).join(' ')}`.toLocaleLowerCase().includes(query));
  if (selected.time) {
    const resolve = async point => {
      if (!point) return null;
      // Browser hosts resolve authorized bounds without copying referenced
      // records into the browser; other callers use this same local resolver.
      const value = resolveTimeBound && point.value === undefined ? await resolveTimeBound(point, now) : await resolveSavedViewTimeBound(point, {now, readRecord, evaluateBinding});
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('The time resolver did not return a valid timestamp.');
      return value;
    };
    const [after, before] = await Promise.all([resolve(selected.time.after), resolve(selected.time.before)]);
    if (after !== null && before !== null && after > before) throw new Error('The time range starts after it ends.');
    kept = kept.filter(row => {
      const value = stamp(row.values?.[selected.time.field]);
      return value !== null && (after === null || value >= after) && (before === null || value <= before);
    });
  }
  if (selected.sort.length) kept.sort((left, right) => {
    for (const entry of selected.sort) {
      const order = compare(left.values?.[entry.field], right.values?.[entry.field]);
      if (order) return entry.direction === 'desc' ? -order : order;
    }
    return compare(left.id, right.id);
  });
  const shown = [...selected.columns.order, ...ids.filter(id => !selected.columns.order.includes(id))].filter(id => !selected.columns.hidden.includes(id));
  const groups = new Map();
  for (const row of kept) {
    const path = selected.groups.map(group => {
      const descriptor = fields.find(field => field.id === group.field);
      return ruleKindOf(descriptor?.kind) === 'date'
        ? calendarBucket(row.values?.[group.field], group.bucket ?? 'day', selected.time_zone, now)
        : words(row.values?.[group.field]) || 'Empty';
    });
    if (path.length) {
      const key = JSON.stringify(path);
      const current = groups.get(key) ?? {path, row_ids: []};
      current.row_ids.push(row.id);
      groups.set(key, current);
    }
  }
  return {view: selected, fields: shown.map(id => fields.find(field => field.id === id)), rows: kept, groups: [...groups.values()], total: kept.length};
}
