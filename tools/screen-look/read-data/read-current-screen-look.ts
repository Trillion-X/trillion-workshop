// packages/screen-look/read-data/read-current-screen-look.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure helper for decoding the current browser screen look from package-bound
// data returned by the runtime data hook. A look that was not read (a failed or
// still-loading read, or an account with no look set) is null, never the default
// look: the page keeps the look it already wears, or the one this device kept last,
// and only falls back to the app's first look when neither exists (screenLookToWear).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A failed read is never read as the default look (readCurrentScreenLook returns null).
//   2. The look the page wears is, in order: the account's look as read, the look already applied,
//      the look this device stored last, then nothing: the caller's looks fall back to the app's first look
//      (resolveChosenScreenLook), the same look every server page and a new account start with. No second default here.
//   3. Storage refused (private browsing) reads as nothing stored: the app's first look shows.
//   4. A page with no account signed in (signed out, or a workspace that failed before its first read) wears the look
//      this browser last wore (readSignedOutScreenLook), so one person's browser never flips to another look on the
//      sign-in or failure screen. It holds only a look id, never anything of the account.
// =============================================================================

import { accountKey, keptAccount } from '../../ui/show/page-storage/page-storage';

interface CurrentScreenLookRow {
  name?: unknown;
}

// The account's last applied look, kept on this device so a reload that cannot read the account shows it again.
export const LAST_ACCOUNT_SCREEN_LOOK_KEY = 'trillion.screen-look.last-account';
// The look this browser last wore, whoever was signed in: read only where no account is signed in on the page.
export const LAST_BROWSER_SCREEN_LOOK_KEY = 'trillion.screen-look.last-worn';

function asScreenLookValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** The account's look as read, or null when it was not read (a failed read is not the default look). */
export function readCurrentScreenLook(raw: unknown): string | null {
  const rows = Array.isArray(raw) ? raw : [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    return asScreenLookValue((entry as CurrentScreenLookRow).name);
  }
  return null;
}

// The name that look is kept under for the signed-in account, so another account on this browser never reads it; null
// where no account is signed in on the page, and then nothing is kept.
function lastAccountKey(): string | null {
  return accountKey(LAST_ACCOUNT_SCREEN_LOOK_KEY);
}

/** The look this device stored last for the account, or null when none is stored. A bare key an older build kept is
 *  removed, never read: nothing can say which account it was for. */
export function readLastAccountScreenLook(): string | null {
  try {
    const storage = globalThis.localStorage;
    storage?.removeItem(LAST_ACCOUNT_SCREEN_LOOK_KEY);
    const key = lastAccountKey();
    return key ? asScreenLookValue(storage?.getItem(key)) : null;
  } catch {
    return null;
  }
}

/** Keeps the account's applied look on this device for the account; storage refused, or no account, keeps nothing. */
export function keepLastAccountScreenLook(lookId: string): void {
  try {
    const key = lastAccountKey();
    if (key) globalThis.localStorage?.setItem(key, lookId);
    globalThis.localStorage?.setItem(LAST_BROWSER_SCREEN_LOOK_KEY, lookId);
  } catch { /* storage refused: nothing kept */ }
}

/** The look a page wears before (or without) reading an account: the signed-in account's kept look, else, where no
 *  account is signed in on the page, the look this browser last wore; null when neither is kept. */
export function readSignedOutScreenLook(): string | null {
  const account = readLastAccountScreenLook();
  if (account || keptAccount()) return account;
  try { return asScreenLookValue(globalThis.localStorage?.getItem(LAST_BROWSER_SCREEN_LOOK_KEY)); } catch { return null; }
}

/**
 * The look to wear: the account's look as read; when that was not read, the look already applied; when nothing is
 * applied yet, the look stored on this device; '' when none of those exists, which the caller's looks resolve to the
 * app's first look (resolveChosenScreenLook).
 */
export function screenLookToWear({ read, applied, stored }: { read: string | null; applied: string | null; stored: string | null }): string {
  return read ?? applied ?? stored ?? '';
}
