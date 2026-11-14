// packages/ui/show/visual-layer-stack/VisualLayerStack.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The generative primitive's renderer: composite an ordered stack of visual
// layers into a region's coordinate frame. This is pure Physics — it knows
// NOTHING about image/video/gradient/dot-grid/shader. It sorts layers by order,
// asks the injected capability map to paint each one, and applies universal CSS
// compositing (opacity, blend, z-order, pointer-events). Each capability renders
// its own element kind (Pattern 103). Unknown capability → ONE generic fallback
// node, never a per-kind branch.
//
// "Background" is not a concept here. A background is simply a layer with lower
// order; content is the layer the owner places at content-order; a watermark is
// a layer with higher order. The renderer treats them identically.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. ZERO Society vocabulary. No `if (kind === 'image')`, no capability names.
// 2. Layers are inert (pointer-events:none) unless a layer opts in.
// 3. Recursion via renderChildren — nested stacks use this same renderer.
// 4. No magic constants in business logic — opacity/blend/z are descriptor DATA.
// =============================================================================

'use client';

import React from 'react';
import type {
  VisualLayerCapabilityMap,
  VisualLayerRenderContext,
} from './visual-layer-registry';
import type {
  AddressRef,
  CapabilityInvocation,
  VisualLayerDescriptor,
  VisualLayerStackRecord,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

/**
 * Merge opaque CSS fragments (from data-selected geometry/style operators) onto a
 * base wrapper style. The renderer never inspects fragment keys (L090) — EXCEPT
 * `transform`/`filter`, which are the CSS substrate's multi-value properties
 * (Physics, like `object-fit`): multiple operators concatenate instead of
 * overwriting so a clip + a skew + a blur all coexist.
 */
function mergeStyleFragments(
  base: React.CSSProperties,
  fragments: readonly React.CSSProperties[],
): React.CSSProperties {
  const out: Record<string, unknown> = { ...base };
  for (const frag of fragments) {
    for (const [key, value] of Object.entries(frag)) {
      if (value == null) continue;
      if ((key === 'transform' || key === 'filter') && typeof out[key] === 'string') {
        out[key] = `${out[key] as string} ${value as string}`;
      } else {
        out[key] = value;
      }
    }
  }
  return out as React.CSSProperties;
}

/** Resolve one geometry/style operator invocation to its CSS fragment (or {}). */
function resolveStyleOp(
  map: VisualLayerCapabilityMap,
  invocation: CapabilityInvocation | undefined,
  regionElement: HTMLElement | null,
): React.CSSProperties {
  if (!invocation || !invocation.capability) return {};
  const capability = map.get(invocation.capability);
  return capability?.resolveStyle?.({ input: invocation.input ?? {}, regionElement }) ?? {};
}

export interface VisualLayerStackProps {
  /** A full stack record, OR pass `layers` + `region` directly. */
  readonly record?: VisualLayerStackRecord;
  readonly layers?: readonly VisualLayerDescriptor[];
  readonly region?: AddressRef;
  /** Owner-provided dispatch map. The renderer holds no built-in capabilities. */
  readonly map: VisualLayerCapabilityMap;
  /** Camera for parallax-bound layers. */
  readonly camera?: { readonly panX: number; readonly panY: number; readonly zoom: number };
  /** Resolve an addressed subject to whatever a capability expects (URL, handle…). */
  readonly resolveSubject?: (ref: AddressRef) => unknown;
  /** Whole-surface silhouette operator applied to the stack ROOT (clips every
   *  layer + content to the card's edge). Overrides `record.clip` when both set. */
  readonly clip?: CapabilityInvocation;
  readonly className?: string;
}

const NO_SUBJECT = (): unknown => null;

/** Effective z for ordering: explicit z, else neighbour-relative, else array order. */
function orderedLayers(layers: readonly VisualLayerDescriptor[]): VisualLayerDescriptor[] {
  const enabled = layers.filter((layer) => layer.enabled !== false);
  const baseZ = new Map<string, number>();
  enabled.forEach((layer, index) => baseZ.set(layer.id, layer.order?.z ?? index));
  const effectiveZ = (layer: VisualLayerDescriptor, index: number): number => {
    const order = layer.order;
    if (order?.before && baseZ.has(order.before)) return baseZ.get(order.before)! - 0.5;
    if (order?.after && baseZ.has(order.after)) return baseZ.get(order.after)! + 0.5;
    return order?.z ?? index;
  };
  return enabled
    .map((layer, index) => ({ layer, key: effectiveZ(layer, index), index }))
    .sort((a, b) => (a.key - b.key) || (a.index - b.index))
    .map((entry) => entry.layer);
}

function LayerView({
  layer,
  zIndex,
  map,
  camera,
  resolveSubject,
  regionElement,
}: {
  layer: VisualLayerDescriptor;
  zIndex: number;
  map: VisualLayerCapabilityMap;
  camera?: VisualLayerStackProps['camera'];
  resolveSubject: (ref: AddressRef) => unknown;
  regionElement: HTMLElement | null;
}) {
  const renderChildren = React.useCallback(
    (children: readonly VisualLayerDescriptor[]): React.ReactNode =>
      React.createElement(VisualLayerStackInner, { layers: children, map, camera, resolveSubject }),
    [map, camera, resolveSubject],
  );

  const ctx: VisualLayerRenderContext = {
    descriptor: layer,
    regionElement,
    camera,
    resolveSubject,
    renderChildren,
  };

  const capability = map.get(layer.paint.capability);
  const body = capability
    ? (capability.render ? capability.render(ctx) : null)
    : React.createElement('div', {
        'data-visual-layer-unknown': layer.paint.capability.capabilityId,
        className: 'hidden',
      });

  const children = layer.children && layer.children.length > 0 ? renderChildren(layer.children) : null;

  // Resolve every data-selected geometry/style operator the descriptor declares,
  // through the SAME registry, and merge their opaque CSS onto the wrapper. The
  // renderer is blind to what each operator does — silhouette clip, mask, blur,
  // skew — it only merges CSSProperties (L090). A descriptor with none of these
  // seams is unaffected (regions render exactly as before).
  const frame = layer.frame;
  const composite = layer.composite;
  const fragments: React.CSSProperties[] = [];
  if (frame?.clip) fragments.push(resolveStyleOp(map, frame.clip as unknown as CapabilityInvocation, regionElement));
  frame?.transform?.forEach((op) => fragments.push(resolveStyleOp(map, op, regionElement)));
  composite?.filters?.forEach((op) => fragments.push(resolveStyleOp(map, op, regionElement)));
  if (composite?.mask?.paint) fragments.push(resolveStyleOp(map, composite.mask.paint, regionElement));
  const hasClip = fragments.some((f) => 'clipPath' in f || 'WebkitClipPath' in f || 'maskImage' in f);

  return React.createElement(
    'div',
    {
      'data-visual-layer-id': layer.id,
      'data-visual-capability': layer.paint.capability.capabilityId,
      'data-visual-clip': hasClip ? 'true' : undefined,
      className: 'absolute inset-0 overflow-hidden',
      style: mergeStyleFragments(
        {
          zIndex,
          opacity: composite?.opacity,
          mixBlendMode: composite?.blend as React.CSSProperties['mixBlendMode'],
          pointerEvents: layer.pointerEvents ? 'auto' : 'none',
        },
        fragments,
      ),
    },
    body,
    children,
  );
}

/** Inner stack used for both the top-level region and recursive children. */
function VisualLayerStackInner({
  layers,
  map,
  camera,
  resolveSubject,
  regionElement,
}: {
  layers: readonly VisualLayerDescriptor[];
  map: VisualLayerCapabilityMap;
  camera?: VisualLayerStackProps['camera'];
  resolveSubject: (ref: AddressRef) => unknown;
  regionElement?: HTMLElement | null;
}) {
  const ordered = React.useMemo(() => orderedLayers(layers), [layers]);
  return React.createElement(
    React.Fragment,
    null,
    ...ordered.map((layer, index) =>
      React.createElement(LayerView, {
        key: layer.id,
        layer,
        zIndex: index,
        map,
        camera,
        resolveSubject,
        regionElement: regionElement ?? null,
      }),
    ),
  );
}

/**
 * Render a region's visual layer stack. Mount this as the region's visual; place
 * the region's own content as a layer (e.g. a `surface-content` capability) so
 * background, content, and overlay all live in one stack differing only by order.
 */
export function VisualLayerStack({
  record,
  layers,
  map,
  camera,
  resolveSubject,
  clip,
  className,
}: VisualLayerStackProps) {
  const [regionElement, setRegionElement] = React.useState<HTMLElement | null>(null);
  const effectiveLayers = record?.layers ?? layers ?? [];
  // Whole-surface silhouette: resolve the stack-level clip operator (prop wins
  // over record.clip) and apply it to the ROOT so every layer + content is
  // clipped to the card's edge. Blind — the renderer merges opaque CSS (L090).
  const effectiveClip = (clip ?? (record?.clip as CapabilityInvocation | undefined));
  const rootClipStyle = resolveStyleOp(map, effectiveClip, regionElement);
  return React.createElement(
    'div',
    {
      ref: setRegionElement,
      'data-visual-layer-stack': 'true',
      'data-visual-stack-clip': ('clipPath' in rootClipStyle || 'WebkitClipPath' in rootClipStyle) ? 'true' : undefined,
      className: ['relative h-full w-full', className].filter(Boolean).join(' '),
      style: rootClipStyle,
    },
    React.createElement(VisualLayerStackInner, {
      layers: effectiveLayers,
      map,
      camera,
      resolveSubject: resolveSubject ?? NO_SUBJECT,
      regionElement,
    }),
  );
}
