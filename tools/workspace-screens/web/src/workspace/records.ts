// src/workspace/records.ts
//
// PURPOSE
//   The one place the workspace's shared screens (sidebar, screen arrangement, screen look, ui) read and write the
//   person's saved state. Those screens were written against a record engine and ask for records by name
//   (`useBitfieldData('layout-state')`) and change them with label-addressed read and write requests
//   (`sendRequestToBitfieldTarget`). Here those two calls are answered by this page: records live in memory, start
//   from the page's own DATA (the screens this app offers) plus the person's saved records, and every write is kept in
//   the person's own store on the Worker (`/work/api/records`), so the next visit opens the same arrangement.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One record per address label. A read and a write of the same label reach the same value, whatever address
//      mode the caller names (identity text or label hash): the label is the identity here.
//   2. A named input resolves to its address through the input DATA (inputs.json), never through code that knows
//      input names. An input that is not in that DATA throws, as it did before, so an unknown read fails loudly.
//   3. A value keeps its object identity until it is written again, so a React read of an unchanged record is a
//      no-op render.
//   4. Every other target is answered by whoever registered it (`answerTarget`: the arrangement's own math, the group
//      graph, the chat's conversations); several may answer one target, each naming the requests it handles; a target
//      nobody registered is refused with the words callers already recognise
//      (`unknown target: <target>`), and each caller falls back as it always has.
//   5. Saving is last-write-wins per label, through the page's one outbox for small writes (quiet-writes.ts): a change
//      is sent at once when nothing was sent in the last moment, changes made within that moment ride together in one
//      batch, and a change the store has not accepted yet is kept on this device and sent again by itself (a busy
//      store, a reload, a page left) until it is. A page that opens with changes an earlier page left unsent shows them.
//   6. A record changed elsewhere (another device or tab, or the person's AI wearing a look) reaches this page: when
//      the person's store changes, the saved records are read again and each label whose stored value differs takes
//      it, except a label whose own change had not reached the store when that read began, or was made after: an
//      older read never puts back a value this page already replaced.
//   7. A record a screen reads from the Worker (`showRecords`, the automations map) is shown, never saved back.
//   8. A write may name the current value it expects (`expected_identity`: the content identity of the value it read,
//      or null for "nothing here yet"); a batch with any expectation that no longer holds writes nothing, and the
//      writer reads again to see why (a save made from an older copy never replaces newer words). A write to a
//      history path (any path but the current record, such as a save's version note) is not kept: the person's store
//      keeps one current value per label.
//   9. A label a row of record-places.json claims (`<prefix><room>/<address>`) lives in that live room, not in the
//      person's store (live-room.ts): a read waits for the room to open and answers what the room holds; a write is
//      kept by the room (merged with any member's change made at the same moment) and never sent to the person's store;
//      and once a screen has read such a label, every change the room hears to it is taken here and told to
//      subscribeSavedChanges like a change from another device, so every screen showing it sees it live.
//  10. subscribeRecordChanges tells every change of every label, whoever made it (this page included), so two screens
//      on one page showing one record (a board card and a Write tab) both follow it; a screen tells its own change
//      apart by what it wrote.

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeHashCodeHexFromBytes } from './content-identity.mjs';
export { makeHashCodeHexFromBytes } from './content-identity.mjs';
import { jsonExpansionBytes } from 'trillion-workshop/tools/json-expansion.mjs';
import inputs from './inputs.json';
import { onRecordsChange, type ReadDepends } from './store-changes';
import liveKeys from '../live-keys.json' with { type: 'json' };
import { bodyOf, readJson } from './api';
import { isQuietWriteCurrent, isQuietWritePendingVersion, isQuietWriteWaiting, onQuietWriteAccepted, onQuietWriteRefusedReceipt, quietWritesAreReadOnly, restoreQuietWrites, sendQuietly, trackQuietWriteAcceptance, type QuietWriteReceipt } from './quiet-writes';
import { openLiveRoom, type LiveRoom } from './live-room';
import recordPlaces from './record-places.json';
import cacheData from './record-cache.json';
import { startupRecordLabels, startupRecordsPath } from './startup-records.mjs';

type Selector = string | { input: string; params?: Record<string, unknown> } | undefined;
type InputRow = { address?: string; address_from_param?: string; missing?: 'empty-list' };
type Write = { address_label?: string; address?: string; payload?: unknown; path?: readonly string[]; expected_identity?: string | null; scope_id?: string };
type Reply = { target: string; payload: Uint8Array };

const inputRows = inputs as Record<string, InputRow>;
const values = new Map<string, unknown>();
// The last store-accepted value is separate from the optimistic cache. A permanent refusal must leave the
// editor's next conditional write based on the accepted record, while the editor keeps its refused frame locally.
const acceptedRecords = new Map<string, ({ found: true; value: unknown } | { found: false }) & { generation?: number }>();
// Package defaults remain available when a saved override is absent or removed. Their retained bytes count too.
const defaultValues = new Map<string, unknown>();
const loadedLabels = new Set<string>();
const loadingLabels = new Map<string, Promise<void>>();
type CachedRecord = { bytes: number; used: number; loaded: boolean; shown?: boolean; missingUntil?: number };
const recordCache = cacheData as { max_items: number; max_bytes: number; max_record_bytes: number; item_overhead_bytes: number; missing_ttl_ms: number; max_parallel_reads: number; refresh_batch: number; absent_guard: { min_labels: number; most_absent_share: number } };
const cachedRecords = new Map<string, CachedRecord>();
const activeRecordReaders = new Map<string, number>();
const startupLabels = new Set<string>();
const encoder = new TextEncoder();
const waitingReadSlots: Array<() => void> = [];
let cacheBytes = 0;
let useClock = 0;
let activeReadSlots = 0;
const listeners = new Set<() => void>();
// The order of this page's own changes: each label keeps the number of its newest change, so a store read can tell
// whether it began before that change.
let changeCount = 0;
const changedAt = new Map<string, number>();
// Owner reads can complete out of order. Keep the newest applied read token
// beside each cache row; eviction releases it with the rest of that row's state.
export type SavedRecordReadStart = Readonly<{ changeCount: number; generation: number }>;
let savedRecordReadGeneration = 0;
const appliedSavedRecordReads = new Map<string, number>();
export function beginSavedRecordRead(): SavedRecordReadStart {
  return { changeCount, generation: ++savedRecordReadGeneration };
}
const RECORDS_PATH = '/work/api/records';
const outboxKey = (label: string) => `records:${label}`;
const LABEL_OF_KEY = /^records:/;

/** A checked outbox snapshot proves a device copy only while this exact record version still remains in it. */
export const isSavedRecordPending = (label: string, identity: string): boolean => isQuietWritePendingVersion(outboxKey(label), identity);

export type SavedRecordAcceptance = { label: string; payload: unknown; identity: string; generation: number };
/** Observe only a current record version's permanent remote refusal. */
export function subscribeSavedRecordRefusal(label: string, listener: (receipt: SavedRecordAcceptance & { status: number; expectedIdentity?: string | null }) => void): () => void {
  return onQuietWriteRefusedReceipt((writes, status) => {
    for (const write of writes) {
      if (write.path !== RECORDS_PATH || write.key !== outboxKey(label) || !isQuietWriteCurrent(write) || !Array.isArray(write.body.writes)) continue;
      for (const row of write.body.writes as Write[]) if ((row.address_label ?? row.address) === label) {
        listener({ label, payload: row.payload, identity: identityOfValue(row.payload), generation: write.generation, status,
          ...(row.expected_identity !== undefined ? { expectedIdentity: row.expected_identity } : {}) });
      }
    }
  });
}
const recordAcceptanceListeners = new Map<string, Set<(receipt: SavedRecordAcceptance) => void>>();
/** Observe verified remote saves without making the editing/mutation queue wait for a network acknowledgement. */
export function subscribeSavedRecordAcceptance(label: string, listener: (receipt: SavedRecordAcceptance) => void): () => void {
  const listeners = recordAcceptanceListeners.get(label) ?? new Set();
  listeners.add(listener);
  recordAcceptanceListeners.set(label, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && recordAcceptanceListeners.get(label) === listeners) recordAcceptanceListeners.delete(label);
  };
}

function publishSavedRecordAcceptance(writes: QuietWriteReceipt[], result: unknown): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !writes.every(write => write.path === RECORDS_PATH && Array.isArray(write.body.writes))) return;
  const reply = result as { written?: unknown; write_count?: unknown; conflicts?: unknown };
  const rows = writes.flatMap(write => write.body.writes as Write[]);
  const conflicts = reply.conflicts ?? [];
  if (!Array.isArray(conflicts)) return;
  const refused = new Set<string>();
  for (const conflict of conflicts) {
    if (typeof conflict?.address !== 'string' || refused.has(conflict.address)
        || !rows.some(row => (row.address_label ?? row.address) === conflict.address)) return;
    refused.add(conflict.address);
  }
  const written = reply.written ?? reply.write_count;
  // Every row must be accounted for. A 2xx or a partial/malformed count alone cannot prove a particular save.
  if (typeof written !== 'number' || !Number.isSafeInteger(written) || written !== rows.length - refused.size) return;
  for (const write of writes) {
    for (const row of write.body.writes as Write[]) {
      const label = row.address_label ?? row.address;
      if (typeof label !== 'string' || write.key !== outboxKey(label)) continue;
      const newerAccepted = (acceptedRecords.get(label)?.generation ?? -1) > write.generation;
      if (refused.has(label)) {
        const conflict = conflicts.find(item => item.address === label);
        if (!newerAccepted && conflict?.current?.found) cacheWithAcceptedRecord(label, { found: true, value: conflict.current.value, generation: write.generation });
        else if (!newerAccepted && conflict?.current && conflict.current.found === false) cacheWithAcceptedRecord(label, { found: false, generation: write.generation });
        continue;
      }
      // The older accepted write is the remote basis even while a newer local
      // generation owns the screen. Keep it for a later refusal's Retry.
      if (!newerAccepted) cacheWithAcceptedRecord(label, { found: true, value: row.payload, generation: write.generation });
      if (!isQuietWriteCurrent(write)) continue;
      const listeners = recordAcceptanceListeners.get(label);
      if (!listeners?.size) continue;
      const receipt = { label, payload: row.payload, identity: identityOfValue(row.payload), generation: write.generation };
      for (const listener of [...listeners]) listener(receipt);
    }
  }
}

