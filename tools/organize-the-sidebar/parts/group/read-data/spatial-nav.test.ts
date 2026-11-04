// Proof for directional spatial navigation: nearestInDirection picks the node ahead in a direction, with a
// perpendicular penalty so aligned nodes win, excludes the origin node, ignores nodes behind, supports a
// point origin (keyboard entry from the viewport centre), and handles the empty / no-candidate cases.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { nearestInDirection, type NavRect } from '../../../read-data/spatial-nav.ts';

// A plus layout around a centre node C (all boxes 40x40, centres at the named points).
const C: NavRect = { id: 'C', x: 100, y: 100, w: 40, h: 40 }; // centre (120,120)
const R: NavRect = { id: 'R', x: 300, y: 100, w: 40, h: 40 }; // right  (320,120)
const L: NavRect = { id: 'L', x: -100, y: 100, w: 40, h: 40 }; // left  (-80,120)
const U: NavRect = { id: 'U', x: 100, y: -100, w: 40, h: 40 }; // up     (120,-80)
const D: NavRect = { id: 'D', x: 100, y: 300, w: 40, h: 40 }; // down   (120,320)
const ALL = [C, R, L, U, D];

describe('spatial-nav — directional node navigation (keyboard a11y primitive)', () => {
  it('from a node id, each arrow selects the neighbour in that direction (origin excluded)', () => {
    expect(nearestInDirection(ALL, 'right', 'C')).toBe('R');
    expect(nearestInDirection(ALL, 'left', 'C')).toBe('L');
    expect(nearestInDirection(ALL, 'up', 'C')).toBe('U');
    expect(nearestInDirection(ALL, 'down', 'C')).toBe('D');
  });

  it('a node BEHIND the origin is never chosen (only nodes strictly ahead)', () => {
    // from the right node, going right, nothing is ahead → null (C/L/U/D are all behind or off-axis-behind)
    expect(nearestInDirection(ALL, 'right', 'R')).toBeNull();
    // from the right node, going left, C is the nearest ahead
    expect(nearestInDirection(ALL, 'left', 'R')).toBe('C');
  });

  it('the perpendicular penalty prefers a well-aligned node over a nearer off-axis one', () => {
    const origin: NavRect = { id: 'O', x: 0, y: 0, w: 0, h: 0 }; // centre (0,0)
    const aligned: NavRect = { id: 'aligned', x: 200, y: 0, w: 0, h: 0 }; // dead right, 200 away → score 200
    const offAxis: NavRect = { id: 'off', x: 120, y: 90, w: 0, h: 0 };    // nearer (along 120) but 90 off → 120+180=300
    expect(nearestInDirection([origin, aligned, offAxis], 'right', 'O')).toBe('aligned');
  });

  it('a WORLD POINT origin (keyboard entry from the viewport centre) navigates without excluding anything', () => {
    // from a point just left of C, going right, C (120,120) is the nearest ahead
    expect(nearestInDirection(ALL, 'right', { x: 0, y: 120 })).toBe('C');
  });

  it('with NO origin, an arrow ENTERS from the trailing edge (Right → left-most, Down → top-most)', () => {
    expect(nearestInDirection(ALL, 'right')).toBe('L'); // left-most node
    expect(nearestInDirection(ALL, 'down')).toBe('U');  // top-most node
  });

  it('empty board or nothing ahead → null', () => {
    expect(nearestInDirection([], 'right', 'C')).toBeNull();
    expect(nearestInDirection([C], 'right', 'C')).toBeNull(); // only the origin exists
  });
});
