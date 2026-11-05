// Read a tool's settings from the person's `list:settings` row: the one reader every Workshop tool shares (the same rules
// as read_setting.py beside it). A setting is one record of type `record:setting` with the id
// `record:setting:<workshop-folder>~<scope_kind>~<scope_id>` (scope_kind person, film, piece or account); its value holds
// name, tool, scope_kind, scope_id, settings (an object, or JSON text), from and status. This ports old trillion's
// `setting` record kind (src/decision-store.mjs `setting(name)`: the value, or nothing) to a row read through the door.

export const TYPE = 'record:setting';
export const PREFIX = 'record:setting:';
export const SCOPE_KINDS = Object.freeze(['person', 'film', 'piece', 'account']);
const PART = /^[a-z0-9][a-z0-9._-]*$/;

export class SettingRefused extends Error {
  constructor(message) { super(message); this.name = 'SettingRefused'; }
}

export function settingId(folder, scopeKind, scopeId) {
  if (typeof folder !== 'string' || !PART.test(folder)) throw new SettingRefused(`the tool folder must be a Workshop folder name in lower case, not ${JSON.stringify(folder)}`);
  if (!SCOPE_KINDS.includes(scopeKind)) throw new SettingRefused(`scope_kind must be one of ${SCOPE_KINDS.join(', ')}, not ${JSON.stringify(scopeKind)}`);
  if (typeof scopeId !== 'string' || !PART.test(scopeId)) throw new SettingRefused(`scope_id must be lower-case letters, digits, dots, dashes or underscores, not ${JSON.stringify(scopeId)}`);
  return `${PREFIX}${folder}~${scopeKind}~${scopeId}`;
}

export function parseSettingId(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) throw new SettingRefused(`a settings record id starts with ${JSON.stringify(PREFIX)}; ${JSON.stringify(id)} does not`);
  const parts = id.slice(PREFIX.length).split('~');
  if (parts.length !== 3) throw new SettingRefused(`a settings record id is ${PREFIX}<workshop-folder>~<scope_kind>~<scope_id>; ${JSON.stringify(id)} is not`);
  const [tool, scope_kind, scope_id] = parts;
  settingId(tool, scope_kind, scope_id);
  return { tool, scope_kind, scope_id };
}

// Check one settings record ({ id, type, value }, as records:read answers it) and answer its parts and its settings.
export function settingOf(record, folder) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new SettingRefused('settings_record must be the record the door read, { id, type, value }');
  const where = parseSettingId(record.id);
  if ((record.type ?? TYPE) !== TYPE) throw new SettingRefused(`settings_record ${record.id} has type ${JSON.stringify(record.type)}; a setting is of type ${JSON.stringify(TYPE)}`);
  if (folder !== undefined && where.tool !== folder) throw new SettingRefused(`settings_record ${record.id} holds the settings of ${where.tool}, not of ${folder}: give this tool's own row (${PREFIX}${folder}~...)`);
  const value = record.value;
  if (value === null || value === undefined) throw new SettingRefused(`there is no setting ${record.id} in the person's list:settings: write it, or give the settings inline`);
  if (typeof value !== 'object' || Array.isArray(value)) throw new SettingRefused(`settings_record ${record.id} has no value object`);
  for (const field of ['tool', 'scope_kind', 'scope_id']) {
    if (field in value && value[field] !== where[field]) throw new SettingRefused(`settings_record ${record.id} says ${field} is ${JSON.stringify(value[field])}, but its id says ${JSON.stringify(where[field])}: correct the row`);
  }
  if (value.status === 'retired') throw new SettingRefused(`setting ${record.id} is retired: give the row that replaced it`);
  let settings = value.settings;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch (error) { throw new SettingRefused(`the settings field of ${record.id} is not JSON: ${error.message}`); }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new SettingRefused(`the settings field of ${record.id} must be a JSON object`);
  return { id: record.id, ...where, name: value.name ?? null, from: value.from ?? null, status: value.status ?? null, settings };
}

// The settings a request carries: from settings_record (checked), else inline settings; null when neither and not required.
export function settingsOf(request, folder, { required = true } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new SettingRefused('the request must be a JSON object');
  if (request.settings_record !== undefined && request.settings_record !== null) return settingOf(request.settings_record, folder).settings;
  if (request.settings !== undefined && request.settings !== null) {
    if (typeof request.settings !== 'object' || Array.isArray(request.settings)) throw new SettingRefused('settings must be a JSON object');
    return request.settings;
  }
  if (required) throw new SettingRefused(`give settings_record: the row ${PREFIX}${folder ?? '<workshop-folder>'}~<scope_kind>~<scope_id> from the person's list:settings, as the door read it (or settings inline)`);
  return null;
}

// Read one settings row through a records door (tools/records-door: openRecordsDoor or recordsDoorFromCall) and answer
// it as records:read does, { id, type, value } with value null when the row is absent: the door is the only way in.
export async function readSetting(door, id) {
  parseSettingId(id);
  const found = await door.readRecord(TYPE, id);
  return { id, type: TYPE, value: found?.value ?? null };
}

// tool:read-a-tools-settings, run by tools/records-door/do-work/run-an-export.mjs: read one settings row through the
// person's door and answer it checked, with the record itself to hand to an on-your-computer tool as settings_record.
export async function read(input, { door }) {
  const id = input?.id;
  parseSettingId(id);
  const record = await readSetting(door, id);
  if (record.value === null) return { id, found: false, record };
  const checked = settingOf(record, input.tool);
  return { id, found: true, tool: checked.tool, scope_kind: checked.scope_kind, scope_id: checked.scope_id, name: checked.name, from: checked.from, status: checked.status, settings: checked.settings, record };
}