/** Track a label's next saved-record write through the shared outbox to remote acceptance. */
export function trackSavedRecordAcceptance(label: string, payload: unknown, expectedIdentity?: string | null, conflictPolicy?: 'preserve' | 'retry') {
  if (quietWritesAreReadOnly()) return null;
  return trackQuietWriteAcceptance({
    key: outboxKey(label),
    path: RECORDS_PATH,
    body: { ...(conflictPolicy ? { conflict_policy: conflictPolicy } : {}), writes: [{ address_label: label, payload, ...(expectedIdentity !== undefined ? { expected_identity: expectedIdentity } : {}) }] },
    ...(expectedIdentity !== undefined ? { compare: { path: ['writes', 0, 'expected_identity'], before: expectedIdentity, after: identityOfValue(payload), replaceableSnapshot: true as const } } : {}),
  });
}
export const savedRecordWritesAreReadOnly = quietWritesAreReadOnly;

/** Read one saved record from the Worker without using this page's optimistic cache. */
export async function readSavedRecordFromOwner(label: string): Promise<{ found: boolean; value?: unknown }> {
  if (typeof label !== 'string' || !label || placeOf(label)) throw new Error('This record cannot be read from the saved-record owner.');
  const query = new URLSearchParams({ label });
  const answer = await readJson<{ records?: Record<string, unknown> }>(`${RECORDS_PATH}?${query}`, { method: 'GET', cache: 'no-store' });
  if (!answer.records || typeof answer.records !== 'object' || Array.isArray(answer.records)) throw new Error('The saved record could not be read.');
  return Object.hasOwn(answer.records, label) ? { found: true, value: answer.records[label] } : { found: false };
}

