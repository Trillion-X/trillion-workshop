// src/workspace/quiet-writes.ts
//
// NO PRIOR: searched the Bitfield packages (packages/*/show) for "outbox", "offline queue", "retry queue" and
// "send again", and the 21st.dev catalog for "offline write queue retry outbox": none. Built on the existing sealed
// device store (parts/ui/show/request/kept-values.ts) and notification center.
//
// PURPOSE
//   The one way the page sends a small write the person never waits on: a tour choice, a layout change, marking a
//   screen seen. The page shows the change at once; the write is kept here, and on this device (the account's own
//   sealed store of kept answers, first-answers.json `kept`), until the person's store accepts it. A store that is busy
//   or cannot be reached is asked again by itself after growing waits (quiet-writes.json), and again the moment the
//   device is back online or the page is shown; a page closed or reloaded before then sends it from the device copy
//   when it opens. The person hears about a write only when their store refused it for good.
//
// NON-NEGOTIABLE INVARIANTS
//   0. A busy answer that names a Retry-After is waited out at least that long (never past `retry_after_max_ms`), so a
//      rate-limited store is not asked again sooner than it said, while an answer naming nothing keeps `waits_ms`.
//   1. Unconditional replacements keep the newest value per key. Conditional replacements can combine only an
//      undispatched chain (S -> A -> B becomes S -> B); a dispatched predecessor stays until its outcome settles.
//      Every write sent this way is safe to send again, including an already-applied conditional replacement.
//   2. Writes that name the same `together` field and path, and are otherwise the same, ride in one request, that
//      field's lists joined in order.
//   3. A write leaves this outbox only when the store accepted it (2xx) or refused it for good; a busy answer, a
//      network failure or a short sign-out never loses it.
//   4. A write refused for good is told once, in the notification center, and never sent again.
//   5. The device copy is the waiting writes and those on their way. One device write runs at a time; while it runs,
//      only the latest complete snapshot waits, so slow storage cannot retain a whole document per keystroke.
//   6. Whoever shows how many writes wait (the catch-up mark, catch-up.tsx) is told after every change
//      (onQuietWritesChange) and reads the count and when the store last accepted one; nothing is polled.
//   8. The device copy holds one session per open tab ({ beat, entries }), changed only under the browser lock, so two tabs
//      never overwrite each other's waiting writes. A tab beats while it has writes; leaving or hiding the page lets go of
//      its session at once; a session silent for `sessions.silent_after_ms` is claimed, whole and in order, by the next tab
//      to look (when it opens and at each beat), in one change that also puts it into the claimer's own session, so a
//      write is never in neither. A page that holds the lock longer than `sessions.lock_wait_ms` (a hidden web view the
//      system has stopped in the middle of its change) has it taken from it, as a silent tab has its session taken:
//      whatever it writes when it wakes is safe, because every write here is safe to send again (invariant 1) and each
//      tab puts its own session back at its next beat.
//  11. A page that keeps an outbox starts it itself as the page loads: what an earlier page left is claimed and sent at
//      once, whatever the page's own first reads answer. Nothing else has to start first for a kept write to be sent.
//   9. A write refused for good is kept as a dead letter for `dead_letters.keep_days` days: the write whole, why, and when.
//      The person can try it again (it goes back in line) or drop it; nothing is lost with its notice.
//  10. Nothing here runs when the file loads beyond making empty tables: the Worker bundle carries this file too, and workerd
//      refuses randomness at load (the deploy gate's new account failed), so this page's name in the device copy is made on first use (tabId).
//   7. A page opened to look at someone's Trillion by their leave (src/view-as.mjs) is read only: its small writes (a
//      screen marked seen, a tour skipped) are the looker's, not the owner's, so they are dropped here, never sent,
//      kept or told as refused (readOnlyPage).

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createKeptValues, type KeptValues } from '../../parts/ui/show/request/kept-values.ts';
import firstAnswers from './first-answers.json' with { type: 'json' };
import settings from './quiet-writes.json' with { type: 'json' };

/** The owner supplies opaque version identities and the exact condition field; only owners that explicitly identify
 * full replacement snapshots may opt into skipping a permanently refused local prerequisite. */
export type QuietWriteComparison = { path: Array<string | number>; before: string | null; after: string; replaceableSnapshot?: true };
export type QuietWrite = { key: string; path: string; body: Record<string, unknown>; together?: string; compare?: QuietWriteComparison };
export type QuietWriteReceipt = QuietWrite & { readonly generation: number };
type Entry = QuietWrite & { tries: number; due: number; generation: number; requestedBody: string; attempted: boolean; requestIdentity: string };
type KeptWrite = QuietWrite & { attempted?: boolean; request_identity?: string };

export class QuietWriteSupersededError extends Error {
  constructor() { super('A newer pending change replaced this version.'); this.name = 'QuietWriteSupersededError'; }
}

const waiting = new Map<string, Entry[]>();
const onTheirWay = new Map<string, Entry>();
const generations = new Map<string, number>();
// Per-key current-generation entries are deleted when idle. Keep ordering across
// those idle periods with one scalar so accepted-baseline fences never compare a
// new generation 1 with an old generation 2.
let generationSequence = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastSentAt = -Infinity;
// The bytes a browser finishes sending after a page is left, counted across every such send still on its way.
const KEEPALIVE_BYTES = 64 * 1024;
let keepaliveBytesOnTheirWay = 0;

const sameQuietDestination = (a: QuietWrite, b: QuietWrite) => a.path === b.path
  && JSON.stringify(a.body.scope ?? null) === JSON.stringify(b.body.scope ?? null);
