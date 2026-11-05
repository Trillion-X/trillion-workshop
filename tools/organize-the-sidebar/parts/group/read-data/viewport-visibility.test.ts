// Proof for minimal scroll-into-view: panToReveal keeps a node on-screen after a programmatic selection,
// panning as little as possible (unchanged when already visible), never touching zoom.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { panToReveal, isBoxVisible, type Camera, type Viewport } from '../../../read-data/viewport-visibility.ts';

const VIEW: Viewport = { w: 800, h: 600 };
const CAM: Camera = { panX: 0, panY: 0, zoom: 1 }; // world (0,0) at screen (0,0)

describe('viewport-visibility — minimal scroll-into-view', () => {
  it('a node already fully inside the viewport does NOT move the camera', () => {
    const box = { x: 100, y: 100, w: 120, h: 80 }; // screen 100..220 / 100..180, well inside
    expect(panToReveal(CAM, VIEW, box)).toEqual({ panX: 0, panY: 0 });
    expect(isBoxVisible(CAM, VIEW, box)).toBe(true);
  });

  it('a node off the RIGHT edge pans left just enough to reveal it (with margin)', () => {
    const box = { x: 900, y: 100, w: 100, h: 80 }; // screen right = 1000, viewport 800, margin 24
    const p = panToReveal(CAM, VIEW, box, 24);
    // right edge (1000) must land on 800-24=776 → panX shifts by 776-1000 = -224
    expect(p.panX).toBe(-224);
    expect(p.panY).toBe(0); // vertically already visible
    expect(isBoxVisible({ ...CAM, ...p }, VIEW, box)).toBe(true);
  });

  it('a node off the LEFT / TOP edge pans to bring its near edge to the margin', () => {
    const box = { x: -200, y: -100, w: 60, h: 60 };
    const p = panToReveal(CAM, VIEW, box, 24);
    // left edge (-200) → margin 24: panX += 224; top (-100) → 24: panY += 124
    expect(p).toEqual({ panX: 224, panY: 124 });
    expect(isBoxVisible({ ...CAM, ...p }, VIEW, box)).toBe(true);
  });

  it('respects zoom in the projection (a zoomed-out board still reveals correctly)', () => {
    const cam: Camera = { panX: 0, panY: 0, zoom: 0.5 };
    const box = { x: 2000, y: 0, w: 100, h: 100 }; // screen left = 1000 at zoom .5, off-screen right
    const p = panToReveal(cam, VIEW, box, 24);
    // right screen = (2000+100)*.5 = 1050 → far 776 → shift -274
    expect(p.panX).toBe(-274);
    expect(isBoxVisible({ ...cam, ...p }, VIEW, box)).toBe(true);
  });

  it('only the off-screen axis moves (a node off-right but vertically fine keeps panY)', () => {
    const box = { x: 1000, y: 250, w: 80, h: 80 };
    const p = panToReveal(CAM, VIEW, box);
    expect(p.panX).not.toBe(0);
    expect(p.panY).toBe(0);
  });
});
