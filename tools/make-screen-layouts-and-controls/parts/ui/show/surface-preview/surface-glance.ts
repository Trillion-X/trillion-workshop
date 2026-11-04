// packages/ui/show/surface-preview/surface-glance.ts
//
// PURPOSE
// A glance is the short live summary a hover card shows for a screen: how many
// things it holds, when it last changed, what is in progress and the latest few
// items. What to read and where each fact sits is DATA on the screen's record
// (`glance`), so one reader serves every screen and no screen has code here.
// A screen's actions (`actions`) are DATA too: each names a window event the
// owning app already listens for, so opening another screen, starting an
// import or anything later is a row of data, never a branch here.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Blind: the reader follows explicit path arrays; it never knows a field
//    name, a screen or an app.
// 2. Read on demand: a glance loads when a card opens, never on a timer.
// 3. A missing or malformed fact is left out; nothing is guessed.
// 4. `{name}` in a source url is filled from the caller's params, URL-encoded;
//    in an action's label and event detail it is filled as plain text, so one
//    declaration serves every row of a list (every project, say).
// 5. A listed thing is worked from the card: `row` on `recent` or `in_progress`
//    reads named values from each item (`values`), which fill the row's
//    `open` event, its `actions` and its `drill`, a whole glance declaration
//    of its own whose source is read only when the person looks inside. A
//    drill may declare rows with drills, so nesting has no fixed depth.
// 6. An open or action naming a value the item does not have is left out,
//    so a row never offers to open something with a blank where its id goes.

export type GlancePath = readonly string[];

/** Where an item's name sits: one path, or several tried in order (a message named by its title, else its words). */
export type GlanceTitle = GlancePath | readonly GlancePath[];

/** A listing field's source: a path read from the item, or the same words on every row. */
export type GlanceFieldSource = GlancePath | {text: string};

/** How each listed thing becomes a row the person can work: values read from the item fill `{name}` in the row's open
 *  event, actions and drill; `fields` are the shared listing shape's fields (icon, picture, value, unit, tone, byline,
 *  text), each read from the item or the same words on every row. */
export interface GlanceRowDeclaration {
  values?: Readonly<Record<string, GlancePath>>;
  fields?: Readonly<Record<string, GlanceFieldSource>>;
  open?: {event: SurfaceActionData['event']};
  actions?: readonly SurfaceActionData[];
  drill?: GlanceDeclaration;
}

export interface GlanceDeclaration {
  source: {url: string};
  count?: {path: GlancePath; measure: 'length' | 'value'; noun: readonly [string, string]};
  updated?: {path: GlancePath};
  recent?: {path: GlancePath; title: GlanceTitle; detail?: GlancePath; time?: GlancePath; limit?: number; row?: GlanceRowDeclaration};
  in_progress?: {path: GlancePath; title: GlanceTitle; progress?: GlancePath; when?: {path: GlancePath; equals: readonly (string | number | boolean)[]}; row?: GlanceRowDeclaration};
}

/** A listed thing worked from the card: its own values, listing fields, and what opening, acting on and looking inside
 *  it do, each already filled from those values. */
export interface GlanceItem {
  values: Record<string, string>;
  fields: Record<string, string>;
  open?: SurfaceActionData['event'];
  actions: SurfaceActionData[];
  drill?: GlanceDeclaration;
}
export interface GlanceRow {title: string; detail?: string; time?: number; item?: GlanceItem}
export interface GlanceWork {title: string; progress: number | null; item?: GlanceItem}
export interface Glance {
  count?: {value: number; label: string};
  updatedAt?: number;
  inProgress: GlanceWork[];
  recent: GlanceRow[];
}

/** An action a screen offers from DATA: dispatch `event.name` on window with `event.detail`. */
export interface SurfaceActionData {
  id: string;
  label: string;
  icon: string;
  event: {name: string; detail?: Record<string, unknown>};
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const readPath = (value: unknown): GlancePath | null =>
  Array.isArray(value) && value.every((part) => typeof part === 'string') ? value as string[] : null;
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

function at(value: unknown, path: GlancePath): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
}

function readTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; }
  return undefined;
}

function readShown(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

const readTitle = (value: unknown): GlanceTitle | null =>
  readPath(value) ?? (Array.isArray(value) && value.length && value.every((part) => readPath(part)) ? value as GlancePath[] : null);
const titleOf = (item: unknown, title: GlanceTitle): string | undefined => {
  const paths = (title.length && Array.isArray(title[0]) ? title : [title]) as readonly GlancePath[];
  for (const path of paths) { const shown = readShown(at(item, path)); if (shown) return shown; }
  return undefined;
};

const readPathMap = (value: unknown): Record<string, GlancePath> | null => {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).flatMap(([name, path]) => (readPath(path) ? [[name, readPath(path)!] as const] : []));
  return entries.length ? Object.fromEntries(entries) : null;
};

