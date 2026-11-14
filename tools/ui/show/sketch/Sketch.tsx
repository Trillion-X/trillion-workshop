// parts/ui/show/sketch/Sketch.tsx
//
// Purpose: hand-drawn page parts. Each looks drawn with a pen on paper and knows nothing about what it
// shows: every word, link and picture arrives as props.
//
//   SketchFrame   a box with a thin pencil outline drawn twice (tinted and outlined in the thread
//                 colour when highlighted, or once a ScrollThread has reached it)
//   DoodleButton  a link painted as a red brush stroke with a loose pen loop round it (or only the
//                 loops, for a quieter action), with a nudge on hover
//   ScribbleTag   a short handwritten tag with a pen swash leading into it and tick marks after it
//   HandNote      a short handwritten note in the hand font, tilted, with two small tick marks
//   SketchLink    a plain text link that gets a drawn underline on hover
//   SketchFigure  an illustration that breathes gently (still when the reader asks for less motion)
//
// Invariants:
// 1. Colours come from theme roles only: --ink-line, --pencil-line, --thread-line, --on-accent,
//    --paper, --text-primary, --text-secondary. Line weights come from tokens: --pencil-stroke.
// 2. Fonts come from tokens only: --font-headline, --font-hand, --font-body.
// 3. Every part passes `data-*` attributes through to its outer element, so a page can make it an
//    anchor for a ScrollThread.
// 4. With reduced motion nothing breathes, wobbles or nudges.

import { type HTMLAttributes, type MouseEventHandler, type ReactNode } from 'react';
import { sketchBrush, sketchBrushStreaks, sketchLoop, sketchRectangle } from './sketch-path';

type DataAttributes = { [key: `data-${string}`]: string | undefined };

