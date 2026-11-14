// packages/ui/show/text-reveal/use-typewriter-reveal.ts
//
// THE STREAMING-REVEAL PRIMITIVE — one SSOT for the "characters coming out" effect
// every surface uses when an AI result lands (a composition text block, a board note).
//
// `runRevealSchedule` is the pure, React-free scheduler: it steps a count from 0 → total
// over ~`frames` animation frames, calling `onStep(shown)` each frame. Two hooks wrap it:
//   • useTypewriterReveal — IMPERATIVE: drives a ref's textContent (for a contentEditable
//     the surface owns, e.g. composition's AutoSizeTextNode). No React re-render.
//   • useRevealedLength — REACT: returns the revealed length as state, so a React-rendered
//     surface (e.g. the board note's dangerouslySetInnerHTML display, which React owns)
//     renders `text.slice(0, count)`. One scheduler, two render applications (L069 SSOT).
//
// The engine already holds the full PERSISTED text — reveal is pure presentation, zero
// round-trips, and a reload shows the text whole. The same scheduler renders live PARTIALS
// when the execution substrate streams (feed a growing `text`) — streaming-shaped day one.

import * as React from 'react';

/** Default animation span (~90 frames ≈ 1.5s at 60fps). SSOT for reveal cadence. */
export const DEFAULT_REVEAL_FRAMES = 90;

/** Characters revealed per frame so `total` is fully shown in ~`frames` frames. */
export function revealPerStep(total: number, frames: number = DEFAULT_REVEAL_FRAMES): number {
  return Math.max(1, Math.round(total / Math.max(1, frames)));
}

/**
 * Pure rAF scheduler: step a count 0 → `total` over ~`frames` frames, calling
 * `onStep(shown)` each frame and `onDone()` once when it reaches `total`. Returns a
 * cancel fn. React-free so both the imperative and the state hook share ONE stepping
 * loop (SSOT). No-op (returns a noop cancel) when `total <= 0`.
 */
export function runRevealSchedule(
  total: number,
  frames: number,
  onStep: (shown: number) => void,
  onDone?: () => void,
): () => void {
  if (total <= 0) { onDone?.(); return () => {}; }
  const perStep = revealPerStep(total, frames);
  let shown = 0;
  let raf = 0;
  const tick = () => {
    shown = Math.min(total, shown + perStep);
    onStep(shown);
    if (shown < total) raf = requestAnimationFrame(tick);
    else onDone?.();
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

export interface TypewriterRevealOptions {
  /** The element whose `textContent` the typewriter drives. */
  readonly ref: React.RefObject<HTMLElement | null>;
  /** The full text to reveal (the engine's persisted value). */
  readonly text: string;
  /** Reveal only when this is true (e.g. the node is a freshly-produced AI result). */
  readonly active: boolean;
  /** Called each frame with the element — the caller re-measures height so an
   *  auto-height box grows with the revealed text. */
  readonly onProgress?: (element: HTMLElement) => void;
  /** Called ONCE when the typewriter releases the element (reveal completed OR was
   *  cancelled and the full text restored). The caller re-applies any STRUCTURED
   *  rendering its plain-text sync skipped while the reveal owned textContent —
   *  e.g. inline chips / emphasis runs (live incident 2026-07-11: a fresh AI block
   *  kept literal ** markers until reload, because the sync effect keys on `value`
   *  which never changed after placement). Held in a ref internally, so an inline
   *  closure is fine — identity changes never restart the reveal. */
  readonly onSettled?: (element: HTMLElement) => void;
  /** Total animation frames the reveal spans (~90 ≈ 1.5s at 60fps). */
  readonly frames?: number;
}

export interface TypewriterRevealHandle {
  /** True while the typewriter owns the element's `textContent`. A caller's
   *  text-sync effect MUST early-return on this so it doesn't overwrite the
   *  animation mid-flight (the reveal effect claims it first). */
  readonly revealingRef: React.MutableRefObject<boolean>;
}

/** IMPERATIVE reveal for a surface that owns its element's textContent (contentEditable). */
export function useTypewriterReveal({
  ref,
  text,
  active,
  onProgress,
  onSettled,
  frames = DEFAULT_REVEAL_FRAMES,
}: TypewriterRevealOptions): TypewriterRevealHandle {
  const revealingRef = React.useRef(false);
  const revealedRef = React.useRef(false);
  // Ref-held so a caller's inline closure never restarts the reveal effect.
  const onSettledRef = React.useRef(onSettled);
  onSettledRef.current = onSettled;
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element || revealedRef.current || !active || text.length === 0) return;
    revealedRef.current = true;
    revealingRef.current = true;
    let settled = false;
    const settle = (el: HTMLElement) => {
      if (settled) return;
      settled = true;
      onSettledRef.current?.(el);
    };
    const full = text;
    element.textContent = '';
    const cancel = runRevealSchedule(
      full.length,
      frames,
      (shown) => {
        if (ref.current) {
          ref.current.textContent = full.slice(0, shown);
          onProgress?.(ref.current);
        }
      },
      () => {
        revealingRef.current = false;
        if (ref.current) settle(ref.current);
      },
    );
    return () => {
      cancel();
      revealingRef.current = false;
      // Restore the full text so a cancel mid-reveal never leaves a truncated node.
      if (ref.current && ref.current.textContent !== full) ref.current.textContent = full;
      if (ref.current) settle(ref.current);
    };
  }, [active, text, ref, onProgress, frames]);
  return { revealingRef };
}

/**
 * REACT reveal for a surface that renders its text through React (so React owns the
 * DOM and an imperative typewriter would fight reconciliation). Returns the number of
 * characters currently revealed: animate 0 → `total` while `active`, or `total`
 * immediately when inactive. The caller renders `text.slice(0, count)`. One-shot per
 * activation (a fresh result reveals once, then stays whole).
 */
export function useRevealedLength(
  total: number,
  active: boolean,
  frames: number = DEFAULT_REVEAL_FRAMES,
): number {
  const [count, setCount] = React.useState(active ? 0 : total);
  const startedRef = React.useRef(false);
  React.useEffect(() => {
    if (!active) { setCount(total); return; }
    if (startedRef.current) return;
    startedRef.current = true;
    setCount(0);
    return runRevealSchedule(total, frames, setCount);
  }, [active, total, frames]);
  return count;
}
