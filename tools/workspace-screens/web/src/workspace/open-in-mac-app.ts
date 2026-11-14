// src/workspace/open-in-mac-app.ts
//
// PURPOSE
//   Hands the screen a person is looking at in their browser to the Trillion Mac app on the same computer: one row on
//   the screen's ⋯ menu ("Open in the Trillion Mac app"), offered when the Mac helper's listener
//   (computer/open-from-web.mjs) has answered that the app is here, so the person never has to find the same screen again.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The listener's address, the paths it takes and every word are DATA (computer/open-from-web.json,
//      open-in-mac-app.json); nothing here names a port or a screen.
//   2. The page asks the listener only when a menu first needs the row, only on a Mac, and never inside the Mac app: no
//      page load of anyone else's computer reaches for a local port. An answer of 'not here' is kept for
//      `recheck_seconds`, so a closed app is not asked again with every menu.
//   3. The row says the app opened it only when the listener said it saw the app take it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import bridge from '../../computer/open-from-web.json';
import words from './open-in-mac-app.json';
import { thisDevice } from './device-facts';
import { announcePageRows, providePageRows, type Thing } from './menu-rows';

const base = `http://${bridge.host}:${bridge.port}`;
let here: boolean | null = null;
let askedAt = 0;
let asking = false;

const insideTheMacApp = () => typeof window !== 'undefined' && 'trillionAlone' in window;

/** Whether the Mac helper's listener answered that the app is on this computer (one look, kept for recheck_seconds). */
async function look(): Promise<boolean> {
  try {
    const answer = await fetch(`${base}/hello`, { signal: AbortSignal.timeout(words.probe_seconds * 1000) });
    return answer.ok && (await answer.json())?.app === 'trillion';
  } catch { return false; }
}

function ask(): void {
  const stale = here === null || (!here && Date.now() - askedAt > words.recheck_seconds * 1000);
  if (asking || !stale) return;
  asking = true;
  void look().then(found => { const changed = found !== here; here = found; askedAt = Date.now(); asking = false; if (changed) announcePageRows(); });
}

/** Opens `path` (the screen shown now by default) in the Mac app: whether the listener saw the app take it. */
export async function openInMacApp(path = `${location.pathname}${location.search}`): Promise<{ opened: boolean; error?: string }> {
  try {
    const answer = await fetch(`${base}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
      signal: AbortSignal.timeout((bridge.delivery.every_ms * bridge.delivery.most_attempts + 3000)) });
    const said = await answer.json().catch(() => ({}));
    return answer.ok && said.opened === true ? { opened: true } : { opened: false, error: typeof said.error === 'string' ? said.error : words.failed };
  } catch { return { opened: false, error: words.failed }; }
}

/** Offers the row on every screen's ⋯ menu; the page calls this once as it starts. */
export function offerOpenInMacApp(): void {
  providePageRows((thing: Thing) => {
    if (thing.kind !== 'screen' || insideTheMacApp() || thisDevice() !== 'Mac') return [];
    ask();
    if (!here) return [];
    return [{ id: 'mac-app:open', label: words.label, icon: words.icon, run: async () => {
      const result = await openInMacApp();
      if (!result.opened) throw new Error(result.error ?? words.failed);
      return words.opened;
    } }];
  });
}
