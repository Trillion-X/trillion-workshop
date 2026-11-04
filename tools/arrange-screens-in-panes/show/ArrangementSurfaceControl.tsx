'use client'

import React from 'react'
import { NamedIcon } from '../../ui/show/icon'
import { Button } from '../../ui/show/button'
import { ExpandableTabs } from '../../ui/show/expandable-tabs'
import { PlacementHistoryMenu } from '../../ui/show/placement-history'
import {
  LAST_PLACEMENT_KEY, PLACEMENT_MODES, RECENT_PLACEMENTS_KEY, SAVED_PLACEMENTS_KEY,
  isPlacementId, placementMode, readLastPlacement, readPlacementChoices, writePlacementChoices,
  type PlacementChoice,
} from '../read-data/placement-choices'
import {
  LayoutActionsContext,
  LayoutStateContext,
} from './screen-arrangement-context'
import type { OverlayLayout } from '../read-data/layout-types'

/**
 * Compact workspace placement selector. Grid and Canvas select the base
 * arrangement; PiP places the focused container in the overlay layer. One
 * click on a choice applies it: there is no confirm step.
 */
export default function ArrangementSurfaceControl({ embedded = false, targetContainerId, targetPosition }: {
  embedded?: boolean
  /** The container selected from the arrangement minimap. */
  targetContainerId?: string | null
  targetPosition?: { x: number; y: number } | null
}) {
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const [destinationLayerDraft, setDestinationLayerDraft] = React.useState<string | null>(null)
  const [lastPlacement, setLastPlacement] = React.useState<string | null>(readLastPlacement)
  const [recentChoices, setRecentChoices] = React.useState<PlacementChoice[]>(() => readPlacementChoices(RECENT_PLACEMENTS_KEY))
  const [savedChoices, setSavedChoices] = React.useState<PlacementChoice[]>(() => readPlacementChoices(SAVED_PLACEMENTS_KEY))
  if (!layoutState || !layoutActions) return null

  const overlay = layoutState.layouts.find((layout): layout is OverlayLayout => layout.type === 'overlay')
  const layers = [...(layoutState.layers ?? [])].sort((left, right) => left.z - right.z)
  const activeLayerId = layoutState.activeLayerId ?? layers[0]?.id
  const containerId = targetContainerId && layoutState.containers[targetContainerId]
    ? targetContainerId
    : layoutState.focusedContainerId
  const targetInOverlay = !!containerId
    && !!overlay?.containers.some((item) => item.containerId === containerId)
  const destinationLayer = layers.find((layer) => layer.id === destinationLayerDraft)
  const destinationHasTiles = !!destinationLayer?.layouts.some((layout) => layout.type === 'tiled' && !!layout.root)
  const destinationHasCanvasPanes = !!destinationLayer?.layouts.some((layout) => layout.type === 'floating' && layout.containers.length > 0)
  const destinationDefaultPlacement = destinationHasTiles && destinationHasCanvasPanes
    ? 'overlay' : destinationHasCanvasPanes ? 'canvas' : 'grid'
  const placementAllowedForLayer = (layerId: string, placement: string) => {
    const layer = layers.find((item) => item.id === layerId)
    if (!layer) return false
    const hasTiles = layer.layouts.some((layout) => layout.type === 'tiled' && !!layout.root)
    const hasCanvasPanes = layer.layouts.some((layout) => layout.type === 'floating' && layout.containers.length > 0)
    return (placement !== 'grid' || !hasCanvasPanes) && (placement !== 'canvas' || !hasTiles)
  }
  const placementAllowed = (placement: string) => !destinationLayerDraft || placementAllowedForLayer(destinationLayerDraft, placement)
  const recordChoice = (layerId: string, placement: string) => {
    if (!isPlacementId(placement)) return
    const choice: PlacementChoice = { id: `${layerId}:${placement}`, layerId, placement: placement as PlacementChoice['placement'] }
    setRecentChoices((current) => {
      const next = [choice, ...current.filter((item) => item.id !== choice.id)].slice(0, 20)
      writePlacementChoices(RECENT_PLACEMENTS_KEY, next)
      return next
    })
    try { window.localStorage.setItem(LAST_PLACEMENT_KEY, placement) } catch { /* storage is optional */ }
    setLastPlacement(placement)
  }
  const options = PLACEMENT_MODES.map((mode) => ({
    id: mode.id,
    label: mode.label,
    icon: mode.icon,
    disabled: mode.id === 'overlay' ? !containerId : !!destinationLayerDraft && !placementAllowed(mode.id),
  }))

  const apply = async (id: string) => {
    const targetId = containerId
    if (id === 'overlay') {
      if (targetId && !targetInOverlay) await layoutActions.toggleOverlay(targetId)
    } else {
      if (id !== 'grid' && id !== 'canvas') return
      if (targetId && targetInOverlay) await layoutActions.toggleOverlay(targetId)
      await layoutActions.setSurface(id)
    }
    if (activeLayerId) recordChoice(activeLayerId, id)
    else {
      try { window.localStorage.setItem(LAST_PLACEMENT_KEY, id) } catch { /* storage is optional */ }
      setLastPlacement(id)
    }
  }

  const moveToLayer = (layerId: string, placement: string) => {
    if (!containerId || !isPlacementId(placement)) return
    if (layerId === activeLayerId) { void apply(placement); return }
    if (!placementAllowedForLayer(layerId, placement)) return
    if (targetPosition) layoutActions.moveContainerToLayer(containerId, layerId, placement as PlacementChoice['placement'], targetPosition)
    else layoutActions.moveContainerToLayer(containerId, layerId, placement as PlacementChoice['placement'])
    layoutActions.setActiveLayer(layerId)
    recordChoice(layerId, placement)
    setDestinationLayerDraft(null)
  }
  const moveToSelectedLayer = (placement: string) => {
    if (destinationLayerDraft) moveToLayer(destinationLayerDraft, placement)
  }

  const selected = destinationLayerDraft ? destinationDefaultPlacement : targetInOverlay ? 'overlay' : layoutState.surface
  const lastLabel = lastPlacement ? placementMode(lastPlacement)?.label ?? null : null
  const layerLabel = (id: string, index: number) => layers.find((layer) => layer.id === id)?.name ?? `Layer ${index + 1}`
  const destinationLayers = layers.filter((layer) => layer.id !== activeLayerId)
  const visibleChoice = (choice: PlacementChoice) => layers.some((layer) => layer.id === choice.layerId)
    && (choice.layerId === activeLayerId || placementAllowedForLayer(choice.layerId, choice.placement))
  const choiceLabel = (choice: PlacementChoice) => {
    const layer = layers.find((item) => item.id === choice.layerId)
    return `${layer?.name ?? 'Layer'} · ${placementMode(choice.placement)?.label ?? choice.placement}`
  }
  const currentChoiceId = `${destinationLayerDraft ?? activeLayerId}:${selected}`
  const isSaved = savedChoices.some((choice) => choice.id === currentChoiceId)

  // Embedded groups sit inline; the standalone control floats bottom-right.
  const placementGroup = (...children: React.ReactNode[]) => React.createElement('div', {
    className: embedded
      ? 'flex shrink-0 items-center gap-1'
      : 'pointer-events-auto absolute bottom-4 right-4 z-[10031] flex shrink-0 items-center gap-1 rounded-xl bg-[var(--glass-bg-subtle)] p-1 shadow-md backdrop-blur-md max-sm:left-3 max-sm:right-auto',
  }, ...children)

  // Two rows: where the pane goes (the placement choice), then the actions on it (layers, presets,
  // history), each a 24px icon button on one line so the controls line up instead of wrapping wherever they fit.
  const row = (name: string, ...children: React.ReactNode[]) => React.createElement('div', { className: 'flex min-w-0 items-center gap-1', [`data-placement-${name}`]: true }, ...children)
  return React.createElement('div', { className: 'flex min-w-0 flex-col items-start gap-1', 'data-placement-control': true },
    row('choice',
      placementGroup(
      React.createElement(ExpandableTabs, {
        value: selected,
        items: options,
        ariaLabel: destinationLayerDraft ? 'Placement in destination layer' : 'Container placement',
        size: 'sm',
        // One click applies the choice, in this layer or in the layer the pane is moving to.
        onChange: (id: string) => {
          if (destinationLayerDraft) moveToSelectedLayer(id)
          else if (id !== selected) void apply(id)
        },
      }),
    ),
    lastLabel && lastPlacement !== selected && placementAllowed(lastPlacement)
      ? React.createElement(Button, {
          type: 'button', size: 'xs', variant: 'ghost',
          'aria-label': destinationLayerDraft ? `Move to layer as last placement: ${lastLabel}` : `Reuse last placement: ${lastLabel}`,
          onClick: () => { if (destinationLayerDraft) moveToSelectedLayer(lastPlacement!); else void apply(lastPlacement!) },
        }, React.createElement(NamedIcon, { name: 'RotateCcw', size: 'xs', 'aria-hidden': true }))
      : null,
    ),
    row('actions',
    layers.length > 1 ? placementGroup(React.createElement(ExpandableTabs, {
      value: activeLayerId ?? '',
      items: layers.map((layer, index) => ({
        id: layer.id,
        label: layerLabel(layer.id, index),
        icon: 'Layers3',
      })),
      ariaLabel: 'Arrangement layer',
      reserveHoverRoom: true,
      size: 'sm',
      onChange: (layerId: string) => {
        setDestinationLayerDraft(null)
        layoutActions.setActiveLayer(layerId)
      },
    })) : null,
    layers.length > 1 && containerId && destinationLayers.length > 0
      ? placementGroup(React.createElement(ExpandableTabs, {
          value: destinationLayerDraft ?? '',
          items: destinationLayers.map((layer) => ({
            id: layer.id,
            label: `Move to ${layer.name ?? layer.id}`,
            icon: 'ArrowRight',
          })),
          ariaLabel: 'Move pane to layer',
          reserveHoverRoom: true,
          size: 'sm',
          onChange: (layerId: string) => {
            setDestinationLayerDraft((current) => current === layerId ? null : layerId)
          },
        })) : null,
    React.createElement(Button, {
      type: 'button', size: 'icon-xs', variant: 'ghost',
      'aria-label': 'Create arrangement layer', title: 'Create arrangement layer',
      onClick: () => layoutActions.createLayer(`Layer ${layers.length + 1}`),
    }, React.createElement(NamedIcon, { name: 'Layers3', size: 'xs', 'aria-hidden': true })),
    containerId ? React.createElement(Button, {
      type: 'button', size: 'icon-xs', variant: isSaved ? 'accent' : 'ghost',
      'aria-label': isSaved ? 'Remove placement preset' : 'Save placement preset',
      title: isSaved ? 'Remove placement preset' : 'Save placement preset',
      onClick: () => {
        const layerId = destinationLayerDraft ?? activeLayerId
        if (!layerId || !isPlacementId(selected)
          || (layerId !== activeLayerId && !placementAllowedForLayer(layerId, selected))) return
        const choice: PlacementChoice = { id: currentChoiceId, layerId, placement: selected as PlacementChoice['placement'] }
        setSavedChoices((current) => {
          const next = isSaved ? current.filter((item) => item.id !== choice.id) : [choice, ...current].slice(0, 20)
          writePlacementChoices(SAVED_PLACEMENTS_KEY, next)
          return next
        })
      },
    }, React.createElement(NamedIcon, { name: 'Bookmark', size: 'xs', 'aria-hidden': true })) : null,
    containerId && (savedChoices.length > 0 || recentChoices.length > 0)
      ? React.createElement(PlacementHistoryMenu, {
          trigger: React.createElement(Button, { type: 'button', size: 'icon-xs', variant: 'ghost', 'aria-label': 'Saved and recent placements', title: 'Saved and recent placements' },
            React.createElement(NamedIcon, { name: 'History', size: 'xs', 'aria-hidden': true })),
          presets: savedChoices.filter(visibleChoice).map((choice) => ({ id: choice.id, label: choiceLabel(choice) })),
          recentChoices: recentChoices.filter(visibleChoice).map((choice) => ({ id: choice.id, label: choiceLabel(choice) })),
          onSelectPreset: (entry: { id: string }) => { const choice = savedChoices.find((item) => item.id === entry.id); if (choice) moveToLayer(choice.layerId, choice.placement) },
          onSelectChoice: (entry: { id: string }) => { const choice = recentChoices.find((item) => item.id === entry.id); if (choice) moveToLayer(choice.layerId, choice.placement) },
        }) : null,
    ),
  )
}
