// packages/screen-arrangement/show/LayerPlacementPanel.tsx
//
// Purpose: move one container between the arrangement's stacked layers. The
// panel lists every layer (drag to restack, a check on the layer holding the
// container), moves the container with ONE click on another layer or on a
// saved preset / recent choice, and, when the person rests on a layer, shows
// that layer's dot map so they can click any spot around the dots and pick
// Tiles / Canvas / PiP before confirming.
// Invariants: placement modes, presets and history come from
// read-data/placement-choices (DATA); this file never names a mode. All layout
// changes go through LayoutActions (the slot owns the reducer). No raw markup:
// shared ui components plus inert createElement containers only.

import React from 'react'
import { Button } from '../../ui/show/button'
import { NamedIcon } from '../../ui/show/icon'
import { ExpandableTabs } from '../../ui/show/expandable-tabs'
import { DragReorderList } from '../../ui/show/drag-reorder-list/DragReorderList'
import { DotPlacementMap } from '../../ui/show/canvas-minimap'
import { FadingScrollList } from '../../ui/show/placement-history'
import { LayoutActionsContext, LayoutStateContext } from './screen-arrangement-context'
import { arrangementViewport } from '../do-work/layout-operations'
import type { ArrangementLayer } from '../read-data/layout-types'
import {
  SAVED_PLACEMENTS_KEY, arrangementLayers, RECENT_PLACEMENTS_KEY,
  choiceFor, layerHoldsContainer, layerPaneFrames, placementAllowedOnLayer, placementMode,
  readLastPlacement, readPlacementChoices, rememberPlacementChoice, toggleSavedPlacement,
  isPlacementId, pictureInPictureShown, shownPlacementModes, type PlacementChoice, type PlacementId,
} from '../read-data/placement-choices'

const h = React.createElement
const RECENT_VISIBLE = 3
const MAP_REVEAL_DELAY_MS = 280

