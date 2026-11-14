// parts/ui/show/audio-timeline/AudioTimeline.tsx
//
// NO PRIOR: searched ~/dev/bitfield-packages/packages/*/show and parts/ for a zoomable scrub timeline ('pinch',
// 'waveform', 'scrub', 'zoom'): media-composition's MediaTimeline and EditTrackLanes place clips but never zoom or
// pinch, ui/show/waveform/Waveform draws a fixed set of div bars, and 21st.dev's WaveformPlayer (component 7978) only
// seeks. Anatomy taken from Mobbin: Brink's bookmark timeline (played bars bright, the rest dim, start and end times
// under it; mobbin.com/screens/8dce49b3-ca4b-40d2-b2ae-44bba3fee9ce) and Polarsteps' trim handles on both edges of the
// chosen part (mobbin.com/screens/b6fb5c67-1b0c-491b-974e-f3520ae4bee9).
//
// PURPOSE
//   A recording's sound as a timeline the person moves through with a finger: the place being listened to stays under a
//   fixed line in the middle and the sound slides beneath it (drag to scrub, the way Voice Memos does), two fingers or
//   a trackpad pinch zoom in and out around that line, and a chosen part (`selection`) is shown between two handles that
//   drag its start and end. It draws only; what the times mean and what happens to a chosen part is the caller's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every time handed out is clamped to 0..duration, and a selection's start is never after its end. A handle drag
//      keeps the other edge as its anchor, so dragging one past the other swaps them rather than pinning the part shut;
//      when the two handles are drawn on one spot (a part only a few pixels wide), the first move decides which edge
//      moves: left moves the start, right moves the end.
//   2. Pixels are derived from (position, pixels per second, width) on every drawing; nothing keeps a second copy of
//      where the sound is, so a resize, a zoom or a new recording can never leave the picture out of step.
//   3. Colours come from the mounted screen look's CSS variables (accent for what was played, muted text for the rest).
//   4. Keyboard reaches everything a finger does: arrows move the place, + and - zoom, and each handle is a slider.
//   5. It names no product, file or recording: it takes peaks (0..1, `peaksPerSecond` of them per second) and seconds.
//
// APPEARANCE
//   Layout only here; colours from screen-look tokens read at draw time.

import * as React from 'react';

import { cn } from '../cn';
import { Playhead } from '../playhead';
import { Text } from '../text';

export type TimelineSpan = { start: number; end: number };

export type AudioTimelineProps = {
  /** Loudness, 0..1, `peaksPerSecond` values for each second of the recording. */
  peaks: ArrayLike<number>;
  peaksPerSecond: number;
  /** The recording's length in seconds. */
  duration: number;
  /** The place under the middle line, in seconds. */
  position: number;
  onPositionChange: (seconds: number) => void;
  /** The chosen part, or null for none. */
  selection?: TimelineSpan | null;
  onSelectionChange?: (span: TimelineSpan) => void;
  /** What the timeline is, for people who cannot see it. */
  label?: string;
  /** The words for the two handles, for people who cannot see them. */
  startLabel?: string;
  endLabel?: string;
  className?: string;
};

const BAR = 2;
const GAP = 1.5;
const MAX_PIXELS_PER_SECOND = 400;
const KEY_STEP_SECONDS = 1;
/** How wide a handle's grip is (w-5); two handles closer than this are drawn on one spot. */
const HANDLE_PIXELS = 20;

/** Seconds as the timeline says them: 0:07, 1:04.5 when zoomed in far enough to matter. */
export function timelineTime(seconds: number, tenths = false): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const whole = tenths ? (Math.floor(rest * 10) / 10).toFixed(1) : String(Math.floor(rest));
  return `${minutes}:${whole.padStart(tenths ? 4 : 2, '0')}`;
}

/** Loudness peaks of decoded sound, `perSecond` of them per second: the loudest sample of each slice, 0..1. */
export function peaksOf(channels: Float32Array[], sampleRate: number, perSecond: number): Float32Array {
  const length = channels[0]?.length ?? 0;
  const step = Math.max(1, Math.round(sampleRate / perSecond));
  const peaks = new Float32Array(Math.ceil(length / step));
  for (let slice = 0; slice < peaks.length; slice += 1) {
    let loudest = 0;
    const end = Math.min(length, (slice + 1) * step);
    for (const channel of channels) {
      for (let at = slice * step; at < end; at += 1) {
        const value = Math.abs(channel[at] ?? 0);
        if (value > loudest) loudest = value;
      }
    }
    peaks[slice] = Math.min(1, loudest);
  }
  return peaks;
}

