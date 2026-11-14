// packages/ui/show/tooltip/title-tooltips.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One document-level delegate that draws every `title` attribute as the shared
// tooltip instead of the operating system's. Hovering an element that carries a
// `title` moves the text aside (to `data-title-tooltip`) so the native tooltip
// never appears, shows the text in the shared tooltip look after the same delay
// the `Tooltip` component uses, and puts the `title` back when the pointer
// leaves. Keyboard focus shows the same tooltip without touching the attribute.
//
// With this installed, every current and future `title` in an app uses the
// shared design; no call site changes.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The `title` is only ever absent while the pointer rests on its element, so
//    assistive technology that reads the attribute still finds it.
// 2. A `title` written while its element is hovered (a re-render, a status
//    change) is moved aside too, so a native tooltip cannot slip through.
// 3. One tooltip at a time, one listener set per document; installing twice is
//    a no-op that returns the first install's teardown.
// 4. Pointer events never reach the tooltip; it can never cover its own target
//    in a way that steals the hover.
// 5. No tooltip inside a trigger whose popup is open (`data-popup-open`): the
//    open popup already says more than the title would.
// 6. A tooltip must add something the element does not already show. A title
//    that only repeats the element's visible text (a tab named "Library" with
//    the title "Library") is never drawn, and its native tooltip is still
//    suppressed. `titleRepeatsLabel` is the one test for this.
// 7. A tooltip never sits under the pointer. The pointer rests on its control
//    and its arrow hangs down and to the right, so every tooltip opens ABOVE its
//    control (`TOOLTIP_PLACEMENT`), flips below only when there is no room
//    above, and shifts sideways to stay inside the window. The `Tooltip`
//    component reads the same placement, so both paths agree.
//
// 8. A tooltip's width comes from its words (TOOLTIP_LAYER_STYLE: as wide as they are, up to the card's widest and
//    never wider than the window), never from where it was placed last, and it stays inside the window it is in, so
//    in a small window (a screen inside an AI chat) it never collapses to one letter a line or overflows.
//
// 9. One tooltip per control: a control the `Tooltip` component wraps (`data-tooltip-trigger`) is left to it, and
//    its `title` is still set aside so no native tooltip appears either.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {computePosition, flip, offset, shift} from '@floating-ui/dom';
import {Card} from '../card/Card';
import {Text} from '../text/Text';
import {LAYER_ORDER} from '../layer-order/layer-order';

/** Where a hovered element's `title` waits until the pointer leaves. */
export const TITLE_ASIDE_ATTRIBUTE = 'data-title-tooltip';
/** Marks a trigger the `Tooltip` component already explains; this delegate never draws a second tooltip for it. */
export const TOOLTIP_TRIGGER_ATTRIBUTE = 'data-tooltip-trigger';
/** The same resting delay as the shared `Tooltip` component. */
export const TITLE_TOOLTIP_DELAY_MS = 1000;
/** A second tooltip within this window opens at once, the way native ones do. */
const WARM_WINDOW_MS = 400;

/**
 * Where every tooltip opens: above its control, `offset` px away, flipping below
 * and shifting sideways only to stay `collisionPadding` px inside the window.
 * The one placement both the `Tooltip` component and this delegate use.
 */
export const TOOLTIP_PLACEMENT = {side: 'top', fallbackSide: 'bottom', offset: 6, collisionPadding: 8} as const;

const installs = new WeakMap<Document, () => void>();

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * True when `title` says nothing the element does not already show: it equals
 * the element's visible text, or that text contains all of it.
 */
export function titleRepeatsLabel(element: Element, title: string): boolean {
  const wanted = normalized(title);
  if (!wanted) return true;
  const shown = normalized((element as HTMLElement).innerText ?? element.textContent ?? '');
  return shown.length > 0 && shown.includes(wanted);
}

/**
 * Where a tooltip's layer sits before it is placed: fixed at the window's corner, as wide as its words up to the
 * card's widest, never wider than the window. Its width comes from its words, never from where it was last placed, so
 * a tooltip measured near the right edge of a small window (an AI chat's frame) never collapses to one letter a line.
 */
export const TOOLTIP_LAYER_STYLE = {position: 'fixed', left: '0', top: '0', width: 'max-content', maxWidth: 'calc(100vw - 16px)', pointerEvents: 'none'} as const;

/** The one tooltip card: the shared tooltip look, words that wrap inside it (a long address too), at most ten lines. */
export function TooltipCard({label}: {label: React.ReactNode}) {
  return (
    <Card variant="tooltip" padding="none" style={{padding: '8px 12px', maxWidth: 'min(320px, calc(100vw - 16px))', minWidth: 0, overflowWrap: 'anywhere'}}>
      <Text variant="body-xs" color="default" leading="tight" style={{display: '-webkit-box', WebkitLineClamp: 10, WebkitBoxOrient: 'vertical', overflow: 'hidden'}}>{label}</Text>
    </Card>
  );
}

/**
 * Starts drawing every `title` in `doc` as the shared tooltip. Returns a
 * teardown that restores any `title` currently set aside.
 */
