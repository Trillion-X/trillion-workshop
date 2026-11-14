// parts/ui/show/point-at-anything/PointAtAnything.tsx
//
// PURPOSE
//   Point at any element of a page and pick it: a ring follows the element under the pointer (or finger), a press picks
//   it, and the owner gets the element and its VisualSelectionRef (parts/ui/show/public-app-editor/selection-ref.ts, the
//   one shape every selection has). Any page works, Trillion's own screens, a public app's preview or an iframe's
//   document, because it reads only the rendered page: no list of components, no knowledge of how the page was built.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One selection shape: `captureVisualSelection`. This file never makes its own selector.
//   2. While active, the press that picks is the only thing a press does (it never also reaches the page), and Escape
//      ends picking. Elements marked `data-point-at-anything-ui` (the owner's own card, this ring) are never picked.
//   3. While active, a clear sheet over the page takes the pointer, so nothing under it is hovered: what is picked is read
//      as it rests, never in its hover look.
//   4. Nothing names a screen, a product or a kind of element; what the owner does with a pick is the owner's.
//   5. Nothing inside a locked region (ui/show/locked-region) is ringed or picked.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Container } from '../container';
import { LAYER_ORDER } from '../layer-order/layer-order';
import { isLockedAt } from '../locked-region';
import { captureVisualSelection, type VisualSelectionRef } from '../public-app-editor/selection-ref';

export type PointAtAnythingProps = {
  /** Picking is on. */
  active: boolean;
  /** The document picked in (the page's own when left out; an iframe's document works). */
  host?: Document;
  /** Where the page is, as the selection names it. */
  pagePath: string;
  route?: string;
  revision: string;
  onSelect: (selection: VisualSelectionRef, element: Element) => void;
  onCancel: () => void;
};

/** The attribute that marks the owner's own controls, which are never picked. */
export const POINT_AT_ANYTHING_UI = 'data-point-at-anything-ui';
const OWN_UI = `[${POINT_AT_ANYTHING_UI}]`;
const SHEET = 'data-point-at-anything-sheet';

/** The element under a point that may be picked: the topmost one outside the owner's own controls. */
function pickableAt(doc: Document, x: number, y: number): Element | null {
  for (const element of doc.elementsFromPoint(x, y)) {
    if (element.closest(OWN_UI)) continue;
    if (element === doc.documentElement || element === doc.body) return null;
    // Inside a locked region nothing is picked (invariant 5).
    return isLockedAt(element) ? null : element;
  }
  return null;
}

export function PointAtAnything({ active, host, pagePath, route, revision, onSelect, onCancel }: PointAtAnythingProps) {
  const [ring, setRing] = React.useState<DOMRect | null>(null);
  const latest = React.useRef({ onSelect, onCancel, pagePath, route, revision });
  latest.current = { onSelect, onCancel, pagePath, route, revision };

  React.useEffect(() => {
    if (!active) { setRing(null); return undefined; }
    const doc = host ?? document;
    const view = doc.defaultView ?? window;
    const show = (event: PointerEvent) => setRing(pickableAt(doc, event.clientX, event.clientY)?.getBoundingClientRect() ?? null);
    const ours = (event: Event) => { const target = event.target as Element | null; return Boolean(target?.closest?.(OWN_UI)) && !target?.hasAttribute?.(SHEET); };
    const swallow = (event: Event) => {
      if (ours(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const pick = (event: MouseEvent) => {
      if (ours(event)) return;
      swallow(event);
      const element = pickableAt(doc, event.clientX, event.clientY);
      if (!element) return;
      setRing(element.getBoundingClientRect());
      const { onSelect: select, pagePath: page, route: at, revision: version } = latest.current;
      select(captureVisualSelection(element, { pagePath: page, ...(at ? { route: at } : {}), revision: version }), element);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); latest.current.onCancel(); } };
    doc.addEventListener('pointermove', show, true);
    doc.addEventListener('pointerdown', swallow, true);
    doc.addEventListener('mousedown', swallow, true);
    doc.addEventListener('click', pick, true);
    view.addEventListener('keydown', key, true);
    doc.documentElement.dataset.pointing = 'true';
    return () => {
      doc.removeEventListener('pointermove', show, true);
      doc.removeEventListener('pointerdown', swallow, true);
      doc.removeEventListener('mousedown', swallow, true);
      doc.removeEventListener('click', pick, true);
      view.removeEventListener('keydown', key, true);
      delete doc.documentElement.dataset.pointing;
    };
  }, [active, host]);

  if (!active || typeof document === 'undefined') return null;
  const layer = { [POINT_AT_ANYTHING_UI]: '' };
  return createPortal(
    <>
      <Container {...layer} {...{ [SHEET]: '' }} position="fixed" inset="0" style={{ zIndex: LAYER_ORDER.dialog, cursor: 'crosshair' }} />
      {ring ? (
        <Container
          {...layer}
          data-point-at-anything-ring
          aria-hidden
          position="fixed"
          pointerEvents="none"
          left={`${ring.left}px`}
          top={`${ring.top}px`}
          width={`${ring.width}px`}
          heightPx={`${ring.height}px`}
          style={{ zIndex: LAYER_ORDER.dialog }}
          className="rounded-md ring-2 ring-[var(--accent-primary)] ring-offset-1"
        />
      ) : null}
    </>,
    (host ?? document).body,
  );
}