export type WorkspaceDocumentRevision = { id: string; number: number; at: string | null; by: string | null; words: string | null; current: boolean };
export async function readWorkspaceDocumentHistory(address: string, { scope_id, before, limit = 50 }: { scope_id: string; before?: number; limit?: number }): Promise<{ revisions: WorkspaceDocumentRevision[]; current_identity: string | null; next_cursor: number | null; limited: boolean }> {
  const query = new URLSearchParams({ address, scope_id, limit: String(limit), ...(before ? { before: String(before) } : {}) });
  const answer = await readJson<{ revisions?: WorkspaceDocumentRevision[]; current_identity?: string | null; next_cursor?: number | null; limited?: boolean }>(`${RECORDS_PATH}/history?${query}`, { method: 'GET', cache: 'no-store' });
  if (!Array.isArray(answer.revisions)) throw new Error('Document history could not be read.');
  return { revisions: answer.revisions, limited: answer.limited === true, current_identity: answer.current_identity ?? null, next_cursor: answer.next_cursor ?? null };
}
export async function readWorkspaceDocumentRevision(id: string): Promise<{ value: unknown } | null> {
  const answer = await readJson<{ id?: string; value?: unknown } | null>(`${RECORDS_PATH}/revisions/${encodeURIComponent(id)}`, { method: 'GET', cache: 'no-store' });
  return answer && Object.hasOwn(answer, 'value') ? { value: answer.value } : null;
}
export async function restoreWorkspaceDocumentRevision(input: { address: string; id: string; scope_id: string; expected_identity: string | null }): Promise<{ restored: boolean; conflict?: boolean }> {
  return readJson(`${RECORDS_PATH}/revisions/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
}
export async function eraseWorkspaceDocument(address: string, expected_identity?: string | null, scope_id?: string): Promise<{ erased: boolean }> {
  return readJson('/work/api/records/erase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: address, ...(expected_identity !== undefined ? { expected_identity } : {}), ...(scope_id ? { scope_id } : {}) }) });
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const notify = () => { for (const listener of listeners) listener(); };

function recordBytes(label: string, value: unknown, hasValue: boolean): number {
  const serialized = hasValue ? JSON.stringify(value) : '';
  const labelBytes = encoder.encode(label).byteLength;
  const serializedBytes = serialized === undefined ? 4 : encoder.encode(serialized).byteLength;
  const fixedBytes = labelBytes + serializedBytes + recordCache.item_overhead_bytes;
  const remaining = Math.max(0, recordCache.max_record_bytes - fixedBytes);
  const expandedBytes = serialized === undefined || !hasValue ? 0 : jsonExpansionBytes(serialized, remaining).bytes;
  return fixedBytes + expandedBytes;
}

function touchRecord(label: string): void {
  const row = cachedRecords.get(label);
  if (row) row.used = ++useClock;
}

function retainedRecordBytes(label: string, value: unknown): number {
  const accepted = acceptedRecords.get(label);
  return recordBytes(label, value, true) + (defaultValues.has(label) && defaultValues.get(label) !== value
    ? recordBytes(label, defaultValues.get(label), true) : 0)
    + (accepted?.found && accepted.value !== value && accepted.value !== defaultValues.get(label)
      ? recordBytes(label, accepted.value, true) : 0);
}

function evictRecord(label: string): void {
  const row = cachedRecords.get(label);
  if (!row) return;
  cachedRecords.delete(label);
  cacheBytes -= row.bytes;
  loadedLabels.delete(label);
  values.delete(label);
  defaultValues.delete(label);
  acceptedRecords.delete(label);
  appliedSavedRecordReads.delete(label);
  unfollow(label);
  if (!loadingLabels.has(label) && !isQuietWriteWaiting(outboxKey(label))) changedAt.delete(label);
}

/** Make room in the byte-and-item bounded cache without displacing an open consumer or a waiting local write. */
function reserveRecords(requests: Array<{ label: string; bytes: number }>): boolean {
  const wanted = new Map<string, number>();
  for (const request of requests) wanted.set(request.label, Math.max(wanted.get(request.label) ?? 0, request.bytes));
  if ([...wanted.values()].some(bytes => bytes > recordCache.max_record_bytes || bytes > recordCache.max_bytes)) return false;
  const targetBytes = [...wanted.values()].reduce((sum, bytes) => sum + bytes, 0);
  const existingBytes = [...wanted.keys()].reduce((sum, label) => sum + (cachedRecords.get(label)?.bytes ?? 0), 0);
  let items = cachedRecords.size + [...wanted.keys()].filter(label => !cachedRecords.has(label)).length;
  let bytes = cacheBytes - existingBytes + targetBytes;
  const victims: string[] = [];
  const candidates = [...cachedRecords]
    .filter(([label]) => !wanted.has(label) && !startupLabels.has(label) && (activeRecordReaders.get(label) ?? 0) === 0
      && !loadingLabels.has(label) && !isQuietWriteWaiting(outboxKey(label)))
    .sort(([, left], [, right]) => left.used - right.used);
  for (const [label, row] of candidates) {
    if (items <= recordCache.max_items && bytes <= recordCache.max_bytes) break;
    victims.push(label);
    items -= 1;
    bytes -= row.bytes;
  }
  // Do not partially evict the cache when a pinned value makes this reservation impossible.
  if (items > recordCache.max_items || bytes > recordCache.max_bytes) return false;
  for (const label of victims) evictRecord(label);
  return true;
}

function commitCachedRecord(label: string, value: unknown, { loaded, shown = false, missingUntil }: { loaded?: boolean; shown?: boolean; missingUntil?: number } = {}): void {
  const old = cachedRecords.get(label);
  const bytes = retainedRecordBytes(label, value);
  cacheBytes += bytes - (old?.bytes ?? 0);
  values.set(label, value);
  cachedRecords.set(label, { bytes, used: ++useClock, loaded: shown ? false : loaded ?? old?.loaded ?? loadedLabels.has(label), shown, ...(missingUntil ? { missingUntil } : {}) });
  const row = cachedRecords.get(label)!;
  if (row.loaded) loadedLabels.add(label); else loadedLabels.delete(label);
}

function cacheRecord(label: string, value: unknown, options: { loaded?: boolean; shown?: boolean; missingUntil?: number } = {}): boolean {
  if (!reserveRecords([{ label, bytes: retainedRecordBytes(label, value) }])) return false;
  commitCachedRecord(label, value, options);
  return true;
}

function cacheMissingRecord(label: string, loaded = true): boolean {
  if (defaultValues.has(label)) return cacheRecord(label, defaultValues.get(label), {
    loaded, ...(loaded ? { missingUntil: Date.now() + recordCache.missing_ttl_ms } : {}),
  });
  const accepted = acceptedRecords.get(label);
  const bytes = recordBytes(label, undefined, false)
    + (accepted?.found && accepted.value !== defaultValues.get(label) ? recordBytes(label, accepted.value, true) : 0);
  if (!reserveRecords([{ label, bytes }])) return false;
  const old = cachedRecords.get(label);
  cacheBytes += bytes - (old?.bytes ?? 0);
  values.delete(label);
  cachedRecords.set(label, { bytes, used: ++useClock, loaded, ...(loaded ? { missingUntil: Date.now() + recordCache.missing_ttl_ms } : {}) });
  if (loaded) loadedLabels.add(label); else loadedLabels.delete(label);
  return true;
}

/** Keep the remote basis inside the same bounded accounting as its optimistic cache row. */
function cacheWithAcceptedRecord(
  label: string,
  accepted: ({ found: true; value: unknown } | { found: false }) & { generation?: number },
  adoptAccepted = false,
): boolean {
  const cached = cachedRecords.get(label);
  const previous = acceptedRecords.get(label);
  if ((previous?.generation ?? -1) > (accepted.generation ?? previous?.generation ?? -1)) return false;
  const next = accepted.generation === undefined && previous?.generation !== undefined
    ? { ...accepted, generation: previous.generation }
    : accepted;
  acceptedRecords.set(label, next);
  // An authoritative label read must mark the row loaded. Preserving its old
  // startup flag would reread it before every conditional write and could replace
  // an accepted baseline with an older cached transport answer.
  const options = adoptAccepted ? { loaded: true }
    : cached ? { loaded: cached.loaded, shown: cached.shown, missingUntil: cached.missingUntil } : { loaded: true };
  const kept = adoptAccepted
    ? next.found ? cacheRecord(label, next.value, options) : cacheMissingRecord(label, options.loaded)
    : cached
      ? values.has(label) ? cacheRecord(label, values.get(label), options) : cacheMissingRecord(label, cached.loaded)
      : next.found ? cacheRecord(label, next.value, options) : cacheMissingRecord(label, options.loaded);
  if (!kept) {
    if (previous) acceptedRecords.set(label, previous); else acceptedRecords.delete(label);
  }
  return kept;
}

function isRecordLoaded(label: string): boolean {
  const row = cachedRecords.get(label);
  // Screen answers have their own Worker owner. A saved-workspace read must never erase those current answers.
  if (row?.shown) { touchRecord(label); return true; }
  if (!row?.loaded || !loadedLabels.has(label)) return false;
  if (row.missingUntil && row.missingUntil <= Date.now()) {
    row.loaded = false;
    row.missingUntil = undefined;
    loadedLabels.delete(label);
    touchRecord(label);
    return false;
  }
  touchRecord(label);
  return true;
}

async function withReadSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeReadSlots >= recordCache.max_parallel_reads) await new Promise<void>(resolve => waitingReadSlots.push(resolve));
  else activeReadSlots += 1;
  try { return await run(); }
  finally {
    const wake = waitingReadSlots.shift();
    if (wake) wake(); else activeReadSlots -= 1;
  }
}

/** Hold the named values while one or more visible consumers use them; each caller releases only its own interest. */
export function retainWorkspaceRecords(labels: readonly string[]): () => void {
  const held = [...new Set(labels.filter(label => typeof label === 'string' && label))];
  for (const label of held) {
    activeRecordReaders.set(label, (activeRecordReaders.get(label) ?? 0) + 1);
    touchRecord(label);
    if (placeOf(label)) follow(label);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const label of held) {
      const count = activeRecordReaders.get(label) ?? 0;
      if (count <= 1) {
        activeRecordReaders.delete(label);
        if (placeOf(label)) unfollow(label);
      } else activeRecordReaders.set(label, count - 1);
    }
  };
}

/** Records this page starts with: the app's own DATA, then the person's saved records over them. */
export function startRecords(seed: Record<string, unknown>, saved: Record<string, unknown> = {}) {
  const previousDefaults = new Map(defaultValues);
  const previousAccepted = new Map(acceptedRecords);
  for (const [label, value] of Object.entries(seed)) defaultValues.set(label, value);
  for (const label of Object.keys(seed)) acceptedRecords.set(label, Object.hasOwn(saved, label) ? { found: true, value: saved[label] } : { found: false });
  for (const [label, value] of Object.entries(saved)) acceptedRecords.set(label, { found: true, value });
  const rows = Object.entries({ ...seed, ...saved });
  if (!reserveRecords(rows.map(([label, value]) => ({ label, bytes: retainedRecordBytes(label, value) })))) {
    defaultValues.clear();
    for (const [label, value] of previousDefaults) defaultValues.set(label, value);
    acceptedRecords.clear();
    for (const [label, value] of previousAccepted) acceptedRecords.set(label, value);
    throw new Error('The workspace startup records exceed their cache budget.');
  }
  for (const [label, value] of rows) {
    startupLabels.add(label);
    commitCachedRecord(label, value, { loaded: loadedLabels.has(label) });
  }
  notify();
  followSavedRecords();
  // Changes an earlier page made that the store has not accepted yet are shown again (they are on their way).
  void restoreQuietWrites().then(restored => {
    let shown = 0;
    for (const write of restored) {
      if (!LABEL_OF_KEY.test(write.key) || !Array.isArray(write.body.writes)) continue;
      for (const { address_label, payload } of write.body.writes as Write[]) {
        if (typeof address_label !== 'string' || changedAt.has(address_label)) continue;
        if (cacheRecord(address_label, payload)) shown += 1;
      }
    }
    if (shown) notify();
  });
}

/**
 * Records a screen read from the Worker and shows as they are (what the person's automations and workflows are now):
 * kept in memory for the screens that read them, never saved back, so the Worker stays their one owner.
 */
export function showRecords(records: Record<string, unknown>) {
  showRecordValues(records, true);
}

function showRecordValues(records: Record<string, unknown>, shown: boolean) {
  let changed = 0;
  for (const [label, value] of Object.entries(records)) {
    if (values.get(label) === value && cachedRecords.get(label)?.shown === shown) { touchRecord(label); continue; }
    if (cacheRecord(label, value, { shown })) changed += 1;
  }
  if (changed) notify();
}

/** Records a screen's package publishes for it (part-records.ts), shown only where nothing is kept under the label yet,
 * so a value the person saved is never replaced; never saved back. */
export function showMissing(records: Record<string, unknown>) {
  let changed = false;
  for (const [label, value] of Object.entries(records)) {
    const hadDefault = defaultValues.has(label);
    const previous = defaultValues.get(label);
    defaultValues.set(label, value);
    const existing = values.has(label);
    if (!cacheRecord(label, existing ? values.get(label) : value, { shown: cachedRecords.get(label)?.shown })) {
      if (hadDefault) defaultValues.set(label, previous); else defaultValues.delete(label);
      continue;
    }
    if (!existing) changed = true;
  }
  if (changed) notify();
}

// What the saved records depend on: every row of the saved records' table, whatever the label (a change elsewhere is
// compared label by label once read, invariant 6).
const SAVED_RECORDS_DEPEND: ReadDepends = { version: null, ids: [], rows: [], members: liveKeys.tables.filter(row => row.table === 'workspace_records').map(row => ({ prefix: row.key, fields: null })) };
let following = false;
let savedRefresh: Promise<void> | null = null;
let savedRefreshAgain = false;
function followSavedRecords() {
  if (following || typeof window === 'undefined') return;
  following = true;
  // Read again only when a revision names the saved records' table (src/live-keys.mjs `tables`), or after a gap, or when
  // only the saved records changed (a label no other screen draws, src/live-screen.mjs changedFor).
  onRecordsChange(() => readSavedRecords(), () => SAVED_RECORDS_DEPEND, undefined, [RECORDS_PATH]);
}

// A server-side compare can find a fork after this page's optimistic check passed. The write reply carries just the
// authoritative branch for each refused address, so the page repairs that value without rereading every record.
onQuietWriteAccepted((writes, result) => {
  // A receipt belongs to the submitted version. A newer local version must keep
  // its read protection, including when the older write reports a conflict.
  const currentWrites = writes.filter(isQuietWriteCurrent);
  // Keep the local-change fence until a tracked owner read completes. Startup
  // snapshots can have begun before this acknowledgement but arrive afterward.
  publishSavedRecordAcceptance(writes, result);
  if (!writes.some(write => write.path === RECORDS_PATH) || !result || typeof result !== 'object') return;
  const conflicts = (result as { conflicts?: Array<{ address?: string; current?: { found?: boolean; value?: unknown } }> }).conflicts;
  if (!Array.isArray(conflicts) || !conflicts.length) return;
  const currentLabels = new Set(currentWrites.flatMap(write => write.path === RECORDS_PATH && Array.isArray(write.body.writes)
    ? (write.body.writes as Write[]).map(row => row.address_label ?? row.address)
      .filter(label => typeof label === 'string' && write.key === outboxKey(label)) : []));
  const changed: string[] = [];
  for (const conflict of conflicts) {
    if (typeof conflict.address !== 'string' || !conflict.current || !currentLabels.has(conflict.address)) continue;
    // publishSavedRecordAcceptance records the conflict branch together with its
    // bounded cache accounting. If that reservation failed, do not bypass it
    // here by caching the visible value without the matching accepted baseline.
    const accepted = acceptedRecords.get(conflict.address);
    const baselineMatches = conflict.current.found
      ? accepted?.found === true && JSON.stringify(accepted.value) === JSON.stringify(conflict.current.value)
      : accepted?.found === false;
    if (!baselineMatches) continue;
    if (conflict.current.found) {
      if (!cacheRecord(conflict.address, conflict.current.value, { loaded: true })) continue;
    } else {
      if (!cacheMissingRecord(conflict.address)) continue;
    }
    changedAt.set(conflict.address, ++changeCount);
    changed.push(conflict.address);
  }
  if (!changed.length) return;
  notify();
  for (const listener of savedListeners) listener(changed);
  tellChanged(changed);
});

// A permanent refusal removed the outbox entry, but its optimistic payload is not the store's current record.
// Restore only the latest refused generation to the last accepted baseline, so a user-initiated Retry derives the
// same conditional identity the store still has. A refusal for an older generation must never replace newer edits.
onQuietWriteRefusedReceipt((writes) => {
  const changed: string[] = [];
  for (const write of writes) {
    if (!isQuietWriteCurrent(write) || write.path !== RECORDS_PATH || !Array.isArray(write.body.writes)) continue;
    for (const row of write.body.writes as Write[]) {
      const label = row.address_label ?? row.address;
      if (typeof label !== 'string' || write.key !== outboxKey(label)) continue;
      const accepted = acceptedRecords.get(label);
      if (!accepted) continue;
      const cachedChanged = accepted.found
        ? (!values.has(label) || JSON.stringify(values.get(label)) !== JSON.stringify(accepted.value))
        : values.has(label);
      const cached = accepted.found
        ? cacheRecord(label, accepted.value, { loaded: true })
        : cacheMissingRecord(label);
      if (!cached || !cachedChanged) continue;
      changedAt.set(label, ++changeCount);
      changed.push(label);
    }
  }
  if (!changed.length) return;
  notify();
  // This is recovery from our own rejected optimistic write, not a new remote
  // version. Announcing it as an external save would open a false conflict in
  // the editor that is retaining the refused draft for Retry.
});

/** Read the person's saved records again and take each one changed elsewhere (invariant 6). */
export async function readSavedRecords(): Promise<void> {
  if (savedRefresh) { savedRefreshAgain = true; return savedRefresh; }
  savedRefresh = (async () => {
    do {
      savedRefreshAgain = false;
      try { await readLabels([...loadedLabels].filter(isRecordLoaded), true); } catch { /* an offline or refused refresh leaves the current value in place */ }
    } while (savedRefreshAgain);
  })().finally(() => { savedRefresh = null; });
  return savedRefresh;
}

/** Resolve an input through inputs.json, so startup reads use the address declared in DATA. */
export function addressLabelForInput(selector: Selector): string {
  const { address } = addressOf(selector);
  if (!address) throw new TypeError('This input does not name a record address.');
  return address;
}

/**
 * The saved records the first paint depends on, in ONE read (startup-records.mjs): carried in the page and kept on this
 * device for the account (api.ts), so the first draw already has the person's own sidebar side, arrangement and layouts.
 * A label the store holds nothing under is remembered as absent. Returns the values that exist.
 */
export async function readStartupRecords(): Promise<Record<string, unknown>> {
  const readStart = beginSavedRecordRead();
  const { records } = await readJson<{ records?: Record<string, unknown> }>(startupRecordsPath);
  takeRecords(records ?? {}, readStart, new Set([...changedAt.keys()].filter(label => isQuietWriteWaiting(outboxKey(label)))), startupRecordLabels);
  return Object.fromEntries(startupRecordLabels.flatMap(label => values.has(label) ? [[label, values.get(label)]] : []));
}

/** The startup read answered again differently from the copy kept on this device: take what changed, in place. */
export async function takeStartupRecords(): Promise<void> {
  const readStart = beginSavedRecordRead();
  const { records } = await readJson<{ records?: Record<string, unknown> }>(startupRecordsPath);
  takeRecords(records ?? {}, readStart, new Set([...changedAt.keys()].filter(label => isQuietWriteWaiting(outboxKey(label)))), startupRecordLabels);
}

/** Load a bounded set of saved labels before startup decisions depend on their current values. */
export async function readSavedLabels(labels: readonly string[]): Promise<Record<string, unknown>> {
  await readLabels([...new Set(labels)], false);
  return Object.fromEntries(labels.flatMap(label => { touchRecord(label); return values.has(label) ? [[label, values.get(label)]] : []; }));
}

async function readLabels(labels: string[], refresh: boolean): Promise<void> {
  const pending = [...new Set(labels)].filter(label => typeof label === 'string' && label && (refresh || !isRecordLoaded(label)));
  // A refresh reads the labels nobody is loading in a few multi-label requests (record-cache.json `refresh_batch`), one
  // request for many labels instead of one each; a label already loading is read again after it, as before.
  const quiet = refresh ? pending.filter(label => !loadingLabels.has(label)) : [];
  const singles = refresh ? pending.filter(label => loadingLabels.has(label)) : pending;
  const batches = Array.from({ length: Math.ceil(quiet.length / recordCache.refresh_batch) }, (_, index) => quiet.slice(index * recordCache.refresh_batch, (index + 1) * recordCache.refresh_batch));
  let nextBatch = 0;
  await Promise.all(Array.from({ length: Math.min(recordCache.max_parallel_reads, batches.length) }, async () => {
    while (nextBatch < batches.length) await readBatch(batches[nextBatch++]);
  }));
  let next = 0;
  const count = Math.min(recordCache.max_parallel_reads, singles.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (next < singles.length) {
      const label = singles[next++];
      const existing = loadingLabels.get(label);
      if (existing) {
        await existing;
        if (refresh && isRecordLoaded(label)) await readOneLabel(label);
      } else await readOneLabel(label);
    }
  }));
}

async function readBatch(labels: string[]): Promise<void> {
  if (labels.length === 1) return readOneLabel(labels[0]);
  const readStart = beginSavedRecordRead();
  const notInStoreYet = new Set([...changedAt.keys()].filter(key => isQuietWriteWaiting(outboxKey(key))));
  const query = new URLSearchParams();
  for (const label of labels) query.append('label', label);
  const request = withReadSlot(() => readJson<{ records?: Record<string, unknown> }>(`${RECORDS_PATH}?${query}`).then(async ({ records }) => {
    // A batch that says most of what this page holds is gone looks like a broken answer, not that many deletions: the
    // absences are not applied from it, each is asked alone instead, and only that answer may remove a record.
    const present = labels.filter(label => records && Object.hasOwn(records, label));
    const heldAbsent = labels.filter(label => !present.includes(label) && values.has(label));
    const guard = recordCache.absent_guard;
    const suspicious = labels.length >= guard.min_labels && heldAbsent.length / labels.length > guard.most_absent_share;
    takeRecords(records ?? {}, readStart, notInStoreYet, suspicious ? present : labels);
    if (suspicious) for (const label of heldAbsent) { loadingLabels.delete(label); await readOneLabel(label); }
  })).catch(async () => {
    // Together they were too many or too large for one answer: read them one at a time, as a refresh always could.
    for (const label of labels) loadingLabels.delete(label);
    for (const label of labels) await readOneLabel(label);
  }).finally(() => { for (const label of labels) loadingLabels.delete(label); });
  for (const label of labels) loadingLabels.set(label, request);
  return request;
}

async function readOneLabel(label: string): Promise<void> {
  if (loadingLabels.has(label)) return loadingLabels.get(label);
  const readStart = beginSavedRecordRead();
  const notInStoreYet = new Set([...changedAt.keys()].filter(key => isQuietWriteWaiting(outboxKey(key))));
  const query = new URLSearchParams({ label });
  const request = withReadSlot(() => readJson<{ records?: Record<string, unknown> }>(`${RECORDS_PATH}?${query}`).then(({ records }) => {
    takeRecords(records && Object.hasOwn(records, label) ? records : {}, readStart, notInStoreYet, [label]);
  })).finally(() => {
    loadingLabels.delete(label);
  });
  loadingLabels.set(label, request);
  return request;
}

/** Capture before requesting saved records, then pass the token with that answer. This rejects both writes made after
 *  the read began and older reads that finish after a newer owner answer. */
export function takeSavedRecords(records: Record<string, unknown>, readStart: SavedRecordReadStart): void {
  takeRecords(records, readStart, new Set([...changedAt.keys()].filter(label => isQuietWriteWaiting(outboxKey(label)))));
}

function takeRecords(records: Record<string, unknown>, readStart: SavedRecordReadStart, notInStoreYet: Set<string>, scope = Object.keys(records)): void {
  const changed: string[] = [];
  for (const label of scope) {
    if (cachedRecords.get(label)?.shown) continue;
    if ((appliedSavedRecordReads.get(label) ?? 0) >= readStart.generation
        || notInStoreYet.has(label) || isQuietWriteWaiting(outboxKey(label))
        || (changedAt.get(label) ?? 0) > readStart.changeCount) continue;
    if (!Object.hasOwn(records, label)) {
      const before = values.get(label);
      const present = values.has(label);
      if (cacheWithAcceptedRecord(label, { found: false }, true)) {
        appliedSavedRecordReads.set(label, readStart.generation);
        if (present !== values.has(label) || before !== values.get(label)) changed.push(label);
      }
      continue;
    }
    const value = records[label];
    if (values.has(label) && JSON.stringify(values.get(label)) === JSON.stringify(value)) {
      if (cacheWithAcceptedRecord(label, { found: true, value }, true)) appliedSavedRecordReads.set(label, readStart.generation);
      const row = cachedRecords.get(label);
      if (row) row.missingUntil = undefined;
      continue;
    }
    const previous = acceptedRecords.get(label);
    if (!cacheWithAcceptedRecord(label, { found: true, value }, true)) continue;
    appliedSavedRecordReads.set(label, readStart.generation);
    // The owner read is the current baseline; retain only the monotonic local
    // generation fence so an older acceptance cannot replace this observation.
    if (previous?.generation !== undefined) acceptedRecords.set(label, { found: true, value, generation: previous.generation });
    changed.push(label);
  }
  if (!changed.length) return;
  notify();
  for (const listener of savedListeners) listener(changed);
  tellChanged(changed);
}

function addressOf(selector: Selector): { address: string; row: InputRow } {
  const name = typeof selector === 'string' ? selector : selector?.input;
  const row = name ? inputRows[name] : undefined;
  // The words callers already recognise for an input an app does not provide (they fall back to empty on them).
  if (!name || !row) throw new Error(`This app has no input named "${String(name)}".`);
  if (row.address) return { address: row.address, row };
  const param = row.address_from_param ? (selector as { params?: Record<string, unknown> })?.params?.[row.address_from_param] : undefined;
  if (typeof param !== 'string' || !param) return { address: '', row };
  return { address: param, row };
}

const EMPTY_LIST: readonly unknown[] = Object.freeze([]);
function read(address: string, row: InputRow): unknown {
  if (!address) return row.missing === 'empty-list' ? EMPTY_LIST : null;
  if (placeOf(address)) follow(address);
  else if (typeof window !== 'undefined' && !isRecordLoaded(address)) void readLabels([address], false).catch(() => {});
  touchRecord(address);
  return values.has(address) ? values.get(address) : row.missing === 'empty-list' ? EMPTY_LIST : null;
}

const savedListeners = new Set<(labels: string[]) => void>();
/**
 * Be told when records change in the person's store from elsewhere (their AI, another tab or device), with the labels
 * that changed; this page's own writes are not told here. Returns the call that stops it.
 */
export function subscribeSavedChanges(listener: (labels: string[]) => void) {
  savedListeners.add(listener);
  return () => { savedListeners.delete(listener); };
}

const recordListeners = new Set<(labels: string[]) => void>();
/** Be told of every label that changed, whoever changed it, this page included (invariant 10). */
export function subscribeRecordChanges(listener: (labels: string[]) => void) {
  recordListeners.add(listener);
  return () => { recordListeners.delete(listener); };
}
const tellChanged = (labels: string[]) => { if (labels.length) for (const listener of recordListeners) listener(labels); };

/** Be told whenever any record changes; returns the call that stops it. */
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeRecordLabel(label: string, listener: () => void) {
  const release = retainWorkspaceRecords(label ? [label] : []);
  const stop = subscribe(listener);
  return () => { stop(); release(); };
}

/** The current value of a named input, re-read whenever a record changes. */
export function useBitfieldData<T = unknown>(selector?: Selector): T {
  const { address, row } = addressOf(selector);
  return useSyncExternalStore(useCallback(listener => subscribeRecordLabel(address, listener), [address]), () => read(address, row), () => read(address, row)) as T;
}

/** The current value of one record by its label (null when there is none). */
export function readRecordAt<T = unknown>(label: string): T | null {
  if (placeOf(label)) follow(label);
  else if (typeof window !== 'undefined' && !isRecordLoaded(label)) void readLabels([label], false).catch(() => {});
  touchRecord(label);
  return (values.has(label) ? values.get(label) : null) as T | null;
}

/** Read a declared input from its current owner, preserving loading/refused reads as errors. */
export async function readInputValueFromOwner<T = unknown>(selector: Selector): Promise<{ found: boolean; value: T | undefined }> {
  const { address } = addressOf(selector);
  if (!address || placeOf(address)) throw new Error('This input has no saved-record owner.');
  const current = await readSavedRecordFromOwner(address);
  return { found: current.found, value: current.found ? current.value as T : undefined };
}

/** Read or replace a declared input through the same record address its screen uses. */
export function readInputValue<T = unknown>(selector: Selector): T {
  const { address, row } = addressOf(selector);
  return read(address, row) as T;
}

/** Read a person's workspace preference from the same account store as their layout. */
export function readWorkspacePreference<T = unknown>(key: string): T | null {
  if (!key.trim()) throw new TypeError('A preference needs a name.');
  const label = `workspace-preference:${key}`;
  if (typeof window !== 'undefined' && !isRecordLoaded(label)) void readLabels([label], false).catch(() => {});
  touchRecord(label);
  return (values.get(label) ?? null) as T | null;
}

/** Save a preference for this person across devices, using the existing record batch. */
export async function writeWorkspacePreference(key: string, value: unknown): Promise<Reply> {
  if (!key.trim()) throw new TypeError('A preference needs a name.');
  return sendRequestToBitfieldTarget({
    target: LABEL_ADDRESSED,
    payload: { operation_label: WRITE_BATCH, writes: [{ address_label: `workspace-preference:${key}`, payload: value }] },
  });
}

/** Keep the immediate local choice, but report a permanent refusal through the
 * existing outbox. A superseding choice owns the result of its own save. */
export async function writeConfirmedWorkspacePreference(key: string, value: unknown): Promise<void> {
  if (!key.trim()) throw new TypeError('A preference needs a name.');
  const label = `workspace-preference:${key}`;
  const acceptance = trackSavedRecordAcceptance(label, value);
  if (!acceptance) throw new Error('Preferences cannot be changed while viewing another account.');
  // Attach the rejection handler before dispatch: a replaced queued choice can
  // settle before the local request promise resumes.
  const outcome = acceptance.accepted.then(() => null, error => error);
  let writtenAt: number | undefined;
  try {
    const submitted = writeWorkspacePreference(key, value);
    writtenAt = changedAt.get(label);
    await submitted;
    const error = await outcome;
    if (!error || error.name === 'QuietWriteSupersededError') return;
    // Refresh only this refused version. A newer local choice is never replaced
    // by a late failure, and transient/offline failures remain in the outbox.
    if (writtenAt === changedAt.get(label) && !isQuietWriteWaiting(outboxKey(label))) {
      try { await readLabels([label], true); } catch { /* The caller retains its last accepted choice. */ }
    }
    throw error;
  } finally { acceptance.cancel(); }
}

/** Subscribe to changes of one preference without re-rendering for unrelated records. */
export function useWorkspacePreference<T = unknown>(key: string): T | null {
  const address = `workspace-preference:${key}`;
  return useSyncExternalStore(useCallback(listener => subscribeRecordLabel(address, listener), [address]), () => readWorkspacePreference(key), () => (values.get(address) ?? null) as T | null);
}

export async function writeInputValue(selector: Selector, payload: unknown): Promise<Reply> {
  const { address } = addressOf(selector);
  if (!address) throw new Error('This input needs an item to save.');
  return sendRequestToBitfieldTarget({ target: LABEL_ADDRESSED, payload: { operation_label: WRITE_BATCH, writes: [{ address_label: address, payload }] } });
}

/** Update a saved input against the store's current value and resolve only after the store confirms it.
 *  Each retry re-reads the owner, so changes to other rows survive a conflict instead of being replaced by a
 *  stale page cache. A lost write response is reconciled by reading the owner before deciding to retry. */
export async function updateInputValueDurably<T = unknown>(selector: Selector, transform: (current: unknown) => T): Promise<T> {
  const { address } = addressOf(selector);
  return updateSavedLabelValueDurably(address, transform);
}

/** Merge a preference through the same current-value compare/retry owner as ordinary inputs. */
export async function updateWorkspacePreferenceDurably<T = unknown>(key: string, transform: (current: unknown) => T): Promise<T> {
  if (!key.trim()) throw new TypeError('A preference needs a name.');
  return updateSavedLabelValueDurably(`workspace-preference:${key}`, transform);
}

/** Update any saved record by its label against the store's current value (the same compare and retry as inputs). */
export async function updateSavedLabelValueDurably<T>(address: string, transform: (current: unknown) => T): Promise<T> {
  if (!address || placeOf(address)) throw new Error('This input cannot be updated in the saved-record store.');
  if (typeof transform !== 'function') throw new TypeError('A saved input update needs a change function.');
  const began = changeCount;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (isQuietWriteWaiting(outboxKey(address))) throw new Error('A change to this record is still being saved. Try again.');
    const current = await readSavedRecordFromOwner(address);
    const expectedIdentity = current.found ? identityOfValue(current.value) : null;
    const next = transform(current.found ? current.value : undefined);
    const nextIdentity = identityOfValue(next);
    // An earlier local durable update may finish after this call began. Publish over it only when the
    // cache still matches the fresh owner value this compare was based on (or already has our result).
    const canPublish = () => {
      if (isQuietWriteWaiting(outboxKey(address))) return false;
      if ((changedAt.get(address) ?? 0) <= began) return true;
      const cachedIdentity = values.has(address) ? identityOfValue(values.get(address)) : null;
      return cachedIdentity === expectedIdentity || cachedIdentity === nextIdentity;
    };
    let reply: { written?: number; write_count?: number; conflicts?: Array<{ address?: string }> };
    try {
      reply = await readJson(RECORDS_PATH, {
        method: 'POST',
        body: JSON.stringify({
          conflict_policy: 'retry',
          writes: [{ address_label: address, payload: next, expected_identity: expectedIdentity }],
        }),
      });
    } catch (error) {
      const status = (error as { status?: number; upgrade_needed?: unknown } | null)?.status;
      if ((status && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429)
        || (error as { upgrade_needed?: unknown } | null)?.upgrade_needed) throw error;
      // The store may have committed before the connection failed. Reconcile by value identity, not the
      // optimistic page cache or the attempted write alone.
      let confirmed: { found: boolean; value?: unknown };
      try { confirmed = await readSavedRecordFromOwner(address); }
      catch (confirmationError) {
        throw Object.assign(new Error('The saved input update could not be confirmed.'), {
          update_outcome: 'unknown', cause: error, confirmationError,
        });
      }
      if (confirmed.found && identityOfValue(confirmed.value) === nextIdentity) {
        if (canPublish()) {
          if (cacheRecord(address, confirmed.value, { loaded: true })) {
            changedAt.set(address, ++changeCount);
            notify();
            for (const listener of savedListeners) listener([address]);
            tellChanged([address]);
          }
        }
        return confirmed.value as T;
      }
      continue;
    }

    const written = reply.written ?? reply.write_count;
    if (written === 1 && (!reply.conflicts || reply.conflicts.length === 0)) {
      if (canPublish()) {
        if (cacheRecord(address, next, { loaded: true })) {
          changedAt.set(address, ++changeCount);
          notify();
          for (const listener of savedListeners) listener([address]);
          tellChanged([address]);
        }
      }
      return next;
    }
    if (written !== 0 || !reply.conflicts?.some(conflict => conflict.address === address)) {
      throw new Error('The saved input update was not confirmed. Try again.');
    }
  }
  throw new Error('This saved input kept changing before the update could be saved. Try again.');
}

function applyWrites(writes: Write[], conflictPolicy?: 'preserve' | 'retry') {
  const labelOf = (write: Write) => write.address_label ?? write.address;
  const expectationFails = (write: Write) => {
    if (write.expected_identity === undefined) return false;
    const label = labelOf(write);
    const current = typeof label === 'string' && values.has(label) ? identityOfValue(values.get(label)) : null;
    return current !== write.expected_identity;
  };
  if (writes.some(expectationFails)) {
    // The worker compares the same expected identities against its authoritative rows and keeps both branches when
    // another writer won. Sending this refused batch is safe to retry: the conflict address is deterministic.
    const kept = writes.filter(write => !write.path || write.path.join('/') === CURRENT_RECORD_PATH).map(write => ({ ...write }));
    if (kept.length) sendQuietly({ key: `workspace-conflict-attempt:${identityOfValue(kept)}`, path: RECORDS_PATH, body: { ...(conflictPolicy ? { conflict_policy: conflictPolicy } : {}), writes: kept } });
    return 0;
  }
  const cacheWrites = writes.flatMap(write => {
    const label = labelOf(write);
    if (typeof label !== 'string' || !label || (write.path && write.path.join('/') !== CURRENT_RECORD_PATH)) return [];
    return [{ label, bytes: retainedRecordBytes(label, write.payload) }];
  });
  if (!reserveRecords(cacheWrites)) throw new Error('The workspace record cache is full. Close another screen and try again.');
  let changed = 0;
  const labels: string[] = [];
  for (const write of writes) {
    const label = labelOf(write);
    if (typeof label !== 'string' || !label) continue;
    if (write.path && write.path.join('/') !== CURRENT_RECORD_PATH) continue;
    commitCachedRecord(label, write.payload);
    labels.push(label);
    changedAt.set(label, ++changeCount);
    sendQuietly({ key: outboxKey(label), path: RECORDS_PATH, body: { ...(conflictPolicy ? { conflict_policy: conflictPolicy } : {}), writes: [{ address_label: label, payload: write.payload, ...(write.expected_identity !== undefined ? { expected_identity: write.expected_identity } : {}) }] }, together: 'writes',
      ...(write.expected_identity !== undefined ? { compare: { path: ['writes', 0, 'expected_identity'], before: write.expected_identity, after: identityOfValue(write.payload), replaceableSnapshot: true as const } } : {}),
    });
    changed += 1;
  }
  if (!changed) return 0;
  notify();
  tellChanged(labels);
  return changed;
}

const LABEL_ADDRESSED = 'engine.operation.label-addressed';
const READ_CURRENT = 'engine.operation.read-current';
const WRITE_BATCH = 'engine.operation.write-batch';
const APPEND_RECORD = 'engine.operation.append-record';
const CURRENT_RECORD_PATH = 'current-item/published-record';
/** The target and operation names the record reads and writes are asked by. */
export const ENGINE_OPERATION_TARGET = LABEL_ADDRESSED;
export const ENGINE_READ_CURRENT_OPERATION_LABEL = READ_CURRENT;
export const ENGINE_WRITE_BATCH_OPERATION_LABEL = WRITE_BATCH;
export const ENGINE_APPEND_RECORD_OPERATION_LABEL = APPEND_RECORD;

type AppendRecord = { address_label: string; field: string; identity_field: string; item: Record<string, unknown> };
/** Append an immutable identified item to a saved list, across independent tabs/bundles. The person's store owns
 *  the compare, not a queue in this module. A reply confirms store acceptance, never merely an outbox enqueue. */
async function appendSavedRecord({ address_label: label, field, identity_field: identityField, item }: AppendRecord) {
  const safeKey = (key: unknown): key is string => typeof key === 'string' && Boolean(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
  if (typeof label !== 'string' || !label || placeOf(label) || !safeKey(field) || !safeKey(identityField)
    || !item || typeof item !== 'object' || Array.isArray(item) || typeof item[identityField] !== 'string' || !item[identityField]) {
    throw new Error('This append needs a saved record, a list and an item with its own identity.');
  }
  // Capture the caller's bytes once. A retry must not silently become a different event.
  const entry = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry[identityField] !== 'string' || !entry[identityField]) throw new Error('This item needs its own saved identity.');
  const entryIdentity = identityOfValue(entry);
  const listOf = (value: unknown): Record<string, unknown>[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('This saved record is not a list container.');
    const list = Object.hasOwn(value, field) ? (value as Record<string, unknown>)[field] : [];
    if (!Array.isArray(list) || list.some(row => !row || typeof row !== 'object' || Array.isArray(row)
      || typeof row[identityField] !== 'string' || !row[identityField])) throw new Error('This saved list has an item without its own identity.');
    return list;
  };
  const publish = (value: Record<string, unknown>, began: number) => {
    // A delayed acknowledgement must not put back a shorter list after another append has been acknowledged.
    const held = values.get(label);
    if ((changedAt.get(label) ?? 0) > began && held && typeof held === 'object') {
      const incoming = new Map(listOf(value).map(row => [row[identityField], identityOfValue(row)]));
      try { if (!listOf(held).every(row => incoming.get(row[identityField]) === identityOfValue(row))) return; }
      catch { return; } // A newer local replacement is not ours to overwrite or misreport as a durable save failure.
    }
    if (!cacheRecord(label, value, { loaded: true })) return;
    changedAt.set(label, ++changeCount);
    notify();
    for (const listener of savedListeners) listener([label]);
    tellChanged([label]);
  };
  for (let attempt = 0; attempt < 16; attempt++) {
    if (isQuietWriteWaiting(outboxKey(label))) throw new Error('A change to this record is still being saved. Try again.');
    const began = changeCount;
    // Explicit GET bypasses page/device answers and read coalescing in api.ts: every compare uses the store's value.
    const answer = await readJson<{ records: Record<string, unknown> }>(`${RECORDS_PATH}?${new URLSearchParams({ label })}`, { method: 'GET', cache: 'no-store' });
    if (!answer.records || typeof answer.records !== 'object' || Array.isArray(answer.records)) throw new Error('The saved record could not be read.');
    const found = Object.hasOwn(answer.records, label);
    const before = found ? answer.records[label] : {};
    const list = listOf(before);
    const duplicate = list.find(row => row[identityField] === entry[identityField]);
    if (duplicate) {
      if (identityOfValue(duplicate) !== entryIdentity) throw new Error('An item with this identity already has different contents.');
      publish(before as Record<string, unknown>, began);
      return { appended: 0, durable: true };
    }
    const next = { ...before as Record<string, unknown>, [field]: [...list, entry] };
    if (!reserveRecords([{ label, bytes: retainedRecordBytes(label, next) }])) throw new Error('The workspace record cache is full. Close another screen and try again.');
    let result: { written?: number; conflicts?: { address?: string }[] };
    try {
      result = await readJson(RECORDS_PATH, {
        method: 'POST', body: JSON.stringify({ conflict_policy: 'retry', writes: [{ address_label: label, payload: next, expected_identity: found ? identityOfValue(before) : null }] }),
      });
    } catch (error) {
      // A lost response can follow a successful write. Reconcile the same immutable item against a fresh owner
      // read before reporting failure; never infer success from the attempted value or an optimistic local copy.
      try {
        const confirmed = await readJson<{ records: Record<string, unknown> }>(`${RECORDS_PATH}?${new URLSearchParams({ label })}`, { method: 'GET', cache: 'no-store' });
        if (!confirmed.records || typeof confirmed.records !== 'object' || Array.isArray(confirmed.records)) throw new Error('The saved record could not be read.');
        const kept = confirmed.records?.[label];
        if (kept && listOf(kept).some(row => row[identityField] === entry[identityField] && identityOfValue(row) === entryIdentity)) {
          publish(kept as Record<string, unknown>, began);
          return { appended: 1, durable: true };
        }
      } catch (confirmationError) {
        throw Object.assign(new Error('The append result could not be confirmed.'), {
          append_outcome: 'unknown', cause: error, confirmationError,
        });
      }
      throw error;
    }
    if (result.written === 1) { publish(next, began); return { appended: 1, durable: true }; }
    if (result.written !== 0 || !result.conflicts?.some(conflict => conflict.address === label)) throw new Error('The item was not confirmed saved. Try again.');
  }
  throw new Error('This list kept changing before the item could be saved. Try again.');
}
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Read one bounded page of open workspace forks, ordered by their hybrid logical clock and stable identity. */
export async function readWorkspaceConflicts({ limit = 25, after = '' }: { limit?: number; after?: string } = {}): Promise<{ conflicts: Record<string, unknown>[]; next_cursor: string | null }> {
  const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, Math.trunc(limit)))), ...(after ? { after } : {}) });
  const reply = await fetch(`/work/api/records/conflicts?${query}`, { credentials: 'same-origin' });
  if (!reply.ok) throw new Error('Could not read workspace conflicts.');
  const page = await bodyOf(reply, body => body.json()) as { conflicts?: Record<string, unknown>[]; next_cursor?: string | null };
  return { conflicts: (page.conflicts ?? [])
    .sort((a, b) => {
      const ac = a.clock as { wall_ms?: number; logical?: number; device_id?: string };
      const bc = b.clock as { wall_ms?: number; logical?: number; device_id?: string };
      return (ac.wall_ms ?? 0) - (bc.wall_ms ?? 0) || (ac.logical ?? 0) - (bc.logical ?? 0)
        || lexical(String(ac.device_id ?? ''), String(bc.device_id ?? '')) || lexical(String(a.id), String(b.id));
    }), next_cursor: page.next_cursor ?? null };
}

/** Read both values for one conflict only when the person opens it. */
export async function readWorkspaceConflict(id: string): Promise<Record<string, unknown>> {
  const reply = await fetch(`/work/api/records/conflicts/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  const body = await bodyOf(reply, answer => answer.json()) as { conflict?: Record<string, unknown>; error?: string };
  if (!reply.ok || !body.conflict) throw new Error(body.error ?? 'Could not read those workspace versions.');
  return body.conflict;
}

/** Keep one of a workspace fork's stored versions, or make a new fork if the record changed again meanwhile. */
export async function resolveWorkspaceConflict(id: string, branchIdentity: string): Promise<{ resolved: boolean; address?: string; kept?: string; conflict_id?: string }> {
  const reply = await fetch(RECORDS_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resolve_conflict: { id, branch_identity: branchIdentity } }) });
  const result = await bodyOf(reply, answer => answer.json()) as { resolved?: boolean; address?: string; kept?: string; conflict_id?: string; error?: string };
  if (!reply.ok) throw new Error(result.error ?? 'Could not resolve workspace conflict.');
  return result as { resolved: boolean; address?: string; kept?: string; conflict_id?: string };
}

