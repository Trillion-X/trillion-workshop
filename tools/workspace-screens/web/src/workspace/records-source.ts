// src/workspace/records-source.ts
//
// PURPOSE
//   The seam between the page's record engine (records.ts) and the store that keeps the person's saved records. The
//   engine reads records by label, sends write batches, keeps small writes until a store accepts them, and follows
//   changes made elsewhere. The page mounts the source it uses once, at its entry (setWorkspaceRecordsSource). Nothing
//   in the engine names a server or an address: a source that talks to a server keeps its addresses to itself
//   (remoteRecordsSource(transport) takes the host's own reads and writes). Two sources need no server: memoryRecordsSource() keeps
//   records in this page's memory, and seededRecordsSource(rows) starts that memory from rows the page gives at mount.
//
// SHAPE (the smallest set the sidebar and the screen arrangement call, plus what the engine keeps for its own writes)
//   read(labels, { fresh? })   the values held under the labels; a label with no value is left out of `records`
//   write(body)                one confirmed batch ({ conflict_policy?, writes }); a refusal throws with `.status`
//   outbox                     small writes kept until the store accepts them (RecordsOutbox)
//   subscribe?(onChange)       changes made elsewhere; a source where none happen omits it
//   openRoom?(path)            live rooms for placed labels; a source without rooms has no placed labels
//   admin?                     document history, revisions, erase and conflicts; a source that keeps none omits it
//
// NON-NEGOTIABLE INVARIANTS
//   1. No source is assumed. A page that reads or writes records before it mounts one gets an error that says so; it
//      never writes into memory it would lose.
//   2. A page mounts one source. Mounting another replaces it, and the engine's listeners are detached from the old one
//      and attached to the new one (onRecordsSourceMounted).
//   3. The one name the engine and a source share for the record protocol is RECORDS_OP. The source maps it to its own
//      address; no other address appears in the engine.
//   4. A memory source confirms a write in a later turn, never inside the call that made it, as a store does, so the
//      engine's bookkeeping sees the same order it sees from a server.

import { makeHashCodeHexFromBytes } from './content-identity.mjs';
import type { LiveRoom } from './live-room';

/** The record protocol's operation name: what the engine calls its records; a source maps it to its own address. */
export const RECORDS_OP = 'records';

export type RecordsLiveRoom = LiveRoom;
export type WorkspaceDocumentRevision = { id: string; number: number; at: string | null; by: string | null; words: string | null; current: boolean };
export type RecordsRead = { records?: Record<string, unknown> };
export type RecordsWriteEntry = { address_label: string; payload: unknown; expected_identity?: string | null };
export type RecordsWriteBody = { conflict_policy?: 'preserve' | 'retry'; writes: RecordsWriteEntry[] };
export type RecordsConflict = { address: string; current?: { found: boolean; value?: unknown } };
export type RecordsWriteReply = { written?: number; write_count?: number; conflicts?: RecordsConflict[] };
export type RecordsCompare = { path: Array<string | number>; before: string | null; after: string; replaceableSnapshot?: true };
/** A small write as the engine sends it: kept under `key` until the store accepts it. */
export type RecordsOutboxWrite = { key: string; path: string; body: Record<string, unknown>; together?: string; compare?: RecordsCompare };
export type RecordsReceipt = RecordsOutboxWrite & { readonly generation: number };

export type RecordsOutbox = {
  /** Keep the write until the store accepts it, and send it again while the store is busy. */
  send(write: RecordsOutboxWrite): void;
  /** Be told when the store accepts the next write under this key; null when writes are read only. */
  track(write: Pick<RecordsOutboxWrite, 'key' | 'path' | 'body' | 'compare'>): { accepted: Promise<void>; cancel: () => void } | null;
  isWaiting(key: string): boolean;
  isPendingVersion(key: string, after: string): boolean;
  isCurrent(receipt: RecordsReceipt): boolean;
  onAccepted(listener: (writes: RecordsReceipt[], result: unknown) => void): () => void;
  onRefusedReceipt(listener: (writes: RecordsReceipt[], status: number) => void): () => void;
  /** Writes an earlier page left unsent on this device, put back in line. Answered once per page. */
  restore(): Promise<RecordsOutboxWrite[]>;
  readOnly(): boolean;
};