const plain = ({ key, path, body, together, compare }: QuietWrite): QuietWrite => ({ key, path, body, ...(together ? { together } : {}), ...(compare ? { compare } : {}) });
// Own the submitted JSON value before asynchronous sending or persistence. The caller's
// later edits must not turn this invocation into different bytes with a different key.
const snapshotWrite = (write: QuietWrite): QuietWrite => JSON.parse(JSON.stringify(plain(write))) as QuietWrite;
const receipt = (entry: Entry): QuietWriteReceipt => ({ ...plain(entry), generation: entry.generation });
const pendingEntries = () => [...waiting.values()].flat();
const pendingHeads = () => [...waiting.values()].map(entries => entries[0]);
const nextGeneration = (key: string) => {
  const generation = ++generationSequence;
  generations.set(key, generation);
  return generation;
};
function releaseGenerationWhenIdle(key: string): void {
  if (!waiting.has(key) && !onTheirWay.has(key) && !acceptanceWaiters.has(key)) generations.delete(key);
}

let device: KeptValues | null = (() => {
  if (typeof document === 'undefined' || typeof indexedDB === 'undefined') return null;
  const kept = JSON.parse(document.getElementById(firstAnswers.kept.element_id)?.textContent || 'null') as { store: string; key: string } | null;
  return kept ? createKeptValues(kept.store, { key: kept.key }) : null;
})();
/** Keep the outbox in another device store (a test's stand-in), or nowhere; forgets what this page restored. */
export function keepQuietWritesIn(store: KeptValues | null): void {
  const leaving = device;
  if (leaving && leaving !== store) void letGoOfSession(leaving);
  device = store;
  restoring = null;
  pendingDeviceCopy = null;
  deadLetters = [];
  tellDeadLetters();
  settleDeviceCopy(++deviceRevision, false);
  if (store) startHeartbeat(); else stopHeartbeat();
}

// ---- the device copy: one session per tab, and the dead letters --------------------------------------------------------
type Session = { beat: number; entries: KeptWrite[] };
/** A write refused for good, kept whole so the person can try it again or drop it. */
export type DeadLetter = { id: string; at: number; status: number; write: QuietWrite; request_identity?: string };
type DeviceIndex = { sessions: Record<string, Session>; dead: DeadLetter[] };
let tabName: string | null = null;
/** This page's name in the device copy, made when it is first needed (not when the file loads). */
const tabId = (): string => (tabName ??= typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `tab-${Math.random().toString(36).slice(2)}`);
// A request identity is an outgoing invocation nonce, never a credential or a claim about a person.
// Keep it with the existing outbox value across device recovery. Old copies did not carry one;
// their first keyed attempt gets an identity without pretending to recover an unknown old RPC.
const savedRequestIdentity = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
const freshRequestIdentity = (generation: number): string => `${tabId()}:${generation}`;
const requestKeyEncoder = new TextEncoder();
function batchRequestKey(entries: Entry[], text: string): string {
  // Bind to the exact transmitted bytes and ordered original entry identities. Batching is unchanged:
  // an unchanged batch retry has the same key; a new/rebased/regrouped body is a new command.
  // The established BLAKE3 implementation owns the digest; no input or private entry identity is sent in a header.
  return `quiet-write:${bytesToHex(blake3(requestKeyEncoder.encode(JSON.stringify([entries[0].path, entries.map(entry => entry.requestIdentity), text]))))}`;
}
const LEGACY_SESSION = 'earlier-page';
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** The index a device copy holds. A copy an earlier page kept as a plain list of writes is a session that let go. */
function indexOf(value: unknown): DeviceIndex {
  if (Array.isArray(value)) return { sessions: value.length ? { [LEGACY_SESSION]: { beat: 0, entries: value as KeptWrite[] } } : {}, dead: [] };
  if (!isObject(value)) return { sessions: {}, dead: [] };
  const sessions: Record<string, Session> = {};
  if (isObject(value.sessions)) for (const [name, session] of Object.entries(value.sessions)) {
    if (isObject(session) && Array.isArray(session.entries)) sessions[name] = { beat: typeof session.beat === 'number' ? session.beat : 0, entries: session.entries as KeptWrite[] };
  }
  return { sessions, dead: Array.isArray(value.dead) ? (value.dead as DeadLetter[]).filter(letter => isObject(letter) && typeof letter.id === 'string' && isObject(letter.write)) : [] };
}
const encodeIndex = (index: DeviceIndex): unknown => ({ sessions: index.sessions, dead: index.dead });
function pruneDead(index: DeviceIndex): boolean {
  const oldest = Date.now() - settings.dead_letters.keep_days * 86_400_000;
  const kept = index.dead.filter(letter => letter.at >= oldest).slice(-settings.dead_letters.most);
  const changed = kept.length !== index.dead.length;
  index.dead = kept;
  return changed;
}
let indexChain: Promise<unknown> = Promise.resolve();
/**
 * Change the device copy under the browser lock (and one change at a time in this page). `change` returns whether it
 * changed anything; the index as written (or as found) comes back, or null when the store could not be read or written.
 */
