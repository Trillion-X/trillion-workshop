// packages/ui/show/floating-panel-opener/FloatingView.tsx
//
// Purpose: the React way for shared ui (and vendored components adapted into
// it) to show something over the page. It opens the shared floating panel
// through the opener seam, so it is a movable, resizable window and the page
// behind it stays usable: no backdrop, no aria-modal, no focus trap.
// Invariants:
// 1. `open` opens one panel; `open` false or unmount closes it without calling
//    `onClose`. The person closing it (Escape or the close button) calls it.
// 2. Children render into the panel body through a portal, so React context
//    reaches them unchanged.
// 3. With no opener provided nothing opens; every app provides one.

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openFloatingPanel } from './floating-panel-opener';
import { LAYER_ORDER } from '../layer-order/layer-order';

export interface FloatingViewProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Accessible name of the panel. */
  readonly label: string;
  /** Shown as a heading at the top of the panel. */
  readonly title?: string;
  /** Starting width in pixels; the height follows the content. */
  readonly width?: number;
  /** Where the panel opens against; defaults to the focused element. */
  readonly anchor?: Element | null;
  readonly children: React.ReactNode;
}

export function FloatingView({ open, onClose, label, title, width = 520, anchor, children }: FloatingViewProps) {
  const [body, setBody] = useState<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    let closingFromHere = false, cancelled = false;
    let handle: ReturnType<typeof openFloatingPanel> = null;
    const from = anchor ?? (document.activeElement instanceof Element && document.activeElement !== document.body ? document.activeElement : null);
    // The owner renders synchronously, which React refuses inside a commit, so the panel opens right after it.
    queueMicrotask(() => {
      if (cancelled) return;
      handle = openFloatingPanel(from, { label, title, kind: 'view:' + label, size: { w: width, h: 240 }, exclusive: false, liveRegions: false, layer: LAYER_ORDER.dialog, onClose: () => { if (!closingFromHere) onCloseRef.current(); } });
      if (handle) setBody(handle.body);
    });
    return () => { cancelled = true; closingFromHere = true; handle?.close(); setBody(null); };
  }, [open, label, title, width, anchor]);
  return open && body ? createPortal(children, body) : null;
}
