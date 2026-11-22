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
const CONTROLS = 'button, a[href], input, select, textarea, [role="button"], [role="link"]';
const MEDIA = 'img, video';

export type ScreenReadyState = 'content' | 'words' | 'failure';

/** Whether an element is drawn with some size and not hidden from the person (its own visibility, not an ancestor's
 *  opacity animation). A hidden slot, a `hidden` attribute and display:none all draw no box, so they fail here. */
function drawn(node: Element): boolean {
  const style = getComputedStyle(node);
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
  return [...node.getClientRects()].some(box => box.width > 0 && box.height > 0);
}

/** Whether a text node's words are drawn: its own box has size, and its parent is not hidden. */
function textDrawn(text: Text): boolean {
  const parent = text.parentElement;
  if (!parent || !drawn(parent)) return false;
  const range = document.createRange();
  range.selectNodeContents(text);
  return [...range.getClientRects()].some(box => box.width > 0 && box.height > 0);
}

/** A control a person can act on, with a name: its words, its label, or its value. */
function namedControl(node: HTMLElement): boolean {
  const name = node.getAttribute('aria-label') ?? node.textContent ?? (node as HTMLInputElement).value ?? '';
  return name.trim() !== '' && drawn(node);
}

function mediaDrawn(node: HTMLElement): boolean {
  if (node instanceof HTMLImageElement) return node.complete && node.naturalWidth > 0 && drawn(node);
  if (node instanceof HTMLVideoElement) return node.readyState >= 2 && drawn(node);
  return false;
}

/** Whether `root` shows something a person can see: drawn words outside a loading state, a named control, or loaded
 *  media. A node that is only there (an empty slot, a detached or hidden one) shows nothing. */
function showsSomething(root: Element): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.textContent?.trim()) continue;
    if (text.parentElement?.closest(LOADING)) continue;
    if (textDrawn(text)) return true;
  }
  for (const node of [root, ...root.querySelectorAll<HTMLElement>(`${CONTROLS}, ${MEDIA}`)]) {
    if (node.closest(LOADING)) continue;
    if (node.matches(CONTROLS) && namedControl(node)) return true;
    if (node.matches(MEDIA) && mediaDrawn(node)) return true;
  }
  return false;
}

/** Whether any element matching `selector` in the pane shows something a person can see. */
function markShows(pane: HTMLElement, selector: string): boolean {
  return [...pane.querySelectorAll<HTMLElement>(selector)].some(showsSomething);
}

/** What the pane draws now, or null while it only loads or shows nothing a person can see. */
export function paneReadyState(pane: HTMLElement): ScreenReadyState | null {
  if (markShows(pane, FAILED)) return 'failure';
  if (markShows(pane, WORDS_STATES)) return 'words';
  const panel = pane.querySelector<HTMLElement>(PANEL);
  if (panel && showsSomething(panel)) return 'content';
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
  observer.observe(pane, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-active', 'data-screen-state', 'hidden', 'style', 'class'] });
  // Media that finishes loading draws without a DOM change, so its load is watched here.
  pane.addEventListener('load', later, true);
  pane.addEventListener('loadeddata', later, true);
  update();
  return () => {
    observer.disconnect();
    pane.removeEventListener('load', later, true);
    pane.removeEventListener('loadeddata', later, true);
    if (frame !== null) cancelAnimationFrame(frame);
    pane.removeAttribute('data-screen-ready');
    pane.removeAttribute('data-pane-state');
  };
}
