// tools/settings/read-data/settings-record.mjs
//
// The one reader of a person's tool settings. A tool's tuned values (thresholds, word lists, model choices) are not
// files in the tool: they are rows of the person's generic list `list:settings`, each a record of type
// `record:setting` whose id names the Workshop folder it is for and its scope:
//
//   record:setting:<workshop-folder>~<scope_kind>~<scope_id>      scope_kind: person | film | piece | account
//
// and whose value is { name, tool, scope_kind, scope_id, settings, from, status } (settings is a JSON object, kept in
// the list's long-text field as JSON text). A tool takes `settings_record`
// in its request and reads the settings at run time through this module.
//
// Ported from old trillion's `setting` record kind (Trillion-X/trillion src/decision-store.mjs:751-762 at
// b6ae0ebf81, ports/setting-record.json): settingStore keeps its setting / setSetting / settings methods as they
// were, over an `eeaf` that is now a snapshot of records read through the person's records door instead of the
// decision store's SQLite. Old names `setting:<name>` are list rows `record:setting:<name>` now.
//
// As a command, for tools that are not Node (the Python tools run it with node):
//   node settings-record.mjs settings-of --record FILE --folder FOLDER     prints the settings object as JSON
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SETTINGS_LIST = 'list:settings';
export const SETTING_TYPE = 'record:setting';
export const SCOPE_KINDS = Object.freeze(['person', 'film', 'piece', 'account']);
const ID_PREFIX = `${SETTING_TYPE}:`;
const PART = /^[a-z0-9][a-z0-9._-]*$/;

/** The list row id of one tool's settings at one scope. */
export function recordId({ folder, scope_kind: kind, scope_id: scope } = {}) {
  if (typeof folder !== 'string' || !PART.test(folder)) throw new Error(`A settings folder is a Workshop folder name in lower case (got ${JSON.stringify(folder)}).`);
  if (!SCOPE_KINDS.includes(kind)) throw new Error(`scope_kind is one of ${SCOPE_KINDS.join(', ')} (got ${JSON.stringify(kind)}).`);
  if (typeof scope !== 'string' || !PART.test(scope)) throw new Error(`scope_id is lower-case letters, digits, dots, dashes or underscores (got ${JSON.stringify(scope)}).`);
  return `${ID_PREFIX}${folder}~${kind}~${scope}`;
}

/** { folder, scope_kind, scope_id } of a settings row id, or an error saying what a settings id looks like. */
export function parseRecordId(id) {
  const shape = `A settings record id reads ${ID_PREFIX}<workshop-folder>~<scope_kind>~<scope_id>`;
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) throw new Error(`${shape} (got ${JSON.stringify(id)}).`);
  const parts = id.slice(ID_PREFIX.length).split('~');
  if (parts.length !== 3) throw new Error(`${shape} (got ${JSON.stringify(id)}).`);
  const [folder, scope_kind, scope_id] = parts;
  recordId({ folder, scope_kind, scope_id });
  return { folder, scope_kind, scope_id };
}

// An `eeaf` over records already read ({ id, type, value }, as records:read and records:list answer them): read and
// ids as old trillion's record engine answered them, under the old `setting:` names; write keeps the records a
// caller then sends with records:write. Nothing here reaches a store.
export function snapshotEeaf(records = []) {
  const held = new Map();
  for (const record of records) {
    if (!record || record.type !== SETTING_TYPE || typeof record.id !== 'string' || !record.id.startsWith(ID_PREFIX)) {
      throw new Error(`Only ${SETTING_TYPE} records are settings (got ${JSON.stringify(record?.type)} ${JSON.stringify(record?.id)}).`);
    }
    held.set(record.id.slice('record:'.length), record.value === null || record.value === undefined ? null : { value: record.value });
  }
  const writes = [];
  return {
    writes,
    read: id => held.get(id) ?? null,
    ids: (type, { prefix = '' } = {}) => (type === 'setting' ? [...held.keys()].filter(id => id.startsWith(prefix)).sort() : []),
    write(records) {
      for (const { id, value } of records) {
        held.set(id, value);
        writes.push({ id: `record:${id}`, type: SETTING_TYPE, value: value === null ? null : value.value });
      }
    },
  };
}

export function settingStore(eeaf) {
  return {
    setting(name) {
      return eeaf.read(`setting:${name}`)?.value ?? null;
    },
    setSetting(name, value, context = {}) {
      eeaf.write([{ id: `setting:${name}`, type: 'setting', value: value === null ? null : { value } }], { actor: { by: 'trillion' }, ...context });
      return value;
    },
    settings(prefix = '') {
      const rootPrefix = `setting:${prefix}`;
      // Both record engines seek the literal prefix. The filter keeps the setting-name boundary explicit.
      return eeaf.ids('setting', { prefix: rootPrefix }).filter(id => id.startsWith(rootPrefix)).map(id => ({ name: id.slice('setting:'.length), value: eeaf.read(id)?.value ?? null }));
    },
  };
}

/**
 * The settings object of one settings record, for the tool in `folder`. Refuses, saying what to fix: a record of
 * another type, one for another tool's folder, one whose status is `retired`, and one with no settings object.
 */
export function settingsOf(record, folder) {
  if (!record || typeof record !== 'object') throw new Error('settings_record names no record: give the record:setting row the tool reads (records:read { id, type: "record:setting" }).');
  const store = settingStore(snapshotEeaf([record]));
  const where = parseRecordId(record.id);
  if (folder !== undefined && where.folder !== folder) throw new Error(`${record.id} holds the settings of tools/${where.folder}, not tools/${folder}: give this tool's own settings row.`);
  const value = store.setting(record.id.slice(ID_PREFIX.length));
  if (!value) throw new Error(`${record.id} is not in the person's ${SETTINGS_LIST}: load it first (its account-write payload), then read it again.`);
  if (value.status === 'retired') throw new Error(`${record.id} is retired: give the row that replaced it.`);
  // The list's `settings` field is long text holding JSON (list:settings); an object is taken as it is.
  let settings = value.settings;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch { throw new Error(`${record.id}: its settings text is not JSON; write the settings as one JSON object.`); }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${record.id} has no settings object.`);
  if (value.scope_kind !== undefined && value.scope_kind !== where.scope_kind) throw new Error(`${record.id} says scope_kind ${value.scope_kind} but its id says ${where.scope_kind}.`);
  if (value.scope_id !== undefined && value.scope_id !== where.scope_id) throw new Error(`${record.id} says scope_id ${value.scope_id} but its id says ${where.scope_id}.`);
  return settings;
}

/** Read one settings row through the person's records door (tools/records-door) and give its settings. */
export async function readSettings(door, id, folder) {
  parseRecordId(id);
  const value = await door.read(SETTING_TYPE, id);
  return settingsOf({ id, type: SETTING_TYPE, value }, folder);
}

/**
 * tool:read-a-tools-settings. Request: { settings_record: "<record:setting id>", folder?: "<workshop folder>" }.
 * Answer: { id, folder, scope_kind, scope_id, settings }.
 */
export async function readSettingsRow(input, { door }) {
  const id = input?.settings_record;
  const where = parseRecordId(id);
  const settings = await readSettings(door, id, input.folder ?? where.folder);
  return { id, ...where, settings };
}

function main(argv) {
  const [verb, ...rest] = argv;
  const flag = name => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1]; };
  if (verb !== 'settings-of' || !flag('--record')) throw new Error('usage: node settings-record.mjs settings-of --record FILE [--folder FOLDER]');
  const record = JSON.parse(readFileSync(flag('--record'), 'utf8'));
  return settingsOf(record, flag('--folder'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
