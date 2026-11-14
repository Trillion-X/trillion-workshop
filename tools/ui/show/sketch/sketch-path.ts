// parts/ui/show/sketch/sketch-path.ts
//
// Purpose: the hand-drawn outlines the sketch parts share. A rounded rectangle whose sides wobble a
// little, drawn in a 0..100 box and stretched to its element (the SVG uses preserveAspectRatio="none"
// with a non-scaling stroke, so the line keeps its thickness at any size). The wobble comes from a
// seed, so an outline looks drawn by hand but is the same on every load.

function random(seed: number) {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}

/** A wobbly rounded rectangle in a 0..100 box. `wobble` is how far a corner or edge may drift. */
export function sketchRectangle(seed: number, wobble = 1.2, radius = 6): string {
  const jitter = random(seed);
  const j = () => jitter() * wobble;
  const r = radius;
  const top = `M ${r + j()} ${1 + j()} C ${35 + j()} ${0.4 + j()} ${65 + j()} ${1.6 + j()} ${100 - r + j()} ${1 + j()}`;
  const right = `Q ${99 + j()} ${1 + j()} ${99 + j()} ${r + j()} C ${99.6 + j()} ${35 + j()} ${98.6 + j()} ${65 + j()} ${99 + j()} ${100 - r + j()}`;
  const bottom = `Q ${99 + j()} ${99 + j()} ${100 - r + j()} ${99 + j()} C ${65 + j()} ${99.6 + j()} ${35 + j()} ${98.5 + j()} ${r + j()} ${99 + j()}`;
  const left = `Q ${1 + j()} ${99 + j()} ${1 + j()} ${100 - r + j()} C ${0.4 + j()} ${65 + j()} ${1.5 + j()} ${35 + j()} ${1 + j()} ${r + j()} Q ${1 + j()} ${1 + j()} ${r + 1 + j()} ${1.4 + j()}`;
  return `${top} ${right} ${bottom} ${left}`;
}

/** A red brush stroke filling a 0..100 box: slightly ragged top and bottom edges and rounded,
 *  frayed ends, the way a loaded brush leaves paint. Used as the fill behind doodled buttons. */
export function sketchBrush(seed: number): string {
  const jitter = random(seed);
  const top: string[] = [];
  const bottom: string[] = [];
  for (let x = 8; x <= 92; x += 4) {
    top.push(`${(x + jitter() * 1.5).toFixed(1)} ${(8 + jitter() * 5).toFixed(1)}`);
    bottom.unshift(`${(x + jitter() * 1.5).toFixed(1)} ${(92 + jitter() * 5).toFixed(1)}`);
  }
  // Each end is a rounded cap: points round a half circle, each nudged a little so the edge frays.
  const cap = (centre: number, from: number) => Array.from({ length: 7 }, (_, index) => {
    const angle = from + (index / 6) * Math.PI;
    return `${(centre + Math.cos(angle) * (7 + jitter() * 2.5)).toFixed(1)} ${(50 + Math.sin(angle) * (41 + jitter() * 4)).toFixed(1)}`;
  });
  return `M ${[...top, ...cap(92, -Math.PI / 2), ...bottom, ...cap(8, Math.PI / 2)].join(' L ')} Z`;
}

/** Thin dry-brush streaks near the top and bottom of a brush stroke, where the paint ran thin. */
export function sketchBrushStreaks(seed: number): string {
  const jitter = random(seed);
  return [16, 84].map((edge) => {
    const y = edge + jitter() * 4;
    const start = 14 + Math.abs(jitter()) * 30;
    const end = start + 20 + Math.abs(jitter()) * 30;
    const third = (end - start) / 3;
    return `M ${start.toFixed(1)} ${y.toFixed(1)} C ${(start + third).toFixed(1)} ${(y + jitter() * 2).toFixed(1)} ${(end - third).toFixed(1)} ${(y + jitter() * 2).toFixed(1)} ${end.toFixed(1)} ${(y + jitter() * 2).toFixed(1)}`;
  }).join(' ');
}

/** A loose pen loop around a 0..100 box that overshoots where it starts, so its two ends cross. */
export function sketchLoop(seed: number): string {
  const jitter = random(seed);
  const j = (size: number) => jitter() * size;
  return [
    `M ${-2 + j(4)} ${30 + j(8)}`,
    `C ${2 + j(3)} ${4 + j(4)} ${40 + j(5)} ${-4 + j(3)} ${80 + j(5)} ${-1 + j(3)}`,
    `C ${104 + j(3)} ${2 + j(4)} ${105 + j(3)} ${80 + j(6)} ${92 + j(4)} ${101 + j(3)}`,
    `C ${60 + j(5)} ${107 + j(3)} ${10 + j(5)} ${104 + j(3)} ${-1 + j(3)} ${80 + j(6)}`,
    `C ${-5 + j(3)} ${55 + j(6)} ${2 + j(4)} ${14 + j(5)} ${24 + j(5)} ${3 + j(3)}`,
  ].join(' ');
}