function updateIndex(store: KeptValues, change: (index: DeviceIndex) => boolean): Promise<DeviceIndex | null> {
  const run = async (): Promise<DeviceIndex | null> => {
    try {
      // A page opened to look at someone's Trillion never reads or changes the device copy (invariant 7).
      if (readOnly || store !== device) return null;
      const index = indexOf(await store.read(settings.kept_under));
      // The page may have become read only, or been given another account's store, while the read was on its way.
      if (readOnly || store !== device) return null;
      const changed = change(index);
      const pruned = pruneDead(index);
      if (changed || pruned) {
        await store.write(settings.kept_under, encodeIndex(index), { unsynced: Object.values(index.sessions).some(session => session.entries.length > 0) });
        return indexOf(await store.read(settings.kept_under));
      }
      return index;
    } catch { return null; }
  };
  const locks = typeof navigator === 'undefined' ? null : navigator.locks;
  // A holder past the wait is stopped, not working (invariant 8): the lock is taken from it. A page whose own lock was
  // taken (AbortError, not this wait's TimeoutError) does not take it back.
  const locked = () => (locks
    ? locks.request(settings.sessions.lock, { signal: AbortSignal.timeout(settings.sessions.lock_wait_ms) }, run)
      .catch((error: unknown) => (error as { name?: unknown })?.name === 'TimeoutError' ? locks.request(settings.sessions.lock, { steal: true }, run) : null)
      .catch(() => null)
    : run());
  const next = indexChain.then(locked, locked) as Promise<DeviceIndex | null>;
  indexChain = next.catch(() => null);
  return next;
}
/** Let go of this tab's session, so the next tab to look claims its writes at once (the page is being left or hidden for good). */
export function letGoOfQuietWritesSession(): Promise<void> { return device ? letGoOfSession(device) : Promise.resolve(); }
async function letGoOfSession(store: KeptValues): Promise<void> {
  await updateIndex(store, index => {
    const mine = index.sessions[tabId()];
    if (!mine || mine.beat === 0) return false;
    mine.beat = 0;
    return true;
  });
}
/** Take every other tab's silent session into this tab's own, in one change, and return what it held. */
async function claimSilentSessions(store: KeptValues): Promise<KeptWrite[]> {
  let claimed: KeptWrite[] = [];
  const found = await updateIndex(store, index => {
    const now = Date.now();
    claimed = [];
    for (const [name, session] of Object.entries(index.sessions)) {
      if (name === tabId() || now - session.beat <= settings.sessions.silent_after_ms) continue;
      claimed.push(...session.entries);
      delete index.sessions[name];
    }
    if (!claimed.length) return false;
    const mine = index.sessions[tabId()];
    index.sessions[tabId()] = { beat: now, entries: [...(mine?.entries ?? []), ...claimed] };
    return true;
  });
  if (found === null) return [];
  deadLetters = found.dead;
  tellDeadLetters();
  return claimed;
}
let heartbeat: ReturnType<typeof setInterval> | null = null;
function startHeartbeat(): void {
  if (heartbeat || typeof setInterval === 'undefined') return;
  heartbeat = setInterval(() => { void beat(); }, settings.sessions.heartbeat_ms);
  (heartbeat as { unref?: () => void }).unref?.();
}
function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}
/** One beat: this tab's session is current (put back whole when a page that woke late wrote over it), and any other
 *  tab's silent session is claimed and its writes sent. */
async function beat(): Promise<void> {
  const store = device;
  if (!store || readOnly) return;
  if (pendingEntries().length + onTheirWay.size) await updateIndex(store, index => {
    const mine = index.sessions[tabId()];
    const entries = keptEntries();
    if (!mine && !entries.length) return false;
    index.sessions[tabId()] = { beat: Date.now(), entries: mine?.entries ?? entries };
    return true;
  });
  if (store !== device || readOnly) return;
  takeInto(await claimSilentSessions(store));
}
/** Put writes another page left (or another tab's silent session held) back in line; a write this page already made under the same key wins. */
function takeInto(kept: KeptWrite[]): QuietWrite[] {
  const currentKeys = new Set([...waiting.keys(), ...onTheirWay.keys()]);
  const restored = kept.filter(write => {
    if (typeof write?.key !== 'string' || typeof write.path !== 'string' || !write.body || typeof write.body !== 'object' || currentKeys.has(write.key)) return false;
    try { validateComparison(write); return true; } catch { return false; }
  });
  for (const write of restored) {
    const owned = snapshotWrite(write);
    const generation = nextGeneration(write.key);
    appendWaiting({ ...owned, tries: 0, due: 0, generation, requestedBody: JSON.stringify(owned.body), attempted: write.attempted === true,
      requestIdentity: savedRequestIdentity(write.request_identity) ?? freshRequestIdentity(generation) });
  }
  if (restored.length) { keepOnDevice(); schedule(); }
  return restored.map(plain);
}

