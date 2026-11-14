// parts/ui/show/floating-occlusion/window-corner.tsx
//
// PURPOSE
//   One group per window corner for every control that floats there (the Look button, the phone's Show sidebar button,
//   the pane map on a page with no sidebar). The message box is not one of them: it is a screen the arrangement floats
//   in a layer (src/workspace/global-composer.tsx). A control is placed with <InWindowCorner corner="bottom-right">; the corner's group lines its
//   controls up side by side with one gap, so no control sits on another and none offsets itself by hand. The group is
//   a floating control like any other: it publishes the band it covers (reserveBottomFloatingInset), so notifications
//   and a message box pinned at a screen's bottom stack above it, and what scrolls beneath it ends with room for it
//   (clearScrollBeneath).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One group per corner per document: every control in that corner joins it; the group exists only while it has
//      a control and leaves the page (releasing what it published) with the last one.
//   2. Where a control sits in its group is its `order` (0 is the corner itself, higher lines up further from it);
//      the gap, the inset from the window edge and the corner's direction are screen-look's
//      (parts/screen-look/show/floating-corner.css), never a number here.
//   3. Nothing here knows what a control is or does.

import React from 'react';
import { createPortal } from 'react-dom';
import { Container } from '../container/container';
import { LAYER_ORDER } from '../layer-order/layer-order';
import { clearScrollBeneath } from './clear-scroll-beneath';
import { reserveBottomFloatingInset } from './reserve-bottom-inset';

/** The window corners a control can float in. */
export type WindowCorner = 'bottom-left' | 'bottom-right';

type Group = { host: HTMLElement; members: number; release: () => void };
const groups = new WeakMap<Document, Map<WindowCorner, Group>>();

/** Joins the corner's group (making it on first use); answers the element the control is drawn into. */
function join(doc: Document, corner: WindowCorner): HTMLElement {
  let byCorner = groups.get(doc);
  if (!byCorner) groups.set(doc, byCorner = new Map());
  let group = byCorner.get(corner);
  if (!group) {
    const host = doc.createElement('div');
    host.className = 'floating-corner-group';
    host.setAttribute('data-floating-corner', corner);
    host.style.zIndex = String(LAYER_ORDER.floatingPanel);
    doc.body.append(host);
    const releaseBand = reserveBottomFloatingInset(host);
    const releaseScroll = clearScrollBeneath(host);
    group = { host, members: 0, release: () => { releaseBand(); releaseScroll(); host.remove(); } };
    byCorner.set(corner, group);
  }
  group.members += 1;
  return group.host;
}

/** Leaves the corner's group; the last control to leave takes the group with it. */
function leave(doc: Document, corner: WindowCorner) {
  const byCorner = groups.get(doc);
  const group = byCorner?.get(corner);
  if (!byCorner || !group) return;
  group.members -= 1;
  if (group.members > 0) return;
  group.release();
  byCorner.delete(corner);
}

export interface InWindowCornerProps {
  corner: WindowCorner;
  /** Where it lines up in the corner: 0 is the corner itself, higher sits further from it. */
  order?: number;
  children: React.ReactNode;
}

/** Floats `children` in a window corner, lined up with every other control there. */
export function InWindowCorner({ corner, order = 0, children }: InWindowCornerProps) {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (typeof document === 'undefined') return undefined;
    setHost(join(document, corner));
    return () => { setHost(null); leave(document, corner); };
  }, [corner]);
  if (!host) return null;
  return createPortal(
    <Container layout="flow" className="floating-corner-item" data-floating-corner-order={order} style={{ order }}>{children}</Container>,
    host,
  );
}
