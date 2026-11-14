// src/workspace/device-copy.ts
//
// NO PRIOR: searched this codebase for "opfs", "sqlite-wasm", "device copy", "offline records" and the 21st.dev
// catalog for "local first sync": none in the product; built on parts/device-copy and parts/record-log record-sync.mjs.
//
// PURPOSE
//   The page's handle on the person's records kept in this browser: it starts the device copy worker
//   (/workspace/device-copy-worker.js, parts/device-copy) once the page is idle, settles it with the person's store in
//   bounded requests when it opens, when the device comes back online and when the page is shown again, and answers reads
//   from it, so the person's own records are found in microseconds and while offline.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Whether this device keeps a copy is the person's show rules (subject `device-copy`, src/workspace/show-rules.json):
//      a rule that hides it keeps no copy here. Nothing else switches it.
//   2. A browser without a private file system for workers, or a second tab while another holds the copy, keeps none and
//      the page reads from the store as before; nothing waits on the copy.
//   3. At most one settle at a time, and none more often than `settle_at_most_every_seconds` (device-copy.json) unless the
//      device just came back online.
//   4. Which indexes the copy keeps is the store's own DATA (src/record-indexes.json), the same the hosted copy keeps.
//   5. Sealed records (parts/sealed-records) are sealed, opened and searched only here: the passphrase goes to the
//      worker, which keeps the key in its memory; the page never holds the key. Which kinds can be sealed is
//      src/record-copies.json `sealable_types`.
//   6. A read both this copy and the store answer the same way (record-find.mjs) is raced (`firstOf`): the first answer
//      wins and the other is aborted. This copy answering nothing (none kept here, a second tab) is a `LocalMissError`,
//      never an empty answer, so the store's answer wins; only when every side fails does the read fail, with the
//      store's own words.
//
// SECURITY
//   The worker settles through the page's own sign-in (same origin); it holds no key.

import recordIndexes from '../record-indexes.json' with { type: 'json' };
import recordModel from '../record-model.json' with { type: 'json' };
import recordCopySettings from '../record-copies.json' with { type: 'json' };
import { showOf, showReady, onShowChange } from '../../parts/ui/show/show-rules/show-of';
import { accountBucket, readJson } from './api';
import { keptAccount } from '../../parts/ui/show/page-storage/page-storage';
import settings from './device-copy.json' with { type: 'json' };
import { findArguments, foundRecords } from '../record-find.mjs';
import { mentionRowsReading, mentionsFrom } from '../work-mentions.mjs';

type Answer = { id: number; result?: unknown; error?: string; account_closed?: boolean };
type Opened = { kept: string; copy_id: string; root: string };
let worker: Worker | null = null;
let opened: Promise<Opened | null> | null = null;
let lastSettle = -Infinity;
let next = 0;
let owner: string | null = null;
let blocked = false;
let listening = false;
let channel: BroadcastChannel | null = null;
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

/** End this page's reads, writes, keys and requests; keep the account's disk copy for its own return. */
function stopDeviceCopy(): void {
  blocked = true;
  worker?.terminate(); worker = null; opened = null; owner = null; lastSettle = -Infinity;
  for (const pending of waiting.values()) pending.reject(new Error('This account’s copy is closed.'));
  waiting.clear();
}

function currentAccount(): string | null {
  const current = keptAccount()?.store ?? null;
  if (owner && current !== owner) stopDeviceCopy();
  return blocked ? null : current;
}

function ask<T>(call: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!currentAccount() || !worker) return Promise.reject(new Error('No copy is kept on this device.'));
  const asking = worker;
  const account = owner;
  const id = ++next;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: (value: unknown) => {
      if (asking !== worker || account !== currentAccount()) reject(new Error('This account’s copy is closed.'));
      else resolve(value as T);
    }, reject });
    asking.postMessage({ id, call, args: { ...args, account } });
  });
}

async function settle(force = false): Promise<void> {
  if (!(await opened)) return;
  const now = performance.now();
  if (!force && now - lastSettle < settings.settle_at_most_every_seconds * 1000) return;
  lastSettle = now;
  await ask('settle').catch(() => undefined);
}

