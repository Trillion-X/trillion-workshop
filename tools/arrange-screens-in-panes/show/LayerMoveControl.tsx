// packages/screen-arrangement/show/LayerMoveControl.tsx
//
// Purpose: the container-header "Move to layer" control as one item of the
// pane's shared icon toolbar (ui ExpandableTabs). The item's button anchors
// LayerPlacementPanel, which opens beside the pane it moves.
// Invariants: shared ui ExpandableTabs item + AnchoredOverlay only; the item
// stays open with its name while the panel is open.

import React from 'react'
import { AnchoredOverlay } from '@/packages/ui/show/anchored-overlay'
import type { ExpandableTab } from '@/packages/ui/show/expandable-tabs'
import LayerPlacementPanel from '@/packages/screen-arrangement/show/LayerPlacementPanel'

const h = React.createElement

export function useLayerMoveItem(containerId: string): { item: ExpandableTab; toggle: () => void; panel: React.ReactNode } {
  const [open, setOpen] = React.useState(false)
  const anchor = React.useRef<HTMLSpanElement | null>(null)
  return {
    item: {
      id: 'layer',
      label: 'Move to layer',
      icon: 'Layers3',
      pinned: open,
      wrap: (button) => h('span', { ref: anchor, className: 'inline-flex' }, button),
    },
    toggle: () => setOpen((value) => !value),
    panel: h(AnchoredOverlay, {
      anchorRef: anchor, open, placement: 'below', gap: 6, onDismiss: () => setOpen(false),
    }, open ? h(LayerPlacementPanel, { containerId, onDone: () => setOpen(false) }) : null),
  }
}
