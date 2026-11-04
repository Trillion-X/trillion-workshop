// A visitor response is an ordinary Trillion record in the context that
// installed the app. This bridge writes directly to EEAF or the Space item
// feed, so business data has only one stored copy.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedVisitorAction } from '../../edit-a-site-visually/src/public-app-definition.mjs';
import { prefixEnd } from '../../shared-code/src/workshop-facts.mjs';

const KEY = /^[a-zA-Z0-9._:-]{8,200}$/;
const APP_FIELD = '_public_app';
const rows = (sql, query, ...values) => sql.exec(query, ...values).toArray();
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function requestRecordId(installationId, requestKey) {
  const source = JSON.stringify({ installation_id: installationId, request_key: requestKey });
  return `public-app:${installationId}:${bytesToHex(blake3(new TextEncoder().encode(source)))}`;
}

function checkedSubmission(installation, { installation_id: installationId, action_id: actionId, fields, request_key: requestKey }) {
  if (!installation || installation.installation_id !== installationId || installation.status !== 'active') {
    throw new Error('This app is not accepting responses.');
  }
  if (!KEY.test(requestKey ?? '')) throw new Error('Give a stable request key for this response.');
  const action = checkedVisitorAction(installation.definition, actionId, fields);
  const recordId = requestRecordId(installationId, requestKey);
  const value = {
    ...action.body,
    [APP_FIELD]: {
      installation_id: installationId,
      app_id: installation.definition.id,
      app_version: installation.definition.version,
      action_id: action.action_id,
    },
  };
  return { action, recordId, value };
}

function payloadOf(value) {
  const { record_id: _recordId, received_at: _receivedAt, ...provenance } = value?.[APP_FIELD] ?? {};
  return { ...Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => key !== APP_FIELD)), [APP_FIELD]: provenance };
}

function replayOrConflict(existing, { recordId, action, value }) {
  if (!existing) return null;
  const provenance = existing[APP_FIELD];
  if (provenance?.record_id !== recordId || provenance.action_id !== action.action_id || !same(payloadOf(existing), value)) {
    throw new Error('This request key was already used for a different response.');
  }
  return {
    record_id: recordId,
    kind: action.kind,
    action_id: action.action_id,
    body: action.body,
    received_at: provenance.received_at,
    already_received: true,
  };
}

function valueWithIdentity(value, recordId, receivedAt) {
  return { ...value, [APP_FIELD]: { ...value[APP_FIELD], record_id: recordId, received_at: receivedAt } };
}

/** Write to the installer's EEAF store as record:<declared kind>:<stable id>. */
export function recordPrivatePublicAppAction({ installation, input, eeaf, transaction, now = () => new Date().toISOString() }) {
  if (installation?.context?.kind !== 'private') throw new Error('This app is not installed in a private account.');
  if (!eeaf || typeof eeaf.read !== 'function' || typeof eeaf.write !== 'function' || typeof transaction !== 'function') {
    throw new Error('The private record store is unavailable.');
  }
  const checked = checkedSubmission(installation, input);
  const address = `record:${checked.action.kind}:${checked.recordId}`;
  let result;
  transaction(() => {
    // The key belongs to the installation, across all its declared actions.
    // Probe at most the definition's 40 declared record kinds, so a retry or
    // conflicting action reuses the business record itself as the index.
    const kinds = new Set(installation.definition.actions.map(action => action.record_kind));
    const earlier = [...kinds].map(kind => eeaf.read(`record:${kind}:${checked.recordId}`)).find(Boolean) ?? null;
    result = replayOrConflict(earlier, checked);
    if (result) return;
    if (earlier) throw new Error('This request key was already used for a different response.');
    const at = now();
    const value = valueWithIdentity(checked.value, checked.recordId, at);
    eeaf.write([{ id: address, type: `record:${checked.action.kind}`, value }], {
      actor: { by: `public-app:${installation.definition.id}` },
      application_time: at,
      transaction_id: checked.recordId,
    });
    result = {
      record_id: checked.recordId,
      kind: checked.action.kind,
      action_id: checked.action.action_id,
      body: checked.action.body,
      received_at: at,
      already_received: false,
    };
  });
  return result;
}

