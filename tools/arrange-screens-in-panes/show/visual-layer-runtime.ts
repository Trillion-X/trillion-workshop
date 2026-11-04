// packages/screen-arrangement/show/visual-layer-runtime.ts
//
// Shared visual-layer runtime for the screen-arrangement: ONE subject->URL
// resolver (a single object-URL cache for the whole app) and the built-in
// capability pack used both for rendering (the dispatch map) and for drop-to-
// layer (the accepts() probe). Region wallpaper layers retain an admitted
// content-media relation identity; this resolver turns that identity into an
// ephemeral guarded object URL.

import { builtinVisualLayerCapabilities, createCapabilityMap, type AddressRef, type VisualLayerCapability, type VisualLayerCapabilityMap, type VisualLayerDescriptor } from '../../ui/show/visual-layer-stack'
import { readCanonicalArtifactObjectUrl } from '../do-work/read-canonical-artifact-object-url'
import type { LayoutState } from '../read-data/layout-types'
import { regionAddressKey } from '../read-data/region-address'

import { setVisualLayerArtifactReader } from './visual-layer-subject-resolver'
export { canonicalArtifactSubjectRef, useVisualLayerSubjectResolver } from './visual-layer-subject-resolver'

// Account runtime installs the existing guarded reader before any layer effect.
setVisualLayerArtifactReader(readCanonicalArtifactObjectUrl)

/** The capability pack record — passed to readVisualLayerDrop for accepts() probing. */
export const visualLayerCapabilityPack = builtinVisualLayerCapabilities

/** Build a dispatch map = the built-in pack plus any region-specific capabilities. */
export function visualLayerCapabilityMap(
  extra?: Readonly<Record<string, VisualLayerCapability>>,
): VisualLayerCapabilityMap {
  return createCapabilityMap(extra ? { ...builtinVisualLayerCapabilities, ...extra } : builtinVisualLayerCapabilities)
}

/**
 * Append a wallpaper layer to a region's stack and persist via the generic
 * applyLayoutState commit (the T7 normalizer preserves visualLayerStacks).
 * Pure data mutation — no new layout action type needed.
 */
export function appendRegionLayer(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  region: AddressRef,
  descriptor: VisualLayerDescriptor,
): void {
  const key = regionAddressKey(region)
  const existing = state.visualLayerStacks?.[key]
  const layers = [...(existing?.layers ?? []), descriptor]
  applyLayoutState({
    ...state,
    visualLayerStacks: {
      ...(state.visualLayerStacks ?? {}),
      [key]: { kind: 'visual-layer-stack', version: 1, region, layers },
    },
  })
}

/**
 * Upsert a SINGLETON layer in a region's stack: replace the layer whose id ===
 * descriptor.id in place, else append it. This is how decoration that has "one
 * value" (a background fill, a single grain pass) is written — picking a new
 * color replaces the old color layer instead of stacking infinitely. Pure data
 * mutation through the generic applyLayoutState commit (slot-persisted).
 */
export function setRegionLayer(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  region: AddressRef,
  descriptor: VisualLayerDescriptor,
): void {
  const key = regionAddressKey(region)
  const existing = state.visualLayerStacks?.[key]
  const prior = existing?.layers ?? []
  const idx = prior.findIndex((layer) => layer.id === descriptor.id)
  const layers = idx === -1
    ? [...prior, descriptor]
    : prior.map((layer, i) => (i === idx ? descriptor : layer))
  applyLayoutState({
    ...state,
    visualLayerStacks: {
      ...(state.visualLayerStacks ?? {}),
      [key]: { kind: 'visual-layer-stack', version: 1, region, layers },
    },
  })
}

/** Read a region's singleton layer by id (for an editor's initial value). */
export function getRegionLayer(
  state: LayoutState,
  region: AddressRef,
  layerId: string,
): VisualLayerDescriptor | null {
  const stack = state.visualLayerStacks?.[regionAddressKey(region)]
  return stack?.layers.find((layer) => layer.id === layerId) ?? null
}