function open(): Promise<Opened | null> {
  owner = currentAccount();
  if (!owner) return Promise.resolve(null);
  if (typeof Worker !== 'function' || !navigator.storage?.getDirectory) return Promise.resolve(null);
  worker = new Worker(settings.worker, { type: 'module' });
  const opening = worker;
  worker.onmessage = (event: MessageEvent<Answer>) => {
    if (event.data.account_closed) { stopDeviceCopy(); return; }
    const pending = waiting.get(event.data.id);
    if (!pending) return;
    waiting.delete(event.data.id);
    if (event.data.error) pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result);
  };
  return ask<Opened>('open', {
    settle_url: settings.settle_url,
    indexes: recordIndexes.indexes,
    // The fields this copy keeps sealed (parts/record-log erasable.mjs), from the same model the hosted store keeps.
    erasable: Object.fromEntries((recordModel.kinds as Array<{ type: string, erasable?: string[] }>).filter(kind => kind.erasable?.length).map(kind => [kind.type, kind.erasable])),
    most_rows_sent: recordCopySettings.most_rows_sent,
    most_chars_sent: recordCopySettings.most_chars_sent,
  })
    .then(copy => (copy.kept === 'device' ? copy : null))
    .catch(() => { if (worker === opening) stopDeviceCopy(); return null; });
}

/** Starts keeping the person's records on this device when their rules allow it (called once, when the page is idle). */
export function startDeviceCopy(): void {
  if (!listening) {
    listening = true;
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel('trillion-device-copy-account');
      channel.onmessage = event => {
        if (event.data?.account !== currentAccount()) stopDeviceCopy();
      };
      channel.postMessage({ account: currentAccount() });
    }
    // This also reaches sign-out links rendered by shared components, before navigation starts.
    const signingOut = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest('a[href], form[action]') : null;
      const address = target?.getAttribute('href') ?? target?.getAttribute('action');
      if (address && new URL(address, location.href).pathname === '/work/sign-out') {
        channel?.postMessage({ account: null }); stopDeviceCopy();
      }
    };
    document.addEventListener('click', signingOut, true);
    document.addEventListener('submit', signingOut, true);
    // A history-restored page carries its old account element; it cannot reopen a copy using that stale identity.
    window.addEventListener('pagehide', () => stopDeviceCopy());
    window.addEventListener('online', () => void settle(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void settle(); });
  }
  const begin = () => {
    const account = currentAccount();
    if (!account || opened || showOf('device-copy', { copy: 'records', bucket: accountBucket(100) }).hidden) return;
    channel?.postMessage({ account });
    opened = open();
    void settle(true);
  };
  if (showReady()) begin();
  else { const stop = onShowChange(() => { if (!showReady()) return; stop(); begin(); }); }
}

/** The id of the copy of the person's records kept on this device, or null when none is kept here (yet). */
export async function deviceCopyId(): Promise<string | null> {
  const account = currentAccount();
  const copy = opened ? await opened : null;
  return account && account === currentAccount() ? copy?.copy_id ?? null : null;
}

type Found = { id: string; type: string; title: string; sealed?: boolean };

/** This device's copy cannot answer: none is kept here, or not for this account (invariant 6). */
export class LocalMissError extends Error {
  constructor() { super('No copy is kept on this device.'); this.name = 'LocalMissError'; }
}

/** Runs every side of one read at once; the first to answer wins and every other is aborted (invariant 6). When every
 *  side fails, the failure of the last side that is not a local miss is thrown (the store's words over "no copy"). */
export function firstOf<T>(sides: ReadonlyArray<(signal: AbortSignal) => Promise<T>>): Promise<T> {
  const running = sides.map(run => ({ run, controller: new AbortController() }));
  let settled = false;
  return Promise.any(running.map(async side => {
    const answer = await side.run(side.controller.signal);
    if (!settled) { settled = true; for (const other of running) if (other !== side) other.controller.abort(); }
    return answer;
  })).catch((failure: unknown) => {
    const errors = failure instanceof AggregateError ? failure.errors : [failure];
    throw errors.filter(error => !(error instanceof LocalMissError)).at(-1) ?? errors.at(-1);
  });
}

