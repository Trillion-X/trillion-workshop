// parts/ui/show/copy-button/CopyButton.tsx
//
// PURPOSE
//   The one way anything in the app copies text with a button: the copy mark turns into a drawn check and the button's
//   words cross-fade to "Copied" on the very thing pressed, or into a cross and the caller's failure words, then go
//   back. Adapted from 21st.dev's Copy Button by Özer (@ddoemonn, interior.dev, MIT; unmodified source in
//   upstream/copy-button.tsx, pinned in provenance.json) onto the shared Coss button and the shared clipboard write.
//   `useCopy` and `CopyMark` are the same behaviour for a control that is something else as well (an app's tab that
//   copies its setup message when picked).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Success is never simulated: "Copied" shows only when copyTextToClipboard verifiably wrote the text; a refused
//      write shows the failure words and is said in an alert.
//   2. A newer press wins: an answer for an earlier press never changes what the button shows, and nothing is set
//      after the button is gone.
//   3. Every word is the caller's; the part knows nothing about what the text is.
//   4. Reduced motion shows each state at once, with no cross-fade or drawn check.
//   5. Keyboard and touch reach it like any Coss button; it names itself by its state (the cross-fading words are
//      hidden from screen readers), and an icon-only one also shows the shared Tooltip.
//
// APPEARANCE
//   screen-look/show/copy-button.css.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { m as motion, useReducedMotion } from 'framer-motion';
import { MotionFeatures } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx'
import { Button } from '../coss/ui/button';
import { Tooltip } from '../tooltip';
import { copyTextToClipboard } from 'trillion-workshop/tools/ui/show/clipboard/copy-text.ts';

export type CopyStatus = 'idle' | 'pending' | 'copied' | 'failed';

/** What every copy says when the browser refused the write, unless its caller words it. Never empty: a failure is
 *  announced, and an empty alert announces nothing. */
export const COPY_FAILED_WORDS = 'Could not copy';

const EASE = [0.23, 1, 0.32, 1] as const;
const CROSSFADE = { type: 'spring', stiffness: 260, damping: 34, mass: 0.8 } as const;
const DRAW = { duration: 0.26, ease: EASE } as const;
const INSTANT = { duration: 0 } as const;

/** Copies text on demand and says how the last copy went (`status`), returning to idle after `timeout` ms. */
export function useCopy({ timeout = 1800 }: { timeout?: number } = {}) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const press = useRef(0);
  const live = useRef(true);
  const timer = useRef<number | null>(null);
  const clear = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };
  useEffect(() => { live.current = true; return () => { live.current = false; clear(); }; }, []);
  const copy = useCallback(async (text: string): Promise<boolean> => {
    if (!text) return false;
    const mine = ++press.current;
    clear();
    setStatus('pending');
    const ok = await copyTextToClipboard(text);
    if (!live.current || mine !== press.current) return ok;
    setStatus(ok ? 'copied' : 'failed');
    timer.current = window.setTimeout(() => setStatus('idle'), ok ? timeout : timeout * 2);
    return ok;
  }, [timeout]);
  return { copy, status };
}

/** The mark that shows a copy's state: a copy icon (`idle` false hides it), a drawn check once copied, a cross on failure. */
function CopyMarkMoving({ status, idle = true }: { status: CopyStatus; idle?: boolean }) {
  const reduced = useReducedMotion();
  const fade = reduced ? INSTANT : CROSSFADE;
  const shows = (state: 'idle' | 'copied' | 'failed') => (state === 'idle' ? idle && (status === 'idle' || status === 'pending') : status === state);
  const look = (state: 'idle' | 'copied' | 'failed') => ({ opacity: shows(state) ? 1 : 0, scale: shows(state) ? 1 : 0.92 });
  const stroke = { viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className: 'copy-mark-layer', initial: false, transition: fade };
  return (
    <span className="copy-mark" aria-hidden="true" data-idle-shown={idle ? '' : undefined}>
      <motion.svg {...stroke} animate={look('idle')}>
        <path d="M9.6 5.1V3.7A1.7 1.7 0 0 0 7.9 2H3.7A1.7 1.7 0 0 0 2 3.7v4.2a1.7 1.7 0 0 0 1.7 1.7h1.4" />
        <rect x="5.1" y="5.1" width="6.9" height="6.9" rx="1.7" />
      </motion.svg>
      <motion.svg {...stroke} animate={look('copied')}>
        <motion.path d="M2.9 7.4 5.6 10.1 11.1 4" initial={false} animate={{ pathLength: status === 'copied' ? 1 : 0 }} transition={reduced ? INSTANT : DRAW} />
      </motion.svg>
      <motion.svg {...stroke} animate={look('failed')}>
        <path d="M3.6 3.6 10.4 10.4" />
        <path d="M10.4 3.6 3.6 10.4" />
      </motion.svg>
    </span>
  );
}