type Answer = (payload: unknown) => unknown | Promise<unknown>;
type Answering = { answer: Answer; handles?: (payload: unknown) => boolean };
const answers = new Map<string, Answering[]>();

/**
 * Answer one named target from this page; its return value is sent back as the reply's JSON bytes. Several screens
 * may answer one target (the chat and the workflow canvas both answer `slot::workflow`): one that names what it
 * `handles` answers only those requests, and the one that names nothing answers the rest.
 */
export function answerTarget(target: string, answer: Answer, { handles }: { handles?: (payload: unknown) => boolean } = {}) {
  const listed = (answers.get(target) ?? []).filter(one => (handles ? one.handles !== handles && one.answer !== answer : Boolean(one.handles)));
  answers.set(target, [...listed, { answer, ...(handles ? { handles } : {}) }]);
}
const answerFor = (target: string, payload: unknown) => {
  const listed = answers.get(target) ?? [];
  return (listed.find(one => one.handles?.(payload)) ?? listed.find(one => !one.handles))?.answer;
};

// ---- Records placed in a live room (invariant 9) ----
type Place = { prefix: string; room_path: string };
type Placed = { label: string; path: string; room: string; address: string };
const PLACES = (recordPlaces as { places: Place[] }).places;
/** Where a label lives when a row of record-places.json claims it; null for a label of the person's own store. */
export function placeOf(label: string): Placed | null {
  const place = PLACES.find(one => label.startsWith(one.prefix));
  if (!place) return null;
  const rest = label.slice(place.prefix.length);
  const cut = rest.indexOf('/');
  if (cut <= 0 || cut === rest.length - 1) return null;
  const room = rest.slice(0, cut);
  return { label, room, address: rest.slice(cut + 1), path: place.room_path.replace('{room}', encodeURIComponent(room)) };
}
/** The label of the record at `address` in the room `room` of the place whose prefix is `prefix`. */
export function placedLabel(prefix: string, room: string, address: string): string {
  return `${prefix}${room}/${address}`;
}
// The rooms this page reads placed labels from (open for the page's life), and the labels screens have read there.
type HeldRoom = { room: LiveRoom; stop: () => void; release: () => void };
const placedRooms = new Map<string, HeldRoom>();
const followed = new Set<string>();
function roomOf(placed: Placed): LiveRoom {
  let held = placedRooms.get(placed.path);
  if (held) return held.room;
  const opened = openLiveRoom(placed.path);
  const room = opened.room;
  held = { room, stop: () => {}, release: opened.release };
  placedRooms.set(placed.path, held);
  const prefix = placed.label.slice(0, placed.label.length - placed.room.length - placed.address.length - 1);
  held.stop = room.listen((records, whole) => {
    const changed: string[] = [];
    const heard = whole ? [...room!.known].map(([address, value]) => ({ address, value })) : records;
    for (const record of heard) {
      const label = placedLabel(prefix, placed.room, record.address);
      if (!followed.has(label) || values.get(label) === record.value) continue;
      if (!cacheRecord(label, record.value)) continue;
      changed.push(label);
    }
    if (!changed.length) return;
    notify();
    for (const listener of savedListeners) listener(changed);
    tellChanged(changed);
  });
  return room;
}
function releaseRoomIfUnused(path: string): void {
  if ([...followed].some(label => placeOf(label)?.path === path)) return;
  const held = placedRooms.get(path);
  if (!held) return;
  held.stop();
  held.release();
  placedRooms.delete(path);
}
function unfollow(label: string): void {
  if (!followed.delete(label)) return;
  const placed = placeOf(label);
  if (placed) releaseRoomIfUnused(placed.path);
}
function follow(label: string) {
  if (followed.has(label)) return;
  const placed = placeOf(label);
  if (!placed) return;
  followed.add(label);
  const room = roomOf(placed);
  void room.opened().then(() => {
    if (!room.known.has(placed.address) || values.get(label) === room.known.get(placed.address)) return;
    if (cacheRecord(label, room.known.get(placed.address))) notify();
  }).catch(() => { /* The caller's readPlaced await reports the refused read. */ });
}
async function readPlaced(placed: Placed) {
  follow(placed.label);
  const room = roomOf(placed);
  await room.opened();
  const found = room.known.has(placed.address);
  if (found) cacheRecord(placed.label, room.known.get(placed.address));
  else cacheMissingRecord(placed.label, false);
  return found ? { found, payload: room.known.get(placed.address) } : { found };
}
/** A write batch with records placed in rooms: every expectation is checked first (a placed one against what its
 *  room holds), then each room keeps its records and the rest go to the person's store. */
