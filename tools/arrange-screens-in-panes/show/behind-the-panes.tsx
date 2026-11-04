// parts/screen-arrangement/show/behind-the-panes.tsx
//
// PURPOSE
//   Lets any screen put something behind the panes, change it or take it away, without reaching into the arrangement:
//   a screen asks (`askBehindPanes`) and reads what is behind the panes now (`useBehindPanes`); the arrangement, once,
//   takes the asks (`TakeBehindPanesAsks`, mounted inside LayoutEngine) and writes them to its own background layers
//   through the same functions its Background menu uses (visual-layer-runtime setRegionLayer / removeRegionLayer). So a
//   screen such as Ambience offers "Put behind my screens" on itself instead of telling the person where a menu is.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: an ask names a layer capability by its id and hands its input; nothing here names a capability, a look or
//      a screen.
//   2. One writer: only the arrangement writes its layers; an ask with no arrangement listening says so (returns false)
//      and changes nothing.
//   3. One layer per capability behind the panes from an ask: putting again replaces it, so asks never stack copies.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

'use client'

import * as React from 'react'
import type { AddressRef, VisualLayerDescriptor } from '../../ui/show/visual-layer-stack'
import type { LayoutState } from '../read-data/layout-types'
import { regionAddressKey } from '../read-data/region-address'
import { removeRegionLayer, setRegionLayer } from './visual-layer-runtime'

/** What a screen can ask: put a capability's layer behind the panes (replacing one already there), change the input of
 *  the one there, or take it away. */
/** True inside an arrangement: an arrangement drawn inside one of its screens is nested and leaves the page
 *  (its background behind the whole page and the asks to change it) to the outermost one. */
export const InsideArrangement = React.createContext(false)
/** True for everything an arrangement draws when that arrangement is itself drawn inside another one's screen (set by
 *  LayoutEngine, which also checks the page, since a screen can be mounted in its own React root): the sidebar's pane
 *  map and Layouts belong to the outermost arrangement, so a nested one leaves them alone. */
export const NestedArrangement = React.createContext(false)

export type BehindPanesAsk =
  | { put: string; input: Record<string, unknown> }
  | { change: string; input: Record<string, unknown> }
  | { take: string }

const REGISTRY: AddressRef = { family: 'visual-layer.capabilities', parts: {} }
const BEHIND_Z = -1

type Taker = (ask: BehindPanesAsk) => void
let taker: Taker | null = null
let shown: readonly VisualLayerDescriptor[] = []
const listeners = new Set<() => void>()
const tell = () => listeners.forEach(listener => listener())

/** Ask the arrangement to change what is behind the panes; false when no arrangement is on this page to take it. */
export function askBehindPanes(ask: BehindPanesAsk): boolean {
  if (!taker) return false
  taker(ask)
  return true
}

type Behind = { listening: boolean; layers: readonly VisualLayerDescriptor[] }
let snapshot: Behind = { listening: false, layers: shown }
const readBehind = () => snapshot
const subscribeBehind = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** What is behind the panes now, and whether an arrangement is there to take asks. */
export function useBehindPanes(): Behind {
  return React.useSyncExternalStore(subscribeBehind, readBehind, readBehind)
}

const capabilityOf = (layer: VisualLayerDescriptor) => layer.paint.capability.capabilityId

/** Takes the asks for the arrangement's backdrop `region`; mounted once inside the arrangement, draws nothing. */
export function TakeBehindPanesAsks({ region, layoutState, applyLayoutState }: {
  region: AddressRef
  layoutState: LayoutState | null | undefined
  applyLayoutState: (next: LayoutState) => void
}): null {
  const layers = layoutState?.visualLayerStacks?.[regionAddressKey(region)]?.layers
  const latest = React.useRef({ layoutState, applyLayoutState, region })
  latest.current = { layoutState, applyLayoutState, region }
  React.useEffect(() => {
    shown = layers ?? []
    snapshot = { listening: true, layers: shown }
    tell()
  }, [layers])
  React.useEffect(() => {
    taker = (ask) => {
      const { layoutState: state, applyLayoutState: apply, region: at } = latest.current
      if (!state) return
      const current = state.visualLayerStacks?.[regionAddressKey(at)]?.layers ?? []
      if ('take' in ask) {
        let next = state
        for (const layer of current.filter(one => capabilityOf(one) === ask.take)) {
          removeRegionLayer(next, (written) => { next = written }, at, layer.id)
        }
        if (next !== state) apply(next)
        return
      }
      const existing = current.find(one => capabilityOf(one) === ('put' in ask ? ask.put : ask.change))
      if ('change' in ask) {
        if (existing) setRegionLayer(state, apply, at, { ...existing, paint: { ...existing.paint, input: ask.input } })
        return
      }
      const layer: VisualLayerDescriptor = existing
        ? { ...existing, enabled: true, paint: { ...existing.paint, input: ask.input } }
        : { id: `behind-${ask.put}`, order: { z: BEHIND_Z }, paint: { capability: { registry: REGISTRY, capabilityId: ask.put }, input: ask.input } }
      setRegionLayer(state, apply, at, layer)
    }
    return () => {
      taker = null
      snapshot = { listening: false, layers: [] }
      tell()
    }
  }, [])
  return null
}
