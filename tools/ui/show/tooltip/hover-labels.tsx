// parts/ui/show/tooltip/hover-labels.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The names of a row of icons, shown as the pointer rests on one: a group of
// controls (a list's view switcher, a toolbar of tools) binds each control to
// its label, and the group draws ONE label in the shared tooltip look beside
// the control the pointer is on. Nothing in the row changes size, so the row
// never moves under the pointer; the label follows its control's live box, so
// a row that wraps, resizes or scrolls carries the label with it.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Hover intent: a label opens only after the pointer has rested on one
//    control for `intent_ms` (hover-labels.json); passing over controls on the
//    way somewhere opens nothing. Once one is open, moving to a neighbour moves
//    the label at once, and for `warm_ms` after the pointer left the group.
// 2. Only the pointer's own movement chooses the control. A control that slides
//    under a still pointer (its row resized) is never chosen by that: the label
//    stays on the control the pointer last moved onto, or closes when the
//    pointer is no longer inside that control's live box.
// 3. The label is anchored to its control's box as it is now, measured again
//    whenever the control, the label or anything scrolling around them changes
//    size or place (floating-ui autoUpdate), never a box remembered from when it
//    opened.
// 4. Leaving the control, pressing anything, Escape, or the control going away
//    closes the label and cancels any label waiting to open.
// 5. Opens above its control, flipping below only when there is no room
//    (`TOOLTIP_PLACEMENT`, the placement every tooltip shares); pointer events
//    never reach it, so it can never take the hover.
// 6. Touch has no hover: a touch pointer opens nothing.
// 7. A label that only repeats what its control already shows is never drawn
//    (`titleRepeatsLabel`).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import {createPortal} from 'react-dom';
import {autoUpdate, computePosition, flip, offset, shift} from '@floating-ui/dom';
import {Container} from '../container/container';
import {LAYER_ORDER} from '../layer-order/layer-order';
import {TOOLTIP_LAYER_STYLE, TOOLTIP_PLACEMENT, TooltipCard, titleRepeatsLabel} from './title-tooltips';
import timing from './hover-labels.json';

/** What a group spreads on each control it names. */
export type HoverLabelBinding = {
  'data-hover-label': string
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
  onPointerLeave: (event: React.PointerEvent<HTMLElement>) => void
  onFocus?: (event: React.FocusEvent<HTMLElement>) => void
  onBlur?: () => void
}

type Pointed = {element: HTMLElement; label: string; focused?: boolean}

const inside = (element: HTMLElement, x: number, y: number) => {
  const box = element.getBoundingClientRect();
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
};

/**
 * One hover label for a group of controls. `bind(label)` returns the props for
 * one control; `label` is the element to draw once anywhere in the group.
 */
export function useHoverLabels(): {bind: (label: string, options?: {focus?: boolean}) => HoverLabelBinding; label: React.ReactNode} {
  const [shown, setShown] = React.useState<Pointed | null>(null);
  const waiting = React.useRef<{pointed: Pointed; timer: number} | null>(null);
  const warmUntil = React.useRef(0);
  const shownRef = React.useRef<Pointed | null>(null);
  shownRef.current = shown;
  // Where the pointer last really moved (invariant 2).
  const last = React.useRef({x: -1, y: -1});

  const cancel = React.useCallback(() => {
    if (waiting.current) window.clearTimeout(waiting.current.timer);
    waiting.current = null;
  }, []);
  const close = React.useCallback(() => {
    cancel();
    if (shownRef.current) warmUntil.current = Date.now() + timing.warm_ms;
    setShown(null);
  }, [cancel]);

  const point = React.useCallback((element: HTMLElement, label: string) => {
    // Invariant 7: the control already says it.
    if (!label.trim() || titleRepeatsLabel(element, label)) { close(); return; }
    if (shownRef.current?.element === element || waiting.current?.pointed.element === element) return;
    cancel();
    const pointed = {element, label};
    // Invariant 1: warm, the label moves at once; cold, it waits for the pointer to rest.
    if (shownRef.current || Date.now() < warmUntil.current) { setShown(pointed); return; }
    const timer = window.setTimeout(() => {
      waiting.current = null;
      // Invariant 2: open only if the pointer is still inside this control's live box.
      if (element.isConnected && inside(element, last.current.x, last.current.y)) setShown(pointed);
    }, timing.intent_ms);
    waiting.current = {pointed, timer};
  }, [cancel, close]);

  const bind = React.useCallback((label: string, options?: {focus?: boolean}): HoverLabelBinding => ({
    'data-hover-label': label,
    onPointerMove: (event) => {
      if (event.pointerType === 'touch') return;
      last.current = {x: event.clientX, y: event.clientY};
      point(event.currentTarget, label);
    },
    onPointerLeave: (event) => {
      const element = event.currentTarget;
      if (!shownRef.current?.focused && (shownRef.current?.element === element || waiting.current?.pointed.element === element)) close();
    },
    ...(options?.focus ? {
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.matches(':focus-visible') || !label.trim()) return;
        cancel();
        setShown({element: event.currentTarget, label, focused: true});
      },
      onBlur: close,
    } : {}),
  }), [point, close, cancel]);

  // Invariant 4: a press or Escape anywhere closes it.
  React.useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [shown, close]);
  React.useEffect(() => cancel, [cancel]);

  const card = React.useRef<HTMLDivElement | null>(null);
  // Invariants 2, 3 and 5: placed against the control's live box, and placed again whenever anything around it moves.
  React.useLayoutEffect(() => {
    const floating = card.current;
    if (!shown || !floating) return;
    const {element} = shown;
    const {side, fallbackSide, offset: gap, collisionPadding: padding} = TOOLTIP_PLACEMENT;
    const place = () => {
      if (!element.isConnected) { close(); return; }
      // The control slid out from under a still pointer: the label goes, never onto the control that slid in.
      if (shown.focused ? document.activeElement !== element : !inside(element, last.current.x, last.current.y)) { close(); return; }
      void computePosition(element, floating, {strategy: 'fixed', placement: side, middleware: [offset(gap), flip({padding, fallbackPlacements: [fallbackSide]}), shift({padding})]})
        .then(({x, y}) => { Object.assign(floating.style, {left: `${x}px`, top: `${y}px`, visibility: 'visible'}); });
    };
    return autoUpdate(element, floating, place);
  }, [shown, close]);

  const label = shown && typeof document !== 'undefined' ? createPortal(
    <Container
      ref={card}
      role="tooltip"
      data-hover-label-shown=""
      style={{...TOOLTIP_LAYER_STYLE, visibility: 'hidden', zIndex: LAYER_ORDER.menu + 1}}
    >
      <TooltipCard label={shown.label}/>
    </Container>,
    document.body,
  ) : null;
  return {bind, label};
}