const clampTo = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function cssColor(element: HTMLElement, variables: readonly string[]): string {
  const style = getComputedStyle(element);
  for (const variable of variables) {
    const value = style.getPropertyValue(variable).trim();
    if (value) return value;
  }
  return style.color || 'CanvasText';
}

type Gesture =
  | { kind: 'drag'; pointer: number; startX: number; startPosition: number }
  | { kind: 'pinch'; startDistance: number; startScale: number }
  | { kind: 'handle'; pointer: number; startX: number; anchor: number | null };

export function AudioTimeline({
  peaks, peaksPerSecond, duration, position, onPositionChange, selection = null, onSelectionChange,
  label = 'Recording timeline', startLabel = 'Start of the chosen part', endLabel = 'End of the chosen part', className,
}: AudioTimelineProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = React.useState(0);
  // Zoom, as pixels for each second; null means "fit the whole recording", which follows the width and length.
  const [scale, setScale] = React.useState<number | null>(null);
  const fit = width > 0 && duration > 0 ? width / duration : 1;
  const pixelsPerSecond = clampTo(scale ?? fit, fit, Math.max(fit, MAX_PIXELS_PER_SECOND));
  const pointers = React.useRef(new Map<number, number>());
  const gesture = React.useRef<Gesture | null>(null);
  const live = React.useRef({ position, pixelsPerSecond, selection, duration });
  live.current = { position, pixelsPerSecond, selection, duration };

  const place = React.useCallback((seconds: number) => onPositionChange(clampTo(seconds, 0, live.current.duration)), [onPositionChange]);
  const zoom = React.useCallback((next: number) => setScale(clampTo(next, fit, Math.max(fit, MAX_PIXELS_PER_SECOND))), [fit]);
  const timeAt = (x: number) => live.current.position + (x - width / 2) / live.current.pixelsPerSecond;
  const xAt = (seconds: number) => width / 2 + (seconds - position) * pixelsPerSecond;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const measure = () => setWidth(host.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // A Safari trackpad pinch arrives as gesture events rather than a ctrl+wheel.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let from = pixelsPerSecond;
    const start = (event: Event) => { event.preventDefault(); from = live.current.pixelsPerSecond; };
    const change = (event: Event) => { event.preventDefault(); zoom(from * ((event as Event & { scale?: number }).scale ?? 1)); };
    host.addEventListener('gesturestart', start);
    host.addEventListener('gesturechange', change);
    return () => { host.removeEventListener('gesturestart', start); host.removeEventListener('gesturechange', change); };
  }, [zoom, pixelsPerSecond]);

  // A wheel pans; a pinch on a trackpad (ctrl + wheel) zooms. Listened to directly so the page does not scroll.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey) { zoom(live.current.pixelsPerSecond * Math.exp(-event.deltaY / 100)); return; }
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      place(live.current.position + delta / live.current.pixelsPerSecond);
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [zoom, place]);

  // Drawing: one bar per slot across the width, each the loudest peak of the time it covers.
  React.useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas || width <= 0) return;
    const height = host.getBoundingClientRect().height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const played = cssColor(host, ['--accent-primary', '--text-primary']);
    const ahead = cssColor(host, ['--text-muted', '--text-secondary']);
    const chosen = cssColor(host, ['--accent-primary', '--text-primary']);
    if (selection) {
      const left = clampTo(xAt(selection.start), 0, width);
      const right = clampTo(xAt(selection.end), 0, width);
      context.globalAlpha = 0.16;
      context.fillStyle = chosen;
      context.fillRect(left, 0, Math.max(0, right - left), height);
      context.globalAlpha = 1;
    }
    const middle = height / 2;
    for (let x = 0; x < width; x += BAR + GAP) {
      const from = position + (x - width / 2) / pixelsPerSecond;
      const to = from + (BAR + GAP) / pixelsPerSecond;
      if (to <= 0 || from >= duration) continue;
      let loudest = 0;
      const first = Math.max(0, Math.floor(from * peaksPerSecond));
      const last = Math.min(peaks.length - 1, Math.ceil(to * peaksPerSecond));
      for (let index = first; index <= last; index += 1) loudest = Math.max(loudest, peaks[index] ?? 0);
      const bar = Math.max(2, Math.min(1, loudest * 1.6) * (height - 8));
      context.fillStyle = from < position ? played : ahead;
      context.globalAlpha = from < position ? 1 : 0.55;
      context.fillRect(x, middle - bar / 2, BAR, bar);
    }
    context.globalAlpha = 1;
  });

  const distance = () => {
    const [first, second] = [...pointers.current.values()];
    return first === undefined || second === undefined ? 0 : Math.abs(first - second);
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.kind === 'handle') return;
    hostRef.current?.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, event.clientX);
    if (pointers.current.size >= 2) gesture.current = { kind: 'pinch', startDistance: distance() || 1, startScale: pixelsPerSecond };
    else gesture.current = { kind: 'drag', pointer: event.pointerId, startX: event.clientX, startPosition: position };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) && gesture.current?.kind !== 'handle') return;
    pointers.current.set(event.pointerId, event.clientX);
    const now = gesture.current;
    if (!now) return;
    if (now.kind === 'pinch') { const span = distance(); if (span > 0) zoom(now.startScale * (span / now.startDistance)); return; }
    if (now.kind === 'drag' && now.pointer === event.pointerId) { place(now.startPosition - (event.clientX - now.startX) / pixelsPerSecond); return; }
    if (now.kind === 'handle' && now.pointer === event.pointerId && selection && onSelectionChange) {
      const box = hostRef.current?.getBoundingClientRect();
      if (!box) return;
      const seconds = clampTo(timeAt(event.clientX - box.left), 0, duration);
      if (now.anchor === null) {
        if (event.clientX === now.startX) return;
        now.anchor = event.clientX < now.startX ? selection.end : selection.start;
      }
      onSelectionChange({ start: Math.min(seconds, now.anchor), end: Math.max(seconds, now.anchor) });
    }
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (gesture.current?.kind === 'handle' && gesture.current.pointer === event.pointerId) { gesture.current = null; return; }
    if (pointers.current.size === 1) {
      const [[pointer, x]] = [...pointers.current.entries()];
      gesture.current = { kind: 'drag', pointer, startX: x, startPosition: live.current.position };
    } else if (!pointers.current.size) gesture.current = null;
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_SECONDS * 5 : KEY_STEP_SECONDS;
    if (event.key === 'ArrowLeft') place(position - step);
    else if (event.key === 'ArrowRight') place(position + step);
    else if (event.key === 'Home') place(0);
    else if (event.key === 'End') place(duration);
    else if (event.key === '+' || event.key === '=') zoom(pixelsPerSecond * 1.5);
    else if (event.key === '-') zoom(pixelsPerSecond / 1.5);
    else return;
    event.preventDefault();
  };
  const handle = (edge: 'start' | 'end') => {
    if (!selection) return null;
    const seconds = edge === 'start' ? selection.start : selection.end;
    const x = xAt(seconds);
    if (x < -12 || x > width + 12) return null;
    const move = (to: number) => onSelectionChange?.(edge === 'start'
      ? { start: clampTo(Math.min(to, selection.end), 0, duration), end: selection.end }
      : { start: selection.start, end: clampTo(Math.max(to, selection.start), 0, duration) });
    return (
      <div
        key={edge}
        role="slider"
        tabIndex={0}
        aria-label={edge === 'start' ? startLabel : endLabel}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 10) / 10}
        aria-valuenow={Math.round(seconds * 10) / 10}
        aria-valuetext={timelineTime(seconds, true)}
        data-timeline-handle={edge}
        className="absolute top-0 bottom-0 z-20 flex w-5 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center focus-visible:outline-2"
        style={{ left: x }}
        onPointerDown={event => {
          event.stopPropagation();
          hostRef.current?.setPointerCapture(event.pointerId);
          const together = Math.abs(xAt(selection.end) - xAt(selection.start)) < HANDLE_PIXELS;
          gesture.current = { kind: 'handle', pointer: event.pointerId, startX: event.clientX, anchor: together ? null : edge === 'start' ? selection.end : selection.start };
        }}
        onKeyDown={event => {
          const step = event.shiftKey ? 1 : 0.1;
          if (event.key === 'ArrowLeft') move(seconds - step);
          else if (event.key === 'ArrowRight') move(seconds + step);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="h-full w-1.5 rounded-full" style={{ background: 'var(--accent-primary, var(--text-primary))' }} />
      </div>
    );
  };

  return (
    <div className={cn('flex w-full flex-col gap-1', className)} data-audio-timeline="">
      <div
        ref={hostRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 10) / 10}
        aria-valuenow={Math.round(position * 10) / 10}
        aria-valuetext={`${timelineTime(position)} of ${timelineTime(duration)}`}
        className="relative h-24 w-full cursor-grab touch-none select-none overflow-hidden rounded-lg focus-visible:outline-2 active:cursor-grabbing"
        style={{ color: 'var(--text-muted)' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
        <Playhead positionPct={50} />
        {handle('start')}
        {handle('end')}
      </div>
      <div className="flex w-full items-center justify-between">
        <Text variant="caption" color="muted">{timelineTime(0)}</Text>
        <Text variant="caption" data-timeline-place="">{timelineTime(position, pixelsPerSecond > 40)}</Text>
        <Text variant="caption" color="muted">{timelineTime(duration)}</Text>
      </div>
    </div>
  );
}
