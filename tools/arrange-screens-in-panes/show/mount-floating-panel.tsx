// packages/screen-arrangement/show/mount-floating-panel.tsx
//
// PURPOSE
// The one owner of panels that open over the page. A panel is a
// picture-in-picture window with minimal chrome (no tab bar): the shared ui
// FloatingPanelFrame supplies a grab strip, an optional title and a close
// button, and OverlayArranger supplies the same move and edge/corner resize
// behaviour every PiP container has. The window opens against the element
// that started it (below, or above when there is no room, clamped to the
// viewport), follows its content height until the person resizes it, and
// remembers its size per `kind`.
//
// Nothing here blocks the page: there is no backdrop, no aria-modal, no focus
// trap and no inert page. The work behind a panel stays usable. This is the
// replacement for every modal dialog; a blocking modal primitive no longer
// exists in the shared packages.
//
// Two kinds of panel:
// - Transient (`exclusive`, the default): a small panel opened from a menu or a
//   button. Opening it closes any open menu or other transient panel through
//   the shared ui owner (claimFloatingSurface).
// - Work (`exclusive: false`, opened through `openWorkPanel`): a form or
//   reader the person works in. Menus and choosers opened inside it do not
//   close it, and several can be open at once.
//
// INVARIANTS
// 1. The caller owns `body`; React never re-renders its children.
// 2. Escape and the close button both close; a `close` event fires on
//    `element`. Escape closes only the most recently opened panel, and never
//    while a chooser opened from inside it is still open.
// 3. Outside presses do not close it, so choosers portaled elsewhere keep it
//    open.

import React from 'react'
import OverlayArranger, { OverlayWindowContext, type OverlayBox } from './OverlayArranger'
import { LAYER_ORDER } from '../../ui/show/layer-order/layer-order'
import { mountSharedContent } from '../../ui/show/coss/shared-content'
import { claimFloatingSurface, releaseFloatingSurface, FloatingPanelFrame, type FloatingPanelRefs } from '../../ui/show/coss/floating-surface'

export type FloatingPanel = { element: HTMLElement; content: HTMLElement; body: HTMLElement; status?: HTMLElement; alert?: HTMLElement; close: () => void }
export type FloatingPanelSize = { w: number; h: number }
export type FloatingPanelOptions = {
  label: string
  /** Remembers the person's size per kind. Defaults to the label. */
  kind?: string
  /** Shown as a heading at the top of the panel. */
  title?: string
  /** One line under the title. */
  description?: string
  /** Ids of content that names and describes the panel, when the content carries its own heading. */
  labelledBy?: string
  describedBy?: string
  /** Size before the person resizes it; the height follows the content. */
  size?: FloatingPanelSize
  /** False for work panels: menus opened inside do not close it and several can be open. */
  exclusive?: boolean
  /** Adds a status and an alert line under the body, for callers that report into the panel. React callers bring their own. */
  liveRegions?: boolean
  /** Stacking layer from LAYER_ORDER, for a panel that must paint above what opened it (a walkthrough). Defaults to picture-in-picture. */
  layer?: number
  /** The close control's words and icon when closing puts the content back (an unpinned list pins back). */
  closeAs?: { label: string; icon: string }
  /** False: Escape leaves the panel open (the close button still closes it), for a panel that must not vanish by accident. */
  escapable?: boolean
  onClose?: () => void
}

const PADDING = 12
const GAP = 8
const DEFAULT_SIZE: FloatingPanelSize = { w: 380, h: 160 }
const WORK_SIZE: FloatingPanelSize = { w: 560, h: 240 }
const WIDE_WORK_SIZE: FloatingPanelSize = { w: 880, h: 320 }
const WINDOW_ID = 'floating-panel'
const FOCUSABLE = 'input:not([type=hidden]):not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])'
const sizeKey = (kind: string) => `floating-panel-size:${kind}`
function readSize(kind: string): FloatingPanelSize | null {
  try { const value = JSON.parse(localStorage.getItem(sizeKey(kind)) || 'null'); return value && value.w > 0 && value.h > 0 ? value : null } catch { return null }
}
function saveSize(kind: string, size: FloatingPanelSize) {
  try { localStorage.setItem(sizeKey(kind), JSON.stringify(size)) } catch { /* storage unavailable: the size is simply not remembered */ }
}

/** Open panels, oldest first; Escape closes the last one. */
const openPanels: { close: () => void }[] = []