function Outline({ seed, passes = 2 }: { seed: number; passes?: number }) {
  return (
    <svg className="sketch__outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {Array.from({ length: passes }, (_, pass) => (
        <path key={pass} d={sketchRectangle(seed + pass * 31, pass ? 1.6 : 1)} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

export type SketchFrameProps = HTMLAttributes<HTMLDivElement> & DataAttributes & {
  seed?: number;
  highlighted?: boolean;
  children: ReactNode;
};

export function SketchFrame({ seed = 1, highlighted = false, className, children, ...rest }: SketchFrameProps) {
  return (
    <div {...rest} className={className ? `sketch-frame ${className}` : 'sketch-frame'} data-highlighted={highlighted ? 'true' : 'false'}>
      <style>{STYLE}</style>
      <Outline seed={seed} />
      {children}
    </div>
  );
}

export type DoodleButtonProps = DataAttributes & {
  href: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  /** A filled marker blob, or only a drawn outline. */
  tone?: 'filled' | 'outline';
  seed?: number;
};

export function DoodleButton({ href, children, onClick, tone = 'filled', seed = 3, ...rest }: DoodleButtonProps) {
  return (
    <a {...rest} href={href} onClick={onClick} className="doodle-button" data-tone={tone}>
      <style>{STYLE}</style>
      <svg className="doodle-button__paint" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {tone === 'filled' ? <path className="doodle-button__fill" d={sketchBrush(seed)} /> : null}
        {tone === 'filled' ? <path className="doodle-button__streaks" d={sketchBrushStreaks(seed + 5)} vectorEffect="non-scaling-stroke" /> : null}
        <path className="doodle-button__edge" d={sketchLoop(seed + 11)} vectorEffect="non-scaling-stroke" />
        <path className="doodle-button__edge doodle-button__edge--second" d={sketchLoop(seed + 23)} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="doodle-button__label">{children}</span>
      <span className="doodle-button__arrow" aria-hidden="true">→</span>
    </a>
  );
}

export type HandNoteProps = DataAttributes & {
  children: ReactNode;
  /** Tilt in degrees. */
  tilt?: number;
  /** Which side the tick marks sit on. */
  ticks?: 'left' | 'right' | 'none';
  className?: string;
};

export function HandNote({ children, tilt = -6, ticks = 'left', className, ...rest }: HandNoteProps) {
  return (
    <span {...rest} className={className ? `hand-note ${className}` : 'hand-note'} data-ticks={ticks} style={{ ['--hand-note-tilt' as string]: `${tilt}deg` }}>
      <style>{STYLE}</style>
      {children}
    </span>
  );
}

export type ScribbleTagProps = DataAttributes & {
  children: ReactNode;
  /** Tilt in degrees. */
  tilt?: number;
  className?: string;
};

export function ScribbleTag({ children, tilt = -7, className, ...rest }: ScribbleTagProps) {
  return (
    <span {...rest} className={className ? `scribble-tag ${className}` : 'scribble-tag'} style={{ ['--scribble-tilt' as string]: `${tilt}deg` }}>
      <style>{STYLE}</style>
      <svg className="scribble-tag__swash" viewBox="0 0 60 40" aria-hidden="true" focusable="false">
        <path d="M 2 38 C 6 26 10 18 22 16 C 34 14 44 18 58 12" />
      </svg>
      <span className="scribble-tag__words">{children}</span>
      <svg className="scribble-tag__ticks" viewBox="0 0 20 30" aria-hidden="true" focusable="false">
        <path d="M 4 4 L 14 8 M 3 14 L 16 15 M 5 25 L 14 21" />
      </svg>
    </span>
  );
}

export type SketchLinkProps = DataAttributes & { href: string; children: ReactNode };

export function SketchLink({ href, children, ...rest }: SketchLinkProps) {
  return (
    <a {...rest} href={href} className="sketch-link">
      <style>{STYLE}</style>
      {children}
    </a>
  );
}

export type SketchFigureProps = DataAttributes & {
  src: string;
  /** What the picture shows; empty when it is only decoration. */
  alt: string;
  width: number;
  height: number;
  className?: string;
  /** Load at once (the first screen) or when near the window. */
  priority?: boolean;
  /** Seconds for one slow breath; 0 keeps the figure still. */
  breathe?: number;
};

export function SketchFigure({ src, alt, width, height, className, priority = false, breathe = 6, ...rest }: SketchFigureProps) {
  return (
    <span {...rest} className={className ? `sketch-figure ${className}` : 'sketch-figure'} style={{ ['--sketch-breathe' as string]: breathe ? `${breathe}s` : '0s' }}>
      <style>{STYLE}</style>
      <img src={src} alt={alt} width={width} height={height} loading={priority ? 'eager' : 'lazy'} decoding="async" />
    </span>
  );
}

const STYLE = `
  .sketch-frame { position: relative; z-index: 1; box-sizing: border-box; background: var(--paper); border-radius: 14px; }
  .sketch__outline { position: absolute; inset: -2px; width: calc(100% + 4px); height: calc(100% + 4px); overflow: visible; pointer-events: none; }
  .sketch__outline path { fill: none; stroke: var(--pencil-line); stroke-width: var(--pencil-stroke); stroke-linecap: round; stroke-linejoin: round; opacity: .8; transition: stroke 400ms ease; }
  .sketch__outline path + path { stroke-width: calc(var(--pencil-stroke) * .6); opacity: .4; }
  .sketch-frame[data-highlighted="true"] .sketch__outline path,
  .sketch-frame[data-thread-reached="true"] .sketch__outline path,
  [data-thread-reached="true"] > .sketch-frame .sketch__outline path { stroke: var(--thread-line); }
  .sketch-frame[data-highlighted="true"] { background: color-mix(in srgb, var(--paper) 94%, var(--thread-line) 6%); }

  .doodle-button { position: relative; display: inline-flex; align-items: center; gap: .6em; min-height: 3.5rem; padding: .8rem 2.2rem; box-sizing: border-box; color: var(--on-accent); font: 600 1.12rem/1 var(--font-body); text-decoration: none; isolation: isolate; transition: transform 180ms ease; }
  .doodle-button[data-tone="outline"] { color: var(--thread-line); }
  .doodle-button__paint { position: absolute; inset: -4px -6px; width: calc(100% + 12px); height: calc(100% + 8px); z-index: -1; overflow: visible; }
  .doodle-button__fill { fill: var(--thread-line); }
  .doodle-button__streaks { fill: none; stroke: var(--paper); stroke-width: 1.2; stroke-linecap: round; opacity: .35; }
  .doodle-button__edge { fill: none; stroke: var(--thread-line); stroke-width: 1.5; stroke-linecap: round; }
  .doodle-button__edge--second { stroke-width: .9; opacity: .6; }
  .doodle-button__arrow { display: inline-block; transition: transform 180ms ease; }
  .doodle-button:hover { transform: rotate(-1.2deg) scale(1.03); }
  .doodle-button:hover .doodle-button__arrow { transform: translateX(4px); }
  .doodle-button:focus-visible { outline: 2px dashed var(--thread-line); outline-offset: 6px; }

  .hand-note { position: relative; display: inline-block; color: var(--thread-line); font: 400 1.75rem/1.05 var(--font-hand); transform: rotate(var(--hand-note-tilt)); white-space: pre-line; }
  .hand-note::before { position: absolute; top: .15em; color: var(--thread-line); font: 600 1rem/1 var(--font-body); letter-spacing: .05em; }
  .hand-note[data-ticks="left"]::before { content: '\\\\\\\\'; left: -1.3em; }
  .hand-note[data-ticks="right"]::before { content: '//'; right: -1.3em; }

  .scribble-tag { position: relative; display: inline-flex; align-items: flex-end; gap: .2rem; color: var(--thread-line); transform: rotate(var(--scribble-tilt)); white-space: nowrap; }
  .scribble-tag__words { font: 400 1.8rem/1 var(--font-hand); }
  .scribble-tag svg { flex: none; overflow: visible; fill: none; stroke: var(--thread-line); stroke-linecap: round; }
  .scribble-tag__swash { width: 2.6rem; height: 1.7rem; stroke-width: 2; margin-bottom: -.4rem; }
  .scribble-tag__ticks { width: .9rem; height: 1.3rem; stroke-width: 1.8; align-self: center; }

  .sketch-link { color: var(--text-primary); font: 500 .95rem/1 var(--font-body); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--thread-line) 45%, transparent); text-underline-offset: 5px; background: linear-gradient(var(--thread-line), var(--thread-line)) no-repeat left 100% / 0 2px; padding-bottom: 3px; transition: background-size 220ms ease; }
  .sketch-link:hover, .sketch-link:focus-visible { background-size: 100% 2px; text-decoration-color: transparent; outline: none; }

  .sketch-figure { position: relative; z-index: 1; display: inline-block; }
  .sketch-figure img { display: block; width: 100%; height: auto; transform-origin: 50% 100%; animation: sketch-breathe var(--sketch-breathe) ease-in-out infinite; }
  @keyframes sketch-breathe { 0%, 100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-4px) rotate(-.6deg); } }

  @media (prefers-reduced-motion: reduce) {
    .sketch-figure img { animation: none; }
    .doodle-button, .doodle-button__arrow { transition: none; }
    .doodle-button:hover { transform: none; }
  }
`;