export type RecordsHistory = { revisions?: WorkspaceDocumentRevision[]; current_identity?: string | null; next_cursor?: number | null; limited?: boolean };

export type RecordsAdmin = {
  history(query: { address: string; scope_id: string; limit: number; before?: number }): Promise<RecordsHistory>;
  revision(id: string): Promise<{ id?: string; value?: unknown } | null>;
  restoreRevision(input: { address: string; id: string; scope_id: string; expected_identity: string | null }): Promise<{ restored: boolean; conflict?: boolean }>;
  erase(address: string, expected_identity?: string | null, scope_id?: string): Promise<{ erased: boolean }>;
  conflicts(query: { limit: number; after: string }): Promise<{ conflicts?: Record<string, unknown>[]; next_cursor?: string | null }>;
  conflict(id: string): Promise<Record<string, unknown>>;
  resolveConflict(id: string, branchIdentity: string): Promise<{ resolved: boolean; address?: string; kept?: string; conflict_id?: string }>;
};

export type WorkspaceRecordsSource = {
  /** The values held under these labels, in one answer. `fresh` asks the store itself, never a copy kept on this device. */
  read(labels: readonly string[], options?: { fresh?: boolean }): Promise<RecordsRead>;
  /** One batch, confirmed by the store: the reply names what it wrote and the expectations that no longer hold. */
  write(body: RecordsWriteBody): Promise<RecordsWriteReply>;
  outbox: RecordsOutbox;
  subscribe?(onChange: () => void): () => void;
  openRoom?(path: string): { room: RecordsLiveRoom; release: () => void };
  admin?: RecordsAdmin;
};

let mounted: WorkspaceRecordsSource | null = null;
let detachHooks: Array<() => void> = [];
const mountHooks = new Set<(source: WorkspaceRecordsSource) => () => void>();

/** Attach a listener to every source the page mounts; the hook returns the call that detaches it from that source. */
export function onRecordsSourceMounted(hook: (source: WorkspaceRecordsSource) => () => void): void {
  mountHooks.add(hook);
}

/** The page's records source: mounted once at its entry, before anything reads or writes records. */
export function setWorkspaceRecordsSource(source: WorkspaceRecordsSource): void {
  for (const detach of detachHooks) detach();
  mounted = source;
  detachHooks = [...mountHooks].map(hook => hook(source));
}

export function activeRecordsSource(): WorkspaceRecordsSource {
  if (!mounted) throw new Error('This page has no records source. Its entry must mount one (setWorkspaceRecordsSource) before it reads or writes records.');
  return mounted;
}

const encoder = new TextEncoder();
const identityOf = (value: unknown): string => makeHashCodeHexFromBytes(encoder.encode(JSON.stringify(value)));

/** Applies one batch to the held values: each write whose expectation still holds is kept, and each whose expectation
 *  no longer holds is reported with the value now held. A memory source keeps no fork, since it keeps no history. */
function applyBatch(held: Map<string, unknown>, body: RecordsWriteBody): RecordsWriteReply {
  const conflicts: RecordsConflict[] = [];
  let written = 0;
  for (const entry of body.writes) {
    const has = held.has(entry.address_label);
    const current = has ? identityOf(held.get(entry.address_label)) : null;
    if (entry.expected_identity !== undefined && current !== entry.expected_identity) {
      conflicts.push({ address: entry.address_label, current: has ? { found: true, value: held.get(entry.address_label) } : { found: false } });
      continue;
    }
    held.set(entry.address_label, entry.payload);
    written += 1;
  }
  return conflicts.length ? { written, conflicts } : { written };
}

type AcceptedListener = (writes: RecordsReceipt[], result: unknown) => void;

