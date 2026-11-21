// tools/settings/read-data/settings-store.mjs
//
// PURPOSE
//   The settings table in the person's own database, as statements and answers. A person's tool settings are rows of
//   the table the owner-places role `settings` names (its connection name and schema.table), made from
//   settings-table.json. This module makes every statement a read, a create or a write needs, each with its own
//   statement_timeout_ms, and reads the answers back into the record shape settings.mjs reads. The caller runs each
//   request with tool:run-sql-in-my-database (one statement per call) and hands the answer back here.
//   Pure: no network, no database, no clock. The readers in settings.mjs and settings.py stay pure too.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every write is compare-and-set: a row kept with no expected row is inserted only when no row has that id (zero
//      rows changed means it already exists, refused in words); a row kept over an expected row updates only where
//      its version is still the one it was read at (zero rows changed means it moved, refused in words naming the id).
//      No write overwrites a row it did not read.
//   2. Every statement carries statement_timeout_ms from settings-table.json; none is sent without one.
//   3. The table's name is a schema.table pair of plain identifiers, checked before it is placed in a statement; it is
//      never taken from a request, only from the owner-places role.
//   4. A missing role reads as no settings, with words saying the role is missing. A missing table reads as no settings.
//      Nothing here makes up a value a row does not hold.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { readFileSync } from 'node:fs';
import { ID_PREFIX, RECORD_TYPE, parseId, SettingError } from './settings.mjs';

export class SettingsStoreError extends SettingError {}

const TABLE_DATA = JSON.parse(readFileSync(new URL('./settings-table.json', import.meta.url), 'utf8'));
export const SETTINGS_ROLE = 'settings';
export const MISSING_ROLE_WORDS = `The owner-places record of this person has no ${SETTINGS_ROLE} role: their tool settings are read as none until the role is written as {credential_name: "<name>-connection", table: "<schema>.<table>"}.`;
const TABLE_NAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const CONNECTION_NAME = /-connection$/;
const UNDEFINED_TABLE = /42P01|relation .* does not exist/;

const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };

/** The settings role of the person's owner-places record ({roles: {settings: {credential_name, table}}}), given as its
 *  value or as the text of it. Null when the record has no settings role. A role that is there but not shaped right is refused. */
export function settingsRoleOf(ownerPlaces) {
  const record = typeof ownerPlaces === 'string' ? parseJson(ownerPlaces) : ownerPlaces;
  const role = record?.roles?.[SETTINGS_ROLE];
  if (role === undefined) return null;
  if (!role || typeof role !== 'object' || typeof role.credential_name !== 'string' || !CONNECTION_NAME.test(role.credential_name)
    || typeof role.table !== 'string' || !TABLE_NAME.test(role.table)) {
    throw new SettingsStoreError(`The ${SETTINGS_ROLE} role must be {credential_name: "<name>-connection", table: "<schema>.<table>"} with plain names; it is ${JSON.stringify(role)}.`);
  }
  return { credential_name: role.credential_name, table: role.table };
}

const sqlOf = (key, role) => TABLE_DATA[key].replaceAll('{table}', role.table);

/** One statement for the caller to run: `input` is the request tool:run-sql-in-my-database takes, `meta` says what it is for. */
const request = (role, sql, params, meta = {}) => ({
  input: { credential_name: role.credential_name, sql, params, statement_timeout_ms: TABLE_DATA.statement_timeout_ms },
  meta,
});

/** The statement that makes the table when it is not there yet. Run it before the first write. */
export function createRequest(role) {
  return request(role, sqlOf('create', role), [], { mode: 'create' });
}

/** The read of one folder's setting rows (every id starting record:setting:<folder>~). */
export function readRequest(role, folder) {
  if (!folder || /[~/]/.test(folder)) throw new SettingsStoreError(`${JSON.stringify(folder)} is not a Workshop folder name: give the folder under tools/, without ~ or /.`);
  return request(role, sqlOf('select', role), [`${ID_PREFIX}${folder}~`], { mode: 'read' });
}

/** The record shape settings.mjs reads, from one read's answer ({rows} from the run, or {error} with the database's words).
 *  A table that is not there yet gives no records; any other error is refused with the database's words. */
export function recordsOf(answer) {
  if (answer?.error !== undefined) {
    if (UNDEFINED_TABLE.test(String(answer.error))) return { records: [], missing: true };
    throw new SettingsStoreError(`The settings table could not be read: ${answer.error}`);
  }
  const rows = Array.isArray(answer?.rows) ? answer.rows : [];
  return {
    records: rows.map(row => ({
      id: row.id,
      type: RECORD_TYPE,
      value: { name: row.name, tool: row.tool, scope_kind: row.scope_kind, scope_id: row.scope_id, settings: row.settings,
        from: row.source, status: row.status, version: Number(row.version) },
    })),
    missing: false,
  };
}

const settingsText = settings => {
  if (typeof settings === 'string') {
    if (parseJson(settings) === null) throw new SettingsStoreError('settings must be JSON text or an object.');
    return settings;
  }
  return JSON.stringify(settings ?? null);
};

const versionOf = expected => {
  const version = expected?.value?.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new SettingsStoreError(`${JSON.stringify(expected?.id ?? null)} was read without a version: read it from the settings table again before writing it.`);
  }
  return version;
};

/** The write statements for the rows a reader keeps (settings.mjs and read_setting.py `keep`: each row with `expected`).
 *  The create statement comes first when there are rows to keep. */
export function writeRequests(role, keep) {
  if (!Array.isArray(keep) || keep.length === 0) return [];
  const out = [createRequest(role)];
  for (const row of keep) {
    parseId(row.id);
    const value = row.value ?? {};
    if (row.type !== undefined && row.type !== RECORD_TYPE) throw new SettingsStoreError(`${JSON.stringify(row.id)} is a ${JSON.stringify(row.type)}, not a ${RECORD_TYPE}.`);
    const common = [value.name, value.tool, value.scope_kind, value.scope_id, settingsText(value.settings), value.from, value.status ?? 'active'];
    if (row.expected === null || row.expected === undefined) {
      out.push(request(role, sqlOf('insert', role), [row.id, ...common], { mode: 'insert', id: row.id }));
    } else {
      const version = versionOf(row.expected);
      out.push(request(role, sqlOf('update', role), [row.id, ...common, version], { mode: 'update', id: row.id, version }));
    }
  }
  return out;
}

/** The words for one write's answer: { id, written, words }. Zero rows changed is a refusal, never an overwrite. */
export function writeOutcome(writeRequest, answer) {
  const { id, mode, version } = writeRequest.meta;
  if (answer?.error !== undefined) throw new SettingsStoreError(`${id} was not written: ${answer.error}`);
  if (answer?.row_count === 1) return { id, written: true, words: `${id} written.` };
  if (mode === 'insert') return { id, written: false, words: `${id} was not written: a row with that id already exists. Read it again and keep the change over it.` };
  return { id, written: false, words: `${id} was not written: its row has changed since version ${version} was read. Read it again and keep the change over the new version.` };
}

/** The carry of rows made before the table existed: each record:setting row handed in is inserted when its id is free.
 *  Used once, when the engine's old rows are read; the rows are not changed here. */
export function carryRequests(role, storedRecords) {
  if (!Array.isArray(storedRecords)) throw new SettingsStoreError('The rows to carry are a list of {id, type, value}.');
  const settingRows = storedRecords.filter(record => record && record.type === RECORD_TYPE);
  return writeRequests(role, settingRows.map(record => ({ id: record.id, type: record.type, value: record.value, expected: null })));
}