/** Place a box of `size` against `anchor`: below and right-aligned, flipped above when it does not fit, clamped to the viewport. */
export function placeAgainst(anchor: Element | null, size: FloatingPanelSize): { x: number; y: number; w: number; h: number } {
  const vw = innerWidth, vh = innerHeight
  const w = Math.min(size.w, vw - PADDING * 2), h = Math.min(size.h, vh - PADDING * 2)
  const r = anchor?.isConnected ? anchor.getBoundingClientRect() : null
  if (!r) return { x: Math.round((vw - w) / 2), y: Math.round(Math.max(PADDING, (vh - h) / 3)), w, h }
  const below = r.bottom + GAP, above = r.top - GAP - h
  const x = Math.min(Math.max(PADDING, r.right - w), vw - PADDING - w)
  if (below + h <= vh - PADDING) return { x: Math.round(x), y: Math.round(below), w, h }
  if (above >= PADDING) return { x: Math.round(x), y: Math.round(above), w, h }

  // A tall work panel can fit neither above nor below a mid-screen trigger.
  // Prefer a clear side placement over dropping it onto the content that opened
  // it. Only use a side when the full panel fits inside the viewport.
  const sideY = Math.min(Math.max(PADDING, r.top), vh - PADDING - h)
  const right = r.right + GAP
  if (right + w <= vw - PADDING) return { x: Math.round(right), y: Math.round(sideY), w, h }
  const left = r.left - GAP - w
  if (left >= PADDING) return { x: Math.round(left), y: Math.round(sideY), w, h }

  // Very constrained viewports have no non-overlapping placement. Keep the
  // panel reachable and inside the window in that case.
  return { x: Math.round(x), y: Math.round(Math.max(PADDING, vh - PADDING - h)), w, h }
}

function PanelInWindow({ label, title, description, labelledBy, describedBy, liveRegions, closeAs, refs, onClose, children }: { label: string; title?: string; description?: string; labelledBy?: string; describedBy?: string; liveRegions: boolean; closeAs?: { label: string; icon: string }; refs: FloatingPanelRefs; onClose: () => void; children?: React.ReactNode }) {
  const overlay = React.useContext(OverlayWindowContext)
  return <FloatingPanelFrame label={label} title={title} description={description} labelledBy={labelledBy} describedBy={describedBy} liveRegions={liveRegions} closeAs={closeAs} refs={refs} onClose={onClose} onGrab={event => overlay?.onStartDrag?.(WINDOW_ID, event)}>{children}</FloatingPanelFrame>
}

type FloatingPanelWindowProps = Omit<FloatingPanelOptions, 'onClose'> & {
  anchor: Element | null
  refs: FloatingPanelRefs
  /** The person asked to close it (Escape, the close button, or a newer exclusive surface). */
  onRequestClose: () => void
  children?: React.ReactNode
}

/**
 * The one floating window. Both entry points render it: the React
 * FloatingPanel declaratively, and mountFloatingPanel into its own host.
 */
