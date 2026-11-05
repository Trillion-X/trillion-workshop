// One person's tool settings, read the way old Trillion's decision store read a `setting` record (Trillion-X/trillion
// src/decision-store.mjs before 4ffa1dc4a2, lines 751-753: `setting(name)` gives the value or null). The same reader
// as settings.py, for tools written in JavaScript. A setting is a row of the generic list `list:settings`: type
// `record:setting`, id `record:setting:<workshop-folder>~<scope_kind>~<scope_id>`, fields name, tool, scope_kind,
// scope_id, settings (JSON text or an object), from and status. Node's standard library only.
import { readFileSync } from 'node:fs';

export const LIST_ID = 'list:settings';
export const RECORD_TYPE = 'record:setting';
export const ID_PREFIX = 'record:setting:';
export const SCOPE_KINDS = ['piece', 'film', 'person', 'account'];

export class SettingError extends Error {}

export function settingId(folder, scopeKind, scopeId) {
  if (!folder || /[~/]/.test(folder)) throw new SettingError(`${JSON.stringify(folder)} is not a Workshop folder name: give the folder under tools/, without ~ or /.`);
  if (!SCOPE_KINDS.includes(scopeKind)) throw new SettingError(`scope_kind ${JSON.stringify(scopeKind)} is not one of ${SCOPE_KINDS.join(', ')}.`);
  if (!scopeId) throw new SettingError('scope_id is empty: name the person, film, piece or account the settings are for.');
  return `${ID_PREFIX}${folder}~${scopeKind}~${scopeId}`;
}

export function parseId(id) {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) throw new SettingError(`${JSON.stringify(id)} is not a setting id: it starts with ${ID_PREFIX}.`);
  const rest = id.slice(ID_PREFIX.length);
  const first = rest.indexOf('~');
  const second = first < 0 ? -1 : rest.indexOf('~', first + 1);
  const parts = second < 0 ? [] : [rest.slice(0, first), rest.slice(first + 1, second), rest.slice(second + 1)];
  if (parts.length !== 3 || !parts[0] || !parts[2] || !SCOPE_KINDS.includes(parts[1])) throw new SettingError(`${JSON.stringify(id)} is not ${ID_PREFIX}<workshop-folder>~<scope_kind>~<scope_id>.`);
  return parts;
}

const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

export function makeRecord(folder, scopeKind, scopeId, settings, { name, tool, source, status = 'active' }) {
  if (!['active', 'retired'].includes(status)) throw new SettingError(`status ${JSON.stringify(status)} is not active or retired.`);
  return { id: settingId(folder, scopeKind, scopeId), type: RECORD_TYPE,
    value: { name, tool, scope_kind: scopeKind, scope_id: scopeId, settings: JSON.stringify(sorted(settings)), from: source, status } };
}

function records(given) {
  if (given === undefined || given === null) return [];
  if (typeof given === 'string') {
    try { given = JSON.parse(readFileSync(given, 'utf8')); }
    catch (error) { throw new SettingError(`settings_record names ${JSON.stringify(given)}, which could not be read as JSON (${error.message}): give the file records:read wrote, or the record itself.`); }
  }
  if (given && !Array.isArray(given) && Array.isArray(given.records)) given = given.records;
  if (!Array.isArray(given)) given = [given];
  if (!given.every(item => item && typeof item === 'object' && !Array.isArray(item))) throw new SettingError('settings_record is a record ({id, type, value}), its value, a list of them, or a JSON file of them.');
  return given;
}

function valueOf(record) {
  if (record.value && typeof record.value === 'object' && !Array.isArray(record.value)) {
    if (record.type !== undefined && record.type !== RECORD_TYPE) throw new SettingError(`${JSON.stringify(record.id)} is a ${JSON.stringify(record.type)}, not a ${RECORD_TYPE}.`);
    return [record.id ?? null, record.value];
  }
  return [record.id ?? null, record];
}

const scopeOf = record => { const [id, value] = valueOf(record); return id ? parseId(id) : [null, value.scope_kind, value.scope_id]; };

export function settingsOf(record, tool) {
  const [id, value] = valueOf(record);
  if ((value.status ?? 'active') !== 'active') throw new SettingError(`${JSON.stringify(id ?? value.name)} is ${JSON.stringify(value.status)}: read the active row that replaced it.`);
  if (tool && value.tool && value.tool !== tool) throw new SettingError(`${JSON.stringify(id)} holds settings for ${value.tool}, not ${tool}.`);
  if (typeof value.settings !== 'string') return value.settings;
  try { return JSON.parse(value.settings); }
  catch (error) { throw new SettingError(`${JSON.stringify(id)}: its settings field is not JSON (${error.message}).`); }
}

export function chosen(given, folder, scopes) {
  let list = records(given);
  if (folder) list = list.filter(record => [null, folder].includes(scopeOf(record)[0]));
  if (!list.length) return null;
  if (!scopes) {
    if (list.length > 1) throw new SettingError(`${list.length} settings records were given and no scope: say which person, film, piece or account.`);
    return list[0];
  }
  for (const [kind, scopeId] of scopes) {
    const found = list.find(record => { const [, k, s] = scopeOf(record); return k === kind && s === scopeId; });
    if (found) return found;
  }
  return null;
}

/** The settings for `folder` at the first of `scopes` ([[kind, id], ...], most specific first) that has a row, else `fallback`. */
export function setting(given, { folder, scopes, fallback = null, tool } = {}) {
  const found = chosen(given, folder, scopes);
  return found === null ? fallback : settingsOf(found, tool);
}

/**
 * The same choice read through the person's records door (tools/records-door) at run time: each scope's row by
 * records:read, most specific first; the settings of the first found, else `fallback`.
 */
export async function readSetting(door, { folder, scopes, fallback = null, tool } = {}) {
  if (!Array.isArray(scopes) || !scopes.length) throw new SettingError('Give the scopes to try, most specific first: [[scope_kind, scope_id], ...].');
  for (const [kind, scopeId] of scopes) {
    const id = settingId(folder, kind, scopeId);
    const value = await door.read(RECORD_TYPE, id);
    if (value) return settingsOf({ id, type: RECORD_TYPE, value }, tool);
  }
  return fallback;
}

/** tool:read-a-tool-setting-through-my-door: { settings_prefix: "record:setting:<folder>~", scopes, tool? } in. */
export async function readSettingRow(input, { door }) {
  const prefix = input?.settings_prefix;
  if (typeof prefix !== 'string' || !prefix.startsWith(ID_PREFIX) || !prefix.endsWith('~') || prefix.slice(ID_PREFIX.length, -1).includes('~')) {
    throw new SettingError(`settings_prefix is ${ID_PREFIX}<workshop-folder>~, the rows the run may read.`);
  }
  const folder = prefix.slice(ID_PREFIX.length, -1);
  const found = await readSetting(door, { folder, scopes: input.scopes, tool: input.tool });
  return { folder, found: found !== null, settings: found };
}