async function writePlaced(writes: Write[], conflictPolicy?: 'preserve' | 'retry') {
  const labelOf = (write: Write) => write.address_label ?? write.address ?? '';
  const current = writes.filter(write => !write.path || write.path.join('/') === CURRENT_RECORD_PATH);
  const placedWrites = current.map(write => ({ write, placed: placeOf(labelOf(write)) })).filter((one): one is { write: Write; placed: Placed } => one.placed !== null);
  const ownExpected = writes.filter(write => !placeOf(labelOf(write)) && write.expected_identity !== undefined).map(labelOf).filter(label => label && !isRecordLoaded(label));
  if (ownExpected.length) await readSavedLabels(ownExpected);
  for (const { placed } of placedWrites) { follow(placed.label); await roomOf(placed).opened(); }
  const fails = (write: Write) => {
    if (write.expected_identity === undefined) return false;
    const placed = placeOf(labelOf(write));
    const room = placed ? roomOf(placed) : null;
    const has = placed ? room!.known.has(placed.address) : values.has(labelOf(write));
    const value = placed ? room!.known.get(placed.address) : values.get(labelOf(write));
    return (has ? identityOfValue(value) : null) !== write.expected_identity;
  };
  if (writes.some(fails)) {
    // A room owns its own merge rule. Persist the person's-store forks through the workspace owner even though this
    // mixed batch remains all-or-nothing at the caller.
    const ownConflicts = writes.filter(write => !placeOf(labelOf(write)) && fails(write));
    if (ownConflicts.length) applyWrites(ownConflicts, conflictPolicy);
    return 0;
  }
  const own = writes.filter(write => !placeOf(labelOf(write)));
  let written = own.length ? applyWrites(own, conflictPolicy) : 0;
  const byRoom = new Map<string, { placed: Placed; write: Write }[]>();
  for (const one of placedWrites) byRoom.set(one.placed.path, [...(byRoom.get(one.placed.path) ?? []), one]);
  for (const group of byRoom.values()) {
    const room = roomOf(group[0].placed);
    if (!reserveRecords(group.map(({ placed, write }) => ({ label: placed.label, bytes: retainedRecordBytes(placed.label, write.payload) })))) {
      throw new Error('The workspace record cache is full. Close another screen and try again.');
    }
    await room.change(group.map(({ placed, write }) => ({ address: placed.address, value: write.payload })));
    for (const { placed } of group) commitCachedRecord(placed.label, room.known.get(placed.address));
    written += group.length;
    tellChanged(group.map(({ placed }) => placed.label));
  }
  notify();
  return written;
}