export function installTitleTooltips(doc: Document = document): () => void {
  const existing = installs.get(doc);
  if (existing) return existing;

  const view = doc.defaultView ?? window;
  const host = doc.createElement('div');
  host.dataset.titleTooltipLayer = '';
  host.setAttribute('role', 'tooltip');
  Object.assign(host.style, {...TOOLTIP_LAYER_STYLE, zIndex: String(LAYER_ORDER.menu + 1), display: 'none'});
  doc.body.append(host);
  const root: Root = createRoot(host);

  let hovered: Element | null = null;
  let shownFor: Element | null = null;
  let timer = 0;
  let lastClosed = 0;

  const labelOf = (element: Element) => element.getAttribute(TITLE_ASIDE_ATTRIBUTE) ?? element.getAttribute('title') ?? '';

  const place = async (anchor: Element) => {
    const {side, fallbackSide, offset: gap, collisionPadding: padding} = TOOLTIP_PLACEMENT;
    const {x, y} = await computePosition(anchor, host, {strategy: 'fixed', placement: side, middleware: [offset(gap), flip({padding, fallbackPlacements: [fallbackSide]}), shift({padding})]});
    if (shownFor === anchor) Object.assign(host.style, {left: `${x}px`, top: `${y}px`});
  };

  const show = (anchor: Element) => {
    const label = labelOf(anchor).trim();
    // Inside a trigger whose own popup is already open (a hover preview that
    // names the thing), a second tooltip would only repeat it.
    // A title that repeats what the element already shows adds nothing.
    // A control wrapped in the Tooltip component already shows its own tooltip; a second one would stack on it.
    if (!label || anchor.closest('[data-popup-open]') || anchor.closest(`[${TOOLTIP_TRIGGER_ATTRIBUTE}]`) || titleRepeatsLabel(anchor, label)) return;
    shownFor = anchor;
    // The card is drawn before it is measured: placed above its element, a box
    // measured before React commits (empty, or the previous label) would put
    // the tooltip over the element instead of above it.
    flushSync(() => root.render(<TooltipCard label={label}/>));
    host.style.display = 'block';
    void place(anchor);
  };

  const hide = () => {
    view.clearTimeout(timer);
    if (shownFor) lastClosed = Date.now();
    shownFor = null;
    host.style.display = 'none';
  };

  const setAside = (element: Element) => {
    const title = element.getAttribute('title');
    if (title === null) return;
    element.setAttribute(TITLE_ASIDE_ATTRIBUTE, title);
    element.removeAttribute('title');
  };

  const restore = (element: Element) => {
    const aside = element.getAttribute(TITLE_ASIDE_ATTRIBUTE);
    if (aside === null) return;
    if (!element.hasAttribute('title')) element.setAttribute('title', aside);
    element.removeAttribute(TITLE_ASIDE_ATTRIBUTE);
  };

  // A `title` written while its element is hovered is moved aside at once.
  const watcher = new MutationObserver(() => {
    if (!hovered || !hovered.hasAttribute('title')) return;
    setAside(hovered);
    if (shownFor === hovered) show(hovered);
  });

  const leave = () => {
    if (!hovered) return;
    watcher.disconnect();
    restore(hovered);
    hovered = null;
    hide();
  };

  const enter = (element: Element) => {
    leave();
    hovered = element;
    setAside(element);
    watcher.observe(element, {attributes: true, attributeFilter: ['title']});
    const wait = Date.now() - lastClosed < WARM_WINDOW_MS ? 0 : TITLE_TOOLTIP_DELAY_MS;
    timer = view.setTimeout(() => { if (hovered === element) show(element); }, wait);
  };

  const titled = (target: EventTarget | null) =>
    target instanceof view.Element ? target.closest(`[title]:not([title=""]),[${TITLE_ASIDE_ATTRIBUTE}]`) : null;

  const onPointerOver = (event: PointerEvent) => {
    const element = titled(event.target);
    if (element === hovered) return;
    if (element) enter(element);
    else leave();
  };
  const onPointerOut = (event: PointerEvent) => {
    if (!hovered) return;
    const next = event.relatedTarget;
    if (next instanceof view.Node && hovered.contains(next)) return;
    leave();
  };
  const onFocusIn = (event: FocusEvent) => {
    const element = titled(event.target);
    if (!element || !(element as HTMLElement).matches?.(':focus-visible')) return;
    view.clearTimeout(timer);
    timer = view.setTimeout(() => show(element), TITLE_TOOLTIP_DELAY_MS);
  };
  const onFocusOut = () => { if (!hovered) hide(); };
  const onDismiss = () => hide();
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };

  doc.addEventListener('pointerover', onPointerOver, true);
  doc.addEventListener('pointerout', onPointerOut, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('pointerdown', onDismiss, true);
  doc.addEventListener('keydown', onKey, true);
  view.addEventListener('scroll', onDismiss, true);
  view.addEventListener('blur', leave);

  const teardown = () => {
    leave();
    doc.removeEventListener('pointerover', onPointerOver, true);
    doc.removeEventListener('pointerout', onPointerOut, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('pointerdown', onDismiss, true);
    doc.removeEventListener('keydown', onKey, true);
    view.removeEventListener('scroll', onDismiss, true);
    view.removeEventListener('blur', leave);
    root.unmount();
    host.remove();
    installs.delete(doc);
  };
  installs.set(doc, teardown);
  return teardown;
}
