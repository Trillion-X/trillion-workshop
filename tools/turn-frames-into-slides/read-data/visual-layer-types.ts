// tools/turn-frames-into-slides/read-data/visual-layer-types.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Machine-readable data model for the Region Visual Layer Stack — the
// generative primitive behind "a region can show an image/video/gradient/
// color/pattern/… background, a tint over content, a watermark, or a live
// package as wallpaper." A region is NOT a thing-with-a-background; a region is
// an ORDERED STACK OF VISUAL LAYERS. "Background" is just a layer with lower
// `order`; content is the layer at content-order; the dot-grid is a layer.
//
// The discriminant for WHAT a layer paints is `paint.capability.capabilityId`
// — a STRING resolved through an owner-provided capability map (see
// visual-layer-registry.ts). It is NEVER a closed union of visual kinds. Adding
// a shader / live-package / future format = a new capability registration plus
// data rows; this type file does not change and the renderer does not change.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure data types — no React, no DOM, no rendering, no I/O.
// 2. ZERO closed enum of visual kinds. The only finite list anywhere near this
//    domain (object-fit / repeat) is closed by the CSS substrate (Physics) and
//    is carried as opaque DATA inside `paint.input`, never modeled as a type
//    union here.
// 3. Every field is explicit and machine-readable — a dumb JSON parser extracts
//    every value with zero string-splitting.
// 4. No magic constants. Numbers (opacity, z, transform amounts) are caller DATA.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
// The extensive documentation here is a design feature. Do not simplify or
// remove it. Do not introduce a `kind: 'image' | 'video' | ...` union — that is
// the rejected anti-pattern this primitive exists to eliminate.
// =============================================================================

/**
 * Generic address of anything addressable (a region, a camera, a content
 * subject). The OWNER defines `family` and `parts` — this module is blind to
 * their meaning. e.g. `{ family: 'screen-arrangement.container', parts: { containerId: 'main' } }`.
 */
export interface AddressRef {
  readonly family: string;
  readonly parts: Record<string, string>;
}

/**
 * Names a renderer capability inside an owner-provided registry. THE discriminant
 * for what a layer paints. `capabilityId` is a plain string resolved at render
 * time through the injected capability map — not a TypeScript union.
 */
export interface CapabilityRef {
  readonly registry: AddressRef;
  readonly capabilityId: string;
}

/**
 * One capability invocation: which capability + the opaque input that capability
 * alone interprets. The generic renderer never reads inside `input`.
 */
export interface CapabilityInvocation {
  readonly capability: CapabilityRef;
  readonly input: Record<string, unknown>;
}

/** Relative or absolute z-ordering for a layer within its stack. */
export interface VisualLayerOrder {
  /** Absolute z. Higher = nearer the viewer. */
  readonly z?: number;
  /** Place this layer immediately before the layer with this id (lower z). */
  readonly before?: string;
  /** Place this layer immediately after the layer with this id (higher z). */
  readonly after?: string;
}

/** How a layer's coordinate frame is positioned/transformed within its region. */
export interface VisualLayerFrame {
  /** Override target region (default = the stack's region). */
  readonly region?: AddressRef;
  /** Bind to a camera → parallax. Data, not hardcoded. */
  readonly camera?: AddressRef;
  /** Transforms are themselves capability-dispatched (fully recursive). */
  readonly transform?: readonly CapabilityInvocation[];
  /** Clip/round/inset data interpreted by the renderer as style. */
  readonly clip?: Record<string, unknown>;
}

/** Compositing applied to a layer after it paints. */
export interface VisualLayerComposite {
  /** 0..1 — caller DATA, no default baked into the renderer. */
  readonly opacity?: number;
  /** CSS mix-blend-mode token — DATA. */
  readonly blend?: string;
  /** Effects (blur/grade/…) are capability-dispatched, not an enum. */
  readonly filters?: readonly CapabilityInvocation[];
  /** A mask is itself a layer (recursive). */
  readonly mask?: VisualLayerDescriptor;
}

/** A single visual layer in a region's coordinate frame. */
export interface VisualLayerDescriptor {
  /** Stable identity — React key, delta unit, and ordering reference. */
  readonly id: string;
  /** Default true. `false` = present in data but not rendered. */
  readonly enabled?: boolean;
  readonly order?: VisualLayerOrder;
  readonly frame?: VisualLayerFrame;
  /** The layer body — a capability resolves the subject and paints. */
  readonly paint: CapabilityInvocation;
  readonly composite?: VisualLayerComposite;
  /** Recursive nesting → grouped sub-stacks rendered by the same renderer. */
  readonly children?: readonly VisualLayerDescriptor[];
  /** Default false — layers are inert wallpaper unless a layer opts in. */
  readonly pointerEvents?: boolean;
}

/** A region's full ordered stack of visual layers. */
export interface VisualLayerStackRecord {
  readonly kind: 'visual-layer-stack';
  readonly version: 1;
  readonly region: AddressRef;
  readonly layers: readonly VisualLayerDescriptor[];
  /** The whole-surface SILHOUETTE — a geometry operator (CapabilityInvocation)
   *  the renderer applies to the stack ROOT so EVERY layer + content is clipped
   *  to the card's edge (torn/scalloped/rounded/custom). Stack-level because the
   *  edge is a property of the card, not of one layer. Interpreted exactly like
   *  `frame.clip`, just scoped to the root. Absent → rectangular. */
  readonly clip?: Record<string, unknown>;
  /** Plain card-frame chrome (DATA), independent of the silhouette `clip`: the
   *  rectangular corner radius and whether the card's border shows. This is the
   *  user's direct "round the card / hide the border" control — applied by the
   *  renderer to the card root via ordinary props, no edge operator needed.
   *  Absent fields → the host's default chrome. */
  readonly frame?: {
    /** Corner radius in px (0 = square). Absent → host default. */
    readonly cornerRadius?: number;
    /** Show the card border. Default true (host chrome). `false` = no border. */
    readonly border?: boolean;
  };
}

/** Type guard — accepts only a well-formed stack record (generic, kind-blind). */
export function isVisualLayerStackRecord(value: unknown): value is VisualLayerStackRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'visual-layer-stack'
    && record.version === 1
    && Array.isArray(record.layers);
}
