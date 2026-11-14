import React from 'react';
import { fetchPointillistFrame, type PointillistPackedFrame } from './pointillistPackedFrame';

const DEFAULT_CELL_STRIDE = 4;
const DEFAULT_CELL_FILL = 3;
const STANDARD_ACTIVATION_MARGIN = '900px 0px';
const LEAN_MEMORY_ACTIVATION_MARGIN = '140px 0px';

export function PointillistPackagePreviewCanvas({
  frameUrl,
  cellFill = DEFAULT_CELL_FILL,
  cellStride = DEFAULT_CELL_STRIDE,
  className,
  fit = 'cover',
}: {
  frameUrl: string;
  cellFill?: number;
  cellStride?: number;
  className?: string;
  fit?: 'contain' | 'cover' | 'fill';
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [leanMemoryLifecycle] = React.useState(usesLeanPointillistLifecycle);
  const [nearViewport, setNearViewport] = React.useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  const safeCellStride = Math.max(1, Math.floor(cellStride));
  const safeCellFill = Math.max(1, Math.min(safeCellStride, Math.floor(cellFill)));

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let mounted = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!mounted) return;
        setNearViewport(entry?.isIntersecting ?? false);
      },
      {
        rootMargin: leanMemoryLifecycle
          ? LEAN_MEMORY_ACTIVATION_MARGIN
          : STANDARD_ACTIVATION_MARGIN,
      },
    );
    observer.observe(canvas);

    return () => {
      mounted = false;
      observer.disconnect();
    };
  }, [leanMemoryLifecycle]);

  React.useEffect(() => {
    const canvasNode = canvasRef.current;

    if (!nearViewport) {
      if (leanMemoryLifecycle) releaseCanvasBackingStore(canvasNode);
      return;
    }

    if (!canvasNode) {
      return;
    }

    let cancelled = false;

    void fetchPointillistFrame(frameUrl, {
      cache: !leanMemoryLifecycle,
    }).then((loaded) => {
      if (cancelled) return;
      const canvas = canvasNode;
      const context = canvas?.getContext('2d', { alpha: true });
      if (!canvas || !context) return;

      canvas.width = loaded.columns * safeCellStride;
      canvas.height = loaded.rows * safeCellStride;
      context.imageSmoothingEnabled = false;
      const image = context.createImageData(canvas.width, canvas.height);
      renderPointillistFrame(
        loaded,
        image.data,
        safeCellStride,
        safeCellFill,
      );
      context.putImageData(image, 0, 0);
    }).catch(() => {
      releaseCanvasBackingStore(canvasNode);
    });

    return () => {
      cancelled = true;
      if (leanMemoryLifecycle) releaseCanvasBackingStore(canvasNode);
    };
  }, [
    frameUrl,
    leanMemoryLifecycle,
    nearViewport,
    safeCellFill,
    safeCellStride,
  ]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{
        display: 'block',
        height: '100%',
        imageRendering: 'pixelated',
        inset: 0,
        objectFit: fit,
        // Decorative (aria-hidden) art must never intercept pointer events — otherwise an absolutely
        // positioned preview/hero canvas can overlay interactive UI (e.g. the search "Ask AI" mode
        // button) and swallow real user clicks. Clicks pass through to the interactive element beneath.
        pointerEvents: 'none',
        position: 'absolute',
        width: '100%',
      }}
    />
  );
}

function usesLeanPointillistLifecycle() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

  const userAgent = navigator.userAgent;
  const iOS = /\b(iPhone|iPad|iPod)\b/.test(userAgent);
  const coarseNarrow = window.matchMedia('(max-width: 719px) and (pointer: coarse)').matches;
  const deviceMemory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  const constrainedMemory = Number.isFinite(deviceMemory) && deviceMemory <= 4;

  return iOS || coarseNarrow || constrainedMemory;
}

function releaseCanvasBackingStore(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  if (canvas.width !== 1) canvas.width = 1;
  if (canvas.height !== 1) canvas.height = 1;
}

function renderPointillistFrame(
  frame: PointillistPackedFrame,
  output: Uint8ClampedArray,
  cellStride: number,
  cellFill: number,
) {
  output.fill(0);

  for (const cell of frame.cells) {
    const column = cell.cellId % frame.columns;
    const row = Math.floor(cell.cellId / frame.columns);
    writeCellBlock(
      output,
      frame.columns,
      column,
      row,
      cell.r,
      cell.g,
      cell.b,
      clampByte(cell.a * cell.opacity),
      cellStride,
      Math.max(1, Math.min(cellStride, Math.round(cellFill * cell.scale))),
    );
  }
}

function writeCellBlock(
  output: Uint8ClampedArray,
  columns: number,
  column: number,
  row: number,
  r: number,
  g: number,
  b: number,
  a: number,
  cellStride: number,
  cellFill: number,
) {
  const pixelColumns = columns * cellStride;
  const startX = column * cellStride;
  const startY = row * cellStride;

  for (let y = 0; y < cellFill; y += 1) {
    for (let x = 0; x < cellFill; x += 1) {
      const pixelIndex = ((startY + y) * pixelColumns + startX + x) * 4;
      output[pixelIndex] = r;
      output[pixelIndex + 1] = g;
      output[pixelIndex + 2] = b;
      output[pixelIndex + 3] = a;
    }
  }
}

function clampByte(value: number) {
  return Math.round(clamp(value, 0, 255));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