/** The person's records whose words at `fields` hold every word, from this device's copy (the request
 *  POST /records/find takes), with the sealed ones this device has opened (kind `sealed`, their own title); null when
 *  none is kept here. */
export async function findOnDevice(body: Record<string, unknown>): Promise<{ records: { id: string; kind: string; title: string }[] } | null> {
  if (!opened || !(await opened)) return null;
  const args = findArguments(body);
  const [plain, sealed] = await Promise.all([ask<Found[]>('find', { ...args, budget: Infinity }), ask<Found[]>('find_sealed', args).catch(() => [] as Found[])]);
  const sealedIds = new Set(sealed.map(row => row.id));
  return foundRecords([...sealed.map(row => ({ ...row, type: 'sealed' })), ...plain.filter(row => !sealedIds.has(row.id))]);
}

export type SealingState = { kept: boolean; has_passphrase: boolean; unlocked: boolean };

/** Whether this device keeps a copy that can seal, whether the person has set a passphrase and whether it is open here. */
export async function sealingState(): Promise<SealingState> {
  if (!opened || !(await opened)) return { kept: false, has_passphrase: false, unlocked: false };
  return { kept: true, ...(await ask<Omit<SealingState, 'kept'>>('sealing')) };
}

/** Opens the person's sealed records on this device with their passphrase (sets it the first time). */
export async function unlockSealed(passphrase: string): Promise<{ unlocked: boolean; is_new: boolean }> {
  if (!(await opened)) throw new Error('Sealing needs a copy kept on this device.');
  return ask('unlock', { passphrase });
}

/** Seals one record so only the person's devices can open it; it reaches the store sealed. */
export async function sealOnDevice(id: string): Promise<{ id: string; sealed: boolean }> {
  if (!(await opened)) throw new Error('Sealing needs a copy kept on this device.');
  return ask('seal', { id, sealable: recordCopySettings.sealable_types });
}

/** Opens one sealed record for good: it is kept as itself again. */
export async function unsealOnDevice(id: string): Promise<{ id: string; sealed: boolean }> {
  if (!(await opened)) throw new Error('Sealing needs a copy kept on this device.');
  return ask('unseal', { id });
}

/** One sealed record opened on this device: { type, value }. */
export async function openSealedOnDevice(id: string): Promise<{ type: string; value: unknown }> {
  if (!(await opened)) throw new Error('Sealing needs a copy kept on this device.');
  return ask('open_sealed', { id });
}

// The mention rows whose read this copy answers (src/mention-sources.json rows reading /records/find). Imported here,
// with this module, so offline nothing more has to load: this module was loaded once the page went idle.
const DEVICE_ROWS = mentionRowsReading('/records/find');

/** The person's records a find names (POST /records/find), from whichever of this device's copy and the store answers
 *  first; the other is aborted (invariant 6). */
export function findRecordsFirst(body: Record<string, unknown>): Promise<{ records: { id: string; kind: string; title: string }[] }> {
  return firstOf([
    async () => { const found = await findOnDevice(body); if (!found) throw new LocalMissError(); return found; },
    signal => readJson<{ records: { id: string; kind: string; title: string }[] }>('/work/api/records/find', { method: 'POST', body: JSON.stringify(body), signal }),
  ]);
}

/** What `@query` offers from the person's records (src/work-mentions.mjs mentionsFrom over findRecordsFirst): this
 *  device's copy when it answers first (offline, a copy kept), else the store's own find. */
export function recordMentionsFirst(space: string, query: string): Promise<{ kinds: Record<string, unknown>; candidates: unknown[] }> {
  return mentionsFrom(async (_method: string, _path: string, body: Record<string, unknown>) => findRecordsFirst(body), { space }, query, DEVICE_ROWS);
}