// Label-addressed reads and writes of the person's records (and of records placed in a room, invariant 9).
answerTarget(LABEL_ADDRESSED, request => {
  const payload = (request ?? {}) as { operation_label?: string; address_label?: string; writes?: Write[]; conflict_policy?: 'preserve' | 'retry' } & Partial<AppendRecord>;
  if (payload.operation_label === APPEND_RECORD) return appendSavedRecord(payload as AppendRecord);
  if (payload.operation_label === READ_CURRENT && typeof payload.address_label === 'string') {
    const placed = placeOf(payload.address_label);
    if (placed) return readPlaced(placed);
    const current = () => {
      const found = values.has(payload.address_label!);
      return found ? { found, payload: values.get(payload.address_label!) } : { found };
    };
    return isRecordLoaded(payload.address_label) ? current() : readSavedLabels([payload.address_label]).then(current);
  }
  if (payload.operation_label === WRITE_BATCH && Array.isArray(payload.writes)) {
    const writes = payload.writes;
    if (writes.some(write => placeOf(write.address_label ?? write.address ?? ''))) return writePlaced(writes, payload.conflict_policy).then(written => ({ written }));
    const expected = writes.filter(write => write.expected_identity !== undefined).map(write => write.address_label ?? write.address ?? '')
      .filter(label => label && !isRecordLoaded(label));
    const apply = () => ({ written: applyWrites(writes, payload.conflict_policy) });
    return expected.length ? readSavedLabels(expected).then(apply) : apply();
  }
  throw new Error(`This app cannot run ${String(payload.operation_label)} on its records.`);
});