let deadLetters: DeadLetter[] = [];
const deadListeners = new Set<() => void>();
const tellDeadLetters = () => { for (const listener of [...deadListeners]) listener(); };
/** Writes the store refused for good, kept whole for `dead_letters.keep_days` days (newest last). */
export const quietDeadLetters = (): readonly DeadLetter[] => deadLetters;
/** Be told when the dead letters changed; returns the call that stops it. */
export function onQuietDeadLettersChange(listener: () => void) {
  deadListeners.add(listener);
  return () => { deadListeners.delete(listener); };
}
async function buryDeadLetters(entries: Entry[], status: number): Promise<void> {
  const store = device;
  if (!store || readOnly) return;
  const buried = entries.map(entry => ({ id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, at: Date.now(), status, write: plain(entry), request_identity: entry.requestIdentity }));
  const found = await updateIndex(store, index => { index.dead.push(...buried); return true; });
  if (found && store === device) { deadLetters = found.dead; tellDeadLetters(); }
}
/** Put dead letters (those named, else all) back in line to be sent again; how many. */
export async function retryQuietDeadLetters(ids?: readonly string[]): Promise<number> {
  const store = device;
  if (!store || readOnly) return 0;
  let taken: DeadLetter[] = [];
  const found = await updateIndex(store, index => {
    taken = index.dead.filter(letter => !ids || ids.includes(letter.id));
    index.dead = index.dead.filter(letter => !taken.includes(letter));
    return taken.length > 0;
  });
  if (found && store === device) { deadLetters = found.dead; tellDeadLetters(); }
  for (const letter of taken) { try { enqueueQuietly(letter.write, savedRequestIdentity(letter.request_identity)); } catch { /* a letter whose comparison no longer holds is dropped, not sent */ } }
  return taken.length;
}
/** Drop dead letters (those named, else all) for good; how many. */
export async function discardQuietDeadLetters(ids?: readonly string[]): Promise<number> {
  const store = device;
  if (!store || readOnly) return 0;
  let dropped = 0;
  const found = await updateIndex(store, index => {
    const before = index.dead.length;
    index.dead = index.dead.filter(letter => ids && !ids.includes(letter.id));
    dropped = before - index.dead.length;
    return dropped > 0;
  });
  if (found && store === device) { deadLetters = found.dead; tellDeadLetters(); }
  return dropped;
}

const changeListeners = new Set<() => void>();
let acceptedAt: number | null = null;
/** Be told whenever the writes waiting here changed (one made, one accepted, one refused); returns the call that stops it. */
export function onQuietWritesChange(listener: () => void) {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}
/** How many writes have not reached the store yet (waiting, or on their way). */
export const quietWritesWaiting = (): number => pendingEntries().length + onTheirWay.size;
/** When the store last accepted a write from this page (milliseconds), or null before the first. */
export const quietWritesAcceptedAt = (): number | null => acceptedAt;

type DeviceCopy = { store: KeptValues; revision: number; text: string };
let deviceRevision = 0;
let completedDeviceRevision = 0;
let completedDeviceCopyKept = false;
let writingDeviceCopy = false;
let pendingDeviceCopy: DeviceCopy | null = null;
const deviceCopyWaiters = new Set<{ revision: number; resolve: (kept: boolean) => void }>();
function settleDeviceCopy(revision: number, kept: boolean) {
  if (revision < completedDeviceRevision) return;
  completedDeviceRevision = revision;
  completedDeviceCopyKept = kept;
  for (const waiter of [...deviceCopyWaiters]) if (waiter.revision <= revision) {
    deviceCopyWaiters.delete(waiter);
    waiter.resolve(kept);
  }
}
async function writeDeviceCopies() {
  if (writingDeviceCopy) return;
  writingDeviceCopy = true;
  while (pendingDeviceCopy) {
    const copy = pendingDeviceCopy;
    pendingDeviceCopy = null;
    let kept = false;
    try {
      if (copy.store === device) {
        const entries = JSON.parse(copy.text) as KeptWrite[];
        // This tab's session is changed under the lock, so another tab's session is never overwritten. KeptValues deliberately turns a full/refused disk into a no-op. Only a matching read-back proves a copy.
        // A read-only page may clear its old outbox, but never reads the looked-at account's kept values.
        const found = await updateIndex(copy.store, index => {
          if (entries.length) index.sessions[tabId()] = { beat: Date.now(), entries }; else if (index.sessions[tabId()]) delete index.sessions[tabId()]; else return false;
          return true;
        });
        kept = found !== null && copy.store === device && !readOnly && JSON.stringify(found.sessions[tabId()]?.entries ?? []) === copy.text;
      }
    } catch { /* A failed device copy does not prevent the remote write or a later device attempt. */ }
    settleDeviceCopy(copy.revision, kept);
  }
  writingDeviceCopy = false;
}
function keepOnDevice() {
  for (const listener of [...changeListeners]) listener();
  const store = device;
  const revision = ++deviceRevision;
  if (!store) { pendingDeviceCopy = null; settleDeviceCopy(revision, false); return; }
  pendingDeviceCopy = { store, revision, text: JSON.stringify(keptEntries()) };
  void writeDeviceCopies();
}
/** This tab's writes as its session keeps them. An attempted version can have reached the server before its
 *  acknowledgement was lost: it stays ahead of its descendants on restart too, since saving just the newest value
 *  would leave that value expecting an unsent version. */
function keptEntries(): KeptWrite[] {
  return [...onTheirWay.values(), ...pendingEntries()].map(entry => ({ ...plain(entry), request_identity: entry.requestIdentity, ...(entry.attempted ? { attempted: true } : {}) }));
}
/** Wait for the complete device snapshot covering changes so far; false means it could not be checked on disk. */
export function quietWritesKept(): Promise<boolean> {
  const revision = deviceRevision;
  if (revision <= completedDeviceRevision) return Promise.resolve(completedDeviceCopyKept);
  return new Promise(resolve => { deviceCopyWaiters.add({ revision, resolve }); });
}

type DraftOperation =
  | { kind: 'keep'; text: string; resolve: (kept: boolean) => void }
  | { kind: 'forget'; expected: string; resolve: (forgotten: boolean) => void }
  | { kind: 'read'; resolve: (value: unknown | null) => void };
