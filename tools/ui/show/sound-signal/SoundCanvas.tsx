// parts/ui/show/sound-signal/SoundCanvas.tsx
//
// NO PRIOR: searched bitfield-packages show for audio reactive canvas, visualizer, and 21st.dev 'audio reactive visualizer microphone background'
//
// PURPOSE
//   One canvas that moves with the sound in a look: the background behind the panes, the stage of the Ambience
//   screen, each look's live preview tile. It reads the page's one sound reading (sound-signal.ts) and paints with
//   the look's motion (sound-painters.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A leaf of parts/ui: the one place this canvas is drawn; callers pass a look, never pixels.
//   2. It paints only while on screen and visible, at most at the screen's pixel density capped by MAX_DENSITY.
//   3. A person who asked for less motion gets the look still: its colours, breathing slowly, never popping.
//   4. What moves it is the page's sound reading unless the caller hands its own `frames` (any signal shaped like a
//      sound frame: a page opening, a job's progress); a canvas given its own frames never opens a sound source.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { onSoundFrame, type SoundFrame } from './sound-signal';
import { soundPainters, type SoundLook } from './sound-painters';
import { cn } from '../cn';

const MAX_DENSITY = 1.5;

/** Where a canvas's frames come from: a subscription that calls `listener` once a frame and answers its stop. */
export type FrameSource = (listener: (frame: SoundFrame) => void) => () => void;

export type SoundCanvasProps = { look: SoundLook; className?: string; label?: string; frames?: FrameSource };

export function SoundCanvas({ look, className, label, frames = onSoundFrame }: SoundCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const lookRef = React.useRef(look);
  lookRef.current = look;
  const framesRef = React.useRef(frames);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return undefined;
    const memory: Record<string, unknown> = {};
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let width = 0;
    let height = 0;
    let visible = true;
    const fit = () => {
      const density = Math.min(window.devicePixelRatio || 1, MAX_DENSITY);
      const box = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(box.width * density));
      height = Math.max(1, Math.round(box.height * density));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    fit();
    const resized = new ResizeObserver(fit);
    resized.observe(canvas);
    const seen = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); });
    seen.observe(canvas);
    const stop = framesRef.current(frame => {
      if (!visible) return;
      const current = lookRef.current;
      (soundPainters[current.motion] ?? soundPainters.glow)({ context, width, height, frame, look: current, memory, still });
    });
    return () => { stop(); resized.disconnect(); seen.disconnect(); };
  }, []);
  return React.createElement('canvas', {
    ref: canvasRef,
    className: cn('block h-full w-full', className),
    'data-moves-with-sound': '',
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
  });
}