/** Send a request to a target this page answers; every other target is refused by name.
 * Cancellation ends this caller's wait, not a shared answer or an effect already dispatched. */
export async function sendRequestToBitfieldTarget(request: { target: string; payload?: unknown }, signal?: AbortSignal): Promise<Reply> {
  signal?.throwIfAborted();
  const answer = answerFor(request?.target, request?.payload);
  if (!answer) throw new Error(`unknown target: ${String(request?.target)}`);
  const result = signal ? await new Promise<unknown>((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener('abort', cancelled); reject(signal.reason); };
    signal.addEventListener('abort', cancelled, { once: true });
    // Observe late success/failure too, so an abandoned wait cannot leave an unhandled rejection.
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return answer(request.payload);
    }).then(value => {
      signal.removeEventListener('abort', cancelled);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', cancelled);
      reject(error);
    });
  }) : await answer(request.payload);
  return { target: request.target, payload: result instanceof Uint8Array ? result : encode(result) };
}

/** The partition every record here lives in: this person's own store, so one name serves every read and write. */
export function readTrustedRuntimePartitionIfPresent(): string {
  return PERSON_PARTITION;
}
const PERSON_PARTITION = 'person';

/** What a screen written for a hosted runtime is handed when it runs: here nothing, since it runs in this page. */
export type BitfieldRuntimeContext = Record<string, unknown> | undefined;
/** The partition a screen's own operations run in: the person's own store. */
export function readTrustedRuntimePartition(_context?: BitfieldRuntimeContext): string {
  return PERSON_PARTITION;
}
/** The clock a screen's own operations stamp with: this page's clock, an input like a date the person typed. */
export function readTrustedRuntimeClockMs(_context?: BitfieldRuntimeContext): number {
  return Date.now();
}
/** Ids for the things a screen's own operation makes: random ones, since it runs in this page and is never replayed. */
export function createTrustedRuntimeIdMinter(_context?: BitfieldRuntimeContext): () => string {
  return () => crypto.randomUUID();
}
/** What a screen's generated read scope names: the partition its records are read from. */
export const bitfieldGeneratedLiveReadScopeDescriptor = { partitionLabel: PERSON_PARTITION } as const;
/** What a screen's generated entry scope binds its writes to. This page answers every target itself (answerTarget), so
 * the binding names nothing; a screen that imports it reads the same value it would in any app. */
