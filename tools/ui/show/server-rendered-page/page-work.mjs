// parts/ui/show/server-rendered-page/page-work.mjs
//
// PURPOSE
//   A pressed page action (a link or button drawn by page-sections-html.mjs) says what its work is doing in itself, the
//   way a copy button says Copied: while the work runs it shows the one loading animation (the needle and thread,
//   parts/ui/show/loading-mark) and its pending words and takes no more presses; when the work is done it shows a
//   check and its done words; when the work fails it shows a mark and "Try again", then goes back to its own label.
//   Anatomy from the 21st.dev Loading Button (ddoemonn/loading-button): one face per state in the same place, so the
//   button never changes size.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The words come from the action's DATA (`pending`, `done`, drawn as data-page-pending and data-page-done), else
//      the caller's, else the action's own label while pending and "Done" when done.
//   2. Only text and SVG nodes are made; no markup is ever written as a string.
//   3. A press while the work runs is refused by the button itself (aria-busy, aria-disabled, no pointer events).
//   4. Waiting draws the needle and thread from its own drawing (loading-mark/stitch.ts) and its own look
//      (screen-look loading-mark.css), never a spinner of its own.
//   5. A wait that runs long says it is still working, its pending words changing each second by the page's chosen
//      words (../still-working), and says when a road asked again.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import LOADING_MARK_CSS from '../../../screen-look/show/loading-mark.css' with { type: 'text' };
import { NEEDLE_BODY, NEEDLE_EYE, STITCH_PATH } from 'trillion-workshop/tools/ui/show/loading-mark/stitch.ts';
import { onAskedAgain, stillWorkingAt } from '../still-working/still-working.ts';

const SVG = 'http://www.w3.org/2000/svg';
// The done and failed faces' marks (21st.dev Loading Button): a check, and an exclamation mark.
const MARKS = {
  done: [['path', { d: 'M2.6 6.3 4.9 8.6 9.4 3.6' }]],
  error: [['path', { d: 'M6 2.9v3.5' }], ['path', { d: 'M6 9.05h.01' }]],
};
/** How long a failed press shows "Try again" before the action shows its own label again. */
export const PAGE_WORK_ERROR_MS = 2400;

const svgNode = (tag, attributes) => {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
};

// The look of the loading animation, once per page.
function wearLoadingLook() {
  if (document.querySelector('style[data-loading-mark-look]')) return;
  const style = document.createElement('style');
  style.dataset.loadingMarkLook = '';
  style.textContent = LOADING_MARK_CSS;
  document.head.append(style);
}

/** The needle and thread, small (the same drawing as parts/ui/show/loading-mark's LoadingMark). */
export function loadingMark() {
  wearLoadingLook();
  const mark = document.createElement('span');
  mark.className = 'loading-mark';
  mark.dataset.loadingMark = 'sm';
  mark.setAttribute('aria-hidden', 'true');
  const art = svgNode('svg', { class: 'loading-mark-art', viewBox: '0 0 64 24', fill: 'none', 'aria-hidden': 'true', focusable: 'false' });
  art.append(svgNode('path', { class: 'loading-mark-guide', d: STITCH_PATH, pathLength: 100 }), svgNode('path', { class: 'loading-mark-thread', d: STITCH_PATH, pathLength: 100 }));
  const needle = svgNode('g', { class: 'loading-mark-needle' });
  needle.style.offsetPath = `path('${STITCH_PATH}')`;
  needle.append(svgNode('path', { class: 'loading-mark-needle-body', d: NEEDLE_BODY }), svgNode('ellipse', { class: 'loading-mark-needle-eye', ...NEEDLE_EYE }));
  art.append(needle);
  mark.append(art);
  return mark;
}

function mark(state) {
  if (state === 'pending') return loadingMark();
  const svg = svgNode('svg', { class: 'page-work-mark', viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const [tag, attributes] of MARKS[state]) svg.append(svgNode(tag, attributes));
  return svg;
}

/**
 * Starts the work of `action` (a page action element). Returns `{ done(words?), failed(words?), idle() }`: done shows
 * the check and stays (the page usually moves on), failed shows "Try again" for PAGE_WORK_ERROR_MS, idle puts the
 * label back. `words` are `{ pending, done }` used when the action's DATA names none.
 */
export function startWork(action, words = {}) {
  if (!action) return { done() {}, failed() {}, idle() {} };
  const label = action.dataset.pageLabel ?? action.textContent;
  action.dataset.pageLabel = label;
  const width = action.getBoundingClientRect().width;
  const show = (state, text) => {
    const face = document.createElement('span');
    face.className = 'page-work-face';
    if (state) face.append(mark(state));
    face.append(document.createTextNode(text));
    action.replaceChildren(face);
    if (state) action.dataset.pageWork = state; else delete action.dataset.pageWork;
    const busy = state === 'pending';
    for (const name of ['aria-busy', 'aria-disabled']) if (busy) action.setAttribute(name, 'true'); else action.removeAttribute(name);
    if (action.tagName === 'BUTTON') action.disabled = busy;
  };
  if (width) action.style.minWidth = `${Math.ceil(width)}px`;
  const pending = action.dataset.pagePending ?? words.pending ?? label;
  show('pending', pending);
  // Invariant 5: the pending words change as the wait runs, and say when it was asked again.
  const started = Date.now();
  let tries = 0;
  let said = pending;
  const tick = () => {
    const later = stillWorkingAt(pending, (Date.now() - started) / 1000, tries) ?? pending;
    if (later !== said) { said = later; show('pending', later); }
  };
  const ticking = setInterval(tick, 1000);
  const stopListening = onAskedAgain(() => { tries += 1; tick(); });
  const stopTicking = () => { clearInterval(ticking); stopListening(); };
  let timer = null;
  const idle = () => { stopTicking(); clearTimeout(timer); show(null, label); action.style.minWidth = ''; };
  return {
    done: text => { stopTicking(); clearTimeout(timer); show('done', text ?? action.dataset.pageDone ?? words.done ?? 'Done'); },
    failed: text => { stopTicking(); clearTimeout(timer); show('error', text ?? 'Try again'); timer = setTimeout(idle, PAGE_WORK_ERROR_MS); },
    idle,
  };
}
