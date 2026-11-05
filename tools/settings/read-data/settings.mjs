// tools/settings/read-data/settings.mjs
//
// The one shared reader of a person's tool settings. A setting is a row of the person's generic Settings list
// (list:settings, row type `setting`), kept as a record of type `record:setting` with the id
// `record:setting:<tool folder>~<scope kind>~<scope id>` (scope kind person, film, piece or account). Its value holds
// { name, tool, scope_kind, scope_id, settings, from, status }; `settings` is the tool's own settings object.
//
// A tool takes `settings_record` (that id) in its input and reads it at run time through its records door:
//
//   const settings = await readSettings(door, input.settings_record, { tool: 'my-tool-folder' });
//
// It is the old app's `setting` record kind (old trillion src/decision-store.mjs before commit 4ffa1dc4a2: line 8 names
// the kind, lines 751-753 `setting(name)` read one by name as `setting:<name>` and answered its value or null,
// 754-757 `setSetting`, 758-762 `settings(prefix)`), now one row of the person's list read through the door. One change
// is on purpose: a missing setting is refused with what to do, never read as null, so a tool cannot run silently on
// built-in defaults when the person's setting is absent. Invariants:
//   1. A setting is read only by its exact id, and only for the tool its id names (a tool cannot read another's).
//   2. Only an active row is read; its value's `tool` must equal the id's tool folder.
//   3. `settings` is a JSON object (or that object as JSON text); anything else is refused.
//   4. Nothing is cached between runs and nothing is written; `settingRow` only builds a row for a loader payload.
import { readFileSync } from 'node:fs';

export const DATA = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));

export class SettingError extends Error {
  constructor(code, words) {
    super(words);
    this.code = code;
  }
}

const say = (code, fill) => new SettingError(code, DATA.words[code].replace(/\{(\w+)\}/g, (_, name) => String(fill[name] ?? '')));
const kinds = DATA.scope_kinds.join(', ');
const plainPart = value => typeof value === 'string' && value.length > 0 && !value.includes(DATA.separator) && !value.includes('/');

/** The id of a tool's setting for one scope. */
export function settingId({ tool, scope_kind, scope_id }) {
  for (const [field, value] of Object.entries({ tool, scope_kind, scope_id })) {
    if (!plainPart(value)) throw say('bad_part', { field, value: JSON.stringify(value) });
  }
  if (!DATA.scope_kinds.includes(scope_kind)) throw say('bad_scope_kind', { id: `${tool}${DATA.separator}${scope_kind}`, scope_kind, kinds });
  return `${DATA.id_prefix}${tool}${DATA.separator}${scope_kind}${DATA.separator}${scope_id}`;
}

/** { tool, scope_kind, scope_id } of a setting id; refuses anything that is not one. */
export function parseSettingId(id) {
  if (typeof id !== 'string' || !id.startsWith(DATA.id_prefix)) throw say('bad_id', { id: JSON.stringify(id), kinds });
  const parts = id.slice(DATA.id_prefix.length).split(DATA.separator);
  if (parts.length !== 3 || !parts.every(plainPart)) throw say('bad_id', { id: JSON.stringify(id), kinds });
  const [tool, scope_kind, scope_id] = parts;
  if (!DATA.scope_kinds.includes(scope_kind)) throw say('bad_scope_kind', { id, scope_kind, kinds });
  return { tool, scope_kind, scope_id };
}

/** The settings object of a setting row's value, checked as invariants 1-3 say. */
export function settingsOf(value, id, { tool } = {}) {
  const named = parseSettingId(id);
  if (tool !== undefined && named.tool !== tool) throw say('other_tool', { id, owner: named.tool, tool });
  if (value === null || value === undefined) throw say('missing', { id });
  if (value.status !== DATA.active_status) throw say('not_active', { id, status: JSON.stringify(value.status ?? null) });
  if (value.tool !== named.tool) throw say('value_tool', { id, owner: JSON.stringify(value.tool ?? null), tool: named.tool });
  let settings = value.settings;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch { throw say('bad_settings', { id }); }
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw say('bad_settings', { id });
  return settings;
}

/** Reads one setting through the person's records door (`door.read(type, id)` answers the value or null). */
export async function readSettings(door, settingsRecord, { tool } = {}) {
  const named = parseSettingId(settingsRecord);
  if (tool !== undefined && named.tool !== tool) throw say('other_tool', { id: settingsRecord, owner: named.tool, tool });
  if (!door || typeof door.read !== 'function') throw say('no_door', { id: settingsRecord });
  return settingsOf(await door.read(DATA.record_type, settingsRecord), settingsRecord, { tool });
}

/** The rights item a row declares to read exactly one setting (tools/records-door: a kind narrowed to one id). */
export function settingRight(id) {
  parseSettingId(id);
  return { kind: DATA.record_type, id, operations: ['records:read'] };
}

/** One row of list:settings as the `{ id, type, value }` a records:write takes, for a loader payload. */
export function settingRow({ tool, scope_kind, scope_id, name, settings, from, status = DATA.active_status }) {
  const id = settingId({ tool, scope_kind, scope_id });
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw say('bad_settings', { id });
  const value = { name: name ?? `${tool} for ${scope_kind} ${scope_id}`, tool, scope_kind, scope_id, settings, status };
  if (from !== undefined) value.from = from;
  return { id, type: DATA.record_type, value };
}
