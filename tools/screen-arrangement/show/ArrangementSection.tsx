// parts/screen-arrangement/show/ArrangementSection.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The sidebar's Arrangement section, the same in every mode: the mode switch
// and pane map (ArrangementNavigator, drawn into this section's map slot), then
// the Layouts picker. It is mounted once by the layout engine and draws into
// the sidebar's `arrangement-navigator` content host, so Tiles and Canvas both
// always show the mode switch, the map and the layouts.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. One section, one place: a portal into the sidebar's content host; no
//    floating copy and no second picker, also when two arrangements are each
//    outermost at once (the one on top draws it).
// 2. The tiled arranger draws its own map into the slot (it owns the tiles view
//    zoom). Whenever the active arrangement is not a tiled tree, this section
//    draws the map itself over the canvas viewport, moving the canvas camera
//    through the layout owner, so the slot is never empty of controls.
// 3. Adding at an empty canvas spot places a pane at that spot's canvas point.
//
// =============================================================================

'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of'
import { Text } from '../../ui/show/text'
import { newEmptyTab, type FloatingLayout, type TiledLayout } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/layout-types.ts'
import { baseGeometryForSurface } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/surface-modes.ts'
import { clampArrangementZoom } from './arrangement-zoom'
import { ArrangementNavigator, type ArrangementMapPoint } from './ArrangementNavigator'
import { LayoutPicker } from './LayoutPicker'
import { LayoutActionsContext, LayoutStateContext } from './screen-arrangement-context'

// The size a pane added from the map opens at, in canvas pixels.
const ADDED_PANE = { w: 480, h: 320 }

// Two arrangements can each be outermost at once (a screen held over the workspace draws its own arrangement beside
// the one behind it); both would portal into the same sidebar host. The one mounted last, the one on top, draws the
// section, and the one behind takes it back when the top one goes, so the sidebar always has exactly one.
const claims: symbol[] = []
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(listener => listener())
function useDrawsSection(): boolean {
  const [claim] = React.useState(() => Symbol('arrangement-section'))
  React.useEffect(() => {
    claims.push(claim)
    notify()
    return () => {
      claims.splice(claims.indexOf(claim), 1)
      notify()
    }
  }, [claim])
  return React.useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => claims[claims.length - 1] === claim,
    () => false,
  )
}

function useSidebarHost(): HTMLElement | null {
  const [host, setHost] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => {
    const find = () => setHost(document.querySelector<HTMLElement>('[data-sidebar-content-host="arrangement-navigator"]')
      ?? document.querySelector<HTMLElement>('[data-arrangement-navigator-host]'))
    find()
    const observer = new MutationObserver(find)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return host
}

/** The active layer's canvas viewport, followed as it mounts and unmounts. */
function useCanvasViewport(wanted: boolean): React.RefObject<HTMLElement | null> {
  const [element, setElement] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => {
    if (!wanted) {
      setElement(null)
      return
    }
    const find = () => setElement(document.querySelector<HTMLElement>('[data-active-layer] [data-arranger="freeform"]')
      ?? document.querySelector<HTMLElement>('[data-arranger="freeform"]'))
    find()
    const observer = new MutationObserver(find)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [wanted])
  return React.useMemo(() => ({ current: element }), [element])
}

export function ArrangementSection() {
  useShowChange()
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const host = useSidebarHost()
  const tiledTree = !!layoutState
    && baseGeometryForSurface(layoutState.surface) === 'tiled'
    && !!layoutState.layouts.find((layout): layout is TiledLayout => layout.type === 'tiled')?.root
  const floating = layoutState?.layouts.find((layout): layout is FloatingLayout => layout.type === 'floating') ?? null
  const canvasViewport = useCanvasViewport(!!host && !tiledTree)
  const draws = useDrawsSection()
  if (!draws || !host || !layoutState || !layoutActions || (!controlShown('arrangement.navigation') && !controlShown('arrangement.layouts'))) return null

  const camera = floating?.camera ?? { scale: 1, tx: 0, ty: 0 }
  const addOnCanvas = (point: ArrangementMapPoint) => {
    const scale = camera.scale || 1
    layoutActions.createFloatingContainerWithSurface(newEmptyTab(), {
      x: Math.round((point.x - camera.tx) / scale - ADDED_PANE.w / 2),
      y: Math.round((point.y - camera.ty) / scale - ADDED_PANE.h / 2),
      ...ADDED_PANE,
    })
  }

  return createPortal(
    <section aria-label="Arrangement" className="flex w-full min-w-0 flex-col gap-2 px-2 pb-2" data-arrangement-section>
      <div data-arrangement-map-host />
      {tiledTree ? null : (
        <ArrangementNavigator
          viewportRef={canvasViewport}
          zoom={camera.scale || 1}
          onZoomChange={(scale) => layoutActions.setCamera({ scale: clampArrangementZoom(scale) })}
          moveView={(delta) => layoutActions.setCamera({ tx: camera.tx - delta.x, ty: camera.ty - delta.y })}
          onAddAt={addOnCanvas}
          watch={floating}
        />
      )}
      {controlShown('arrangement.layouts') ? <><Text variant="label" color="secondary">Layouts</Text><LayoutPicker /></> : null}
    </section>,
    host,
  )
}