/** Words that cross-fade with the copy's state: `label` while idle, `copiedLabel` once copied, `failedLabel` on failure. */
export function CopyWords({ status, label, copiedLabel, failedLabel }: { status: CopyStatus; label: string; copiedLabel: string; failedLabel: string }) {
  const reduced = useReducedMotion();
  const fade = reduced ? INSTANT : CROSSFADE;
  const shown = status === 'copied' ? 'copied' : status === 'failed' ? 'failed' : 'idle';
  const words: [typeof shown, string][] = [['idle', label], ['copied', copiedLabel], ['failed', failedLabel]];
  return (
    <span className="copy-words" aria-hidden="true">
      {words.map(([state, text]) => (
        <motion.span key={state} className="copy-words-layer" initial={false} transition={fade}
          animate={state === shown ? { opacity: 1, y: 0, filter: 'blur(0px)' } : { opacity: 0, y: 3, filter: 'blur(3px)' }}>
          {text}
        </motion.span>
      ))}
    </span>
  );
}

/** What a screen reader hears about the copy, and the alert when the browser refused it. */
export function CopyStatusLine({ status, copiedLabel, failedLabel }: { status: CopyStatus; copiedLabel: string; failedLabel?: string }) {
  return status === 'failed'
    ? <span className="copy-status" role="alert">{failedLabel || COPY_FAILED_WORDS}</span>
    : <span className="copy-status" role="status">{status === 'copied' ? copiedLabel : ''}</span>;
}

export type CopyButtonProps = {
  /** The text put on the clipboard. */
  text: string;
  /** The button's words and name, for example "Copy link". */
  label?: string;
  /** What it says once copied. */
  copiedLabel?: string;
  /** What it says when the browser refused the write. */
  failedLabel?: string;
  /** Only the mark shows (the words become its name and hint), for a copy beside a line of code. */
  iconOnly?: boolean;
  /** The Coss button's look. */
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
  /** How long "Copied" stays, in milliseconds. */
  timeout?: number;
  className?: string;
  onCopy?: () => void;
};

export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied', failedLabel = COPY_FAILED_WORDS, iconOnly = false, variant = 'ghost', size, timeout, className, onCopy }: CopyButtonProps) {
  const { copy, status } = useCopy({ timeout });
  const press = async () => { if (await copy(text)) onCopy?.(); };
  const named = status === 'copied' ? copiedLabel : status === 'failed' ? failedLabel : label;
  const button = (
    <Button type="button" variant={variant} size={size ?? (iconOnly ? 'icon-sm' : 'sm')} className={`copy-button${className ? ` ${className}` : ''}`}
      aria-label={named} disabled={status === 'pending' || !text} onClick={() => press()} work={null} data-copy-state={status}>
      <CopyMark status={status} />
      {iconOnly ? null : <CopyWords status={status} label={label} copiedLabel={copiedLabel} failedLabel={failedLabel} />}
    </Button>
  );
  return (
    <span className="copy-button-control" data-copy-state={status}>
      {iconOnly ? <Tooltip label={named}>{button}</Tooltip> : button}
      <CopyStatusLine status={status} copiedLabel={copiedLabel} failedLabel={failedLabel} />
    </span>
  );
}

// Drawn inside MotionFeatures (ui/motion/lazy-motion.tsx): its motion arrives after the first paint, without remounting.
export function CopyMark(props: React.ComponentProps<typeof CopyMarkMoving>) {
  return <MotionFeatures><CopyMarkMoving {...props} /></MotionFeatures>;
}
