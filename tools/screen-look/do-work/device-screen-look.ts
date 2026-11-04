// parts/screen-look/do-work/device-screen-look.ts
//
// PURPOSE
//   A look kept on this device only. The account keeps the look the person chose for every device (input
//   `current-screen-look`); a device may keep its own look over it (a dark laptop, a light shared screen) without
//   changing what the person's other devices wear. The device's choice lives in this browser's storage, as one small
//   record `{ look_id, held_since }`, kept for the signed-in account (accountKey), and every open tab of this browser
//   follows it.
//
//   wearScreenLook is the one way a chooser changes the look: to this device when the device keeps its own look, to the
//   account otherwise.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The account's choice is never written by a device-only choice, and a device-only choice never survives the
//      person turning it off (followAccountScreenLook forgets it).
//   2. Storage refused (private browsing, a locked-down browser) reads as no device look: the account's look shows.
//   3. Nothing here names a look.
//   4. A device-only look is held by this device's own record (`held_since`, when it began): it never writes the
//      account's look plan (LOOK_PLAN_RECORD). Only an account choice holds the plan, as before.
//   5. The record is kept for the signed-in account only (accountKey): another account on this browser never reads it,
//      and with no account signed in nothing is kept.

import { readWorkspacePreference, writeWorkspacePreference } from '#workspace-records';
import { LOOK_PLAN_RECORD, readLookPlan } from '../read-data/look-over-time';
import { chooseCurrentScreenLook } from './choose-current-screen-look';
import { accountKey } from '../../ui/show/page-storage/page-storage';

const DEVICE_SCREEN_LOOK_KEY = 'trillion.screen-look.this-device';
const listeners = new Set<() => void>();

type DeviceScreenLookRecord = { look_id: string; held_since?: string };

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The name this device's own look is kept under for the signed-in account; null where no account is signed in. */
function deviceKey(): string | null {
  return accountKey(DEVICE_SCREEN_LOOK_KEY);
}

function tell() { for (const listener of listeners) listener(); }

/** The look this device keeps for itself, or null when it follows the account. */
export function readDeviceScreenLook(): string | null {
  try {
    const key = deviceKey();
    const raw = key ? storage()?.getItem(key) : null;
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<DeviceScreenLookRecord>;
    return typeof record?.look_id === 'string' && record.look_id.trim() ? record.look_id.trim() : null;
  } catch {
    return null;
  }
}

/** When this device began holding its own look (the hold a look plan respects on this device), or null when it follows the account. */
export function readDeviceScreenLookHeldSince(): string | null {
  try {
    const key = deviceKey();
    const raw = key ? storage()?.getItem(key) : null;
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<DeviceScreenLookRecord>;
    return typeof record?.look_id === 'string' && typeof record.held_since === 'string' ? record.held_since : null;
  } catch {
    return null;
  }
}

/** Keeps look `lookId` on this device only, held from now; the account's look is left as it is. */
export function keepScreenLookOnThisDevice(lookId: string): void {
  const id = lookId.trim();
  if (!id) throw new Error('Choose a look to keep on this device.');
  const record: DeviceScreenLookRecord = { look_id: id, held_since: new Date().toISOString() };
  try {
    const key = deviceKey();
    if (key) storage()?.setItem(key, JSON.stringify(record));
  } catch { /* storage refused: the account's look keeps showing */ }
  tell();
}

/** Forgets this device's own look, so it wears the account's look again. */
export function followAccountScreenLook(): void {
  try {
    const key = deviceKey();
    if (key) storage()?.removeItem(key);
  } catch { /* nothing kept */ }
  tell();
}

/** Be told when this device's look changes, here or in another tab of this browser; returns the call that stops it. */
export function subscribeDeviceScreenLook(listener: () => void): () => void {
  listeners.add(listener);
  const fromAnotherTab = (event: StorageEvent) => { if (event.key === null || event.key === deviceKey()) listener(); };
  globalThis.addEventListener?.('storage', fromAnotherTab);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', fromAnotherTab);
  };
}

/** Wears look `lookId`: on this device only when `onThisDevice`, otherwise for the account (every device that
 *  follows it). While the person's look plan is on, the look picked is held until the plan's next point, so the plan
 *  never takes it straight back (read-data/look-over-time.ts). */
export async function wearScreenLook(lookId: string, onThisDevice: boolean): Promise<void> {
  // A device-only look is held by this device's own record; the account's plan is not written for it.
  if (onThisDevice) { keepScreenLookOnThisDevice(lookId); return; }
  const plan = readLookPlan(readWorkspacePreference(LOOK_PLAN_RECORD));
  if (plan?.on) await writeWorkspacePreference(LOOK_PLAN_RECORD, { ...plan, hold: { kind: 'worn', since: new Date().toISOString() } });
  await chooseCurrentScreenLook(lookId);
}