/** Decode a row declaration; malformed parts are left out, and a row with nothing left is null. */
export function readGlanceRow(value: unknown): GlanceRowDeclaration | null {
  if (!isRecord(value)) return null;
  const values = readPathMap(value.values);
  const fieldEntries = isRecord(value.fields) ? Object.entries(value.fields).flatMap(([name, source]): [string, GlanceFieldSource][] => {
    if (readPath(source)) return [[name, readPath(source)!]];
    const words = isRecord(source) ? text(source.text) : null;
    return words ? [[name, {text: words}]] : [];
  }) : [];
  const fields = fieldEntries.length ? Object.fromEntries(fieldEntries) : null;
  const openName = isRecord(value.open) && isRecord(value.open.event) ? text(value.open.event.name) : null;
  const open = openName ? {event: {name: openName, ...(isRecord((value.open as {event: Record<string, unknown>}).event.detail) ? {detail: (value.open as {event: {detail: Record<string, unknown>}}).event.detail} : {})}} : null;
  const actions = readSurfaceActions(value.actions);
  const drill = readGlanceDeclaration(value.drill);
  const row: GlanceRowDeclaration = {
    ...(values ? {values} : {}), ...(fields ? {fields} : {}),
    ...(open ? {open} : {}), ...(actions.length ? {actions} : {}), ...(drill ? {drill} : {}),
  };
  return Object.keys(row).length ? row : null;
}

/** Decode a `glance` DATA value; null when it does not name a source. */
export function readGlanceDeclaration(value: unknown): GlanceDeclaration | null {
  if (!isRecord(value) || !isRecord(value.source) || !text(value.source.url)) return null;
  const declaration: GlanceDeclaration = {source: {url: text(value.source.url)!}};
  if (isRecord(value.count)) {
    const path = readPath(value.count.path), noun = value.count.noun;
    if (path && Array.isArray(noun) && noun.length === 2 && noun.every((word) => typeof word === 'string')) {
      declaration.count = {path, measure: value.count.measure === 'value' ? 'value' : 'length', noun: [noun[0], noun[1]] as [string, string]};
    }
  }
  if (isRecord(value.updated) && readPath(value.updated.path)) declaration.updated = {path: readPath(value.updated.path)!};
  if (isRecord(value.recent) && readPath(value.recent.path) && readTitle(value.recent.title)) {
    declaration.recent = {
      path: readPath(value.recent.path)!, title: readTitle(value.recent.title)!,
      ...(readPath(value.recent.detail) ? {detail: readPath(value.recent.detail)!} : {}),
      ...(readPath(value.recent.time) ? {time: readPath(value.recent.time)!} : {}),
      ...(typeof value.recent.limit === 'number' && value.recent.limit > 0 ? {limit: Math.floor(value.recent.limit)} : {}),
      ...(readGlanceRow(value.recent.row) ? {row: readGlanceRow(value.recent.row)!} : {}),
    };
  }
  if (isRecord(value.in_progress) && readPath(value.in_progress.path) && readTitle(value.in_progress.title)) {
    const when = isRecord(value.in_progress.when) && readPath(value.in_progress.when.path) && Array.isArray(value.in_progress.when.equals)
      ? {path: readPath(value.in_progress.when.path)!, equals: value.in_progress.when.equals.filter((entry): entry is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof entry))}
      : undefined;
    declaration.in_progress = {
      path: readPath(value.in_progress.path)!, title: readTitle(value.in_progress.title)!,
      ...(readPath(value.in_progress.progress) ? {progress: readPath(value.in_progress.progress)!} : {}),
      ...(when ? {when} : {}),
      ...(readGlanceRow(value.in_progress.row) ? {row: readGlanceRow(value.in_progress.row)!} : {}),
    };
  }
  return declaration;
}

/** Decode an `actions` DATA list; rows without an id, label, icon and event name are left out. */
export function readSurfaceActions(value: unknown): SurfaceActionData[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!isRecord(row) || !isRecord(row.event)) return [];
    const id = text(row.id), label = text(row.label), icon = text(row.icon), name = text(row.event.name);
    if (!id || !label || !icon || !name) return [];
    return [{id, label, icon, event: {name, ...(isRecord(row.event.detail) ? {detail: row.event.detail} : {})}}];
  });
}

/** Dispatch a DATA action. Returns true when a listener took it. */
export function runSurfaceAction(action: Pick<SurfaceActionData, 'event'>): boolean {
  if (typeof window === 'undefined') return false;
  const request = new CustomEvent(action.event.name, {detail: action.event.detail ?? {}, cancelable: true});
  window.dispatchEvent(request);
  return request.defaultPrevented;
}

const PLACEHOLDER = /\{([a-z0-9_]+)\}/gi;

export function fillGlanceUrl(url: string, params: Record<string, string>): string {
  return url.replace(PLACEHOLDER, (_match, name: string) => encodeURIComponent(params[name] ?? ''));
}

