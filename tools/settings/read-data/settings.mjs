// tools/settings/read-data/settings.mjs
//
// The one Workshop reader for a person's tool settings: rows of their generic list `list:settings`, each a record of
// type `record:setting` with id `record:setting:<workshop-folder>~<scope_kind>~<scope_id>`, read through the run's
// records door. Ported from old Trillion's `setting` record kind (Trillion-X/trillion src/decision-store.mjs at
// 4ffa1dc4a2^, lines 8 and 751-754: `setting(name)` read `setting:<name>` and answered its value or null).
//
// A tool takes `settings_record` (that id) in its input. Its row grants records:read on the prefix
// `record:setting:<its folder>~`, and the tool calls settingsFor(input, { door, folder, defaults }). The settings the
// tool runs with are, in order of strength: its own `defaults`, the record's `settings`, the input's own `settings`.
import { readFileSync } from 'node:fs';

export const SETTING_TYPE = 'record:setting';
export const SETTING_LIST = 'list:settings';
export const SCOPE_KINDS = Object.freeze(['person', 'film', 'piece', 'account']);
const PART = /^[a-z0-9][a-z0-9._-]*$/;
const RULES = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));

export class SettingsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The id of one setting row, from its Workshop folder and scope. */
export function settingId({ folder, scope_kind, scope_id }) {
  for (const [name, value] of [['folder', folder], ['scope_id', scope_id]]) {
    if (typeof value !== 'string' || !PART.test(value)) throw new SettingsError('bad_id', `${name} must be lower-case letters, digits, dots, dashes or underscores (got ${JSON.stringify(value)}).`);
  }
  if (!SCOPE_KINDS.includes(scope_kind)) throw new SettingsError('bad_id', `scope_kind must be one of ${SCOPE_KINDS.join(', ')} (got ${JSON.stringify(scope_kind)}).`);
  return `${SETTING_TYPE}:${folder}~${scope_kind}~${scope_id}`;
}

/** Split a setting id into { folder, scope_kind, scope_id }, refusing any other shape. */
export function parseSettingId(id) {
  if (typeof id !== 'string' || !id.startsWith(`${SETTING_TYPE}:`)) throw new SettingsError('bad_id', `A settings record id starts with ${SETTING_TYPE}: (got ${JSON.stringify(id)}).`);
  const parts = id.slice(SETTING_TYPE.length + 1).split('~');
  if (parts.length !== 3) throw new SettingsError('bad_id', `A settings record id is ${SETTING_TYPE}:<workshop-folder>~<scope_kind>~<scope_id> (got ${JSON.stringify(id)}).`);
  const [folder, scope_kind, scope_id] = parts;
  settingId({ folder, scope_kind, scope_id });
  return { folder, scope_kind, scope_id };
}

/** Check one setting row's value: the fields list:settings keeps. Answers the value, or throws naming what is wrong. */
export function checkSettingValue(id, value) {
  const { folder, scope_kind, scope_id } = parseSettingId(id);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError('bad_value', `${id} holds no setting row.`);
  for (const field of RULES.required_fields) {
    if (!(field in value)) throw new SettingsError('bad_value', `${id} has no ${field}.`);
  }
  if (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw new SettingsError('bad_value', `${id}: settings must be a JSON object.`);
  if (value.scope_kind !== scope_kind || value.scope_id !== scope_id) throw new SettingsError('bad_value', `${id}: its scope_kind and scope_id do not match its id.`);
  if (!RULES.statuses.includes(value.status)) throw new SettingsError('bad_value', `${id}: status must be one of ${RULES.statuses.join(', ')}.`);
  return { ...value, folder };
}

/**
 * Read one setting row through the run's records door, like old Trillion's setting(name): the row, or null when the
 * person keeps none under that id. A row of another tool's folder is refused, so a tool never reads another's settings.
 */
export async function readSetting(door, id, { folder } = {}) {
  const parsed = parseSettingId(id);
  if (folder !== undefined && parsed.folder !== folder) throw new SettingsError('other_tool', `${id} belongs to tools/${parsed.folder}, not tools/${folder}: give a record:setting:${folder}~... id.`);
  const value = await door.read(SETTING_TYPE, id);
  if (value === null || value === undefined) return null;
  return checkSettingValue(id, value);
}

const isPlain = value => value && typeof value === 'object' && !Array.isArray(value);

/** Lay `over` on `under`: plain objects merge key by key, anything else is replaced whole. */
export function layOver(under, over) {
  if (!isPlain(under) || !isPlain(over)) return over === undefined ? under : over;
  const out = { ...under };
  for (const [key, value] of Object.entries(over)) out[key] = key in under ? layOver(under[key], value) : value;
  return out;
}

/**
 * The settings a tool runs with: its defaults, then the record named by input.settings_record, then input.settings.
 * Answers { settings, from } where from names the record used (or null). A named record that is absent is refused,
 * since running on defaults when the person named their own would silently change the answer.
 */
export async function settingsFor(input = {}, { door, folder, defaults = {} } = {}) {
  let settings = defaults;
  let from = null;
  if (input.settings_record !== undefined) {
    if (!door) throw new SettingsError('no_door', 'settings_record was given but this run was handed no records door.');
    const row = await readSetting(door, input.settings_record, { folder });
    if (!row) throw new SettingsError('absent', `No ${input.settings_record} in list:settings. Write the row first, or leave settings_record out to run on the defaults.`);
    if (row.status !== 'active') throw new SettingsError('not_active', `${input.settings_record} is ${row.status}; only an active setting row is used.`);
    settings = layOver(settings, row.settings);
    from = { id: input.settings_record, from: row.from ?? null };
  }
  if (input.settings !== undefined) {
    if (!isPlain(input.settings)) throw new SettingsError('bad_input', 'settings, when given, must be a JSON object.');
    settings = layOver(settings, input.settings);
  }
  return { settings, from };
}

/** The row function: answer the settings one record holds, merged over nothing. */
export async function readSettingRow(input, { door }) {
  const row = await readSetting(door, input.id);
  return { id: input.id, found: row !== null, row };
}
