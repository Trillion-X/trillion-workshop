// parts/ui/show/step-overlay/StepOverlay.tsx
//
// PURPOSE
//   One step the person takes in front of the app (choosing a plan, connecting their AI): a panel over the whole
//   window with the app still visible through a quiet blur behind it. The caller supplies the heading, the words
//   under it and the body (React children, or `mount`: a screen the caller draws into a host); this part owns the
//   portal, the blur, the focus that stays inside the panel, and closing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words or roads: every word and the body are the caller's.
//   2. With `onClose` the step can be left (a close button and Escape); without it the step stays until the caller
//      takes it away, which is how a step that must be done first holds.
//   3. Focus moves into the panel when it opens, stays inside it while open (Tab wraps), and returns to where it was
//      when it closes. The page behind does not scroll while it is open.
//   4. It paints above everything else a step can cover (LAYER_ORDER.stepInFront), a tour included.
//
// SECURITY
//   Renders the caller's React children only; no markup strings.

import * as React from 'react';
import { createPortal } from 'react-dom';
import { LAYER_ORDER } from '../layer-order/layer-order';
import { LoadingMark } from 'trillion-workshop/tools/ui/show/loading-mark/LoadingMark.tsx';

export type StepOverlayProps = {
  title: string;
  /** The words under the heading. */
  description?: string;
  /** Leaving the step; with none, the step has no close button and Escape does nothing. */
  onClose?: () => void;
  /** The close button's name for a screen reader, such as "Close pricing". */
  closeLabel?: string;
  /** `wide` for side-by-side content such as plan cards; `reading` for a column of steps. */
  width?: 'wide' | 'reading';
  /** What the step is waiting for, said beside the loading mark under the heading (such as "Waiting for your AI"). */
  waiting?: string;
  /** What this step is, as a data attribute a proof or tour can find it by. */
  marker?: string;
  /** A body drawn by the caller into a host element; answers the function that takes it away. */
  mount?: (host: HTMLElement) => () => void;
  children?: React.ReactNode;
};

// The body a caller's mount function draws, mounted once per function.
function MountedBody({ mount }: { mount: (host: HTMLElement) => () => void }) {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => (host.current ? mount(host.current) : undefined), [mount]);
  return <div ref={host} className="step-overlay__body" />;
}

export function StepOverlay({ title, description, onClose, closeLabel = 'Close', width = 'wide', waiting, marker, mount, children }: StepOverlayProps) {
  const panel = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) { event.preventDefault(); panel.current.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = before; previous?.focus(); };
  }, [onClose]);
  return createPortal(
    <div className="step-overlay" data-step-overlay={marker ?? ''} role="presentation" style={{ zIndex: LAYER_ORDER.stepInFront }}>
      <div className="step-overlay__backdrop" aria-hidden="true" />
      <section ref={panel} className="step-overlay__panel plan-paper" data-width={width} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="step-overlay__top">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
            {waiting ? <p className="step-overlay__waiting" role="status"><LoadingMark size="sm" /><span>{waiting}</span></p> : null}
          </div>
          {onClose ? <button type="button" className="step-overlay__close" onClick={onClose} aria-label={closeLabel}>×</button> : null}
        </div>
        {mount ? <MountedBody mount={mount} /> : null}
        {children}
      </section>
    </div>, document.body);
}
