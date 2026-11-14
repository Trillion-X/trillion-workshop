// packages/ui/show/disclosure-heading/DisclosureHeading.tsx
//
// Purpose
//   The one heading that folds a list: a sidebar list ("Work", "Tools") and a
//   group of records ("Week of September 20, 2026") are the same object. The
//   whole row is the button: hovering it lights the full width, a click
//   anywhere on it folds or unfolds what is under it, the chevron shows which
//   way it will go, and the count sits in the same neutral chip a sidebar row
//   uses for its badge. Actions the list offers (narrower, pin, a menu) wait at
//   the end and appear while the row is pointed at or focused.
//
// Non-negotiable invariants
//   1. Blind: the caller supplies the words, the count and the actions; this
//      names no kind of list.
//   2. One hit target: the label, the count and the chevron are inside the one
//      toggle, so there is no dead strip between them.
//   3. `aria-expanded` always tells the truth about what is under it.
//   4. Appearance lives in screen-look/show/disclosure-heading.css; the chevron
//      side (`chevron`) is a caller choice, never a second component.
//   5. `wrap` lets a caller put the toggle inside something that needs the
//      exact element (a hover card trigger) without re-implementing it.

import React from 'react'
import {Button} from '../coss/ui/button'
import {Badge} from '../badge/Badge'
import {NamedIcon} from '../icon'

export type DisclosureHeadingProps = {
  /** What the list is called; text or a caller-drawn label. */
  label: React.ReactNode
  /** The words a screen reader says for the toggle when `label` is not text. */
  accessibleLabel?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** How many things are under the heading; shown as a chip, with separators. */
  count?: number
  /** Which side of the words the chevron sits on. */
  chevron?: 'start' | 'end'
  /** Controls shown at the end while the heading is pointed at or focused. */
  actions?: React.ReactNode
  /** Keep the actions shown regardless (the list holds the current selection). */
  actionsShown?: boolean
  /** Told when the heading starts or stops being pointed at or focused. */
  onPointedChange?: (pointed: boolean) => void
  /** Nesting depth, for a heading inside another folded list. */
  depth?: number
  /** Puts the toggle inside another element that needs it (a hover card trigger). */
  wrap?: (toggle: React.ReactElement) => React.ReactElement
  className?: string
}

export function DisclosureHeading({label, accessibleLabel, open, onOpenChange, count, chevron = 'end', actions, actionsShown = false, onPointedChange, depth, wrap, className}: DisclosureHeadingProps) {
  const [pointed, setPointedState] = React.useState(false)
  const setPointed = (next: boolean) => { setPointedState(next); onPointedChange?.(next) }
  const revealed = actionsShown || pointed
  const counted = count === undefined ? '' : count.toLocaleString()
  const mark = <NamedIcon name="chevron-down" size="xs" aria-hidden className="disclosure-heading-chevron"/>
  const toggle = (
    <Button
      variant="ghost"
      className="disclosure-heading-toggle"
      aria-expanded={open}
      aria-label={accessibleLabel ? `${accessibleLabel}${counted ? `, ${counted}` : ''}` : undefined}
      data-disclosure-toggle=""
      onClick={() => onOpenChange(!open)}
    >
      {chevron === 'start' && mark}
      <span className="disclosure-heading-label">{label}</span>
      {counted && <Badge variant="neutral" size="sm" className="disclosure-heading-count">{counted}</Badge>}
      {chevron === 'end' && mark}
    </Button>
  )
  return (
    <div
      className={['disclosure-heading', className].filter(Boolean).join(' ')}
      data-open={open ? 'true' : 'false'}
      data-chevron={chevron}
      data-depth={depth}
      onPointerEnter={() => setPointed(true)}
      onPointerLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setPointed(false) }}
      onFocus={() => setPointed(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPointed(false) }}
    >
      {wrap ? wrap(toggle) : toggle}
      {actions && <span className="disclosure-heading-actions" data-revealed={revealed ? '' : undefined}>{actions}</span>}
    </div>
  )
}
