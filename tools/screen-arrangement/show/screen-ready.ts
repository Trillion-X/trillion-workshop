// tools/screen-arrangement/show/screen-ready.ts
//
// PURPOSE
//   The one ready mark for every pane. The shell sets two attributes on the pane (its container element):
//   `data-screen-ready` once the pane has drawn something a person can read, and `data-pane-state` saying what
//   (not `data-screen-state`: the shared ScreenState part owns that name on its own element):
//     content  the active screen drew its own words (its panel has text and no state marker)
//     words    the pane shows a words-state (empty, unavailable): the screen says why it has nothing
//     failure  the pane shows a failure (the arrangement or a screen could not be shown)
//   While a pane only loads (a loading state, or nothing drawn yet) neither attribute is set. No screen names them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The pane's own tab bar and header words never count: only the active tab's panel and the pane's state markers do.
//   2. A failure anywhere in the pane is a failure of the pane, whichever screen it came from.
//   3. Words inside a loading state (`data-screen-state="loading"`) never count.
//   4. The attributes are set and removed in step with what is drawn, at most once per frame.

const PANEL = '[data-screen-arrangement-tab-panel][data-active="true"]';
const LOADING = '[data-screen-state="loading"]';
const FAILED = '[data-screen-state="failed"]';
const WORDS_STATES = '[data-screen-state="empty"], [data-screen-state="unavailable"]';

export type ScreenReadyState = 'content' | 'words' | 'failure';

function panelHasText(panel: HTMLElement): boolean {
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    if (node.parentElement?.closest(LOADING)) continue;
    return true;
  }
  return false;
}

/** What the pane draws now, or null while it only loads. */
export function paneReadyState(pane: HTMLElement): ScreenReadyState | null {
  if (pane.querySelector(FAILED)) return 'failure';
  if (pane.querySelector(WORDS_STATES)) return 'words';
  const panel = pane.querySelector<HTMLElement>(PANEL);
  if (panel && panelHasText(panel)) return 'content';
  return null;
}

/** Keeps `data-screen-ready` and `data-pane-state` on `pane` in step with what it draws. Returns the call that stops it. */
export function watchScreenReady(pane: HTMLElement | null): () => void {
  if (!pane) return () => {};
  let frame: number | null = null;
  const update = () => {
    frame = null;
    const state = paneReadyState(pane);
    if (state) {
      pane.setAttribute('data-screen-ready', '');
      pane.setAttribute('data-pane-state', state);
    } else {
      pane.removeAttribute('data-screen-ready');
      pane.removeAttribute('data-pane-state');
    }
  };
  const later = () => { if (frame === null) frame = requestAnimationFrame(update); };
  const observer = new MutationObserver(later);
  observer.observe(pane, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-active', 'data-screen-state'] });
  update();
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    pane.removeAttribute('data-screen-ready');
    pane.removeAttribute('data-pane-state');
  };
}
