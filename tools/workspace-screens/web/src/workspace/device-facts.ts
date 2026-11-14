// src/workspace/device-facts.ts
//
// PURPOSE
//   The one way a page tells the person's Trillion what a device profile can see for itself (src/device-facts.mjs):
//   Always recording says which cameras it sees, a device switch says whether it is on. These facts help the person's
//   Waiting on you list notice when a device can finish a step.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A stable browser-profile identity is separate from the display label; it does not claim to identify physical hardware.
//   2. Each source owns its own facts. A source refresh cannot erase another source's facts or keep its own removed facts.
//   3. Queues and de-duplication are scoped to the signed-in account and device profile.
//   4. Reports for one source are serialized across tabs where the browser supports Web Locks, and every report carries
//      a generation so the receiver rejects an older snapshot that arrives late. A report's snapshot and generation are
//      taken when it is made, under the profile lock every tab is granted in request order, so a later report always
//      carries the later snapshot and generation even when another tab's post wins the source lock first.
//   5. A failed report clears its sent marker, so a later invocation retries the current snapshot.
//
// AI DIRECTIVE: Do not combine the display label with the stable profile identity.
import { deviceAccount, postJson } from './api';

type DeviceSnapshot = Record<string, string>;
const profileKey = 'trillion.device-facts.profile-id';
const statePrefix = 'trillion.device-facts.source';
const generationPrefix = 'trillion.device-facts.generation';
const known = new Map<string, DeviceSnapshot>();
const generationWatermarks = new Map<string, string>();
const sent = new Map<string, string>();
const queues = new Map<string, Promise<void>>();
let volatileProfileId: string | null = null;

const randomId = () => {
  const value = globalThis.crypto?.randomUUID?.();
  return value ? `profile-${value}` : `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};
const pageId = randomId().replace(/^profile-/, 'page-');
let pageSequence = 0;

/** A stable browser-profile identity, or a per-page identity when this browser will not keep site storage. */
export function deviceProfileId(): string {
  try {
    const kept = localStorage.getItem(profileKey);
    if (kept) return kept;
    const created = randomId();
    localStorage.setItem(profileKey, created);
    return localStorage.getItem(profileKey) ?? created;
  } catch {
    volatileProfileId ??= randomId();
    return volatileProfileId;
  }
}

/** The display name people recognize; this broad label is not the identity of one physical device. */
export function thisDevice(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const named = [['iPhone', /iPhone/], ['iPad', /iPad/], ['Android', /Android/], ['Mac', /Macintosh|Mac OS X/], ['Windows', /Windows/], ['Linux', /Linux/]] as const;
  return named.find(([, pattern]) => pattern.test(agent))?.[0] ?? 'This device';
}

const storageKey = (prefix: string, account: string, identity: string, source: string) => `${prefix}:${encodeURIComponent(account)}:${encodeURIComponent(identity)}:${encodeURIComponent(source)}`;
function readStored(key: string): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function nextGeneration(account: string, identity: string, source: string): string {
  const clock = typeof performance === 'undefined' ? Date.now() : performance.timeOrigin + performance.now();
  const key = storageKey(generationPrefix, account, identity, source);
  const scope = `${account}:${identity}:${source}`;
  let stored = '';
  try { stored = localStorage.getItem(key) ?? ''; } catch { /* this page still orders its own reports */ }
  const remembered = generationWatermarks.get(scope) ?? '';
  const prior = [stored, remembered].filter(value => /^\d{16}-page-/.test(value))
    .sort((a, b) => a.slice(0, 16).localeCompare(b.slice(0, 16)) || a.localeCompare(b)).at(-1) ?? '';
  const priorTimestamp = prior ? BigInt(prior.slice(0, 16)) : 0n;
  const clockTimestamp = BigInt(Math.max(1, Math.round(clock * 1000)));
  const timestamp = (clockTimestamp > priorTimestamp ? clockTimestamp : priorTimestamp + 1n).toString().padStart(16, '0');
  const generation = `${timestamp}-${pageId}-${String(++pageSequence).padStart(8, '0')}`;
  generationWatermarks.set(scope, generation);
  try { localStorage.setItem(key, generation); } catch { /* ordering remains available to the receiver */ }
  return generation;
}
function keepGenerationAtLeast(account: string, identity: string, source: string, generation: string | number): void {
  const key = storageKey(generationPrefix, account, identity, source);
  const scope = `${account}:${identity}:${source}`;
  const incoming = String(generation);
  let stored = '';
  try { stored = localStorage.getItem(key) ?? ''; } catch { /* retain a per-page watermark */ }
  const remembered = generationWatermarks.get(scope) ?? '';
  const newest = [stored, remembered, incoming].filter(value => /^\d{16}-page-/.test(value))
    .sort((a, b) => a.slice(0, 16).localeCompare(b.slice(0, 16)) || a.localeCompare(b)).at(-1);
  if (!newest) return;
  generationWatermarks.set(scope, newest);
  try { localStorage.setItem(key, newest); } catch { /* memory remains authoritative for this page */ }
}

/** Adds facts owned by `source` and sends that source's complete current snapshot when it changes. */
export function reportDeviceFacts(facts: Record<string, string>, source = 'workspace'): void {
  const account = deviceAccount();
  if (!account || !source) return;
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  const ordered = () => {
    const identity = deviceProfileId();
    const scope = `${account}:${identity}:${source}`;
    const persistedKey = storageKey(statePrefix, account, identity, source);
    const snapshot = { ...(known.get(scope) ?? {}), ...readStored(persistedKey), ...facts };
    known.set(scope, snapshot);
    try { localStorage.setItem(persistedKey, JSON.stringify(snapshot)); } catch { /* per-page state remains available */ }
    return { identity, scope, snapshot, generation: nextGeneration(account, identity, source) };
  };
  const identify = locks?.request
    ? locks.request('trillion-device-facts-profile-identity', { mode: 'exclusive' }, ordered)
    : Promise.resolve(ordered());
  void identify.then(({ identity, scope, snapshot, generation }) => {
    const write = async () => {
      const run = async () => {
        // A queued report belongs to the account that created it. A lock may wait across a sign-in change.
        if (deviceAccount() !== account) return;
        const report = JSON.stringify(snapshot);
        if (sent.get(scope) === report) return;
        sent.set(scope, report);
        try {
          // Recheck at the network boundary too; never send A's queued snapshot with B's session.
          if (deviceAccount() !== account) {
            if (sent.get(scope) === report) sent.delete(scope);
            return;
          }
          const answer = await postJson<{ stale?: boolean; current_generation?: string | number }>('/work/api/device-facts', {
            device: thisDevice(), device_id: identity, source, generation, facts: snapshot, expected_account: account,
          });
          if (answer?.stale) {
            if (answer.current_generation !== undefined) keepGenerationAtLeast(account, identity, source, answer.current_generation);
            if (sent.get(scope) === report) sent.delete(scope);
          }
        } catch {
          if (sent.get(scope) === report) sent.delete(scope);
        }
      };
      if (locks?.request) await locks.request(`trillion-device-facts:${scope}`, { mode: 'exclusive' }, run);
      else await run();
    };
    const previous = queues.get(scope) ?? Promise.resolve();
    const pending = previous.then(write, write);
    queues.set(scope, pending);
    const clear = () => { if (queues.get(scope) === pending) queues.delete(scope); };
    void pending.then(clear, clear);
  }).catch(() => {});
}
