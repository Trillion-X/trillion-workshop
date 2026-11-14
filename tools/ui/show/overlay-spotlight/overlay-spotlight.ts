// packages/ui/show/overlay-spotlight/overlay-spotlight.ts
//
// PURPOSE
// The occluder geometry (engine mechanism M1) for the guided-overlay walkthrough:
// a full-viewport scrim with N "cutout" holes punched at the step's target rects,
// plus the click-through policy. This module is the PURE, testable core; the
// React `OverlaySpotlight` component renders an SVG mask from it.
//
// FIRST-PRINCIPLES
//   - `cutout.shapes[].shape` is OPEN DATA dispatched through the shared
//     `blind-registry` (rounded-rect | circle | <future blob>): a new cutout
//     shape = one `register()` + zero change. The padding/radius are DATA.
//   - The click-through policy is DATA (a content kind's policy string), mapped to
//     two physical behaviours: block every click, or let ONLY the cutouts through.

import { createBlindRegistry } from '../blind-registry/blind-registry';
import type { Rect } from '../anchor-resolver/anchor-resolver';

/** A cutout descriptor as it appears in step DATA. `shape` is an open key. */
export interface CutoutDescriptor {
  readonly shape?: string;
  /** px of breathing room added around the target on every side (DATA, default 8). */
  readonly padding?: number;
  /** corner radius for rounded shapes (DATA, default 8). */
  readonly radius?: number;
}

/** An SVG-ready rounded rect (a circle is a rounded rect with rx=ry=half-min-side). */
export interface CutoutGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx: number;
  readonly ry: number;
}

/** Turn a target rect + descriptor into cutout geometry. Pure. */
export type CutoutShapeFn = (target: Rect, descriptor: CutoutDescriptor) => CutoutGeometry;

function pad(target: Rect, padding: number): Rect {
  return {
    x: target.x - padding,
    y: target.y - padding,
    width: target.width + padding * 2,
    height: target.height + padding * 2,
  };
}

/** Rounded-rect cutout — the default. `padding` insets the scrim, `radius` rounds it. */
export const roundedRectCutout: CutoutShapeFn = (target, d) => {
  const r = pad(target, d.padding ?? 8);
  const radius = Math.min(d.radius ?? 8, r.width / 2, r.height / 2);
  return { x: r.x, y: r.y, width: r.width, height: r.height, rx: radius, ry: radius };
};

/** Circle/pill cutout — rx=ry=half the smaller side of the padded rect. */
export const circleCutout: CutoutShapeFn = (target, d) => {
  const r = pad(target, d.padding ?? 8);
  const radius = Math.min(r.width, r.height) / 2;
  return { x: r.x, y: r.y, width: r.width, height: r.height, rx: radius, ry: radius };
};

/** Create a shape registry pre-seeded with rounded-rect (also the fallback) + circle. */
export function createCutoutShapeRegistry() {
  const reg = createBlindRegistry<CutoutShapeFn>({ fallback: roundedRectCutout });
  reg.register('rounded-rect', roundedRectCutout);
  reg.register('circle', circleCutout);
  return reg;
}

/**
 * Compute cutout geometry for each (target, descriptor) pair. Targets and shapes
 * are zipped by index; a missing descriptor defaults to a rounded-rect. Blind to
 * shape — dispatch is a registry lookup.
 */
export function computeCutouts(
  targets: readonly Rect[],
  descriptors: readonly CutoutDescriptor[] = [],
  registry = createCutoutShapeRegistry(),
): CutoutGeometry[] {
  return targets.map((target, i) => {
    const d = descriptors[i] ?? descriptors[0] ?? {};
    return registry.resolve(d.shape ?? 'rounded-rect')(target, d);
  });
}

/** Three physical click behaviours — closed by Physics (a hole is live or it isn't; a scrim nobody can see catches nothing). */
export type PointerPolicy = 'block-all' | 'cutouts-interactive' | 'pass-all';

/**
 * A scrim with no colour and no blur is not there for the eye, so it is not there for the hand either: the whole page
 * stays usable (a live showcase step that leaves the workspace clear while the tour moves it).
 */
export function scrimIsInvisible(scrimColor: string, blurPx: number): boolean {
  if (blurPx > 0) return false;
  const color = scrimColor.replace(/\s+/g, '').toLowerCase();
  if (color === 'transparent') return true;
  const alpha = /^rgba?\((?:[^,]+,){3}([0-9.]+)\)$/.exec(color)?.[1] ?? /^hsla?\((?:[^,]+,){3}([0-9.]+)\)$/.exec(color)?.[1];
  return alpha !== undefined && Number(alpha) === 0;
}

/**
 * Map a tour's open DATA click behaviour to the three physical pointer policies.
 * The short public words are `all` (the whole page stays usable), `target` (only
 * spotlight holes stay usable), and `none` (the page is read-only). The physical
 * names and the older `interactive-gate` name remain accepted so saved tours keep
 * behaving the same after this becomes configurable. Unknown input is safe by
 * default: it cannot silently make the page interactive.
 */
export function pointerPolicy(policy: string | undefined): PointerPolicy {
  if (policy === 'all' || policy === 'pass-all' || policy === 'page-interactive') return 'pass-all';
  if (policy === 'target' || policy === 'interactive-gate' || policy === 'cutouts-interactive') return 'cutouts-interactive';
  return 'block-all';
}

/** Build the SVG path that punches the cutouts out of a full-viewport scrim rect. */
export function scrimMaskPath(viewport: { width: number; height: number }, cutouts: readonly CutoutGeometry[]): {
  readonly outer: string;
  readonly holes: readonly CutoutGeometry[];
} {
  // The outer covers the whole viewport (white = opaque scrim); holes (black) reveal.
  return { outer: `M0 0 H${viewport.width} V${viewport.height} H0 Z`, holes: cutouts };
}

/** One rounded-rect cutout as a closed SVG subpath (clamped radii). */
export function cutoutSubpath(c: CutoutGeometry): string {
  const rx = Math.min(c.rx, c.width / 2);
  const ry = Math.min(c.ry, c.height / 2);
  const { x, y, width: w, height: h } = c;
  return (
    `M${x + rx} ${y} H${x + w - rx} A${rx} ${ry} 0 0 1 ${x + w} ${y + ry} ` +
    `V${y + h - ry} A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H${x + rx} ` +
    `A${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V${y + ry} A${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
  );
}

/**
 * The single `d` for a full-viewport scrim with the cutouts punched out, rendered
 * with `fill-rule: evenodd`. The holes are literally excluded from the fill, so a
 * `pointer-events: auto` path catches clicks ONLY on the dark area — clicks inside
 * a hole pass through to the real control beneath (deterministic hit-testing that
 * does NOT depend on browser mask-hit behaviour). Pure.
 */
export function scrimPathD(viewport: { width: number; height: number }, cutouts: readonly CutoutGeometry[]): string {
  const outer = `M0 0 H${viewport.width} V${viewport.height} H0 Z`;
  return [outer, ...cutouts.map(cutoutSubpath)].join(' ');
}
