// parts/sidebar/show/SidebarBar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The thin bar the window's sidebar becomes when it is collapsed, on any window edge or on a seam between two panes:
// one line of icons along whichever way it lies, scrolling along it when they do not all fit (read-data/bar-fit.ts,
// bounded by the person's at most), empty space rows pushing them apart, and a More button holding any rows past that
// bound, the bar's own controls (where it sits, folding it away, how many icons show) and a way to show the names. A grip at its start
// moves it: dropped on an edge or a seam it docks there, dropped anywhere else it folds to a handle there.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The rows come from the same sections as the open list, flattened in order; no row is named here.
// 2. The rows scroll along the bar between its grip and what always shows; room never hides a row.
// 3. The open screen's row is always on the bar, scrolled into view; a list's own panel (bottomContent) is one icon
//    that opens it.
// 4. Spaces take no icon's place and never go behind More.
// 5. Pinned rows (the window controls' screens, the foot rows) always show, after the rows.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
// =============================================================================

import * as React from 'react';
import { ChevronDown, ChevronRight, GripHorizontal, GripVertical, Minus, MoreHorizontal, MoreVertical, Plus } from 'lucide-react';
import { Button, Container, Icon, Text, Tooltip } from '../../ui';
import { NamedIcon } from '../../ui/show/icon';
import { AnchoredOverlay } from '../../ui/show/anchored-overlay';
import { Popover, PopoverPopup, PopoverTrigger } from '../../ui/show/coss/ui/popover';
import type { DockFit } from '../../ui/show/dockable-placement/dockable-placement';
import { CollapsibleSection, NavItem, type NavItemData, type NavSectionData } from './SidebarContent';
import bar from '../read-data/sidebar-bar.json';
import { rowsShown, splitBarEntries, type BarEntry } from '../read-data/bar-fit';
import { SPACE_ROW_LOOK } from 'trillion-workshop/tools/organize-the-sidebar/read-data/space-row.ts';

/** One thing the bar can show: a screen's row, or a list's own panel opened from its icon. */
type BarRow =
  | { readonly kind: 'item'; readonly item: NavItemData }
  | { readonly kind: 'panel'; readonly section: NavSectionData };

const rowKey = (row: BarRow) => (row.kind === 'item' ? row.item.id : `panel:${row.section.id}`);

/** A list the person unpinned into its own panel: it keeps its own icon on the bar, which pins it back. */
const isUnpinned = (section: NavSectionData) => Boolean(section.collection) && section.attached === false;

/** The sections' rows in order (invariant 1): a list with a panel is its icon, then its rows, then its lists. */
function barEntries(sections: readonly NavSectionData[]): BarEntry<BarRow>[] {
  const entries: BarEntry<BarRow>[] = [];
  let index = 0;
  const walk = (section: NavSectionData) => {
    if (isUnpinned(section)) return;
    if (section.bottomContent && section.icon && section.collapsible) entries.push({ kind: 'row', row: { kind: 'panel', section }, index: index++ });
    for (const item of section.items) {
      if (item.look === SPACE_ROW_LOOK) entries.push({ kind: 'space', key: item.id });
      else entries.push({ kind: 'row', row: { kind: 'item', item }, index: index++ });
    }
    section.sections?.forEach(walk);
  };
  sections.forEach(walk);
  return entries;
}

/**
 * The one handle that moves a sidebar, drawn at the start of whatever strip the sidebar is (its thin bar when folded,
 * the open list when expanded): a press starts the move (show/place-drag.tsx). `axis` is the strip's own direction,
 * so the handle lies across it.
 */
export function SidebarMoveGrip({ thing, axis, onPointerDown }: {
  thing: string
  axis: 'vertical' | 'horizontal'
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
}) {
  const vertical = axis === 'vertical'
  return (
    <Tooltip label={`Move ${thing}`}>
      <Button
        variant="ghost"
        aria-label={`Move ${thing}`}
        onPointerDown={onPointerDown}
        className="shrink-0 cursor-grab touch-none p-0 text-[var(--text-muted)] active:cursor-grabbing"
        style={vertical ? { width: bar.row_px, height: bar.grip_px } : { width: bar.grip_px, height: bar.row_px }}
        data-sidebar-bar-grip=""
      >
        <Icon icon={vertical ? GripHorizontal : GripVertical} size="sm" />
      </Button>
    </Tooltip>
  )
}