export const bitfieldGeneratedPackageEntryScopeBinding = { scope_binding: null } as const;

/**
 * Every value a named input has had, folded in order into one accumulated value (a growing stream of output, say).
 * The fold starts again from `createInitial` when the input's address changes; the same value is folded once.
 */
export function useBitfieldFold<T, A>(selector: Selector, fold: (accumulated: A, value: T | null) => A, createInitial: () => A): A {
  const { address, row } = addressOf(selector);
  const value = useSyncExternalStore(useCallback(listener => subscribeRecordLabel(address, listener), [address]), () => read(address, row), () => read(address, row)) as T | null;
  const kept = useRef<{ address: string; value: unknown; accumulated: A } | null>(null);
  if (!kept.current || kept.current.address !== address) kept.current = { address, value: undefined, accumulated: createInitial() };
  if (kept.current.value !== value) kept.current = { address, value, accumulated: fold(kept.current.accumulated, value) };
  return kept.current.accumulated;
}

/** A read of one record by its label, answered by the label-addressed read above. */
export function buildEngineReadCurrentRequestFromLabels(_partition: string, addressLabel: string, _options?: { addressMode?: string }) {
  return { target: LABEL_ADDRESSED, payload: { operation_label: READ_CURRENT, address_label: addressLabel } };
}

/** The same read, in the partition this page serves (the person's own store). */
export function buildEngineReadCurrentRequestForServingPartition(addressLabel: string) {
  return buildEngineReadCurrentRequestFromLabels(PERSON_PARTITION, addressLabel);
}

/** The reply of that read: whether the record is there, its bytes as JSON text, and their content identity. */
export function decodeEngineReadCurrentReply(bytes: Uint8Array): { found: boolean; payload: Uint8Array; contentHash: string | null } {
  const reply = JSON.parse(new TextDecoder().decode(bytes)) as { found?: boolean; payload?: unknown };
  if (!reply.found) return { found: false, payload: new Uint8Array(), contentHash: null };
  const payload = encode(reply.payload);
  return { found: true, payload, contentHash: makeHashCodeHexFromBytes(payload) };
}

type WriteEntry = {
  addressLabel?: string;
  addressMultihashHex?: string;
  payload?: unknown;
  value?: unknown;
  payloadBytes?: Uint8Array;
  pathLabels?: readonly string[];
  expectedCurrent?: { payloadHash: Uint8Array | null };
  /** Existing content identity form, used when the matching read already returned it as text. */
  expectedIdentity?: string | null;
};
/**
 * A write request built from label entries, answered by the same label-addressed write. A payload given as bytes is
 * its JSON text; an expected current value is given as its multihash bytes and travels as its content identity.
 */
export function buildEngineWriteBatchRequestFromLabels(entries: ReadonlyArray<WriteEntry>, options: { conflictPolicy?: 'preserve' | 'retry' } = {}) {
  return {
    target: LABEL_ADDRESSED,
    payload: {
      operation_label: WRITE_BATCH,
      ...(options.conflictPolicy ? { conflict_policy: options.conflictPolicy } : {}),
      writes: entries.map(entry => ({
        address_label: entry.addressLabel ?? entry.addressMultihashHex,
        payload: entry.payloadBytes ? JSON.parse(new TextDecoder().decode(entry.payloadBytes)) : entry.payload ?? entry.value,
        ...(entry.pathLabels ? { path: [...entry.pathLabels] } : {}),
        ...(entry.expectedCurrent ? { expected_identity: entry.expectedCurrent.payloadHash ? identityOfMultihash(entry.expectedCurrent.payloadHash) : null } : {}),
        ...(entry.expectedIdentity !== undefined ? { expected_identity: entry.expectedIdentity } : {}),
      })),
    },
  };
}

/** Basis for a conditional saved-record write: use the last store-accepted value, never an optimistic cache value. */
export const savedRecordBasis = (label: string): string | null => {
  const accepted = acceptedRecords.get(label);
  return accepted?.found ? identityOfValue(accepted.value) : null;
};

/** The content identity of a stored value: the identity of the JSON bytes a read of it answers. */
/** The identity a write to `label` must name to be measured against what this page holds now: null while nothing is held
 *  (the same rule a write's expectation is checked by). A screen takes it when it adopts a record, so a later save made
 *  from that copy is refused if the record has changed since. */
export function identityOfValue(value: unknown): string {
  return makeHashCodeHexFromBytes(encode(value));
}

/** A multihash (unsigned-varint code, unsigned-varint length, digest) as the `<code hex>:<digest hex>` identity. */
function identityOfMultihash(bytes: Uint8Array): string {
  let at = 0;
  const varint = () => {
    let value = 0, shift = 0, byte = 0;
    do { byte = bytes[at++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return value;
  };
  const code = varint();
  const length = varint();
  return `${code.toString(16)}:${bytesToHex(bytes.subarray(at, at + length))}`;
}

/** The address of a label: the label itself, since records here are kept by label. */
export function makeIdentityTextAddressFromLabel(label: string): string {
  if (typeof label !== 'string' || !label) throw new TypeError('An address needs a label.');
  return label;
}

// ---- A workflow run's reply, as the workflow canvas reads it ----
// PORTED FROM: bitfield-runtime-kit packages/js/src/protocol/workflow-result.ts (decodeWorkflowRunReply and its two
// types, verbatim but for the file's own small helpers, renamed here so they do not collide with this file's names).

export interface WorkflowRunStepResult {
  stepId: string;
  status: string;
  error: string | null;
  durationMs: number;
  /** The step's real output payload (n8n-style per-step data preview). */
  output: unknown;
}

export interface WorkflowRunResult {
  definitionId: string;
  status: string;
  durationMs: number;
  output: unknown;
  steps: WorkflowRunStepResult[];
  error: string | null;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const readReplyText = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null);
const readReplyNumber = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0);
/** Realm-safe byte check: `instanceof Uint8Array` lies across realms; `ArrayBuffer.isView` is the structural truth. */
const replyBytes = (value: unknown): Uint8Array | null => (ArrayBuffer.isView(value) && !(value instanceof DataView)
  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  : null);

/** The transport reply is `{payload: Uint8Array}`; anything unreadable degrades to an honest empty body. */
function replyBody(reply: unknown): Record<string, unknown> {
  const payload = (isPlainRecord(reply) ? replyBytes(reply.payload) : null) ?? replyBytes(reply);
  if (payload) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
      return isPlainRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isPlainRecord(reply) ? reply : {};
}

export function decodeWorkflowRunReply(definitionId: string, reply: unknown): WorkflowRunResult {
  const body = replyBody(reply);
  const steps: WorkflowRunStepResult[] = [];
  if (isPlainRecord(body.steps)) {
    for (const [stepId, raw] of Object.entries(body.steps)) {
      const step = isPlainRecord(raw) ? raw : {};
      steps.push({
        stepId,
        status: readReplyText(step.status) ?? 'unknown',
        error: readReplyText(step.error),
        durationMs: readReplyNumber(step.duration_ms),
        output: step.output ?? null,
      });
    }
    // Numeric-aware ordering: step_10 runs after step_2, so it sorts after it too.
    steps.sort((left, right) => left.stepId.localeCompare(right.stepId, undefined, { numeric: true }));
  }
  return {
    definitionId,
    status: readReplyText(body.status) ?? 'unknown',
    durationMs: readReplyNumber(body.duration_ms),
    output: body.output ?? null,
    steps,
    error: readReplyText(body.error),
  };
}
