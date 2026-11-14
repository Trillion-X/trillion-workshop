// parts/ui/show/button/press-work.tsx
// PORTED FROM: parts/ui/show/coss/ui/button.tsx (its useButtonWork and work face, themselves 21st.dev Loading Button,
// ddoemonn/loading-button), moved here so both shared buttons say their work through one owner.
//
// What a pressed button's work is doing, said in the button itself, for both shared buttons (./Button.tsx and
// ../coss/ui/button.tsx). A press whose handler returns a promise is that button's work: the one loading animation and
// its pending words while it runs (no more presses), a check and its done words when it worked, a mark and "Try again"
// when it failed, then the button's own label again. No caller wires anything: returning the promise is the whole
// contract, so every button that starts work says it the same way. A caller that runs its work elsewhere passes
// `work` itself, which wins over the press's own; a button that draws its own work (a copy's Copied, a sent job's Sent)
// passes `work={null}`, and its press is left as it is. A wait that runs long says it is still working, its words
// changing as time passes and saying when it was asked again (../still-working).
// A button keeps the width it had when it was pressed for as long as its work is drawn (pending words, check or mark
// are never shorter than the label they replace), so it neither shrinks nor moves whatever is laid out beside it.

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { Spinner } from '../spinner/Spinner';
import { sayHappened } from '../happened/happened';
import { useStillWorking } from '../still-working/use-still-working';

export type ButtonWork = 'pending' | 'done' | 'error';

/** How long a finished press keeps its check or its mark before the button's own label returns. */
export const PRESS_WORK_SETTLE_MS = 1400;

type Press = React.MouseEventHandler<HTMLButtonElement> | undefined;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value != null && typeof (value as { then?: unknown }).then === 'function';

/** The work a press is doing and the press to put on the button. `given` is the caller's own work (it wins; `null`
 *  means the button draws its own); `loading` is the caller's pending state with the button's own words. */
export function usePressWork(onClick: Press, given?: ButtonWork | null, loading?: boolean, settleMs = PRESS_WORK_SETTLE_MS): {
  work: ButtonWork | undefined;
  onClick: Press;
} {
  const [own, setOwn] = useState<ButtonWork | undefined>(undefined);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  const held = useRef<HTMLElement | null>(null);
  const letGoOfWidth = () => { if (held.current) { held.current.style.minWidth = ''; held.current = null; } };
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  const press = useCallback<React.MouseEventHandler<HTMLButtonElement>>((event) => {
    if (running.current) { event.preventDefault(); return; }
    const answer: unknown = onClick?.(event);
    if (!isThenable(answer)) return;
    const button = event.currentTarget;
    running.current = true;
    if (timer.current) clearTimeout(timer.current);
    // Hold the laid-out width (not the pressed, scaled box) while the button's work changes its face. Bound the hold
    // by the containing block so a parent that narrows during async work can still shrink the button to fit.
    if (!held.current) { held.current = button; button.style.minWidth = `min(${getComputedStyle(button).width}, 100%)`; }
    setOwn('pending');
    const settle = (next: ButtonWork) => {
      running.current = false;
      if (!live.current) return;
      setOwn(next);
      timer.current = setTimeout(() => { letGoOfWidth(); if (live.current) setOwn(undefined); }, settleMs);
    };
    // The press's outcome is said on the happened channel with the button, so the device's feel answers it there.
    answer.then(() => { settle('done'); sayHappened({ event_kind: 'press-done', target: button }); }, () => { settle('error'); sayHappened({ event_kind: 'press-failed', target: button }); });
  }, [onClick, settleMs]);
  if (given === null) return { work: loading ? 'pending' : undefined, onClick };
  return { work: given ?? own ?? (loading ? 'pending' : undefined), onClick: onClick ? press : undefined };
}

/** The button's face for its work: its own children when nothing runs. An icon-only button keeps its size and shows
 *  only the loading animation, the check or the mark. */
export function PressWorkFace({ work, iconOnly = false, pendingLabel, doneLabel = 'Done', errorLabel = 'Try again', children }: {
  work: ButtonWork | undefined;
  iconOnly?: boolean;
  pendingLabel?: React.ReactNode;
  doneLabel?: React.ReactNode;
  errorLabel?: React.ReactNode;
  children?: React.ReactNode;
}): React.ReactElement {
  const own = pendingLabel ?? children;
  const later = useStillWorking(work === 'pending' && !iconOnly, typeof own === 'string' ? own : '');
  if (work === 'pending') return <><Spinner aria-hidden data-slot="button-loading-indicator" />{iconOnly ? null : <span aria-live="polite">{later ?? own}</span>}</>;
  if (work === 'done') return <><Check aria-hidden />{iconOnly ? null : doneLabel}</>;
  if (work === 'error') return <><CircleAlert aria-hidden />{iconOnly ? null : errorLabel}</>;
  // A button that names its pending words is wide enough for them from the start: its resting face is laid over an
  // unseen copy of the pending face (the loading mark's room and the words), so pressing it changes nothing about its
  // width and nothing laid out beside it (a button at the end of a row, a row that wraps) is moved by the press.
  if (!iconOnly && typeof pendingLabel === 'string' && pendingLabel) {
    const layer = 'col-start-1 row-start-1 inline-flex items-center justify-center gap-2';
    return (
      <span className="inline-grid">
        <span className={layer}>{children}</span>
        {/* 30px is the loading mark's small width (screen-look/show/loading-mark.css); it is room, not a second mark. */}
        {/* The words are drawn from the attribute, so they are never text a reader, a copy or a test finds in the button. */}
        <span aria-hidden data-button-sizer={pendingLabel} className={`${layer} invisible after:content-[attr(data-button-sizer)]`}><span className="w-[30px] shrink-0" /></span>
      </span>
    );
  }
  return <>{children}</>;
}
