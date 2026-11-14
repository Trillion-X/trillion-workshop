// packages/group/show/camera-frame.test.ts
//
// Pure proof of the camera-framing primitive. Verifies the inverse-transform math:
// after framing, the content bounds centre lands at the viewport centre, and the
// zoom fits the content within the padded viewport (clamped). No DOM, no engine.

import { describe, it, expect } from 'vitest';
import { frameCamera, zoomAroundCenter, zoomAroundPoint, type FrameRect } from './camera-frame';

const VIEW = { w: 1000, h: 800 };
const OPTS = { padding: 80, minZoom: 0.1, maxZoom: 4 };

// Where a world point maps on screen under a camera — the forward transform.
const toScreen = (cam: { panX: number; panY: number; zoom: number }, wx: number, wy: number) => ({
  x: wx * cam.zoom + cam.panX,
  y: wy * cam.zoom + cam.panY,
});

describe('frameCamera', () => {
  it('centres a single rect at the viewport centre', () => {
    const rect: FrameRect = { x: 200, y: 100, w: 100, h: 80 };
    const cam = frameCamera([rect], VIEW, OPTS)!;
    const center = toScreen(cam, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(center.x).toBeCloseTo(VIEW.w / 2, 5);
    expect(center.y).toBeCloseTo(VIEW.h / 2, 5);
  });

  it('clamps zoom to maxZoom for tiny content (does not zoom in past the cap)', () => {
    const cam = frameCamera([{ x: 0, y: 0, w: 10, h: 10 }], VIEW, OPTS)!;
    expect(cam.zoom).toBe(OPTS.maxZoom);
  });

  it('clamps zoom to minZoom for huge content', () => {
    const cam = frameCamera([{ x: 0, y: 0, w: 100000, h: 100000 }], VIEW, OPTS)!;
    expect(cam.zoom).toBe(OPTS.minZoom);
  });

  it('frames the UNION of multiple rects (content centred, fits the padded viewport)', () => {
    const rects: FrameRect[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 500, y: 300, w: 100, h: 100 },
    ];
    const cam = frameCamera(rects, VIEW, OPTS)!;
    // bounds = 0..600 x 0..400 → centre (300,200) maps to viewport centre.
    const center = toScreen(cam, 300, 200);
    expect(center.x).toBeCloseTo(500, 5);
    expect(center.y).toBeCloseTo(400, 5);
    // both corners land inside the padded viewport.
    const tl = toScreen(cam, 0, 0);
    const br = toScreen(cam, 600, 400);
    expect(tl.x).toBeGreaterThanOrEqual(OPTS.padding - 0.5);
    expect(br.x).toBeLessThanOrEqual(VIEW.w - OPTS.padding + 0.5);
  });

  it('limits zoom by WIDTH when content is wide, by HEIGHT when tall', () => {
    const wide = frameCamera([{ x: 0, y: 0, w: 4200, h: 50 }], VIEW, OPTS)!; // availW/bw
    expect(wide.zoom).toBeCloseTo((VIEW.w - 160) / 4200, 5);
    const tall = frameCamera([{ x: 0, y: 0, w: 50, h: 4200 }], VIEW, OPTS)!; // availH/bh
    expect(tall.zoom).toBeCloseTo((VIEW.h - 160) / 4200, 5);
  });

  it('returns null when there is nothing to frame', () => {
    expect(frameCamera([], VIEW, OPTS)).toBeNull();
  });

  it('a single malformed (non-finite) rect does NOT poison the whole camera (cont.98 batch-10)', () => {
    // One NaN/Infinity coordinate would make min/max NaN → bw NaN → zoom/pan NaN, killing zoom-to-fit for
    // the ENTIRE board. The bad rects are skipped; the good rect still frames.
    const good: FrameRect = { x: 0, y: 0, w: 200, h: 100 };
    const cam = frameCamera([{ x: NaN, y: 0, w: 50, h: 50 }, good, { x: 0, y: 0, w: Infinity, h: 1 }], VIEW, OPTS)!;
    expect(cam).not.toBeNull();
    expect(Number.isFinite(cam.zoom)).toBe(true);
    expect(Number.isFinite(cam.panX)).toBe(true);
    expect(Number.isFinite(cam.panY)).toBe(true);
    // Same result as framing ONLY the good rect (the malformed ones contribute nothing).
    expect(cam).toEqual(frameCamera([good], VIEW, OPTS));
  });

  it('every rect malformed → null (nothing valid to frame, camera left as-is)', () => {
    expect(frameCamera([{ x: NaN, y: 0, w: 1, h: 1 }, { x: 0, y: Infinity, w: 1, h: 1 }], VIEW, OPTS)).toBeNull();
  });

  it('a negative-w/h rect frames its TRUE extent (both corners), not a collapsed width (cont.98 batch-10)', () => {
    // A rect drawn from its far corner ({x:200,w:-200}) covers world x ∈ [0,200] — same as {x:0,w:200}.
    const fromFarCorner = frameCamera([{ x: 200, y: 100, w: -200, h: -100 }], VIEW, OPTS);
    const normal = frameCamera([{ x: 0, y: 0, w: 200, h: 100 }], VIEW, OPTS);
    expect(fromFarCorner).toEqual(normal);
  });
});

