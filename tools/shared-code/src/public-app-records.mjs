// Durable installation and visitor records. The same table and validation run
// inside a private PersonStore or the shared Network store. An acknowledged
// visitor action is committed in that context's SQLite before the reply.
import { checkedInstallationContext, checkedPublicAppDefinition, checkedVisitorAction } from '../../edit-a-site-visually/src/public-app-definition.mjs';

const now = () => new Date().toISOString();
const ID = /^[a-f0-9]{32}$/;
const KEY = /^[a-zA-Z0-9._:-]{8,200}$/;

export function setUpPublicAppRecords(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS public_app_installations (id TEXT PRIMARY KEY, definition TEXT NOT NULL, context_kind TEXT NOT NULL, context_id TEXT NOT NULL, installed_by TEXT NOT NULL, status TEXT NOT NULL, installed_at TEXT NOT NULL, ended_at TEXT)');
  sql.exec('CREATE TABLE IF NOT EXISTS public_app_visitor_records (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, request_key TEXT NOT NULL, kind TEXT NOT NULL, action_id TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(installation_id, request_key))');
  sql.exec('CREATE INDEX IF NOT EXISTS public_app_visitor_records_by_installation ON public_app_visitor_records (installation_id, received_at DESC)');
}

export function installPublicApp(sql, { installation_id: id, definition, context, installed_by: installedBy, live = true }) {
  setUpPublicAppRecords(sql);
  if (!ID.test(id ?? '')) throw new Error('The installation id is invalid.');
  const checked = checkedPublicAppDefinition(definition);
  const selected = checkedInstallationContext(context);
  if (typeof installedBy !== 'string' || !installedBy) throw new Error('The installer is needed.');
  if (typeof live !== 'boolean') throw new Error('Say whether the app should be live.');
  const earlier = sql.exec('SELECT * FROM public_app_installations WHERE id = ?', id).toArray()[0];
  if (earlier) {
    if (earlier.context_kind !== selected.kind || earlier.context_id !== selected.id || earlier.installed_by !== installedBy || earlier.definition !== JSON.stringify(checked)) throw new Error('That installation id is already in use.');
    return installationView(earlier);
  }
  const at = now();
  const status = live ? 'active' : 'ended';
  sql.exec('INSERT INTO public_app_installations (id, definition, context_kind, context_id, installed_by, status, installed_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, JSON.stringify(checked), selected.kind, selected.id, installedBy, status, at, live ? null : at);
  return { installation_id: id, definition: checked, context: selected, installed_by: installedBy, status, installed_at: at, ...(live ? {} : { ended_at: at }) };
}

function installationView(row) {
  return { installation_id: row.id, definition: JSON.parse(row.definition), context: { kind: row.context_kind, id: row.context_id }, installed_by: row.installed_by, status: row.status, installed_at: row.installed_at, ended_at: row.ended_at ?? null };
}

export function publicAppInstallation(sql, id) {
  // A read makes no table: a store that never installed an app holds no installation (and a fenced store may make none).
  if (!ID.test(id ?? '') || !sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'public_app_installations' LIMIT 1").toArray().length) return null;
  const row = sql.exec('SELECT * FROM public_app_installations WHERE id = ?', id).toArray()[0];
  return row ? installationView(row) : null;
}

export function privatePublicAppInstallations(sql, ownerId) {
  setUpPublicAppRecords(sql);
  if (typeof ownerId !== 'string' || !ownerId) return [];
  return sql.exec("SELECT * FROM public_app_installations WHERE context_kind = 'private' AND context_id = ? ORDER BY installed_at DESC, id DESC LIMIT 100", ownerId).toArray().map(installationView);
}

/** Takes one installation offline (live false) or puts it back (live true). Asking for the state it is already in changes nothing. */
export function setPublicAppInstallationLive(sql, id, live) {
  const row = publicAppInstallation(sql, id);
  if (!row) throw new Error('That app installation was not found.');
  if (typeof live !== 'boolean') throw new Error('Say whether the app should be live.');
  const status = live ? 'active' : 'ended';
  if (row.status === status) return row;
  const endedAt = live ? null : now();
  sql.exec('UPDATE public_app_installations SET status = ?, ended_at = ? WHERE id = ?', status, endedAt, id);
  return { ...row, status, ended_at: endedAt };
}

export function recordPublicAppVisitorAction(sql, { installation_id: id, action_id: actionId, fields, request_key: requestKey }) {
  const installation = publicAppInstallation(sql, id);
  if (!installation || installation.status !== 'active') throw new Error('This app is not accepting responses.');
  if (!KEY.test(requestKey ?? '')) throw new Error('Give a stable request key for this response.');
  const checked = checkedVisitorAction(installation.definition, actionId, fields);
  const earlier = sql.exec('SELECT * FROM public_app_visitor_records WHERE installation_id = ? AND request_key = ?', id, requestKey).toArray()[0];
  if (earlier) {
    if (earlier.kind !== checked.kind || earlier.action_id !== checked.action_id || earlier.body !== JSON.stringify(checked.body)) throw new Error('This request key was already used for a different response.');
    return { record_id: earlier.id, kind: earlier.kind, action_id: earlier.action_id, body: JSON.parse(earlier.body), received_at: earlier.received_at, already_received: true };
  }
  const at = now();
  const recordId = `public-app:${id}:${requestKey}`;
  sql.exec('INSERT INTO public_app_visitor_records (id, installation_id, request_key, kind, action_id, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)', recordId, id, requestKey, checked.kind, checked.action_id, JSON.stringify(checked.body), at);
  return { record_id: recordId, kind: checked.kind, action_id: checked.action_id, body: checked.body, received_at: at, already_received: false };
}

export function publicAppVisitorRecords(sql, id, { limit = 50 } = {}) {
  const installation = publicAppInstallation(sql, id);
  if (!installation) throw new Error('That app installation was not found.');
  const count = Math.max(1, Math.min(100, Number(limit) || 50));
  const records = sql.exec('SELECT id, kind, action_id, body, received_at FROM public_app_visitor_records WHERE installation_id = ? ORDER BY received_at DESC, id DESC LIMIT ?', id, count).toArray().map(row => ({ record_id: row.id, kind: row.kind, action_id: row.action_id, body: JSON.parse(row.body), received_at: row.received_at }));
  return { installation_id: id, records };
}
