// packages/ui/show/expandable-tabs/ExpandableTabs.tsx
//
// PURPOSE
//   The one icon-tab / action-group control. Icons sit in one bordered group;
//   the active item grows to show its label. Adapted from 21st.dev
//   "Expandable Tabs" by victorwelander (21st.dev component id 1428, MIT);
//   provenance.json records the upstream and every adaptation.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Items are DATA: {id, label, icon (NamedIcon name), disabled?} or
//      {type:'separator', id}. The control never names what it holds.
//   2. Nothing grows under the pointer (the owner 2026-10-04: hovering one item
//      pushed the others, so the pointer landed three items away). A pointed-at
//      item is named by the group's one hover label (tooltip/hover-labels.tsx,
//      the owner 2026-10-05: the names must show on hover): it opens after the
//      pointer rests on the item, moves at once to a neighbour, follows the
//      item's live box when the row resizes, and closes when the pointer leaves.
//      The chosen or pinned item shows its label in place, and keyboard focus
//      opens the focused item's label; blurring or pressing outside collapses it.
//      mode 'choice' is a picker: `value` also stays expanded; onChange(id).
//      mode 'action' is a toolbar: a press fires onSelect(id).
//   3. Every button keeps its accessible name while collapsed.
//   4. Appearance comes only from screen-look custom properties.
//   5. Reduced motion swaps state instantly instead of springing.
//   6. An action item may open a menu or popover: `wrap` receives the item's
//      button and returns it wrapped in that owner's trigger, so a toolbar of
//      menus is the same control as a toolbar of actions.
//   7. `detail` (what an item currently holds, "Project") and `badge` (a
//      count) are part of its accessible name; `pinned` keeps an item that
//      holds something open with its label, the way the chosen item stays open.
//   8. `reserveHoverRoom` (for a group inside a row that wraps): the group
//      reserves the room its widest label needs, as trailing space it gives
//      back while a label is open (same spring), so its outer width never
//      changes and the row never re-wraps or jumps between lines on focus.
//   9. `frame` 'group' (the default) draws the bordered glass group; 'none'
//      draws the items bare on whatever holds them (a chat box's bottom row),
//      their own hover and expansion unchanged.
//  10. A row of items wider than the room it is given wraps onto a second
//      line inside its group, so no item is ever cut off out of reach on a
//      narrow pane or a phone; a row that fits stays one line.
//  11. `labelDisplay` 'tooltip' keeps a constrained toolbar's icons stable,
//      including pinned and keyboard-focused items; the shared hover label
//      also names keyboard focus without taking any of the toolbar's space.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

'use client'

import * as React from 'react'
import { AnimatePresence, m as motion, useReducedMotion } from 'framer-motion'
import { MotionFeatures } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx'
import { cn } from '../cn'
import { NamedIcon } from '../icon'
import { controlTargetAttributes, controlTargetClass, type ControlTargetRole } from '../control-target/control-target'
import { useHoverLabels } from '../tooltip/hover-labels'

export type ExpandableTab = {
  id: string
  label: string
  icon: string
  disabled?: boolean
  type?: never
  /** What the item currently holds, shown after the label ("Group by · Project"). */
  detail?: string
  /** A small count beside the icon, visible while collapsed. */
  badge?: string | number
  /** Stay open with its label (an item that is currently applied). */
  pinned?: boolean
  /** Extra guidance for the tooltip; the visible label is never repeated. */
  tip?: string
  /** Wrap the button in a menu or popover trigger that owns what it opens. */
  wrap?: (button: React.ReactElement) => React.ReactNode
  /** A shared look this item wears instead of the row's own colours (for example the one close look, close-control). */
  look?: string
}
export type ExpandableTabSeparator = { type: 'separator'; id: string }
export type ExpandableTabItem = ExpandableTab | ExpandableTabSeparator

export type ExpandableTabsProps = {
  items: readonly ExpandableTabItem[]
  ariaLabel: string
  /** Both name the pointed-at item in its tooltip and open the keyboard-focused item. 'choice' also keeps `value` expanded; 'action' fires onSelect. */
  mode?: 'choice' | 'action'
  /** Selected item in choice mode. */
  value?: string | null
  onChange?: (id: string) => void
  /** Fired by every press in action mode. */
  onSelect?: (id: string) => void
  size?: 'sm' | 'md'
  className?: string
  disabled?: boolean
  /** The shared hit-target contract for every button (control-target). */
  targetRole?: ControlTargetRole
  /** Keep the group's outer width constant while labels open, so a wrapping row never jumps. */
  reserveHoverRoom?: boolean
  /** 'vertical' stacks the items for a toolbar docked on a left or right edge. */
  orientation?: 'horizontal' | 'vertical'
  /** 'group' draws the bordered glass group around the items; 'none' leaves them bare on what holds them. */
  frame?: 'group' | 'none'
  /** 'tooltip' names icons on hover and keyboard focus without expanding the row. */
  labelDisplay?: 'inline' | 'tooltip'
}

