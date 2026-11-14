// packages/ui/show/visual-layer-stack/visual-layer-registry.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The capability-map dispatch contract for the Region Visual Layer Stack. This
// is the enum-dissolution mechanism (Pattern 81): the generic renderer holds NO
// built-in list of visual kinds. It is handed an INJECTED capability map and
// asks it `get(capabilityRef) -> renderer`. The renderer never knows `image`,
// `video`, `gradient`, `dot-grid`, `shader`, etc.
//
// "Registry-in-name is not enough" (.claude/rules/1000x-enum-dissolution.md):
// the extensible list of capabilities lives OUTSIDE the generic core. This file
// owns ZERO concrete capability names — `createCapabilityMap` simply wraps a
// caller-supplied record. The built-in pack (solid/gradient/image/media/
// pattern.dot-grid/…) lives in capabilities/builtin.ts and is composed in by the
// owner, never hardcoded here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. No concrete capabilityId string appears in this file.
// 2. A capability renders its OWN element kind (Pattern 103 sibling-consumption)
//    — CSS via style, media via <video>/<img>, dot-grid via canvas, future
//    shader via <canvas>. The renderer composites; it does not materialize.
// 3. Unknown capability resolves to `null` so the renderer can show ONE generic
//    fallback layer — never a per-kind branch.
// =============================================================================