type DraftLane = { running: boolean; waiting: DraftOperation[] };
const draftLanes = new WeakMap<KeptValues, Map<string, DraftLane>>();
const DRAFT_KIND = 'quiet-device-draft/v1';
const CLEARED_DRAFT = JSON.stringify({ kind: 'quiet-device-draft-cleared/v1' });
function draftKey(key: string): string | null { return typeof key === 'string' && key ? `quiet-draft:${key}` : null; }
function draftValue(kept: unknown): { value: unknown } | null {
  return kept && typeof kept === 'object' && !Array.isArray(kept)
    && (kept as { kind?: unknown }).kind === DRAFT_KIND && Object.hasOwn(kept, 'value')
    ? kept as { value: unknown } : null;
}
async function writeCheckedDraft(store: KeptValues, key: string, text: string): Promise<boolean> {
  if (device !== store || readOnly) return false;
  await store.write(key, JSON.parse(text), { unsynced: text !== CLEARED_DRAFT });
  if (device !== store || readOnly) return false;
  const found = await store.read(key);
  return device === store && !readOnly && JSON.stringify(found) === text;
}
function enqueueDraft(store: KeptValues, key: string, operation: DraftOperation): void {
  const lanes = draftLanes.get(store) ?? new Map<string, DraftLane>();
  draftLanes.set(store, lanes);
  const lane = lanes.get(key) ?? { running: false, waiting: [] };
  lanes.set(key, lane);
  const previous = lane.waiting.at(-1);
  if (operation.kind === 'keep' && previous?.kind === 'keep') {
    // Exact older callers are told their draft was superseded; only the active and newest draft retain text.
    lane.waiting.pop();
    previous.resolve(false);
  }
  lane.waiting.push(operation);
  if (lane.running) return;
  lane.running = true;
  void (async () => {
    while (lane.waiting.length) {
      const next = lane.waiting.shift()!;
      let kept: unknown = null;
      let checked = false;
      try {
        const perform = async () => {
          if (device === store && !readOnly) {
            if (next.kind === 'keep') checked = await writeCheckedDraft(store, key, next.text);
            else {
              const found = draftValue(await store.read(key));
              if (device === store && !readOnly && found) {
                if (next.kind === 'read') kept = found.value;
                else if (JSON.stringify(found.value) === next.expected) checked = await writeCheckedDraft(store, key, CLEARED_DRAFT);
              }
            }
          }
        };
        // Cooperating tabs must hold the same key through read/compare/write, not merely through the write itself.
        // The account store still owns encryption and access; the origin-wide lock carries no document content.
        const locks = typeof navigator === 'undefined' ? null : navigator.locks;
        if (locks) await locks.request(`trillion:${key}`, perform); else await perform();
      } catch { /* Unavailable, unopenable or full storage must not be reported as a saved or cleared draft. */ }
      if (next.kind === 'read') next.resolve(kept); else next.resolve(checked);
    }
    lane.running = false;
    lanes.delete(key);
  })();
}
/** Read an owner's recovery draft from this account's sealed device store, after earlier same-key operations. */
export function readQuietDeviceDraft<T>(key: string): Promise<T | null> {
  const store = device;
  const address = draftKey(key);
  if (!store || !address || readOnly) return Promise.resolve(null);
  return new Promise(resolve => { enqueueDraft(store, address, { kind: 'read', resolve: value => resolve(value as T | null) }); });
}
/** Keep an exact recovery draft. True requires matching sealed-store read-back; a superseded draft answers false. */
export function keepQuietDeviceDraft(key: string, value: unknown): Promise<boolean> {
  const store = device;
  const address = draftKey(key);
  if (!store || !address || readOnly) return Promise.resolve(false);
  try {
    if (JSON.stringify(value) === undefined) return Promise.resolve(false);
    const text = JSON.stringify({ kind: DRAFT_KIND, value });
    return new Promise(resolve => { enqueueDraft(store, address, { kind: 'keep', text, resolve }); });
  } catch { return Promise.resolve(false); }
}
/** Clear only the exact draft the owner resolved. A late acknowledgement cannot erase a newer local version. */
export function forgetQuietDeviceDraftIfValue(key: string, expectedValue: unknown): Promise<boolean> {
  const store = device;
  const address = draftKey(key);
  if (!store || !address || readOnly) return Promise.resolve(false);
  try {
    const expected = JSON.stringify(expectedValue);
    if (expected === undefined) return Promise.resolve(false);
    return new Promise(resolve => { enqueueDraft(store, address, { kind: 'forget', expected, resolve }); });
  } catch { return Promise.resolve(false); }
}

