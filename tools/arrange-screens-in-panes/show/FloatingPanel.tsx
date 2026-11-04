// packages/screen-arrangement/show/FloatingPanel.tsx
//
// PURPOSE
// The React way to open a panel over the page. It renders the one floating
// window (FloatingPanelWindow, the same one mountFloatingPanel draws): movable,
// resizable, and the page behind it stays usable. This replaces the retired
// blocking Modal: no backdrop, no aria-modal, no focus trap.
//
// INVARIANTS
// 1. `open` shows one panel; `open` false or unmount removes it. The person
//    closing it (Escape or the close button) calls `onClose`; `escapable`
//    false leaves Escape to the content.
// 2. Children render inside the panel as part of this React tree, so context
//    (theme, data, callbacks) reaches them unchanged and they appear in the
//    same render.
// 3. `width` sets the starting width in pixels; the height follows the
//    content until the person resizes the panel.

import type React from 'react'
import { useRef, useState } from 'react'
import type { FloatingPanelRefs } from '../../ui/show/coss/workspace-controls'
import { FloatingPanelWindow } from './mount-floating-panel'
import { LAYER_ORDER } from '../../ui/show/layer-order/layer-order'

export interface FloatingPanelProps {
  open: boolean
  onClose: () => void
  /** Heading and accessible name of the panel. */
  title?: string
  /** Accessible name when the content supplies its own heading. */
  label?: string
  /** One line under the title. */
  description?: string
  /** Ids of content that names and describes the panel, when the content carries its own heading. */
  labelledBy?: string
  describedBy?: string
  /** Starting width in pixels. */
  width?: number
  /** Remembers the person's size per kind. Defaults to the title. */
  kind?: string
  /** Stacking layer from LAYER_ORDER; defaults to the dialog layer, above page toolbars. Raise it for a panel that must paint above what opened it. */
  layer?: number
  /** False: Escape leaves the panel open; the close button still closes it. */
  escapable?: boolean
  children: React.ReactNode
}

const focusedElement = () => document.activeElement instanceof Element && document.activeElement !== document.body ? document.activeElement : null

export function FloatingPanel({ open, onClose, title, label, description, labelledBy, describedBy, width = 520, kind, layer, escapable, children }: FloatingPanelProps) {
  const refs = useRef<FloatingPanelRefs>({}).current
  // The panel opens against whatever the person was using when it opened.
  const [opening, setOpening] = useState<{ open: boolean; anchor: Element | null }>(() => ({ open, anchor: open ? focusedElement() : null }))
  if (opening.open !== open) setOpening({ open, anchor: open ? focusedElement() : null })
  if (!open) return null
  const name = title || label || 'Panel'
  return <FloatingPanelWindow
    anchor={opening.anchor}
    label={name}
    title={title}
    description={description}
    labelledBy={labelledBy}
    describedBy={describedBy}
    kind={'panel:' + (kind || name)}
    size={{ w: width, h: 240 }}
    exclusive={false}
    layer={layer ?? LAYER_ORDER.dialog}
    escapable={escapable}
    liveRegions={false}
    refs={refs}
    onRequestClose={onClose}
  >{children}</FloatingPanelWindow>
}