/** The outbox over one batch applier: a send is applied in a later turn, and confirmed to the listeners when the applier
 *  answers; an applier that throws is refused to the refusal listeners with status 0 (a lost connection) and the write
 *  is no longer waiting. The memory and seeded sources apply to their own rows; a remote source applies over the wire. */
function applierOutbox(apply: (body: RecordsWriteBody) => RecordsWriteReply | Promise<RecordsWriteReply>): RecordsOutbox {
  let latest = 0;
  const generations = new Map<string, number>();
  const onTheirWay = new Map<string, RecordsReceipt>();
  const acceptedListeners = new Set<AcceptedListener>();
  const refusedListeners = new Set<(writes: RecordsReceipt[], status: number) => void>();
  const onAccepted = (listener: AcceptedListener) => {
    acceptedListeners.add(listener);
    return () => { acceptedListeners.delete(listener); };
  };
  return {
    send(write) {
      latest += 1;
      const receipt: RecordsReceipt = { ...write, generation: latest };
      generations.set(write.key, latest);
      onTheirWay.set(write.key, receipt);
      queueMicrotask(() => {
        Promise.resolve().then(() => apply(write.body as RecordsWriteBody)).then(result => {
          if (onTheirWay.get(write.key) === receipt) onTheirWay.delete(write.key);
          for (const listener of [...acceptedListeners]) listener([receipt], result);
        }, () => {
          if (onTheirWay.get(write.key) === receipt) onTheirWay.delete(write.key);
          for (const listener of [...refusedListeners]) listener([receipt], 0);
        });
      });
    },
    track(write) {
      let resolveAccepted: () => void = () => {};
      const accepted = new Promise<void>(resolve => { resolveAccepted = resolve; });
      const stop = onAccepted(writes => {
        if (!writes.some(one => one.key === write.key)) return;
        stop();
        resolveAccepted();
      });
      return { accepted, cancel: stop };
    },
    isWaiting: key => onTheirWay.has(key),
    isPendingVersion: (key, after) => onTheirWay.get(key)?.compare?.after === after,
    isCurrent: receipt => generations.get(receipt.key) === receipt.generation,
    onAccepted,
    onRefusedReceipt: listener => {
      refusedListeners.add(listener);
      return () => { refusedListeners.delete(listener); };
    },
    restore: async () => [],
    readOnly: () => false,
  };
}

function memoryOutbox(held: Map<string, unknown>): RecordsOutbox {
  return applierOutbox(async body => applyBatch(held, body));
}

/** Records held in this page's memory only: nothing is written anywhere else, and a reload starts empty. */
export function memoryRecordsSource(): WorkspaceRecordsSource {
  return seededRecordsSource({});
}

/** The memory source, started from rows the page gives at mount (its fixed sidebar entries, its screens). Every change
 *  stays in this page's memory. */
export function seededRecordsSource(rows: Record<string, unknown>): WorkspaceRecordsSource {
  const held = new Map<string, unknown>(Object.entries(rows));
  return {
    read: async labels => ({ records: Object.fromEntries(labels.filter(label => held.has(label)).map(label => [label, held.get(label)])) }),
    write: async body => applyBatch(held, body),
    outbox: memoryOutbox(held),
  };
}

/** A source whose reads and writes go to a store the page reaches over the wire (the page's own server). `transport.read`
 *  answers the values held under labels; `transport.write` confirms one batch, or throws when the store refuses or cannot be
 *  reached. Changes are kept and sent in the same order as the memory source keeps them. */
export function remoteRecordsSource(transport: { read(labels: readonly string[], options?: { fresh?: boolean }): Promise<RecordsRead>; write(body: RecordsWriteBody): Promise<RecordsWriteReply> }): WorkspaceRecordsSource {
  return {
    read: (labels, options) => transport.read(labels, options),
    write: body => transport.write(body),
    outbox: applierOutbox(body => transport.write(body)),
  };
}