const refusedListeners = new Set<(writes: QuietWrite[], status: number) => void>();
const refusedReceiptListeners = new Set<(writes: QuietWriteReceipt[], status: number) => void>();
const acceptedListeners = new Set<(writes: QuietWriteReceipt[], result: unknown) => void>();
type AcceptanceWaiter = { generation: number; path: string; body: string; scheduled: boolean; resolve: () => void; reject: (error: Error) => void };
const acceptanceWaiters = new Map<string, Set<AcceptanceWaiter>>();
/** Be told what the store accepted so owners can handle a compare conflict without rereading unrelated records. */
export function onQuietWriteAccepted(listener: (writes: QuietWriteReceipt[], result: unknown) => void) {
  acceptedListeners.add(listener);
  return () => { acceptedListeners.delete(listener); };
}
/** Be told when the store refused writes for good; returns the call that stops it. */
export function onQuietWriteRefused(listener: (writes: QuietWrite[], status: number) => void) {
  refusedListeners.add(listener);
  return () => { refusedListeners.delete(listener); };
}
/** Refusals with the exact submitted generation, for consumers that must ignore older saves. */
export function onQuietWriteRefusedReceipt(listener: (writes: QuietWriteReceipt[], status: number) => void) {
  refusedReceiptListeners.add(listener);
  return () => { refusedReceiptListeners.delete(listener); };
}
function tellRefused(entries: Entry[], status: number) {
  let rebased = false;
  for (const entry of entries) if (rebaseReplaceableSuccessor(entry)) rebased = true;
  if (rebased) keepOnDevice();
  for (const entry of entries) settleAcceptance(entry, entry.generation, new Error(`The saved change was refused (${status}).`));
  void buryDeadLetters(entries, status);
  const writes = entries.map(plain);
  for (const listener of refusedListeners) listener(writes, status);
  for (const listener of refusedReceiptListeners) listener(entries.map(receipt), status);
  if (typeof document === 'undefined') return;
  // The notification host is a page's (React and its controls), loaded only where a page is: the Worker reads this
  // module too, and must not carry the page's controls into every start.
  void import('../../parts/ui/show/coss/notifications').then(({ ensureNotificationHost }) => ensureNotificationHost().emit(settings.refused.title, { kind: settings.refused.kind, detail: settings.refused.detail }));
}

/** A record row is a complete replacement, so an undispatched exact descendant
 * can skip a permanently refused local prerequisite while retaining its original
 * CAS basis. Other compare owners remain opaque and are never rebased here. */
function rebaseReplaceableSuccessor(refused: Entry): boolean {
  const basis = refused.compare;
  const successor = waiting.get(refused.key)?.[0];
  const next = successor?.compare;
  if (!basis?.replaceableSnapshot || !successor || successor.attempted || !sameQuietDestination(successor, refused)
      || successor.together !== refused.together || !next?.replaceableSnapshot
      || next.before !== basis.after || next.path.length !== basis.path.length
      || next.path.some((part, index) => part !== basis.path[index])) return false;
  const body = structuredClone(successor.body);
  let parent: Record<string | number, unknown> = body;
  for (const part of next.path.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
  const field = next.path.at(-1)!;
  if (parent[field] !== next.before) return false;
  parent[field] = basis.before;
  const requestedBody = JSON.stringify(body);
  successor.body = body;
  successor.compare = { ...next, before: basis.before };
  successor.requestedBody = requestedBody;
  for (const waiter of acceptanceWaiters.get(successor.key) ?? []) {
    if (waiter.generation === successor.generation && waiter.path === successor.path) waiter.body = requestedBody;
  }
  return true;
}

function settleAcceptance(write: QuietWrite & { requestedBody?: string }, generation: number, error?: Error) {
  const waiters = acceptanceWaiters.get(write.key);
  if (!waiters) return;
  for (const waiter of [...waiters]) {
    if (waiter.generation !== generation || waiter.path !== write.path || waiter.body !== (write.requestedBody ?? JSON.stringify(write.body))) continue;
    waiters.delete(waiter);
    error ? waiter.reject(error) : waiter.resolve();
  }
  if (!waiters.size) acceptanceWaiters.delete(write.key);
}
function settleVerifiedAcceptance(write: Entry, result: unknown, expectedWritten: number) {
  const waiters = acceptanceWaiters.get(write.key);
  if (!waiters) return;
  const matching = [...waiters].filter(waiter => waiter.generation === write.generation
    && waiter.path === write.path && waiter.body === write.requestedBody);
  if (!matching.length) return;
  const reply = result && typeof result === 'object' && !Array.isArray(result)
    ? result as { written?: unknown; write_count?: unknown; conflicts?: unknown }
    : null;
  const count = reply?.written ?? reply?.write_count;
  const conflicts = reply?.conflicts;
  const refused = Array.isArray(conflicts) && conflicts.length > 0;
  const error = refused
    ? new Error('The saved change conflicted and was not accepted.')
    : typeof count !== 'number' || !Number.isSafeInteger(count) || count !== expectedWritten
      ? new Error('The saved change could not be verified. Try again.')
      : undefined;
  settleAcceptance(write, write.generation, error);
}

/** Wait for this exact keyed write to be accepted by the person's store. Register before sending it. */
export function trackQuietWriteAcceptance(write: Pick<QuietWrite, 'key' | 'path' | 'body' | 'compare'>): { accepted: Promise<void>; cancel: () => void } | null {
  if (readOnly) return null;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const accepted = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const waiter = { generation: 0, path: write.path, body: JSON.stringify(write.body), scheduled: false, resolve, reject };
  const waiters = acceptanceWaiters.get(write.key) ?? new Set();
  waiters.add(waiter);
  acceptanceWaiters.set(write.key, waiters);
  return { accepted, cancel: () => {
    waiters.delete(waiter);
    if (!waiters.size && acceptanceWaiters.get(write.key) === waiters) acceptanceWaiters.delete(write.key);
    releaseGenerationWhenIdle(write.key);
    resolve();
  } };
}

let readOnly = false;
/** Makes this page read only (invariant 7): every small write after it is dropped. */
export function readOnlyPage(): void {
  readOnly = true;
  stopHeartbeat();
  waiting.clear();
  for (const [key, waiters] of acceptanceWaiters) {
    acceptanceWaiters.delete(key);
    for (const waiter of waiters) waiter.reject(new Error('This page is read only.'));
    releaseGenerationWhenIdle(key);
  }
  keepOnDevice();
}
export const quietWritesAreReadOnly = (): boolean => readOnly;

/** Send one small write: kept until the store accepts it, sent again by itself while the store is busy. */
export function sendQuietly(write: QuietWrite): number | null {
  return enqueueQuietly(write);
}
function enqueueQuietly(write: QuietWrite, requestIdentity?: string): number | null {
  if (readOnly) return null;
  write = snapshotWrite(write);
  validateComparison(write);
  const generation = nextGeneration(write.key);
  const requestedBody = JSON.stringify(write.body);
  const waiter = [...(acceptanceWaiters.get(write.key) ?? [])].find(candidate => !candidate.scheduled
    && candidate.path === write.path && candidate.body === requestedBody);
  if (waiter) { waiter.generation = generation; waiter.scheduled = true; }
  appendWaiting({ ...plain(write), tries: 0, due: 0, generation, requestedBody, attempted: false, requestIdentity: requestIdentity ?? freshRequestIdentity(generation) });
  keepOnDevice();
  schedule();
  return generation;
}

function validateComparison(write: QuietWrite): void {
  if (!write.compare) return;
  const { path, before, after } = write.compare;
  if (!Array.isArray(path) || !path.length || path.length > 32
    || path.some(key => typeof key === 'number' ? !Number.isSafeInteger(key) || key < 0
      : typeof key !== 'string' || !key || ['__proto__', 'constructor', 'prototype'].includes(key))
    || (before !== null && typeof before !== 'string') || typeof after !== 'string' || !after) {
    throw new TypeError('The conditional change needs a valid comparison.');
  }
  let value: unknown = write.body;
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new TypeError('The conditional change is missing its comparison field.');
    value = (value as Record<string | number, unknown>)[key];
  }
  if (value !== before) throw new TypeError('The conditional change does not match its comparison.');
}