function fillValue(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_match, name: string) => params[name] ?? '');
  if (Array.isArray(value)) return value.map((entry) => fillValue(entry, params));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillValue(entry, params)]));
  return value;
}

/** The same action for one row: `{name}` in its label and event detail is filled from the row's params. */
export function fillSurfaceAction(action: SurfaceActionData, params: Record<string, string>): SurfaceActionData {
  return {
    ...action,
    label: fillValue(action.label, params) as string,
    event: {name: action.event.name, ...(action.event.detail ? {detail: fillValue(action.event.detail, params) as Record<string, unknown>} : {})},
  };
}

// A field whose value is empty, zero or false says nothing on a row, so it is left out.
const shownField = (value: unknown): string | undefined => (value === 0 || value === false ? undefined : readShown(value));

/** Whether every `{name}` an action's label and event name is among the row's values. */
const fillable = (action: SurfaceActionData, values: Record<string, string>): boolean =>
  [...JSON.stringify([action.label, action.event]).matchAll(PLACEHOLDER)].every(([, name]) => name in values);

/** One listed thing as a row the person can work, from the row declaration and the item; null with no declaration. */
export function readGlanceItem(row: GlanceRowDeclaration | undefined, item: unknown, inherited: Record<string, string> = {}): GlanceItem | undefined {
  if (!row) return undefined;
  const values: Record<string, string> = {...inherited};
  for (const [name, path] of Object.entries(row.values ?? {})) { const value = readShown(at(item, path)); if (value) values[name] = value; }
  const fields: Record<string, string> = {};
  for (const [name, source] of Object.entries(row.fields ?? {})) {
    const value = Array.isArray(source) ? shownField(at(item, source)) : (source as {text: string}).text;
    if (value) fields[name] = value;
  }
  const open = row.open ? {id: 'open', label: 'Open', icon: 'ArrowUpRight', event: row.open.event} : null;
  return {
    values, fields,
    ...(open && fillable(open, values) ? {open: fillSurfaceAction(open, values).event} : {}),
    actions: (row.actions ?? []).filter(action => fillable(action, values)).map(action => fillSurfaceAction(action, values)),
    ...(row.drill ? {drill: row.drill} : {}),
  };
}

/** Read one glance from a source reply, following the declaration's paths. `inherited` are the values of the thing this
 *  glance looks inside, so a nested row can still name its parent. */
export function readGlance(declaration: GlanceDeclaration, reply: unknown, plural = (count: number, noun: readonly [string, string]) => `${count.toLocaleString()} ${count === 1 ? noun[0] : noun[1]}`, inherited: Record<string, string> = {}): Glance {
  const glance: Glance = {inProgress: [], recent: []};
  if (declaration.count) {
    const raw = at(reply, declaration.count.path);
    const value = declaration.count.measure === 'length' ? (Array.isArray(raw) ? raw.length : undefined) : (typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined);
    if (value !== undefined) glance.count = {value, label: plural(value, declaration.count.noun)};
  }
  if (declaration.updated) glance.updatedAt = readTime(at(reply, declaration.updated.path));
  if (declaration.in_progress) {
    const {path, title, progress, when} = declaration.in_progress;
    const rows = at(reply, path);
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (when && !when.equals.includes(at(row, when.path) as never)) continue;
        const name = titleOf(row, title);
        if (!name) continue;
        const share = progress ? at(row, progress) : undefined;
        const item = readGlanceItem(declaration.in_progress.row, row, inherited);
        glance.inProgress.push({title: name, progress: typeof share === 'number' && Number.isFinite(share) ? Math.max(0, Math.min(1, share > 1 ? share / 100 : share)) : null, ...(item ? {item} : {})});
      }
    }
  }
  if (declaration.recent) {
    const {path, title, detail, time, limit = 4} = declaration.recent;
    const rows = at(reply, path);
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (glance.recent.length >= limit) break;
        const name = titleOf(row, title);
        if (!name) continue;
        const shown = detail ? readShown(at(row, detail)) : undefined;
        const when = time ? readTime(at(row, time)) : undefined;
        const item = readGlanceItem(declaration.recent.row, row, inherited);
        glance.recent.push({title: name, ...(shown ? {detail: shown} : {}), ...(when !== undefined ? {time: when} : {}), ...(item ? {item} : {})});
        if (when !== undefined && (glance.updatedAt === undefined || when > glance.updatedAt) && !declaration.updated) glance.updatedAt = when;
      }
    }
  }
  return glance;
}

/** Load a glance from its declared source. */
export async function loadGlance(declaration: GlanceDeclaration, params: Record<string, string> = {}, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Glance> {
  const response = await fetcher(fillGlanceUrl(declaration.source.url, params), {signal, headers: {accept: 'application/json'}});
  if (!response.ok) throw new Error('This summary could not be read.');
  return readGlance(declaration, await response.json(), undefined, params);
}
