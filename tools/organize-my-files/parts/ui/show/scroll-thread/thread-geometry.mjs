// parts/ui/show/scroll-thread/thread-geometry.mjs
//
// Purpose: the red thread's drawing, the one copy of it: the hand-drawn ball of loops and the smooth curve through
// points that gettrillion.ai's scroll thread (./ScrollThread.tsx) and the opening cover (../thread-cover) both draw.
//
// Non-negotiable invariants:
// - Each function is whole in itself (it reads nothing outside its own body and arguments), so the opening cover can
//   carry them into the page's first bytes as text (Function.prototype.toString) and draw before any script file
//   arrives. Never make one call another or read a module value.
// - The same seed gives the same ball; nothing here reads the clock or Math.random.

/** A small deterministic random source, so a tangle looks hand-drawn but never changes between loads.
 *  @param {number} seed @returns {() => number} */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Loops around a centre that start and end near it: a ball of thread. The bigger the ball, the more loops.
 *  @param {{x:number,y:number}} center @param {number} radius @param {() => number} next @returns {{x:number,y:number}[]} */
export function tangle(center, radius, next) {
  const points = [];
  let angle = next() * Math.PI * 2;
  const turns = Math.max(16, Math.round(radius / 2.6));
  for (let index = 0; index < turns; index += 1) {
    angle += 1.1 + next() * 1.4;
    const reach = radius * (0.45 + next() * 0.55);
    points.push({ x: center.x + Math.cos(angle) * reach, y: center.y + Math.sin(angle) * reach * 0.86 });
  }
  points.push(center);
  return points;
}

/** A smooth curve through every point (Catmull-Rom, written as cubic Beziers), as path segments after the first point.
 *  From each point index in `lifted` the line jumps to the next point without drawing; the curve either side stays smooth.
 *  @param {{x:number,y:number}[]} points @param {ReadonlySet<number>} lifted @returns {string[]} */
export function curve(points, lifted) {
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p1 = points[index];
    const p2 = points[index + 1];
    if (lifted.has(index)) {
      segments.push(`M ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
      continue;
    }
    const p0 = lifted.has(index - 1) ? p1 : points[index - 1] ?? p1;
    const p3 = lifted.has(index + 1) ? p2 : points[index + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    segments.push(`C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
  }
  return segments;
}

/** Where the line stops. `items` are the anchors in drawing order, each `{ end: boolean }` (true when the page marked
 *  that element as the end of the line). The last item marked as the end is the line's last point and nothing after it is
 *  drawn; with none marked, every item stays and the last one is the end.
 *  @template {{ end: boolean }} T @param {T[]} items @returns {T[]} */
export function stopAtEnd(items) {
  let last = -1;
  items.forEach((item, index) => { if (item.end) last = index; });
  return last < 0 ? items : items.slice(0, last + 1);
}

/** Keeps a curve (the segments `curve` returns) from going below `floor`. A cubic Bezier stays inside its control
 *  points, so no control point is allowed lower than the floor and the curve cannot reach below it either. A long
 *  approach from far above would otherwise sag past the line's end. Not part of the opening cover's copy of `curve`.
 *  @param {string[]} segments @param {number} floor @returns {string[]} */
export function capSegments(segments, floor) {
  return segments.map((segment) => {
    if (!segment.startsWith('C')) return segment;
    const numbers = segment.slice(2).split(' ').map(Number);
    numbers[1] = Math.min(numbers[1], floor);
    numbers[3] = Math.min(numbers[3], floor);
    return `C ${numbers.map((value) => value.toFixed(1)).join(' ')}`;
  });
}