function appendWaiting(entry: Entry): void {
  const entries = waiting.get(entry.key) ?? [];
  const previous = entries.at(-1);
  const sameDestination = previous && sameQuietDestination(previous, entry);
  let replace = Boolean(sameDestination && !previous.compare && !entry.compare);
  if (sameDestination && previous && !previous.attempted && previous.compare && entry.compare
    && previous.path === entry.path && previous.together === entry.together
    && JSON.stringify(previous.compare.path) === JSON.stringify(entry.compare.path)
    && previous.compare.after === entry.compare.before) {
    // Only this observed local chain grants permission to retain the earlier basis. A foreign basis is never
    // guessed or replaced with the server's winner; that remains a real compare conflict for the owner.
    const body = structuredClone(entry.body);
    let parent: Record<string | number, unknown> = body;
    for (const key of entry.compare.path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    parent[entry.compare.path.at(-1)!] = previous.compare.before;
    entry = { ...entry, body, compare: { ...entry.compare, before: previous.compare.before } };
    replace = true;
  }
  if (replace && previous) {
    entries.pop();
    settleAcceptance(previous, previous.generation, new QuietWriteSupersededError());
  }
  entries.push(entry);
  waiting.set(entry.key, entries);
}

/** Whether this dispatched value is still the newest value for its key (including a same-key pending successor). */
export function isQuietWriteCurrent(write: QuietWrite & { generation?: number }): boolean {
  if (write.generation !== undefined) return generations.get(write.key) === write.generation;
  const current = waiting.get(write.key)?.at(-1) ?? onTheirWay.get(write.key);
  if (!current) return true;
  return current.path === write.path && JSON.stringify(current.body) === JSON.stringify(write.body);
}

/** Whether a write under this key has not reached the store yet (waiting, or on its way). */
export function isQuietWriteWaiting(key: string): boolean {
  return waiting.has(key) || onTheirWay.has(key);
}

/** Whether the newest pending conditional write still carries these exact bytes (the owner supplies its identity). */
export function isQuietWritePendingVersion(key: string, after: string): boolean {
  const latest = waiting.get(key)?.at(-1) ?? onTheirWay.get(key);
  return typeof after === 'string' && latest?.compare?.after === after;
}

let restoring: Promise<QuietWrite[]> | null = null;
/**
 * The writes a page before this one left unsent on this device (and any silent tab's), put back in line (a write this page
 * already made under the same key wins) and sent. Answered once per page.
 */
export function restoreQuietWrites(): Promise<QuietWrite[]> {
  restoring ??= (async () => {
    if (readOnly) return [];
    const store = device;
    if (!store) return [];
    const claimed = await claimSilentSessions(store);
    if (readOnly || store !== device) return [];
    // A tab's own earlier session (this page opened again) and a let-go session are both claimed above; nothing else is read.
    return takeInto(claimed);
  })();
  return restoring;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (readOnly || !waiting.size) return;
  const now = Date.now();
  const eligible = pendingHeads().filter(entry => !onTheirWay.has(entry.key));
  if (!eligible.length) return;
  const due = Math.min(...eligible.map(entry => entry.due));
  timer = setTimeout(() => send(false), Math.max(0, due - now, lastSentAt + settings.together_ms - now));
  // A wait never keeps a process open by itself (a script or test that loads this page's code ends when its work does).
  (timer as { unref?: () => void }).unref?.();
}

const sendsAgain = (status: number) => status === 0 || status >= settings.again_from_status || settings.again_statuses.includes(status);

function send(leaving: boolean) {
  if (readOnly) return;
  if (timer) { clearTimeout(timer); timer = null; }
  const now = Date.now();
  // A key has one request in flight at a time. A newer choice stays in `waiting` until the older
  // request settles, so no older response can arrive after (and overwrite) that newer choice.
  const ready = pendingHeads().filter(entry => !onTheirWay.has(entry.key) && (leaving || entry.due <= now));
  if (!ready.length) return schedule();
  lastSentAt = now;
  const groups = new Map<string, Entry[]>();
  for (const entry of ready) {
    const remaining = waiting.get(entry.key)!.slice(1);
    if (remaining.length) waiting.set(entry.key, remaining); else waiting.delete(entry.key);
    entry.attempted = true;
    onTheirWay.set(entry.key, entry);
    // Writes ride together only when everything but their joined list is the same (the same path, the same read mark).
    const group = entry.together ? JSON.stringify([entry.path, entry.together, { ...entry.body, [entry.together]: null }]) : JSON.stringify([entry.key]);
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  keepOnDevice();
  for (const entries of groups.values()) void sendGroup(entries);
  schedule();
}

/** How long the store asked this device to wait (a Retry-After in seconds), at most `retry_after_max_ms`; 0 when it asked nothing. */
export function retryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, settings.retry_after_max_ms) : 0;
}