// Upstream timing, unchanged: spring, no bounce, 0.6s, 0.1s delay.
const transition = { delay: 0.1, type: 'spring', bounce: 0, duration: 0.6 } as const
const instant = { duration: 0 } as const
const labelVariants = {
  initial: { width: 0, opacity: 0 },
  animate: { width: 'auto', opacity: 1 },
  exit: { width: 0, opacity: 0 },
}

// md is the upstream geometry; sm fits a 36px list row. Every padding and gap
// is a multiple of 4px, so the control sits on the same grid as its toolbar.
// A framed group is a corner holder (screen-look nested-corners.css names each
// size's corner and the line plus padding to its buttons): its buttons' corners
// follow it, the group's corner less that gap. A bare row keeps each button's own.
const SIZE = {
  sm: { group: 'gap-0.5 p-0.5', bare: 'gap-0.5', button: 'h-7 rounded-lg text-xs', icon: 'xs', pad: ['.5rem', '.75rem'], gap: '.25rem' },
  md: { group: 'gap-2 p-1', bare: 'gap-2', button: 'h-9 rounded-xl text-sm', icon: 'md', pad: ['.5rem', '1rem'], gap: '.5rem' },
} as const

const remPx = () => (typeof document === 'undefined' ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
const toPx = (value: string) => (value.endsWith('rem') ? parseFloat(value) * remPx() : parseFloat(value) || 0)
const LABEL_TEXT = { sm: 'text-xs', md: 'text-sm' } as const

const isSeparator = (item: ExpandableTabItem): item is ExpandableTabSeparator => item.type === 'separator'

function ExpandableTabsMoving({
  items,
  ariaLabel,
  mode = 'choice',
  value = null,
  onChange,
  onSelect,
  size = 'md',
  className,
  disabled,
  targetRole = 'action',
  reserveHoverRoom = false,
  orientation = 'horizontal',
  frame = 'group',
  labelDisplay = 'inline',
}: ExpandableTabsProps) {
  const [active, setActive] = React.useState<string | null>(null)
  const hover = useHoverLabels()
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const reduceMotion = useReducedMotion()
  const look = SIZE[size]
  const motionTransition = reduceMotion ? instant : transition
  // What opening each label adds to the group's width, measured from hidden
  // copies of the labels; the group keeps the largest as reserved room.
  const sizerRef = React.useRef<HTMLSpanElement | null>(null)
  const [extras, setExtras] = React.useState<Record<string, number>>({})
  const labelKey = items.map((item) => isSeparator(item) ? item.id : `${item.id}\u0001${item.label}\u0001${item.detail ?? ''}`).join('\u0000')
  React.useLayoutEffect(() => {
    const sizer = sizerRef.current
    if (!sizer || !reserveHoverRoom || labelDisplay === 'tooltip') return
    const opening = toPx(look.gap) + 2 * (toPx(look.pad[1]) - toPx(look.pad[0]))
    const next: Record<string, number> = {}
    for (const node of Array.from(sizer.children) as HTMLElement[]) {
      const width = node.getBoundingClientRect().width
      if (width > 0) next[node.dataset.sizerFor!] = Math.ceil(width + opening)
    }
    setExtras((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
  }, [labelKey, look, reserveHoverRoom, labelDisplay])
  const openAtRest = (item: ExpandableTab) => (mode === 'choice' ? value === item.id : !!item.pinned)
  const reserve = !reserveHoverRoom || labelDisplay === 'tooltip' ? 0 : Math.max(0, ...items.filter((item): item is ExpandableTab => !isSeparator(item) && !openAtRest(item)).map((item) => extras[item.id] ?? 0))
  const activeItem = items.find((item): item is ExpandableTab => !isSeparator(item) && item.id === active)
  const opened = activeItem && !openAtRest(activeItem) ? extras[activeItem.id] ?? 0 : 0

  React.useEffect(() => {
    if (active === null) return
    const collapse = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setActive(null)
    }
    document.addEventListener('pointerdown', collapse)
    return () => document.removeEventListener('pointerdown', collapse)
  }, [active])

  return (
    <motion.div
      ref={rootRef}
      initial={false}
      animate={{ marginInlineEnd: Math.max(0, reserve - opened) }}
      transition={motionTransition}
      data-expandable-tabs-reserve={reserve || undefined}
      role={mode === 'choice' ? 'radiogroup' : 'toolbar'}
      aria-label={ariaLabel}
      aria-orientation={orientation}
      data-expandable-tabs={mode}
      data-expandable-tabs-frame={frame}
      data-expandable-tabs-size={size}
      data-expandable-tabs-labels={labelDisplay}
      data-corner-holder={frame === 'group' ? '' : undefined}
      onPointerLeave={() => setActive(null)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(null) }}
      className={cn(
        orientation === 'vertical' ? 'relative inline-flex max-h-full flex-col items-stretch' : 'relative inline-flex max-w-full flex-wrap items-center',
        frame === 'group' ? cn('border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] shadow-sm', look.group) : look.bare,
        disabled && 'opacity-50',
        className,
      )}
    >
      {items.map((item) => {
        if (isSeparator(item)) {
          return (
            <span
              key={item.id}
              aria-hidden="true"
              data-expandable-tabs-separator=""
              className={orientation === 'vertical' ? 'my-1 h-[1.2px] w-6 shrink-0 self-center bg-[var(--border-primary)]' : 'mx-1 h-6 w-[1.2px] shrink-0 bg-[var(--border-primary)]'}
            />
          )
        }
        const isExpanded = labelDisplay === 'inline' && (active === item.id || (mode === 'choice' ? value === item.id : !!item.pinned))
        const isChosen = mode === 'choice' ? value === item.id : !!item.pinned
        const name = [item.label, item.detail, item.badge !== undefined && item.badge !== '' && item.badge !== 0 ? String(item.badge) : ''].filter(Boolean).join(', ')
        const named = hover.bind(isExpanded ? item.tip ?? '' : [item.label, item.detail].filter(Boolean).join(' · ') + (item.tip ? `. ${item.tip}` : ''), {focus: labelDisplay === 'tooltip'})
        const button = (
          <motion.button
            key={item.id}
            type="button"
            role={mode === 'choice' ? 'radio' : undefined}
            aria-checked={mode === 'choice' ? isChosen : undefined}
            aria-label={name}
            {...named}
            data-pinned={item.pinned ? '' : undefined}
            disabled={disabled || item.disabled}
            data-expanded={isExpanded ? '' : undefined}
            data-corner-follows={frame === 'group' ? '' : undefined}
            {...controlTargetAttributes(targetRole)}
            initial={false}
            animate={{
              gap: isExpanded ? look.gap : '0rem',
              paddingLeft: isExpanded ? look.pad[1] : look.pad[0],
              paddingRight: isExpanded ? look.pad[1] : look.pad[0],
            }}
            transition={motionTransition}
            // Pointing never grows an item: a label that opened under the pointer pushed its neighbours, so the pointer
            // landed on another item (the owner 2026-10-04). The hover label names it; keyboard focus opens it in place.
            onFocus={(event) => { named.onFocus?.(event); if (labelDisplay === 'inline' && event.currentTarget.matches(':focus-visible')) setActive(item.id) }}
            onClick={() => (mode === 'choice' ? onChange?.(item.id) : onSelect?.(item.id))}
            className={cn(
              'relative inline-flex shrink-0 items-center font-medium transition-colors duration-300 motion-reduce:transition-none',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-40',
              look.button,
              controlTargetClass(targetRole),
              item.look
                ? item.look
                : isChosen
                ? 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <NamedIcon name={item.icon} size={look.icon} aria-hidden />
            {item.badge !== undefined && item.badge !== '' && item.badge !== 0 && (
              <span aria-hidden="true" data-expandable-tabs-badge="" className="expandable-tabs-badge">{item.badge}</span>
            )}
            <AnimatePresence initial={false}>
              {isExpanded ? (
                <motion.span
                  key="label"
                  aria-hidden="true"
                  variants={labelVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  transition={motionTransition}
                  className="overflow-hidden whitespace-nowrap"
                >
                  {item.label}
                  {item.detail && <span className="expandable-tabs-detail">{item.detail}</span>}
                </motion.span>
              ) : null}
            </AnimatePresence>
          </motion.button>
        )
        return item.wrap ? <React.Fragment key={item.id}>{item.wrap(button)}</React.Fragment> : button
      })}
      {hover.label}
      {reserveHoverRoom ? <span ref={sizerRef} aria-hidden="true" data-expandable-tabs-sizer="" className={cn('pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap font-medium', LABEL_TEXT[size])}>
        {items.map((item) => isSeparator(item) ? null : (
          // The text is drawn from an attribute so it adds nothing to the group's text.
          <span key={item.id} data-sizer-for={item.id} data-label={item.detail ? `${item.label} · ${item.detail}` : item.label} />
        ))}
      </span> : null}
    </motion.div>
  )
}

// Drawn inside MotionFeatures (ui/motion/lazy-motion.tsx): its motion arrives after the first paint, without remounting.
export function ExpandableTabs(props: React.ComponentProps<typeof ExpandableTabsMoving>) {
  return <MotionFeatures><ExpandableTabsMoving {...props} /></MotionFeatures>;
}