export function FloatingPanelWindow({ anchor, label, kind = label, title, description, labelledBy, describedBy, size = DEFAULT_SIZE, exclusive = true, liveRegions = true, layer, closeAs, escapable = true, refs, onRequestClose, children }: FloatingPanelWindowProps) {
  const remembered = React.useMemo(() => readSize(kind), [kind])
  const [box, setBox] = React.useState<OverlayBox>(() => ({ containerId: WINDOW_ID, z: 0, ...placeAgainst(anchor, remembered || size) }))
  const person = React.useRef({ moved: false, sized: false })
  const requestClose = React.useRef(onRequestClose)
  requestClose.current = onRequestClose
  const escapes = React.useRef(escapable)
  escapes.current = escapable
  React.useEffect(() => {
    const surface = { close: () => requestClose.current() }
    // Escape closes the newest panel unless a chooser opened from inside it is still open; that chooser closes first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !escapes.current || openPanels.at(-1) !== surface || document.querySelector('[data-slot=select-popup],[data-slot=menu-popup]')) return
      event.preventDefault(); requestClose.current()
    }
    openPanels.push(surface)
    if (exclusive) claimFloatingSurface(surface)
    addEventListener('keydown', onKey, true)
    return () => {
      const index = openPanels.indexOf(surface); if (index >= 0) openPanels.splice(index, 1)
      if (exclusive) releaseFloatingSurface(surface)
      removeEventListener('keydown', onKey, true)
    }
  }, [exclusive])
  // Opening moves focus into the panel's first control so the keyboard lands where the work is. Nothing traps it
  // there: the page behind stays reachable.
  React.useEffect(() => {
    queueMicrotask(() => {
      const body = refs.body
      if (!body?.isConnected || refs.element?.contains(document.activeElement)) return
      body.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true })
    })
  }, [refs])
  // Until the person sizes it, the window follows its content height; until they move it, it also stays against its anchor.
  React.useLayoutEffect(() => {
    const content = refs.content
    if (remembered || !content) return
    const observer = new ResizeObserver(() => {
      if (person.current.sized) return
      const h = content.offsetHeight + (refs.grab?.offsetHeight ?? 0) + 2
      setBox(current => Math.abs(h - current.h) < 1 ? current
        : person.current.moved ? { ...current, h: Math.min(h, innerHeight - PADDING - Math.max(current.y, PADDING)) }
        : { ...current, ...placeAgainst(anchor, { w: current.w, h }) })
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [remembered, anchor, refs])
  return <OverlayArranger
    layer={layer}
    boxes={[box]}
    onBringToFront={() => {}}
    onMove={(_id, xy) => { if (xy.x !== box.x || xy.y !== box.y) person.current.moved = true; setBox(current => ({ ...current, ...xy })) }}
    onResize={(_id, next) => { person.current.sized = true; saveSize(kind, next); setBox(current => ({ ...current, ...next })) }}
    renderContainer={() => <PanelInWindow label={label} title={title} description={description} labelledBy={labelledBy} describedBy={describedBy} liveRegions={liveRegions} closeAs={closeAs} refs={refs} onClose={() => requestClose.current()}>{children}</PanelInWindow>}
  />
}

export function mountFloatingPanel(anchor: Element | null, { onClose, ...options }: FloatingPanelOptions): FloatingPanel {
  const host = document.createElement('div'); host.className = 'floating-panel-host'; host.style.setProperty('--floating-panel-layer', String(LAYER_ORDER.pictureInPicture)); document.body.append(host)
  const refs: FloatingPanelRefs = {}
  let closed = false
  function close() {
    if (closed) return
    closed = true
    refs.element?.dispatchEvent(new Event('close')); onClose?.(); host.remove()
  }
  mountSharedContent(host, <FloatingPanelWindow anchor={anchor} {...options} refs={refs} onRequestClose={close} />)
  const { element, body, status, alert, content } = refs
  const liveRegions = options.liveRegions ?? true
  if (!element || !body || !content || (liveRegions && (!status || !alert))) { host.remove(); throw Error('The panel could not open.') }
  return { element, content, body, status, alert, close }
}

export type WorkPanelElement = HTMLElement & { close: () => void }

/**
 * Opens a work panel: a form or reader the person works in beside the page.
 * The returned element is the panel (marked `[data-work-panel]`); its
 * `[data-panel-body]` is where the
 * caller puts content, its `[role=alert]` shows errors, `close()` closes it
 * and a `close` event fires when it closes. Shared control tokens written into
 * it are upgraded to the shared controls.
 */
export function openWorkPanel(title: string, { anchor = document.activeElement, wide = false, kind = title }: { anchor?: Element | null; wide?: boolean; kind?: string } = {}): WorkPanelElement {
  // A work panel is what the person just opened, so it paints above page toolbars (the dialog layer it replaces).
  const panel = mountFloatingPanel(anchor instanceof Element && anchor !== document.body ? anchor : null, { label: title, kind: 'work:' + kind, title, size: wide ? WIDE_WORK_SIZE : WORK_SIZE, exclusive: false, layer: LAYER_ORDER.dialog })
  const element = panel.element as WorkPanelElement
  element.close = panel.close
  element.dataset.workPanel = ''
  panel.body.dataset.panelBody = ''
  panel.content.classList.add('coss-work-panel')
  // The shared controls the tokens become are fetched with the first work panel (they render their looks as they load).
  let stop: (() => void) | null = null
  let closed = false
  void import('../../ui/show/coss/dom-controls').then(({ decorateControls }) => { if (!closed) stop = decorateControls(panel.content) })
  element.addEventListener('close', () => { closed = true; stop?.() }, { once: true })
  return element
}