async function sendGroup(entries: Entry[]) {
  const [first] = entries;
  const field = first.together;
  const body = field
    ? { ...first.body, [field]: entries.flatMap(entry => (Array.isArray(entry.body[field]) ? entry.body[field] as unknown[] : [])) }
    : first.body;
  const text = JSON.stringify(body);
  const requestKey = batchRequestKey(entries, text);
  const bytes = new TextEncoder().encode(text).byteLength;
  const keepalive = keepaliveBytesOnTheirWay + bytes <= KEEPALIVE_BYTES;
  if (keepalive) keepaliveBytesOnTheirWay += bytes;
  let status = 0;
  let result: unknown;
  let askedToWait = 0;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = async () => {
      const response = await fetch(first.path, { method: 'POST', credentials: 'same-origin', keepalive, signal: controller.signal, headers: { 'content-type': 'application/json', 'idempotency-key': requestKey }, body: text });
      const responseStatus = response.status;
      askedToWait = retryAfterMs(response.headers.get('retry-after'));
      const responseResult = responseStatus >= 200 && responseStatus <= 299
        && (acceptedListeners.size || entries.some(entry => entry.compare || acceptanceWaiters.has(entry.key)))
        ? await response.json().catch(() => undefined)
        : undefined;
      return { status: responseStatus, result: responseResult };
    };
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('The saved change request timed out.'));
      }, settings.request_timeout_ms);
    });
    ({ status, result } = await Promise.race([request(), deadline]));
  } catch { status = 0; } finally { if (keepalive) keepaliveBytesOnTheirWay -= bytes; }
  if (timeout) clearTimeout(timeout);
  for (const entry of entries) if (onTheirWay.get(entry.key) === entry) onTheirWay.delete(entry.key);
  if (readOnly) {
    keepOnDevice();
    for (const entry of entries) releaseGenerationWhenIdle(entry.key);
    return;
  }
  if (status >= 200 && status <= 299 && entries.some(entry => entry.compare)) {
    const reply = result && typeof result === 'object' && !Array.isArray(result)
      ? result as { written?: unknown; write_count?: unknown; conflicts?: unknown } : null;
    const conflict = Array.isArray(reply?.conflicts) && reply.conflicts.length > 0;
    // A successful HTTP status with a lost or malformed acknowledgement is still uncertain. Retrying the exact
    // prerequisite is safe; skipping straight to a successor with its hash as basis is not.
    if (!conflict && (reply?.written ?? reply?.write_count) !== entries.length) status = 0;
  }
  if (status >= 200 && status <= 299) {
    acceptedAt = Date.now();
    for (const listener of acceptedListeners) listener(entries.map(receipt), result);
    for (const entry of entries) settleVerifiedAcceptance(entry, result, entries.length);
    for (const entry of entries) releaseGenerationWhenIdle(entry.key);
    keepOnDevice();
    return schedule();
  }
  if (!sendsAgain(status)) {
    keepOnDevice();
    tellRefused(entries, status);
    for (const entry of entries) releaseGenerationWhenIdle(entry.key);
    return schedule();
  }
  // An attempted conditional value is a prerequisite until its outcome is known, even when a successor exists.
  // Ordinary unconditional choices retain their historical newest-value retry behavior.
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.compare && waiting.get(entry.key)?.some(next => sameQuietDestination(entry, next))) {
      settleAcceptance(entry, entry.generation, new QuietWriteSupersededError());
      continue;
    }
    const tries = entry.tries + 1;
    waiting.set(entry.key, [{ ...entry, tries, due: now + Math.max(settings.waits_ms[Math.min(tries, settings.waits_ms.length) - 1], askedToWait) }, ...(waiting.get(entry.key) ?? [])]);
  }
  keepOnDevice();
  schedule();
}

/** Send everything waiting now, without waiting for its turn (the page is being left, or the device came back). */
export function sendQuietWritesNow(): void { send(true); }

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pagehide', () => { sendQuietWritesNow(); void letGoOfQuietWritesSession(); });
  // A page brought back from the browser's cache holds its writes again.
  window.addEventListener('pageshow', event => { if ((event as PageTransitionEvent).persisted && pendingEntries().length + onTheirWay.size) keepOnDevice(); });
  window.addEventListener('online', () => sendQuietWritesNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && waiting.size) sendQuietWritesNow(); });
}

// The outbox starts itself (invariant 11): a page's first reads, refused or not, never stand between a kept write and
// its store.
if (device) { startHeartbeat(); void restoreQuietWrites(); }
