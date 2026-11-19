// src/workspace/records-worker-source.ts
//
// PURPOSE
//   The Workshop Worker's records source: the one file that names the Worker's record addresses. The engine (records.ts)
//   asks the page's mounted source for records by label and for writes. This source answers from the person's own
//   store at /work/api/records, keeps small writes on this device until that store accepts them (quiet-writes.ts),
//   follows changes made elsewhere over the live socket (store-changes.ts), and opens placed live rooms (live-room.ts).
//   A page mounts it at its entry: setWorkspaceRecordsSource(workerRecordsSource()).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every address this store answers at is named here and nowhere else in the records engine.
//   2. Each small write goes through the device outbox (quiet-writes.ts), so it survives a reload and is sent again while
//      the store is busy. This file only translates the engine's record operation to that outbox's address for it.

import { bodyOf, readJson } from './api.ts';
import { isQuietWriteCurrent, isQuietWritePendingVersion, isQuietWriteWaiting, onQuietWriteAccepted, onQuietWriteRefusedReceipt, quietWritesAreReadOnly, restoreQuietWrites, sendQuietly, trackQuietWriteAcceptance, type QuietWriteReceipt } from './quiet-writes.ts';
import { onRecordsChange, type ReadDepends } from './store-changes.ts';
import { openLiveRoom } from './live-room.ts';
import liveKeys from '../live-keys.json' with { type: 'json' };
import { RECORDS_OP, type RecordsAdmin, type RecordsOutbox, type RecordsReceipt, type RecordsRead, type RecordsWriteReply, type WorkspaceRecordsSource } from './records-source.ts';

const RECORDS_ADDRESS = '/work/api/records';
const addressOf = (operation: string): string => (operation === RECORDS_OP ? RECORDS_ADDRESS : operation);
const operationOf = (address: string): string => (address === RECORDS_ADDRESS ? RECORDS_OP : address);

// What the saved records depend on: every row of the saved records' table, whatever the label (a change elsewhere is
// compared label by label once read).
const SAVED_RECORDS_DEPEND: ReadDepends = { version: null, ids: [], rows: [], members: liveKeys.tables.filter(row => row.table === 'workspace_records').map(row => ({ prefix: row.key, fields: null })) };

function workerOutbox(): RecordsOutbox {
  const operations = (writes: QuietWriteReceipt[]): RecordsReceipt[] => writes.map(write => ({ ...write, path: operationOf(write.path) }));
  return {
    send: write => { sendQuietly({ ...write, path: addressOf(write.path) }); },
    track: write => trackQuietWriteAcceptance({ ...write, path: addressOf(write.path) }),
    isWaiting: key => isQuietWriteWaiting(key),
    isPendingVersion: (key, after) => isQuietWritePendingVersion(key, after),
    isCurrent: receipt => isQuietWriteCurrent({ ...receipt, path: addressOf(receipt.path) }),
    onAccepted: listener => onQuietWriteAccepted((writes, result) => listener(operations(writes), result)),
    onRefusedReceipt: listener => onQuietWriteRefusedReceipt((writes, status) => listener(operations(writes), status)),
    restore: async () => (await restoreQuietWrites()).map(write => ({ ...write, path: operationOf(write.path) })),
    readOnly: () => quietWritesAreReadOnly(),
  };
}

const workerAdmin: RecordsAdmin = {
  history: async query => {
    const params = new URLSearchParams({ address: query.address, scope_id: query.scope_id, limit: String(query.limit), ...(query.before ? { before: String(query.before) } : {}) });
    return readJson(`${RECORDS_ADDRESS}/history?${params}`, { method: 'GET', cache: 'no-store' });
  },
  revision: id => readJson(`${RECORDS_ADDRESS}/revisions/${encodeURIComponent(id)}`, { method: 'GET', cache: 'no-store' }),
  restoreRevision: input => readJson(`${RECORDS_ADDRESS}/revisions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  erase: (address, expected_identity, scope_id) => readJson(`${RECORDS_ADDRESS}/erase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ record: address, ...(expected_identity !== undefined ? { expected_identity } : {}), ...(scope_id ? { scope_id } : {}) }),
  }),
  conflicts: async ({ limit, after }) => {
    const query = new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) });
    const reply = await fetch(`${RECORDS_ADDRESS}/conflicts?${query}`, { credentials: 'same-origin' });
    if (!reply.ok) throw new Error('Could not read workspace conflicts.');
    return bodyOf(reply, body => body.json());
  },
  conflict: async id => {
    const reply = await fetch(`${RECORDS_ADDRESS}/conflicts/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    const body = await bodyOf(reply, answer => answer.json()) as { conflict?: Record<string, unknown>; error?: string };
    if (!reply.ok || !body.conflict) throw new Error(body.error ?? 'Could not read those workspace versions.');
    return body.conflict;
  },
  resolveConflict: async (id, branchIdentity) => {
    const reply = await fetch(RECORDS_ADDRESS, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolve_conflict: { id, branch_identity: branchIdentity } }),
    });
    const result = await bodyOf(reply, answer => answer.json()) as { resolved?: boolean; address?: string; kept?: string; conflict_id?: string; error?: string };
    if (!reply.ok) throw new Error(result.error ?? 'Could not resolve workspace conflict.');
    return result as { resolved: boolean; address?: string; kept?: string; conflict_id?: string };
  },
};

/** The Workshop Worker's source: the person's own store, reached at its records address. */
export function workerRecordsSource(): WorkspaceRecordsSource {
  return {
    read: (labels, options) => {
      const query = new URLSearchParams();
      for (const label of labels) query.append('label', label);
      return readJson<RecordsRead>(`${RECORDS_ADDRESS}?${query}`, options?.fresh ? { method: 'GET', cache: 'no-store' } : {});
    },
    write: body => readJson<RecordsWriteReply>(RECORDS_ADDRESS, { method: 'POST', body: JSON.stringify(body) }),
    outbox: workerOutbox(),
    subscribe: onChange => onRecordsChange(onChange, () => SAVED_RECORDS_DEPEND, undefined, [RECORDS_ADDRESS]),
    openRoom: path => openLiveRoom(path),
    admin: workerAdmin,
  };
}
