// parts/ui/show/page-storage/page-storage.ts
//
// PURPOSE
//   The one way a page reaches the storage kept on this device (localStorage). Some pages may not use it: a screen
//   drawn inside another app's frame (ChatGPT, Claude), a browser with site storage blocked, a blank page. There,
//   even reading `localStorage` throws, so a module that touched it while loading took every screen importing it
//   down with it (the tray store, 820ba359: Decisions and Lists drew nothing).
//
// NON-NEGOTIABLE INVARIANTS
//   1. pageStorage() never throws: it answers the page's storage, or null where there is none or it is refused.
//   2. A caller treats null as "keep nothing past this page": what it holds still works for as long as the page is open.
//   3. Anything that reaches the device's storage while its module loads asks here (the tray store does), so loading a
//      screen never fails where storage is refused; test/every-screen-has-its-states.test.mjs draws real screens on a
//      page that refuses it.
//   4. What the page keeps on this device for a person is kept under a name that carries the signed-in account
//      (accountKey), so an account that signs in on this browser after another never finds that account's copy. Where
//      no account is signed in on the page, accountKey answers null and the caller keeps nothing.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import firstAnswers from '../../../../src/workspace/first-answers.json' with { type: 'json' };

/** This device's storage for the page, or null where the page may not use any. */
export function pageStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** The signed-in account on this page, as the Worker wrote it into the page (first-answers.json `kept`: the store's
 *  name and this sign-in's key), or null where the page names none (signed out, look-only, no document). The one reader
 *  of that element: the workspace's kept answers (src/workspace/api.ts) read it through here too. */
export function keptAccount(): { store: string; key: string } | null {
  try {
    if (typeof document === 'undefined') return null;
    const kept = JSON.parse(document.getElementById(firstAnswers.kept.element_id)?.textContent || 'null');
    return kept && typeof kept.store === 'string' && typeof kept.key === 'string' ? kept : null;
  } catch { return null; }
}

/** The name `key` is kept under for the signed-in account, so another account's copy is never the one read; null
 *  where no account is signed in on the page, and then nothing is kept under it. */
export function accountKey(key: string): string | null {
  const account = keptAccount()?.store;
  return account ? `${key}@${account}` : null;
}