/** Remove a region's singleton layer by id (clear a background / grain). */
export function removeRegionLayer(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  region: AddressRef,
  layerId: string,
): void {
  const key = regionAddressKey(region)
  const existing = state.visualLayerStacks?.[key]
  if (!existing) return
  const layers = existing.layers.filter((layer) => layer.id !== layerId)
  applyLayoutState({
    ...state,
    visualLayerStacks: { ...(state.visualLayerStacks ?? {}), [key]: { ...existing, layers } },
  })
}

/**
 * Reorder a region's layers to match `orderedIds` (front-most first) and rewrite
 * each layer's `order.z` so the renderer paints them in that order. z is centred
 * around the content layer (z=0): front-most layers get positive z (over
 * content), back layers negative z (wallpaper). Layers not named in orderedIds
 * keep their relative tail position.
 */
export function reorderRegionLayers(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  region: AddressRef,
  orderedIds: readonly string[],
): void {
  const key = regionAddressKey(region)
  const existing = state.visualLayerStacks?.[key]
  if (!existing) return
  const byId = new Map(existing.layers.map((layer) => [layer.id, layer]))
  const ordered = orderedIds.map((id) => byId.get(id)).filter((layer): layer is VisualLayerDescriptor => !!layer)
  const rest = existing.layers.filter((layer) => !orderedIds.includes(layer.id))
  // front-most (index 0) → highest z; centre on 0 so backgrounds stay behind content.
  const frontToBack = [...ordered, ...rest]
  const n = frontToBack.length
  const layers = frontToBack.map((layer, index) => ({
    ...layer,
    order: { ...layer.order, z: n - 1 - index - Math.floor((n - 1) / 2) },
  }))
  applyLayoutState({
    ...state,
    visualLayerStacks: { ...(state.visualLayerStacks ?? {}), [key]: { ...existing, layers } },
  })
}

/**
 * Patch one layer's compositing/visibility fields in place (opacity, blend,
 * enabled) — the per-row controls of the layer tree. Pure data mutation.
 */
export function patchRegionLayer(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  region: AddressRef,
  layerId: string,
  patch: { opacity?: number; blend?: string; enabled?: boolean },
): void {
  const key = regionAddressKey(region)
  const existing = state.visualLayerStacks?.[key]
  if (!existing) return
  const layers = existing.layers.map((layer) => {
    if (layer.id !== layerId) return layer
    const composite = { ...layer.composite }
    if (patch.opacity !== undefined) composite.opacity = patch.opacity
    if (patch.blend !== undefined) composite.blend = patch.blend
    const next: VisualLayerDescriptor = { ...layer, composite }
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    return next
  })
  applyLayoutState({
    ...state,
    visualLayerStacks: { ...(state.visualLayerStacks ?? {}), [key]: { ...existing, layers } },
  })
}

/** Read a region's full decoration layer list (for the layer-tree editor). */
export function getRegionLayers(state: LayoutState, region: AddressRef): readonly VisualLayerDescriptor[] {
  return state.visualLayerStacks?.[regionAddressKey(region)]?.layers ?? []
}

/**
 * Patch one layer's capability input (e.g. a fill's `color`, grain's `amount`,
 * media `fit`) — the per-layer settings drawer of the tree. The renderer reads
 * `paint.input` opaquely, so this is pure data: merge the patch into input.
 */
export function patchRegionLayerInput(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  region: AddressRef,
  layerId: string,
  inputPatch: Record<string, unknown>,
): void {
  const key = regionAddressKey(region)
  const existing = state.visualLayerStacks?.[key]
  if (!existing) return
  const layers = existing.layers.map((layer) =>
    layer.id === layerId
      ? { ...layer, paint: { ...layer.paint, input: { ...layer.paint.input, ...inputPatch } } }
      : layer,
  )
  applyLayoutState({
    ...state,
    visualLayerStacks: { ...(state.visualLayerStacks ?? {}), [key]: { ...existing, layers } },
  })
}
