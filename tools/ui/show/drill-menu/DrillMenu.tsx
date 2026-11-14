// parts/ui/show/drill-menu/DrillMenu.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One calm popover menu that drills down without limit. A level is DATA: sections of rows (an icon, a label, a
// quiet hint, a check) or a panel (any live part: a picker, a form, a whole screen). A row that holds another
// level opens it beside itself as its own popover when pointed at or pressed, so a person can go as deep as the
// work needs and back out by moving away; inside a phone sheet the level opens in place with Back instead. The
// menu knows nothing about what its rows do: the caller hears which row was chosen.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Blind: no row, level or panel is named here; what a menu holds is the caller's DATA.
// 2. Nothing under the pointer moves: rows keep their size whether pointed at, pressed or open.
// 3. One road at every size: nested levels are side popovers on a wide screen and in-place steps in a phone sheet,
//    drawn by the same rows.
// 4. A level opened by pointing stays open while the pointer travels into it (the popover's safe path) and a press
//    on its row pins it (coss Popover).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../cn'
import { Button } from '../button'
import { Container } from '../container'
import { Text } from '../text'
import { NamedIcon } from '../icon'
import { Popover, PopoverPopup, PopoverTrigger } from '../coss/ui/popover'
import { usePhoneSheet } from '../phone-sheet/phone-sheet'

export type DrillRow = {
  readonly id: string
  readonly label: string
  /** A named icon (lucide name). */
  readonly icon: string
  /** Quiet words at the row's end: the current choice inside its level, a count. */
  readonly hint?: string
  /** 'danger' tints the row (closing, deleting). */
  readonly tone?: 'danger'
  /** A check at the row's end: this row is the current choice. */
  readonly checked?: boolean
  /** Drawn as switched on (a mode that is running). */
  readonly active?: boolean
  readonly disabled?: boolean
  /** Choosing the row leaves the menu open. */
  readonly keepOpen?: boolean
  /** The level this row opens instead of running. */
  readonly next?: DrillLevel
  /** Wraps the row's button (a drag handle that owns its own pointer). */
  readonly wrap?: (button: React.ReactElement) => React.ReactNode
  /** Extra attributes on the row (what tours and tests find it by). */
  readonly attrs?: Readonly<Record<string, string>>
}

export type DrillSection = {
  readonly id: string
  /** A quiet heading over the section. */
  readonly label?: string
  /** 'icons' draws the rows as one row of icon buttons (their labels as tooltips); 'rows' (default) as a list. */
  readonly look?: 'rows' | 'icons'
  readonly rows?: readonly DrillRow[]
  /** Any live part drawn as the section (a picker, a form, a screen). */
  readonly panel?: React.ReactNode
  readonly attrs?: Readonly<Record<string, string>>
}

export type DrillLevel = {
  readonly id: string
  readonly title: string
  readonly sections: readonly DrillSection[]
  /** How wide the level's popover is: 'menu' (default) for rows, 'panel' for a picker or a screen. */
  readonly width?: 'menu' | 'panel'
}

export type DrillMenuProps = {
  readonly level: DrillLevel
  /** A row without a level was chosen. */
  readonly onSelect: (row: DrillRow) => void
  /** Draw nested levels in place with Back (inside a phone sheet) instead of beside. Defaults to the phone sheet. */
  readonly inPlace?: boolean
  readonly className?: string
}

const LEVEL_WIDTH = { menu: 'w-64', panel: 'w-80' } as const

/** The menu: one level, its nested levels beside it or in place. */
export function DrillMenu({ level, onSelect, inPlace, className }: DrillMenuProps): React.ReactElement {
  const sheet = usePhoneSheet()
  const stacked = inPlace ?? sheet
  const [trail, setTrail] = React.useState<readonly DrillLevel[]>([])
  const shown = stacked ? (trail[trail.length - 1] ?? level) : level
  const choose = (row: DrillRow) => {
    if (row.next) { if (stacked) setTrail((current) => [...current, row.next!]); return }
    onSelect(row)
  }
  return (
    <Container layout="vertical" gap="none" className={cn('min-w-0', className)} data-drill-menu={level.id} data-drill-level={shown.id}>
      {stacked && trail.length > 0 ? (
        <Container layout="horizontal" gap="xs" alignItems="center" className="px-1 pb-1" data-drill-back>
          <Button type="button" variant="ghost" size="icon" aria-label="Back" title="Back" onClick={() => setTrail((current) => current.slice(0, -1))}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <Text variant="label" color="strong" className="truncate">{shown.title}</Text>
        </Container>
      ) : null}
      <DrillLevelView level={shown} stacked={stacked} onChoose={choose} />
    </Container>
  )
}