import type * as React from 'react';
import type {
  AddressRef,
  CapabilityRef,
  VisualLayerDescriptor,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

/**
 * Everything a capability needs to paint its layer, supplied by the generic
 * renderer. A capability reads only what it understands; it is blind to siblings.
 */
export interface VisualLayerRenderContext {
  /** The descriptor for THIS layer. */
  readonly descriptor: VisualLayerDescriptor;
  /** The live region frame element (for sizing / world-space math). May be null on first paint. */
  readonly regionElement: HTMLElement | null;
  /** Camera state when the layer's frame binds to one (parallax). */
  readonly camera?: { readonly panX: number; readonly panY: number; readonly zoom: number };
  /** Resolve an addressed subject (a dropped blob handle, a log-addressed content ref, …) to whatever the capability expects. The renderer never touches bytes. */
  readonly resolveSubject: (ref: AddressRef) => unknown;
  /** Render nested descriptors through the SAME stack renderer (recursion). */
  readonly renderChildren: (children: readonly VisualLayerDescriptor[]) => React.ReactNode;
}

/**
 * Context for a capability used as a data-selected GEOMETRY/STYLE OPERATOR
 * (clip silhouette, mask, transform, filter) rather than a body painter. The
 * capability reads ONLY its invocation `input` (the opaque DATA it alone
 * interprets) plus the live region element if it needs pixel math. It returns a
 * CSS fragment the generic renderer merges onto the layer wrapper — the renderer
 * never inspects the returned keys (L090 blind handler). This is what lets the
 * SAME registry resolve an edge silhouette / mask / blur / skew without forcing
 * geometry through `render()` (which would be the wrong abstraction).
 */
export interface VisualLayerStyleContext {
  readonly input: Record<string, unknown>;
  readonly regionElement: HTMLElement | null;
}

/**
 * Editing context for a capability's settings editor. STORAGE-BLIND: the editor
 * reads the layer's current `input` and calls `patchInput` to change it. The
 * capability never sees the node, the region, or how/where the layer persists
 * (L098) — the owner wires `patchInput` to its own commit path.
 */
export interface VisualLayerEditorContext {
  readonly input: Record<string, unknown>;
  readonly patchInput: (patch: Record<string, unknown>) => void;
}

/** How a capability presents as a layer row + an "Add layer" choice. */
export interface VisualLayerPresentation {
  /** Generic fill vocabulary (Color, Gradient, Grain). An owner may wrap to override. */
  readonly label: string;
  /** Named-icon id. */
  readonly icon: string;
}

/**
 * Present = this capability is user-addable from the "Add layer" menu. Its
 * presence (not a hardcoded menu) is what makes a capability addable — adding a
 * new fill is ONE registry entry, ZERO menu edits (L063/L090).
 */
export interface VisualLayerAddAffordance {
  /** Sort order in the Add menu (lower = earlier). */
  readonly order?: number;
  /** Absolute z for a freshly-added layer (wallpaper ≈ negative, overlay ≈ positive). */
  readonly defaultZ?: number;
  /** Maximally-capable default input for a freshly-added layer (L083). */
  readonly defaultInput?: Record<string, unknown>;
  /**
   * This capability paints a picked/dropped SUBJECT (image/video/…) rather than a
   * static default. The owner runs its subject picker (with `subjectPrefixes`),
   * ingests the bytes, then adds the layer — routing the picked file to whichever
   * capability `accepts()` it.
   */
  readonly requiresSubject?: boolean;
  /** Content-type prefixes the subject picker should accept (e.g. ['image/']). */
  readonly subjectPrefixes?: readonly string[];
}

/** A single registered renderer capability. SELF-DESCRIBING: it owns its render,
 *  its settings editor, its row presentation, and its add-affordance — so every
 *  consumer (renderer, settings panel, Add menu) is a blind generic handler. */
export interface VisualLayerCapability {
  /**
   * Subject-match predicate used by authoring (drop-to-layer) to choose which
   * capability paints a dropped subject. The generic renderer does NOT call
   * this — it dispatches purely by capabilityId.
   */
  readonly accepts?: (descriptor: VisualLayerDescriptor) => boolean;
  /** Paint the layer body. Returns the capability's OWN element (Pattern 103).
   *  OPTIONAL: a capability may be a pure geometry/style operator (clip/mask/
   *  transform/filter) that paints nothing and only contributes `resolveStyle`. */
  readonly render?: (ctx: VisualLayerRenderContext) => React.ReactNode;
  /** Produce an opaque CSS fragment the universal renderer merges onto the layer
   *  wrapper — for capabilities used as data-selected GEOMETRY/STYLE operators
   *  (silhouette clip, mask, transform, filter) rather than body painters. The
   *  renderer never inspects the returned keys (L090). A capability may provide
   *  `render`, `resolveStyle`, or both. */
  readonly resolveStyle?: (ctx: VisualLayerStyleContext) => React.CSSProperties;
  /**
   * Produce this capability's BODY PAINT expressed as TARGET-NEUTRAL CSS — the
   * same fill, but as a `React.CSSProperties` (`background`/`backgroundImage`/
   * `backgroundColor`/…) that can paint ANY element, not just a region <div>.
   * This is what lets the SAME paint primitive fill a card region (via `render`)
   * AND a run of text (the composer stacks these and clips them to the glyphs via
   * `background-clip: text`). It is the body-paint sibling of `resolveStyle`
   * (which carries post-paint geometry operators). A capability provides it ONLY
   * when its paint is genuinely CSS-expressible: solid/gradient/mesh/grain/tint do;
   * media (a <video>) and dot-grid (a <canvas>) cannot, so they OMIT it and are
   * simply not offered as a text paint (honest opt-out, L090 — no per-kind branch).
   */
  readonly resolveCssPaint?: (ctx: VisualLayerStyleContext) => React.CSSProperties;
  /** Human label + icon for a layer row and the Add menu. */
  readonly presentation?: VisualLayerPresentation;
  /** The capability's OWN per-layer settings editor (color wheel for a fill,
   *  slider for grain). Storage-blind. Absent = no settings drawer for this layer. */
  readonly editor?: (ctx: VisualLayerEditorContext) => React.ReactNode;
  /** Present = user-addable; declares default + subject needs. Absent = not in Add menu. */
  readonly addAffordance?: VisualLayerAddAffordance;
}

/** The injected dispatch map the renderer consults. */
export interface VisualLayerCapabilityMap {
  get(ref: CapabilityRef): VisualLayerCapability | null;
}

/**
 * Wrap a caller-supplied `capabilityId -> capability` record as a
 * VisualLayerCapabilityMap. This helper owns NO capability names — the record is
 * entirely the owner's. Compose built-in + custom: `createCapabilityMap({
 * ...builtinVisualLayerCapabilities, 'my.shader': myShaderCapability })`.
 *
 * `registry` on the CapabilityRef is reserved for multi-registry routing; this
 * default helper keys on `capabilityId` alone, which is sufficient for a single
 * owner-provided pack and keeps lookups O(1).
 */
export function createCapabilityMap(
  entries: Readonly<Record<string, VisualLayerCapability>>,
): VisualLayerCapabilityMap {
  return {
    get(ref: CapabilityRef): VisualLayerCapability | null {
      return entries[ref.capabilityId] ?? null;
    },
  };
}
