// packages/ui/show/visual-layer-stack/compose-text-style.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Project a visual-layer STACK (the SAME infinite paint primitive that fills a
// card region) onto a TEXT RUN. A region paints by stacking <div> layers; a text
// run cannot — so we collect each layer's TARGET-NEUTRAL CSS paint
// (`capability.resolveCssPaint`) into a single comma-stacked `background-image`
// and clip it to the glyph outlines via `background-clip: text`. Gradient, mesh,
// solid colour, grain, tint — every CSS-expressible fill becomes the FILL OF THE
// LETTERS for free, and operators (edge clip / transform / filter via
// `resolveStyle`) apply to the run box. Applied to a one-character selection it
// paints a single letter.
//
// =============================================================================
// WHY THIS IS GENERIC (L063 / L069 / L090)
// =============================================================================
//
// This composer NEVER branches on a capabilityId (`if (cap === 'gradient')`). It
// asks each capability for its CSS via the injected map and normalises the
// returned CSS by KEY NAME (the Physics of CSS: background-image stacks, others
// merge). Adding a new fill (a shader, a noise field, a future "foil") that
// implements `resolveCssPaint` paints text with ZERO change here. A capability
// that cannot be CSS (video/canvas) simply returns nothing and contributes
// nothing — honest opt-out, no per-kind code.
//
// The SAME `composeStackTextStyle` output is what persists as the inline-style
// projection on a paint span, while the structured stack persists as the span's
// `data-visual-layer-stack` JSON (re-editable source of truth). One stack model,
// two targets (region + text), one composer.
// =============================================================================

import type * as React from 'react';
import type { VisualLayerCapabilityMap } from './visual-layer-registry';
import type {
  CapabilityInvocation,
  VisualLayerDescriptor,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

/** Background-affecting CSS keys — these feed the clipped text background stack. */
const BACKGROUND_KEYS = new Set(['background', 'backgroundImage', 'backgroundColor']);

/** CSS substrate facts: these properties CONCATENATE across operators (Physics). */
const MULTI_VALUE_KEYS = new Set(['transform', 'filter', 'WebkitTextStroke']);

/** Enabled layers in paint order (lowest z first = bottom of the stack). */
function orderedLayers(layers: readonly VisualLayerDescriptor[]): VisualLayerDescriptor[] {
  return layers
    .filter((l) => l.enabled !== false)
    .map((layer, index) => ({ layer, z: layer.order?.z ?? index, index }))
    .sort((a, b) => a.z - b.z || a.index - b.index)
    .map((e) => e.layer);
}

/** Normalise one paint's background-ish CSS into a background-image token (so a
 *  flat colour participates in the glyph-clipped stack just like a gradient). A
 *  plain colour becomes a `linear-gradient(c, c)` (the standard CSS idiom for a
 *  solid as a background-image). Returns null when this paint has no background. */
function backgroundImageToken(css: Record<string, unknown>): string | null {
  const direct = css.backgroundImage;
  if (typeof direct === 'string' && direct && direct !== 'none') return direct;
  const shorthand = css.background;
  if (typeof shorthand === 'string' && shorthand && shorthand !== 'transparent') {
    // A shorthand that already names an image/gradient is used verbatim; a bare
    // colour is wrapped so it can be clipped to text like any other background.
    return /gradient|url\(|image/.test(shorthand) ? shorthand : `linear-gradient(${shorthand}, ${shorthand})`;
  }
  const color = css.backgroundColor;
  if (typeof color === 'string' && color && color !== 'transparent') {
    return `linear-gradient(${color}, ${color})`;
  }
  return null;
}

/** Merge an operator/effect CSS fragment, concatenating multi-value properties. */
function mergeFragment(out: Record<string, unknown>, frag: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(frag)) {
    if (value == null) continue;
    if (BACKGROUND_KEYS.has(key)) continue; // backgrounds handled by the stack
    if (MULTI_VALUE_KEYS.has(key) && typeof out[key] === 'string') {
      out[key] = `${out[key] as string} ${value as string}`;
    } else {
      out[key] = value;
    }
  }
}

/**
 * Compose a text-run CSS style from a visual-layer stack + optional silhouette
 * clip, using the injected capability map. Returns `{}` when nothing paints.
 *
 * Order of the background stack: HIGHEST z is listed FIRST (CSS paints the first
 * background-image on top), matching the region renderer's z-stacking.
 */
export function composeStackTextStyle(
  layers: readonly VisualLayerDescriptor[],
  clip: CapabilityInvocation | undefined,
  map: VisualLayerCapabilityMap,
): React.CSSProperties {
  const ordered = orderedLayers(layers);
  const out: Record<string, unknown> = {};
  const backgroundTokens: string[] = [];

  // Bottom-to-top so we can unshift to get top-first background-image order.
  for (const layer of ordered) {
    const cap = layer.paint?.capability ? map.get(layer.paint.capability) : null;
    if (!cap) continue;
    const input = layer.paint?.input ?? {};
    // Body paint as CSS (background → glyph fill; effects merge onto the run).
    const paint = cap.resolveCssPaint?.({ input, regionElement: null });
    if (paint) {
      const token = backgroundImageToken(paint as Record<string, unknown>);
      if (token) backgroundTokens.unshift(token);
      mergeFragment(out, paint as Record<string, unknown>);
    }
    // Per-layer geometry/style operator (e.g. this layer's own edge clip).
    const layerClip = layer.frame?.clip;
    if (layerClip?.capability) {
      const op = map.get(layerClip.capability)?.resolveStyle?.({ input: layerClip.input ?? {}, regionElement: null });
      if (op) mergeFragment(out, op as Record<string, unknown>);
    }
  }

  // Whole-run silhouette operator (the card-level "Edge" applied to the text box).
  if (clip?.capability) {
    const op = map.get(clip.capability)?.resolveStyle?.({ input: clip.input ?? {}, regionElement: null });
    if (op) mergeFragment(out, op as Record<string, unknown>);
  }

  if (backgroundTokens.length > 0) {
    out.backgroundImage = backgroundTokens.join(', ');
    // Clip the painted background to the glyph outlines — the letters BECOME the
    // gradient/mesh/colour. `color: transparent` reveals the clipped fill.
    out.WebkitBackgroundClip = 'text';
    out.backgroundClip = 'text';
    out.color = 'transparent';
  }

  return out as React.CSSProperties;
}