function DrillLevelView({ level, stacked, onChoose }: { level: DrillLevel; stacked: boolean; onChoose: (row: DrillRow) => void }) {
  return (
    <>
      {level.sections.map((section, index) => (
        <Container
          key={section.id}
          layout="vertical"
          gap="none"
          className={cn('py-1', index > 0 && 'border-t border-[var(--border-primary)]')}
          data-drill-section={section.id}
          {...section.attrs}
        >
          {section.label ? <Text variant="caption" color="muted" className="px-2 pb-1 pt-0.5">{section.label}</Text> : null}
          {section.rows?.length ? (
            section.look === 'icons' ? (
              <Container layout="horizontal" gap="none" alignItems="center" wrap className="px-1">
                {section.rows.map((row) => <IconRow key={row.id} row={row} onChoose={onChoose} />)}
              </Container>
            ) : section.rows.map((row) => (
              row.next && !stacked
                ? <NestedRow key={row.id} row={row} onChoose={onChoose} />
                : <ListRow key={row.id} row={row} onChoose={onChoose} />
            ))
          ) : null}
          {section.panel ? <Container layout="vertical" gap="none" className="min-w-0 px-1">{section.panel}</Container> : null}
        </Container>
      ))}
    </>
  )
}

function rowFace(row: DrillRow) {
  return (
    <>
      <NamedIcon name={row.checked ? 'Check' : row.icon} size="xs" aria-hidden />
      <Text as="span" variant="label" className="min-w-0 flex-1 truncate text-start text-inherit">{row.label}</Text>
      {row.hint ? <Text as="span" variant="caption" color="muted" className="shrink-0">{row.hint}</Text> : null}
      {row.next ? <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden /> : null}
    </>
  )
}

const rowTone = (row: DrillRow) => row.tone === 'danger' ? 'text-status-error hover:text-status-error' : undefined

function ListRow({ row, onChoose }: { row: DrillRow; onChoose: (row: DrillRow) => void }) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="menu"
      active={row.active}
      disabled={row.disabled}
      aria-checked={row.checked === undefined ? undefined : row.checked}
      data-drill-row={row.id}
      {...row.attrs}
      onClick={() => onChoose(row)}
      className={rowTone(row)}
    >
      {rowFace(row)}
    </Button>
  )
  return row.wrap ? <>{row.wrap(button)}</> : button
}

function IconRow({ row, onChoose }: { row: DrillRow; onChoose: (row: DrillRow) => void }) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      active={row.active}
      disabled={row.disabled}
      aria-label={row.label}
      title={row.label}
      data-drill-row={row.id}
      {...row.attrs}
      onClick={() => onChoose(row)}
      className={rowTone(row)}
    >
      <NamedIcon name={row.icon} size="xs" aria-hidden />
    </Button>
  )
  return row.wrap ? <>{row.wrap(button)}</> : button
}

// A row holding a level opens it beside itself when pointed at (after a short rest, so passing over a row on the way
// to another opens nothing) or pressed; the level stays open while the pointer travels into it.
function NestedRow({ row, onChoose }: { row: DrillRow; onChoose: (row: DrillRow) => void }) {
  const level = row.next!
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={200}
        render={
          <Button type="button" variant="ghost" size="menu" disabled={row.disabled} data-drill-row={row.id} {...row.attrs} className={rowTone(row)}>
            {rowFace(row)}
          </Button>
        }
      />
      <PopoverPopup side="right" align="start" sideOffset={2} className={cn(LEVEL_WIDTH[level.width ?? 'menu'], 'max-h-[80vh] overflow-hidden p-0')} portalProps={{ className: 'coss-ui' }} data-drill-popover={level.id}>
        <DrillLevelView level={level} stacked={false} onChoose={onChoose} />
      </PopoverPopup>
    </Popover>
  )
}