export default function LayerPlacementPanel({ containerId, onDone }: { containerId: string; onDone: () => void }) {
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const [presets, setPresets] = React.useState<PlacementChoice[]>(() => readPlacementChoices(SAVED_PLACEMENTS_KEY))
  const [recent, setRecent] = React.useState<PlacementChoice[]>(() => readPlacementChoices(RECENT_PLACEMENTS_KEY))
  const [showAllRecent, setShowAllRecent] = React.useState(false)
  const [mapLayerId, setMapLayerId] = React.useState<string | null>(null)
  const [destination, setDestination] = React.useState<{ layerId: string; point: { x: number; y: number } } | null>(null)
  const [draft, setDraft] = React.useState<PlacementId | null>(null)
  const revealTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current) }, [])
  if (!layoutState || !layoutActions) return null

  const layers = [...arrangementLayers(layoutState)].sort((left, right) => right.z - left.z)
  const layerById = new Map(layers.map((layer) => [layer.id, layer]))
  const current = layers.find((layer) => layerHoldsContainer(layer, containerId))
    ?? layerById.get(layoutState.activeLayerId ?? '')
  const inOverlay = !!current?.layouts.some((layout) => layout.type === 'overlay'
    && layout.containers.some((item) => item.containerId === containerId))
  const viewport = arrangementViewport()
  const layerName = (layer: ArrangementLayer | undefined) => layer
    ? layer.name ?? `Layer ${[...layers].reverse().indexOf(layer) + 1}`
    : 'Layer'
  const allowed = (layerId: string, placement: string) => {
    const layer = layerById.get(layerId)
    if (!layer) return false
    if (placement === 'overlay' && !pictureInPictureShown()) return false
    return layer.id === current?.id || placementAllowedOnLayer(layer, placement)
  }
  const usable = (choice: PlacementChoice) => allowed(choice.layerId, choice.placement)
  /** The person's preset for this layer, else any preset mode, else the last mode, else the first allowed. */
  const preselect = (layerId: string): PlacementId => {
    const candidates = [
      ...presets.filter((choice) => choice.layerId === layerId).map((choice) => choice.placement),
      ...presets.map((choice) => choice.placement),
      readLastPlacement(),
      ...shownPlacementModes().map((mode) => mode.id),
    ]
    const found = candidates.find((placement) => isPlacementId(placement) && allowed(layerId, placement))
    return isPlacementId(found) ? found : 'overlay'
  }

  const run = (layerId: string, placement: PlacementId, point?: { x: number; y: number }) => {
    if (!allowed(layerId, placement)) return
    if (layerId === current?.id) {
      if (layoutState.activeLayerId !== layerId) layoutActions.setActiveLayer(layerId)
      if (placement === 'overlay') { if (!inOverlay) void layoutActions.toggleOverlay(containerId) }
      else {
        if (inOverlay) void layoutActions.toggleOverlay(containerId)
        void layoutActions.setSurface(placement)
      }
    } else {
      layoutActions.moveContainerToLayer(containerId, layerId, placement, point)
      layoutActions.setActiveLayer(layerId)
    }
    setRecent(rememberPlacementChoice(choiceFor(layerId, placement)))
    onDone()
  }

  const choiceLabel = (choice: PlacementChoice) =>
    `${layerName(layerById.get(choice.layerId))} · ${placementMode(choice.placement)?.label ?? choice.placement}`
  const choiceButton = (choice: PlacementChoice, kind: string) => h(Button, {
    key: `${kind}:${choice.id}`, type: 'button', size: 'sm', variant: 'secondary',
    className: 'min-w-0 justify-start gap-1.5', 'data-placement-choice': kind,
    title: choiceLabel(choice), onClick: () => run(choice.layerId, choice.placement),
  },
  h(NamedIcon, { name: placementMode(choice.placement)?.icon ?? 'Square', size: 'xs', 'aria-hidden': true }),
  h('span', { className: 'truncate' }, choiceLabel(choice)))

  const usablePresets = presets.filter(usable)
  const usableRecent = recent.filter(usable)
  const visibleRecent = showAllRecent ? usableRecent : usableRecent.slice(0, RECENT_VISIBLE)
  const caption = (text: string) => h('span', {
    className: 'text-[length:var(--font-size-caption)] font-medium text-[var(--text-muted)]',
  }, text)

  const picker = (layerId: string) => {
    const selected = draft ?? preselect(layerId)
    const saved = presets.some((choice) => choice.id === `${layerId}:${selected}`)
    return h('div', { className: 'mt-1.5 flex items-center gap-1', 'data-placement-picker': true },
      h(ExpandableTabs, {
        value: selected,
        ariaLabel: 'Place as',
        size: 'sm',
        items: shownPlacementModes().map((mode) => ({
          id: mode.id, label: mode.label, icon: mode.icon, disabled: !allowed(layerId, mode.id),
        })),
        onChange: (id: string) => { if (isPlacementId(id)) setDraft(id) },
      }),
      h(Button, {
        type: 'button', size: 'icon', variant: saved ? 'accent' : 'ghost',
        'aria-label': saved ? 'Remove preset' : 'Save as preset', title: saved ? 'Remove preset' : 'Save as preset',
        onClick: () => setPresets(toggleSavedPlacement(choiceFor(layerId, selected))),
      }, h(NamedIcon, { name: 'Bookmark', size: 'xs', 'aria-hidden': true })),
      h(Button, {
        type: 'button', size: 'icon', variant: 'confirm', className: 'ml-auto',
        'aria-label': 'Place here', title: 'Place here',
        onClick: () => run(layerId, selected, destination?.layerId === layerId ? destination.point : undefined),
      }, h(NamedIcon, { name: 'Check', size: 'sm', 'aria-hidden': true })),
    )
  }

  const layerRow = (layer: ArrangementLayer) => {
    const isCurrent = layer.id === current?.id
    const paneCount = layerPaneFrames(layer, viewport).length
    const showMap = mapLayerId === layer.id
    return h('div', {
      className: 'flex min-w-0 flex-col',
      onPointerEnter: () => {
        if (revealTimer.current) clearTimeout(revealTimer.current)
        revealTimer.current = setTimeout(() => setMapLayerId(layer.id), MAP_REVEAL_DELAY_MS)
      },
      onPointerLeave: () => { if (revealTimer.current) clearTimeout(revealTimer.current) },
    },
    h('div', { className: 'flex min-w-0 items-center gap-1' },
      h(Button, {
        type: 'button', size: 'sm', variant: 'ghost', active: isCurrent,
        className: 'min-w-0 flex-1 justify-start gap-2',
        'aria-current': isCurrent ? 'true' : undefined,
        'data-layer-choice': layer.id,
        title: isCurrent ? 'This pane is on this layer' : `Move here as ${placementMode(preselect(layer.id))?.label ?? ''}`,
        onClick: () => { if (!isCurrent) run(layer.id, preselect(layer.id)); else setMapLayerId(layer.id) },
      },
      h(NamedIcon, { name: 'Layers3', size: 'xs', 'aria-hidden': true }),
      h('span', { className: 'min-w-0 flex-1 truncate text-left' }, layerName(layer)),
      h('span', { className: 'text-[length:var(--font-size-caption)] text-[var(--text-muted)]' }, String(paneCount)),
      isCurrent ? h(NamedIcon, { name: 'Check', size: 'xs', 'aria-hidden': true }) : null),
      h(Button, {
        type: 'button', size: 'icon', variant: 'ghost', 'aria-expanded': showMap,
        'aria-label': `Choose a spot on ${layerName(layer)}`, title: 'Choose a spot',
        onClick: () => setMapLayerId(showMap ? null : layer.id),
      }, h(NamedIcon, { name: 'Map', size: 'xs', 'aria-hidden': true }))),
    showMap ? h('div', { className: 'mt-1.5 flex flex-col', 'data-layer-map': layer.id },
      h(DotPlacementMap, {
        frames: layerPaneFrames(layer, viewport),
        worldWidth: viewport.w, worldHeight: viewport.h, width: 232, height: 136,
        highlightId: containerId,
        value: destination?.layerId === layer.id ? destination.point : null,
        ariaLabel: `Place on ${layerName(layer)}`,
        onPlace: (point) => { setDestination({ layerId: layer.id, point }); setDraft(null) },
      }),
      destination?.layerId === layer.id ? picker(layer.id) : null) : null)
  }

  return h('div', { className: 'flex w-72 flex-col gap-3 p-2', 'data-layer-placement-panel': true },
    usablePresets.length > 0 ? h('div', { className: 'flex flex-col gap-1' },
      caption('Presets'),
      h('div', { className: 'flex flex-wrap gap-1' }, ...usablePresets.map((choice) => choiceButton(choice, 'preset')))) : null,
    usableRecent.length > 0 ? h('div', { className: 'flex flex-col gap-1' },
      caption('Recent'),
      showAllRecent
        ? h(FadingScrollList, { 'data-recent-placements': true } as React.HTMLAttributes<HTMLDivElement>, ...visibleRecent.map((choice) => choiceButton(choice, 'recent')))
        : h('div', { className: 'flex flex-col gap-1', 'data-recent-placements': true }, ...visibleRecent.map((choice) => choiceButton(choice, 'recent'))),
      usableRecent.length > RECENT_VISIBLE ? h(Button, {
        type: 'button', size: 'xs', variant: 'ghost', className: 'self-start',
        onClick: () => setShowAllRecent((value) => !value),
      }, showAllRecent ? 'Show less' : `Show ${usableRecent.length - RECENT_VISIBLE} more`) : null) : null,
    h('div', { className: 'flex flex-col gap-1' },
      caption('Layers'),
      h(DragReorderList, {
        items: layers.map((layer) => ({ id: layer.id, label: layerName(layer), content: layerRow(layer) })),
        onReorder: (frontToBack: string[]) => layoutActions.reorderLayers([...frontToBack].reverse()),
      }),
      h(Button, {
        type: 'button', size: 'xs', variant: 'ghost', className: 'self-start gap-1.5',
        onClick: () => layoutActions.createLayer(`Layer ${layers.length + 1}`),
      }, h(NamedIcon, { name: 'Plus', size: 'xs', 'aria-hidden': true }), 'New layer')),
  )
}
