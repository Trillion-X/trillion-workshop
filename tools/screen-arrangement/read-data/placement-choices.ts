// packages/screen-arrangement/read-data/placement-choices.ts
//
// Purpose: the one owner of container placement choices: the placement modes a
// container can take on a layer (the surface modes plus the PiP overlay), the
// person's saved presets and recent history, and the pane geometry of a layer
// used to draw its placement map.
// Invariants: modes are DATA (SURFACE_MODES + the overlay row); no caller
// branches on a mode id to find its label or icon. Presets and history are
// browser-local preferences; unreadable storage reads as empty.

import { SURFACE_MODES } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/surface-modes.ts'
import { controlShown } from '../../ui/show/show-rules/show-of'
import type { ArrangementLayer, LayoutState, SplitTreeNode } from './layout-types'

export interface PlacementMode {
  readonly id: string
  readonly label: string
  readonly icon: string
}

/** Every placement a container can take on a layer. The overlay row is the PiP plane. */
export const PLACEMENT_MODES: readonly PlacementMode[] = [
  ...SURFACE_MODES.map((mode) => ({ id: mode.id, label: mode.label, icon: mode.icon ?? 'Square' })),
  { id: 'overlay', label: 'PiP', icon: 'PictureInPicture' },
]

/** The control the PiP plane is decided under (../controls.json): a show rule hiding it offers no PiP anywhere. */
export const PICTURE_IN_PICTURE_CONTROL = 'open.picture-in-picture'

/** Whether a pane may float over the screen as picture in picture now. */
export const pictureInPictureShown = (): boolean => controlShown(PICTURE_IN_PICTURE_CONTROL)

/** The placements to offer now: every one, less the PiP plane while a show rule hides picture in picture. */
export function shownPlacementModes(): readonly PlacementMode[] {
  return pictureInPictureShown() ? PLACEMENT_MODES : PLACEMENT_MODES.filter((mode) => mode.id !== 'overlay')
}

export type PlacementId = 'grid' | 'canvas' | 'overlay'
const PLACEMENT_IDS = new Set(PLACEMENT_MODES.map((mode) => mode.id))

export function isPlacementId(value: unknown): value is PlacementId {
  return typeof value === 'string' && PLACEMENT_IDS.has(value)
}

export function placementMode(id: string): PlacementMode | undefined {
  return PLACEMENT_MODES.find((mode) => mode.id === id)
}

export interface PlacementChoice { id: string; layerId: string; placement: PlacementId }

export const LAST_PLACEMENT_KEY = 'screen-arrangement:last-placement-choice'
export const RECENT_PLACEMENTS_KEY = 'screen-arrangement:recent-placement-choices'
export const SAVED_PLACEMENTS_KEY = 'screen-arrangement:saved-placement-choices'
const MAX_CHOICES = 40

export function readPlacementChoices(key: string): PlacementChoice[] {
  if (typeof window === 'undefined') return []
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((choice): choice is PlacementChoice => !!choice && typeof choice === 'object'
      && typeof choice.id === 'string' && typeof choice.layerId === 'string'
      && isPlacementId(choice.placement)).slice(0, MAX_CHOICES)
  } catch { return [] }
}

export function writePlacementChoices(key: string, choices: PlacementChoice[]) {
  try { window.localStorage.setItem(key, JSON.stringify(choices.slice(0, MAX_CHOICES))) } catch { /* storage is optional */ }
}

export function readLastPlacement(): PlacementId | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(LAST_PLACEMENT_KEY)
    return isPlacementId(value) ? value : null
  } catch { return null }
}

export function choiceFor(layerId: string, placement: PlacementId): PlacementChoice {
  return { id: `${layerId}:${placement}`, layerId, placement }
}

/** Put a choice at the front of the recent history and remember it as the last placement. */
export function rememberPlacementChoice(choice: PlacementChoice): PlacementChoice[] {
  const next = [choice, ...readPlacementChoices(RECENT_PLACEMENTS_KEY).filter((item) => item.id !== choice.id)]
  writePlacementChoices(RECENT_PLACEMENTS_KEY, next)
  try { window.localStorage.setItem(LAST_PLACEMENT_KEY, choice.placement) } catch { /* storage is optional */ }
  return next.slice(0, MAX_CHOICES)
}

/** Add or remove a saved preset; returns the new preset list. */
export function toggleSavedPlacement(choice: PlacementChoice): PlacementChoice[] {
  const current = readPlacementChoices(SAVED_PLACEMENTS_KEY)
  const next = current.some((item) => item.id === choice.id)
    ? current.filter((item) => item.id !== choice.id)
    : [choice, ...current]
  writePlacementChoices(SAVED_PLACEMENTS_KEY, next)
  return next
}

/** Which placements a layer can accept without losing its peers' geometry. */
export function placementAllowedOnLayer(layer: ArrangementLayer, placement: string): boolean {
  const hasTiles = layer.layouts.some((layout) => layout.type === 'tiled' && !!layout.root)
  const hasCanvasPanes = layer.layouts.some((layout) => layout.type === 'floating' && layout.containers.length > 0)
  return (placement !== 'grid' || !hasCanvasPanes) && (placement !== 'canvas' || !hasTiles)
}

export function layerHoldsContainer(layer: ArrangementLayer, containerId: string): boolean {
  return layer.layouts.some((layout) => layout.type === 'tiled'
    ? treeHolds(layout.root, containerId)
    : layout.containers.some((item) => item.containerId === containerId))
}

function treeHolds(node: SplitTreeNode | null, containerId: string): boolean {
  if (!node) return false
  return node.kind === 'leaf' ? node.containerId === containerId : node.children.some((child) => treeHolds(child, containerId))
}

export interface PaneFrame { id: string; x: number; y: number; width: number; height: number }

/** Every pane on a layer as a rect in viewport space (tiles, canvas panes, and PiPs). */
export function layerPaneFrames(layer: ArrangementLayer, viewport: { w: number; h: number }): PaneFrame[] {
  const frames: PaneFrame[] = []
  const walk = (node: SplitTreeNode, x: number, y: number, width: number, height: number) => {
    if (node.kind === 'leaf') { frames.push({ id: node.containerId, x, y, width, height }); return }
    let offset = 0
    node.children.forEach((child, index) => {
      const share = node.sizes[index] ?? 1 / node.children.length
      if (node.dir === 'row') walk(child, x + offset * width, y, share * width, height)
      else walk(child, x, y + offset * height, width, share * height)
      offset += share
    })
  }
  for (const layout of layer.layouts) {
    if (layout.type === 'tiled') { if (layout.root) walk(layout.root, 0, 0, viewport.w, viewport.h) }
    else for (const item of layout.containers) frames.push({ id: item.containerId, x: item.x, y: item.y, width: item.w, height: item.h })
  }
  return frames
}

/**
 * The layers a state holds. A state saved before layers existed is ONE layer
 * holding its layouts, under the id the slot gives it when it normalizes the
 * state (`default`), so the list is never empty.
 */
export function arrangementLayers(state: LayoutState): ArrangementLayer[] {
  if (state.layers && state.layers.length > 0) return state.layers
  return [{ id: state.activeLayerId ?? 'default', z: 0, surface: state.surface, layouts: state.layouts }]
}