/** Write one shared app response into the Space's existing, readable item feed. */
export function recordSpacePublicAppAction({ installation, input, sql, transaction, afterWrite = () => {}, now = () => new Date().toISOString() }) {
  if (installation?.context?.kind !== 'space') throw new Error('This app is not installed in a Space.');
  if (!sql || typeof sql.exec !== 'function' || typeof transaction !== 'function') throw new Error('The shared record store is unavailable.');
  const checked = checkedSubmission(installation, input);
  const sourceRef = checked.recordId;
  let result;
  let inserted = false;
  transaction(() => {
    const earlier = rows(sql, 'SELECT id, kind, body, contributed_by, added_at FROM space_items WHERE space_id = ? AND contributed_by = ? AND source_ref = ?', installation.context.id, installation.installed_by, sourceRef)[0];
    if (earlier) {
      result = replayOrConflict(JSON.parse(earlier.body), checked);
      if (!result) throw new Error('This request key was already used for a different response.');
      return;
    }
    const collision = rows(sql, 'SELECT id FROM space_items WHERE id = ?', checked.recordId)[0];
    if (collision) throw new Error('This request key was already used for a different response.');
    const at = now();
    const value = valueWithIdentity(checked.value, checked.recordId, at);
    sql.exec('INSERT INTO space_items (id, space_id, kind, title, body, origin, contributed_by, source_ref, about, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      checked.recordId, installation.context.id, checked.action.kind, null, JSON.stringify(value), 'space', installation.installed_by, sourceRef, '[]', at);
    inserted = true;
    result = {
      record_id: checked.recordId,
      kind: checked.action.kind,
      action_id: checked.action.action_id,
      body: checked.action.body,
      received_at: at,
      already_received: false,
    };
  });
  // Watchers hear only the new canonical item and only after the database commits.
  if (inserted) afterWrite({ space_id: installation.context.id, item_id: checked.recordId });
  return result;
}

/** Read the same EEAF records generic tools and rules consume. */
export function privatePublicAppRecords({ installation, eeaf, limit = 50 }) {
  if (installation?.context?.kind !== 'private') throw new Error('That app installation was not found.');
  const count = Math.max(1, Math.min(100, Number(limit) || 50));
  const records = [];
  for (const action of installation.definition.actions) {
    const type = `record:${action.record_kind}`;
    for (const id of eeaf.ids(type, { limit: 1000 })) {
      const value = eeaf.read(id);
      if (value?.[APP_FIELD]?.installation_id !== installation.installation_id) continue;
      records.push({
        record_id: value[APP_FIELD].record_id,
        kind: action.record_kind,
        action_id: value[APP_FIELD].action_id,
        body: Object.fromEntries(action.fields.filter(field => Object.hasOwn(value, field.id)).map(field => [field.id, value[field.id]])),
        received_at: value[APP_FIELD].received_at,
      });
    }
  }
  records.sort((a, b) => b.received_at.localeCompare(a.received_at) || b.record_id.localeCompare(a.record_id));
  return { installation_id: installation.installation_id, records: records.slice(0, count) };
}

/** A Space belongs to the membership context after install; installed_by is attribution, not a permanent reader. */
export async function spacePublicAppRecords({ installation, sql, space_id: spaceId = installation?.context?.id, relay, authorizeRead, limit = 50 }) {
  if (installation?.context?.kind !== 'space') throw new Error('That app installation was not found.');
  if (spaceId !== installation.context.id) throw new Error('That app installation was not found.');
  if (typeof authorizeRead !== 'function') throw new Error('A current pursuit member check is required.');
  await authorizeRead(spaceId, relay);
  const count = Math.max(1, Math.min(100, Number(limit) || 50));
  const items = rows(sql, 'SELECT id, kind, body, added_at FROM space_items WHERE space_id = ? AND contributed_by = ? AND source_ref >= ? AND source_ref < ? AND withdrawn_at IS NULL ORDER BY added_at DESC, id DESC LIMIT ?',
    installation.context.id, installation.installed_by, `public-app:${installation.installation_id}:`, prefixEnd(`public-app:${installation.installation_id}:`), count);
  return {
    installation_id: installation.installation_id,
    records: items.map(item => {
      const value = JSON.parse(item.body);
      return {
        record_id: value[APP_FIELD]?.record_id ?? item.id,
        kind: item.kind,
        action_id: value[APP_FIELD]?.action_id,
        body: Object.fromEntries(Object.entries(value).filter(([key]) => key !== APP_FIELD)),
        received_at: value[APP_FIELD]?.received_at ?? item.added_at,
      };
    }),
  };
}