export interface SidebarBarProps {
  /** `vertical`: the bar runs down (on a side, or between panes side by side); `horizontal`: across. */
  axis: 'vertical' | 'horizontal';
  sections: NavSectionData[];
  /** Rows that always show after the rows (the window controls' screens, the foot rows). */
  pinned: NavItemData[];
  currentSelectionId: string;
  onNavigate: (viewId: string) => void;
  onCollectionsChanged?: () => void | Promise<void>;
  onItemAction?: (item: NavItemData, actionId: string) => void;
  /** The person's bounds on how many icons show. */
  fit: DockFit | undefined;
  onFitChange: (fit: DockFit | undefined) => void;
  /** Where the bar sits and its other controls, drawn in the More popover. */
  controls: React.ReactNode;
  /** The grip that moves the bar (a pointer down starts the move); absent draws no grip. */
  onGripPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  /** What the bar holds, in words (`sidebar`). */
  thing: string;
  /** Shows the list with its names; absent draws no Expand button. */
  onExpand?: () => void;
}

export function SidebarBar({
  axis,
  sections,
  pinned,
  currentSelectionId,
  onNavigate,
  onCollectionsChanged,
  onItemAction,
  fit,
  onFitChange,
  controls,
  onGripPointerDown,
  thing,
  onExpand,
}: SidebarBarProps) {
  const vertical = axis === 'vertical';
  const rowsRef = React.useRef<HTMLDivElement | null>(null);

  const entries = React.useMemo(() => barEntries(sections), [sections]);
  const total = entries.filter((entry) => entry.kind === 'row').length;
  // Lists unpinned into their own panels keep their icons, which are pinned like the window's own screens (invariant 5).
  const unpinned = React.useMemo(() => {
    const found: NavSectionData[] = [];
    const walk = (section: NavSectionData) => { if (isUnpinned(section)) found.push(section); else section.sections?.forEach(walk); };
    sections.forEach(walk);
    return found;
  }, [sections]);
  const shown = rowsShown({ total, fit });
  const isOpen = (row: BarRow) => row.kind === 'item' && (currentSelectionId === row.item.id || currentSelectionId === row.item.viewId);
  const { onBar, behind } = splitBarEntries(entries, shown, isOpen);
  // The open screen's row scrolled into view along the bar (invariant 3), without moving anything else on the page.
  React.useLayoutEffect(() => {
    const rows = rowsRef.current;
    const open = rows?.querySelector<HTMLElement>('[data-sidebar-bar-row] [aria-current="true"]')?.closest<HTMLElement>('[data-sidebar-bar-row]');
    if (!rows || !open) return;
    const start = vertical ? open.offsetTop - rows.offsetTop : open.offsetLeft - rows.offsetLeft;
    const length = vertical ? open.offsetHeight : open.offsetWidth;
    const scrolled = vertical ? rows.scrollTop : rows.scrollLeft;
    const room = vertical ? rows.clientHeight : rows.clientWidth;
    const next = start < scrolled ? start : start + length > scrolled + room ? start + length - room : scrolled;
    if (next !== scrolled) rows.scrollTo(vertical ? { top: next } : { left: next });
  }, [currentSelectionId, vertical, shown]);
  // A bar lying across the window scrolls sideways under a mouse wheel too, which turns only up and down.
  React.useEffect(() => {
    const rows = rowsRef.current;
    if (!rows || vertical) return;
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || rows.scrollWidth <= rows.clientWidth) return;
      event.preventDefault();
      rows.scrollLeft += event.deltaY;
    };
    rows.addEventListener('wheel', wheel, { passive: false });
    return () => rows.removeEventListener('wheel', wheel);
  }, [vertical]);

  const [moreOpen, setMoreOpen] = React.useState(false);
  const [openPanel, setOpenPanel] = React.useState<string | null>(null);
  const panelAnchors = React.useRef(new Map<string, HTMLElement | null>());
  const moreRef = React.useRef<HTMLButtonElement | null>(null);
  const panelSection = openPanel ? entries.find((entry) => entry.kind === 'row' && entry.row.kind === 'panel' && entry.row.section.id === openPanel) : undefined;

  const cell = (key: string, child: React.ReactNode, extra: Record<string, string> = {}) => (
    <Container key={key} gap="none" className="flex shrink-0 items-center justify-center" style={{ width: bar.row_px, height: bar.row_px }} {...extra}>
      {child}
    </Container>
  );
  const drawRow = (row: BarRow) => row.kind === 'item'
    ? cell(rowKey(row), (
      <NavItem
        item={row.item}
        isActive={isOpen(row)}
        showLabel={false}
        onClick={() => onNavigate(row.item.viewId ?? row.item.id)}
        onCollectionsChanged={onCollectionsChanged}
        onItemAction={onItemAction}
      />
    ), { 'data-sidebar-bar-row': row.item.id })
    : cell(rowKey(row), (
      <Tooltip label={row.section.title ?? row.section.id}>
        <Button
          ref={(element: HTMLButtonElement | null) => { panelAnchors.current.set(row.section.id, element); }}
          variant="ghost"
          aria-label={row.section.title ?? row.section.id}
          aria-expanded={openPanel === row.section.id}
          active={openPanel === row.section.id}
          onClick={() => setOpenPanel((current) => (current === row.section.id ? null : row.section.id))}
          className="p-0"
        >
          <NamedIcon name={row.section.icon} size="lg" />
        </Button>
      </Tooltip>
    ), { 'data-sidebar-bar-panel': row.section.id });

  const atMost = fit?.max;
  const bound = (next: DockFit) => {
    const max = next.max !== undefined && next.max > 0 ? next.max : undefined;
    onFitChange(max === undefined ? undefined : { max });
  };
  // At most so many icons on the bar (the rest behind More); "All" when unbounded, and one more than all is all again.
  const stepper = (label: string, value: number | undefined, empty: string, change: (next: number | undefined) => void) => (
    <Container layout="horizontal" alignItems="center" gap="xs" className="justify-between" data-sidebar-bar-bound={label}>
      <Text variant="label" color="secondary">{label}</Text>
      <Container layout="horizontal" alignItems="center" gap="xs">
        <Button variant="ghost" size="icon" aria-label={`${label}: fewer`} disabled={value === 1 || total < 2}
          onClick={() => change(Math.max(1, (value ?? total) - 1))}>
          <Icon icon={Minus} size="sm" />
        </Button>
        <Text variant="label" className="w-14 text-center tabular-nums" data-sidebar-bar-bound-value="">{value ?? empty}</Text>
        <Button variant="ghost" size="icon" aria-label={`${label}: more`} disabled={value === undefined}
          onClick={() => change(value === undefined || value + 1 >= total ? undefined : value + 1)}>
          <Icon icon={Plus} size="sm" />
        </Button>
      </Container>
    </Container>
  );

  return (
    <Container
      layout={vertical ? 'vertical' : 'horizontal'}
      alignItems="center"
      gap="none"
      className="sidebar-bar h-full w-full min-h-0 min-w-0 overflow-hidden"
      style={{ padding: bar.padding_px, '--sidebar-bar-button': `${bar.button_px}px`, '--sidebar-bar-icon': `${bar.icon_px}px` } as React.CSSProperties}
      data-sidebar-bar={axis}
      data-sidebar-bar-shown={shown}
      data-sidebar-bar-behind={behind.length}
    >
      {onGripPointerDown ? <SidebarMoveGrip thing={thing} axis={axis} onPointerDown={onGripPointerDown} /> : null}
      {onExpand ? cell('expand', (
        <Tooltip label="Expand">
          <Button variant="ghost" aria-label="Expand" onClick={onExpand} className="p-0" data-sidebar-bar-expand="">
            <Icon icon={vertical ? ChevronRight : ChevronDown} size="lg" />
          </Button>
        </Tooltip>
      )) : null}
      {/* The rows scroll along the bar when they do not all fit (invariant 2), fading at an edge with more beyond it. */}
      <Container
        ref={rowsRef}
        layout={vertical ? 'vertical' : 'horizontal'}
        alignItems="center"
        gap="none"
        className={`sidebar-bar-rows min-h-0 min-w-0 ${vertical ? 'screen-edge-fade' : 'screen-edge-fade-x'}`}
        style={{ flex: '1 1 0px', '--screen-edge-fade-size': `${bar.row_px / 2}px` } as React.CSSProperties}
        data-sidebar-bar-rows=""
      >
        {onBar.map((entry) => (entry.kind === 'space'
          ? <Container key={entry.key} className="min-h-0 min-w-0" style={{ flex: '1 1 0px' }} data-sidebar-bar-space="" aria-hidden />
          : drawRow(entry.row)))}
      </Container>
      {unpinned.map((section) => cell(`unpinned:${section.id}`, (
        <CollapsibleSection section={section} currentSelectionId={currentSelectionId} showLabels={false} onNavigate={onNavigate} onCollectionsChanged={onCollectionsChanged} onItemAction={onItemAction} />
      ), { 'data-sidebar-bar-unpinned': section.id }))}
      {pinned.map((item) => cell(item.id, (
        <NavItem item={item} isActive={currentSelectionId === item.id || currentSelectionId === item.viewId} showLabel={false} onClick={() => onNavigate(item.viewId ?? item.id)} />
      ), { 'data-sidebar-bar-pinned': item.id }))}
      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger
          render={(
            <Button
              ref={moreRef}
              variant="ghost"
              aria-label={behind.length ? `More, ${behind.length} more` : 'More'}
              className="relative shrink-0 p-0"
              style={{ width: bar.more_px, height: bar.more_px }}
              data-sidebar-bar-more=""
            />
          )}
        >
          <Icon icon={vertical ? MoreVertical : MoreHorizontal} size="lg" />
        </PopoverTrigger>
        <PopoverPopup className="sidebar-list-popover w-72 max-h-[80vh] overflow-hidden p-0" side={vertical ? 'right' : 'bottom'} align="end" portalProps={{ className: 'coss-ui' }}>
          <Container layout="vertical" className="max-h-[80vh] overflow-y-auto p-2" gap="xs" data-sidebar-bar-more-list=""
            onClick={(event: React.MouseEvent) => { if ((event.target as Element).closest('[data-sidebar-activate]')) setMoreOpen(false); }}>
            {behind.map((row) => (row.kind === 'item'
              ? (
                <NavItem
                  key={rowKey(row)}
                  item={row.item}
                  isActive={isOpen(row)}
                  showLabel
                  onClick={() => onNavigate(row.item.viewId ?? row.item.id)}
                  onCollectionsChanged={onCollectionsChanged}
                  onItemAction={onItemAction}
                />
              ) : (
                <Button key={rowKey(row)} variant="ghost" className="w-full justify-start gap-3 px-3 h-9"
                  onClick={() => { setMoreOpen(false); setOpenPanel(row.section.id); }}>
                  <NamedIcon name={row.section.icon} size="lg" />
                  <Text className="truncate">{row.section.title ?? row.section.id}</Text>
                </Button>
              )))}
            <Container layout="vertical" gap="xs" className={behind.length ? 'mt-1 border-t border-[var(--border-primary)] pt-2' : ''} data-sidebar-bar-controls="">
              {stepper('At most', atMost, 'All', (next) => bound({ max: next }))}
              {controls}
            </Container>
          </Container>
        </PopoverPopup>
      </Popover>
      {panelSection && panelSection.kind === 'row' && panelSection.row.kind === 'panel' ? (
        <AnchoredOverlay
          anchorRef={{ current: panelAnchors.current.get(panelSection.row.section.id) ?? moreRef.current }}
          open
          placement="below"
          gap={6}
          onDismiss={() => setOpenPanel(null)}
        >
          <Container className="w-72 p-2" data-sidebar-rail-panel={panelSection.row.section.id}>{panelSection.row.section.bottomContent}</Container>
        </AnchoredOverlay>
      ) : null}
    </Container>
  );
}