describe('zoomAroundPoint', () => {
  it('keeps the world point under an ARBITRARY anchor fixed while changing zoom (cursor-zoom invariant)', () => {
    const cam = { panX: 123, panY: -45, zoom: 2.5 };
    const anchor = { x: 720, y: 610 }; // off-centre cursor
    const worldUnder = { x: (anchor.x - cam.panX) / cam.zoom, y: (anchor.y - cam.panY) / cam.zoom };
    const zoomed = zoomAroundPoint(cam, anchor, 4);
    expect(zoomed.zoom).toBe(4);
    // the world point that was under the cursor still maps EXACTLY to the cursor.
    const screen = toScreen(zoomed, worldUnder.x, worldUnder.y);
    expect(screen.x).toBeCloseTo(anchor.x, 5);
    expect(screen.y).toBeCloseTo(anchor.y, 5);
  });

  it('clamps the target zoom to [minZoom, maxZoom]', () => {
    const cam = { panX: 0, panY: 0, zoom: 1 };
    expect(zoomAroundPoint(cam, { x: 10, y: 10 }, 999, 0.1, 4).zoom).toBe(4);
    expect(zoomAroundPoint(cam, { x: 10, y: 10 }, 0.0001, 0.1, 4).zoom).toBe(0.1);
  });

  it('a non-finite anchor or degenerate zoom yields a finite camera (fail-safe: set zoom, keep pan)', () => {
    const cam = { panX: 30, panY: 40, zoom: 2 };
    const bad = zoomAroundPoint(cam, { x: NaN, y: 10 }, 3);
    expect(bad).toEqual({ zoom: 3, panX: 30, panY: 40 });
    const degenerate = zoomAroundPoint({ panX: 30, panY: 40, zoom: 0 }, { x: 10, y: 10 }, 3);
    expect(Number.isFinite(degenerate.panX)).toBe(true);
    expect(degenerate).toEqual({ zoom: 3, panX: 30, panY: 40 });
  });
});

describe('zoomAroundCenter', () => {
  it('keeps the world point under the viewport centre fixed while changing zoom', () => {
    const cam = { panX: 123, panY: -45, zoom: 2.5 };
    const worldBefore = { x: (VIEW.w / 2 - cam.panX) / cam.zoom, y: (VIEW.h / 2 - cam.panY) / cam.zoom };
    const reset = zoomAroundCenter(cam, VIEW, 1);
    expect(reset.zoom).toBe(1);
    // the world point under the centre is unchanged → it still maps to the centre.
    const screen = toScreen(reset, worldBefore.x, worldBefore.y);
    expect(screen.x).toBeCloseTo(VIEW.w / 2, 5);
    expect(screen.y).toBeCloseTo(VIEW.h / 2, 5);
  });

  it('is EXACTLY zoomAroundPoint at the viewport centre (single SSOT, no drift)', () => {
    const cam = { panX: 88, panY: -12, zoom: 1.7 };
    const viaCenter = zoomAroundCenter(cam, VIEW, 3, 0.1, 6);
    const viaPoint = zoomAroundPoint(cam, { x: VIEW.w / 2, y: VIEW.h / 2 }, 3, 0.1, 6);
    expect(viaCenter).toEqual(viaPoint);
  });
});
