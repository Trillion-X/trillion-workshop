// parts/ui/show/frame-window/FrameWindow.tsx
//
// A still of a video with the part that will be kept outlined: a window of the chosen frame's shape, made smaller by
// a zoom, that the person drags (or moves with the arrow keys) to choose what stays in the picture. Everything
// outside the window is dimmed. An optional CSS filter previews colour changes on the still, and a mirror flips the
// still the way the result will be flipped.
//
// Invariants
//   1. Positions are the point of the source picture to keep centred, 0..1 across and down, clamped so the window
//      stays inside the picture (the same bounds as selection/crop-position.mjs, which owns the math).
//   2. Domain-blind: the caller supplies the address, time, shapes, words and what to do with a new position.

import * as React from 'react';
import { cropBounds } from '../selection/crop-position.mjs';

export type FrameWindowCenter = { x: number; y: number };

export type FrameWindowProps = {
  /** Address of a video the browser can play. */
  source: string;
  /** Seconds into the video to show. */
  at: number;
  /** Width divided by height of the frame being filled. */
  frameAspect: number;
  /** 1 keeps the largest window; 2 keeps half as much, and so on. */
  zoom: number;
  center: FrameWindowCenter;
  /** CSS filter for a live colour preview of the still. */
  filter?: string;
  /** Flip the still across (h), up and down (v) or both (hv). */
  mirror?: 'h' | 'v' | 'hv';
  /** Accessible name of the draggable window. */
  label: string;
  onChange: (center: FrameWindowCenter) => void;
};

/** The window in 0..1 fractions of the picture: its centre (clamped), size and top-left corner. */
export function frameWindowBounds(sourceAspect: number, frameAspect: number, zoom: number, center: FrameWindowCenter) {
  const full = cropBounds(sourceAspect, 1, frameAspect, { x: 0.5, y: 0.5 });
  const width = full.width / zoom, height = full.height / zoom;
  const x = Math.max(width / 2, Math.min(1 - width / 2, center.x)), y = Math.max(height / 2, Math.min(1 - height / 2, center.y));
  return { x, y, width, height, left: x - width / 2, top: y - height / 2 };
}

export function FrameWindow({ source, at, frameAspect, zoom, center, filter, mirror, label, onChange }: FrameWindowProps) {
  const stage = React.useRef<HTMLDivElement>(null);
  const video = React.useRef<HTMLVideoElement>(null);
  const [sourceAspect, setSourceAspect] = React.useState<number | null>(null);
  const drag = React.useRef<{ id: number; x: number; y: number; center: FrameWindowCenter } | null>(null);
  const flipX = mirror === 'h' || mirror === 'hv' ? -1 : 1, flipY = mirror === 'v' || mirror === 'hv' ? -1 : 1;
  const bounds = sourceAspect ? frameWindowBounds(sourceAspect, frameAspect, zoom, center) : null;
  const move = (next: FrameWindowCenter) => {
    if (!sourceAspect) return;
    const clamped = frameWindowBounds(sourceAspect, frameAspect, zoom, next);
    onChange({ x: Math.round(clamped.x * 1000) / 1000, y: Math.round(clamped.y * 1000) / 1000 });
  };
  React.useEffect(() => {
    const element = video.current;
    if (element && element.readyState >= 1) element.currentTime = at;
  }, [at, source]);
  return <div className="grid gap-2" data-frame-window="">
    <div ref={stage} className="relative w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: String(sourceAspect ?? 16 / 9), transform: `scale(${flipX}, ${flipY})` }}>
      <video
        ref={video}
        className="block h-full w-full object-contain"
        src={source}
        muted
        playsInline
        preload="metadata"
        style={filter ? { filter } : undefined}
        onLoadedMetadata={event => {
          const element = event.currentTarget;
          if (element.videoWidth && element.videoHeight) setSourceAspect(element.videoWidth / element.videoHeight);
          element.currentTime = at;
        }}
      />
      {bounds ? <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(bounds.x * 100)}
        aria-valuetext={`Across ${Math.round(bounds.x * 100)}%, down ${Math.round(bounds.y * 100)}%`}
        className="absolute cursor-grab touch-none border-2 border-white shadow-[0_0_0_100vmax_rgba(0,0,0,0.55)] outline-none focus-visible:border-[var(--accent-primary)] active:cursor-grabbing"
        style={{ left: `${bounds.left * 100}%`, top: `${bounds.top * 100}%`, width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%` }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, center: { x: bounds.x, y: bounds.y } };
        }}
        onPointerMove={event => {
          const start = drag.current, box = stage.current?.getBoundingClientRect();
          if (!start || start.id !== event.pointerId || !box?.width || !box.height) return;
          move({ x: start.center.x + flipX * (event.clientX - start.x) / box.width, y: start.center.y + flipY * (event.clientY - start.y) / box.height });
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { if (drag.current) onChange(drag.current.center); drag.current = null; }}
        onKeyDown={event => {
          const step = event.shiftKey ? 0.05 : 0.01;
          const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          const change = delta[event.key];
          if (!change) return;
          event.preventDefault();
          move({ x: bounds.x + flipX * change[0], y: bounds.y + flipY * change[1] });
        }}
      /> : null}
    </div>
  </div>;
}
