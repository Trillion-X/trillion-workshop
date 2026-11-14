// Proof for fit-a-container-to-its-contents: fitRectToContents wraps the child bounding box (via the shared
// selectionBounds SSOT) with padding + a top header inset, leaves an empty frame untouched, unions with the
// current rect in growOnly mode (never shrinks), and needsGrow flags only when an expansion is required.
import { describe, expect, it } from 'vitest';
import { fitRectToContents, needsGrow, type FitRect } from './fit-to-contents';

const R = (x: number, y: number, w: number, h: number): FitRect => ({ x, y, w, h });

describe('fit-to-contents — fitRectToContents', () => {
  it('wraps the child bounding box with uniform padding (exact fit)', () => {
    const section = R(0, 0, 500, 500);
    const kids = [R(100, 100, 40, 40), R(300, 200, 60, 60)]; // bbox x100..360, y100..260
    expect(fitRectToContents(section, kids, { padding: 10 })).toEqual({ x: 90, y: 90, w: 280, h: 180 });
  });

  it('reserves extra space at the TOP for the section header', () => {
    const kids = [R(100, 100, 40, 40)];
    const fit = fitRectToContents(R(0, 0, 200, 200), kids, { padding: 10, headerHeight: 30 });
    expect(fit).toEqual({ x: 90, y: 60, w: 60, h: 90 }); // top pushed up by padding+header (40+2*10+30)
  });

  it('leaves an EMPTY frame unchanged (never collapses to a point)', () => {
    const section = R(20, 20, 300, 200);
    expect(fitRectToContents(section, [])).toEqual(section);
    expect(needsGrow(section, [])).toBe(false);
  });

  it('exact fit can SHRINK a frame that is far larger than its contents', () => {
    const big = R(0, 0, 1000, 1000);
    const kids = [R(400, 400, 50, 50)];
    const fit = fitRectToContents(big, kids, { padding: 20 });
    expect(fit.w).toBeLessThan(big.w);
    expect(fit.h).toBeLessThan(big.h);
  });

  it('growOnly UNIONS with the current rect — expands to swallow an out-of-bounds child, never shrinks', () => {
    const section = R(0, 0, 300, 300);
    const escaped = [R(400, 50, 40, 40)]; // sits to the RIGHT of the section (x 400..440)
    const grown = fitRectToContents(section, escaped, { padding: 10, growOnly: true });
    expect(grown.x).toBe(0); // left edge unchanged (union keeps the smaller-left)
    expect(grown.y).toBe(0);
    expect(grown.x + grown.w).toBe(450); // right edge extended to child right + padding
    expect(grown.h).toBe(300); // vertical unchanged (child already within)
  });

  it('growOnly is a no-op when the frame already contains its children', () => {
    const section = R(0, 0, 300, 300);
    const inside = [R(100, 100, 40, 40)];
    expect(fitRectToContents(section, inside, { padding: 10, growOnly: true })).toEqual(section);
    expect(needsGrow(section, inside, { padding: 10 })).toBe(false);
  });

  it('needsGrow is true when a child pokes outside the current frame', () => {
    expect(needsGrow(R(0, 0, 300, 300), [R(400, 50, 40, 40)], { padding: 10 })).toBe(true);
  });
});
