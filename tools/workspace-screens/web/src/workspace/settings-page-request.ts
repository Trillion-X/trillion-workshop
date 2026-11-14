// src/workspace/settings-page-request.ts
//
// PURPOSE
//   One screen asking the Settings shell (settings-screen.tsx) to show another of its pages in place, the way Previous and
//   Next do, with no address change. A guide action whose `open` is `settings-page:<rail item id>` (guide-screens.tsx)
//   sends it; the shell, when it is open, answers by choosing that page. Nothing here names a page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The request says handled only when the open shell has a page with that id; otherwise the caller says so in words.
//   2. This file holds no state: the request is one cancelable event, answered by whoever shows the pages.

export const SETTINGS_PAGE_PREFIX = 'settings-page:';
const EVENT = 'trillion:settings-page-request';

/** Asks the open Settings shell to show page `id`; true when it did. */
export function requestSettingsPage(id: string): boolean {
  return !window.dispatchEvent(new CustomEvent(EVENT, { detail: { id }, cancelable: true }));
}

/** What a guide action's `open` means to the shell: 'not-a-page' when it is not `settings-page:<id>`, else 'shown' or 'not-open'. */
export function openSettingsPage(open: string): 'not-a-page' | 'shown' | 'not-open' {
  if (!open.startsWith(SETTINGS_PAGE_PREFIX)) return 'not-a-page';
  return requestSettingsPage(open.slice(SETTINGS_PAGE_PREFIX.length)) ? 'shown' : 'not-open';
}

/** The shell's side: `choose(id)` answers true when it has that page and shows it. Returns how to stop listening. */
export function answerSettingsPageRequests(choose: (id: string) => boolean): () => void {
  const listener = (event: Event) => { if (choose((event as CustomEvent<{ id: string }>).detail.id)) event.preventDefault(); };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
