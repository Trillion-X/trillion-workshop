// packages/group/do-work/median-cut-palette.ts
//
// MEDIAN-CUT COLOUR PALETTE — the generative primitive behind "pull the palette out of this image" (the
// canonical Photoshop/GIF colour-quantisation algorithm). Given the pixels of an image it returns the N most
// representative colours: start with one box holding every pixel, then repeatedly split the box with the
// widest colour spread along its widest channel at the median, until N boxes remain — each box's average is
// one palette colour. Unlike a fixed curated theme (board-palettes' Sunset/Ocean), this is DERIVED from the
// actual image, so a mood board can recolour its notes to match its hero photo (feed the result straight to
// `batch-actions.recolorSelectionToPalette`, whose `BoardPalette` is exactly a colour string[]).
//
// Pure leaf: zero I/O, zero DOM, deterministic (a stable sort + integer averages — no Date/random). It NEVER
// fabricates colours: an image with fewer distinct colours than `count` returns only as many as truly exist
// (a solid-colour image → one colour), because a box that can't be split is never split.

export interface RGB {
  r: number;
  g: number;
  b: number;
}

type Channel = 'r' | 'g' | 'b';

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => clampByte(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** The channel with the widest min→max spread in a box, and that spread. Ties resolve r > g > b (stable). */
function widestChannel(box: readonly RGB[]): { channel: Channel; range: number } {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
  for (const p of box) {
    if (p.r < rmin) rmin = p.r;
    if (p.r > rmax) rmax = p.r;
    if (p.g < gmin) gmin = p.g;
    if (p.g > gmax) gmax = p.g;
    if (p.b < bmin) bmin = p.b;
    if (p.b > bmax) bmax = p.b;
  }
  const rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
  if (rr >= gr && rr >= br) return { channel: 'r', range: rr };
  if (gr >= br) return { channel: 'g', range: gr };
  return { channel: 'b', range: br };
}

function averageHex(box: readonly RGB[]): string {
  let r = 0, g = 0, b = 0;
  for (const p of box) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  const n = box.length;
  return rgbToHex(r / n, g / n, b / n);
}

/**
 * The `count` most representative colours (hex) of `pixels`, ordered by population (most dominant first).
 * `count <= 0` or no pixels → `[]`. Returns fewer than `count` when the image has fewer distinct colours
 * (a box with zero spread is never split) — it never invents a colour that isn't in the image.
 */
export function medianCutPalette(pixels: readonly RGB[], count: number): string[] {
  if (count <= 0 || pixels.length === 0) return [];
  let boxes: RGB[][] = [pixels.slice()];
  while (boxes.length < count) {
    // Split the box with the widest single-channel spread (the classic median-cut choice).
    let target = -1;
    let bestRange = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].length < 2) continue;
      const { range } = widestChannel(boxes[i]);
      if (range > bestRange) {
        bestRange = range;
        target = i;
      }
    }
    if (target < 0) break; // every box is a singleton or uniform → nothing left to split (don't fabricate)
    const box = boxes[target];
    const { channel } = widestChannel(box);
    box.sort((a, b) => a[channel] - b[channel]);
    const mid = box.length >> 1;
    boxes.splice(target, 1, box.slice(0, mid), box.slice(mid));
  }
  boxes.sort((a, b) => b.length - a.length); // most-populous colour first
  return boxes.map(averageHex);
}

/**
 * Sample RGB pixels out of a canvas `ImageData.data` (flat RGBA bytes), skipping (near-)transparent pixels and
 * taking every `step`-th pixel to keep median-cut fast on a large image. `step` is in pixels (default 4).
 */
export function pixelsFromImageData(data: Uint8ClampedArray | readonly number[], step = 4): RGB[] {
  const stride = 4 * Math.max(1, Math.floor(step));
  const out: RGB[] = [];
  for (let i = 0; i + 3 < data.length; i += stride) {
    if (data[i + 3] < 128) continue; // skip (near-)transparent pixels — they aren't part of the image's colour
    out.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  }
  return out;
}
