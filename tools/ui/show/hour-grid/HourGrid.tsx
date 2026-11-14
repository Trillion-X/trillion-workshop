// packages/ui/show/hour-grid/HourGrid.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Domain-blind timed-lane grid: a vertical minute axis (hour gutter + 1px
// hairline hour rows), N parallel lanes, an optional "now" marker line, and
// absolutely-positioned interval pills with a left color spine. It knows
// NOTHING about what an interval is — calendar events, bookings, shifts,
// machine jobs, court reservations are all just {startMinute, endMinute}
// items. Callers format every visible string (hour labels, lane headers,
// pill title/subtitle) and supply overlap placement (column/columnCount) —
// this primitive only lays out, styles, and routes selection.
//
// Reference anatomy (real Amie evidence, verified 2026-07-19 — see
// notes/projects/packages-and-package-sets/calendar/reference/
// 2026-07-19-real-amie-week-and-day-grid-evidence.md; the prior "W11 screen
// contract §4-§6" citation named a file that does not exist and is corrected
// here): muted right-aligned gutter labels (lowercase am/pm, e.g. "2 pm"),
// hairlines at ~6% white opacity, 1.5px accent now-line with a 6px gutter
// dot, pills = 3px spine (kept — visible in the App Store day-view
// reference) + solid pastel color wash (~32%, up from a too-faint 18% —
// both the substack week-view and App Store day-view show fully opaque,
// confident fills, not a translucent tint) + 8px radius + hue-matched title
// text (color-mix toward the pill's own color, not a flat neutral) +
// selected ring.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary — an item is an item; content arrives as data.
// 2. Geometry is data: startMinute/endMinute of the visible window and
//    pixels-per-hour are caller-supplied; nothing is hardcoded to a workday.
// 3. Overlap placement is caller-supplied DATA (column/columnCount) — the
//    packing policy is not this primitive's business.
// 4. Selection is routed, not owned — onSelectItem(key) fires; the caller
//    passes `selected` back down.
// 5. Dragging is routed too: an item marked `draggable` can be picked up
//    (the caller reads `data-hour-grid-item` in its own drag handlers, and
//    `data-hour-grid-lane` on the lane under the pointer); `dropMarker` is the
//    caller's preview of where a drop lands, drawn as a line in that lane.
// 6. The keys of a focused pill are the caller's keymap, not this file's: a caller that passes `commandRef` owns every key
//    (this file binds none) and is handed what only the grid can do, move focus to the neighbouring pill. A caller that
//    passes none gets Enter and Space to choose a focused pill, the one fallback every grid has.
// 7. Extra hour gutters (other time zones) are caller DATA: each draws the same rows with its own words, and the
//    zoom a Cmd-drag over the labels asks for is reported, never kept here.
//
// =============================================================================
//
// Interaction research: the Amie hour-grid captures above ground event scale and
// quiet grid lines. 21st.dev Inbox Calendar component 8088 was also reviewed
// for quick-selection hierarchy (captured in proof/amie-rebuild-2026-10-12/
// 21st-inbox-calendar.json); it is inspiration only and contributes no copied code.
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { cn } from '../cn';
import { Button } from '../coss/ui/button';
import { ColorDot } from '../color-dot';
import { durationAtDelta, minuteAtOffset } from '../schedule-calendar/schedule-placement.mjs';
import { neighborKey } from './neighbor.mjs';
import '../../../screen-look/show/schedule-calendar.css';

export interface HourGridItem {
  /** Caller-owned accessible action words and inactive state. */
  actionLabel?: string;
  inactive?: boolean;
  /** Stable identity — React key and the onSelectItem argument. */
  key: string;
  /** Interval start, minutes from the grid window's own zero. */
  startMinute: number;
  /** Interval end, minutes. Rendered height is clamped to a readable minimum. */
  endMinute: number;
  /** 0-based sub-column within an overlap cluster. */
  column: number;
  /** Total sub-columns in the cluster (width denominator). */
  columnCount: number;
  /** Spine + wash color (any CSS color). Falls back to the accent token. */
  color?: string;
  /** Primary line. */
  title: string;
  /** Secondary line, shown only when the pill is tall enough. */
  subtitle?: string;
  /** Selected pills get an elevated ring in their own color. */
  selected?: boolean;
  /** The thing is done: drawn quietly with its title struck through. */
  done?: boolean;
  /** Quiet pills render at reduced opacity (pending/tentative semantics live with the caller). */
  quiet?: boolean;
  /** The pill can be picked up and dragged (the caller handles the drag). */
  draggable?: boolean;
  /** The caller explicitly permits changing this timed interval's duration. */
  resizable?: boolean;
  /** Caller-owned shared control for selecting this item into a batch. */
  selectionControl?: React.ReactNode;
}

/** The caller's preview of where a dragged thing lands: a line at `minute` in one lane, with its words. */
export interface HourGridDropMarker {
  laneKey: string;
  minute: number;
  label: string;
}

/** What only the grid can do for a caller's keys: it knows how its pills lie in the lanes. */
export interface HourGridCommands {
  /** Focuses the pill next to this one (above, below, in the previous or the next lane); does nothing when there is none. */
  focusNeighbor: (key: string, direction: 'up' | 'down' | 'left' | 'right') => void;
}

/** One more hour gutter beside the first: the same rows read in another time zone, with the caller's words. */
export interface HourGridGutter {
  key: string;
  /** Heading above the gutter (a nickname). */
  heading?: string;
  /** The label of an hour row (hour = 0-23) in this gutter. */
  formatHourLabel: (hour: number) => string;
}

/** The local wall-clock interval treated as working time; an end before the start spans midnight. */
export interface HourGridWorkingHours {
  startMinute: number;
  endMinute: number;
}

export interface HourGridBanner {
  actionLabel?: string;
  inactive?: boolean;
  /** Stable identity — React key and the onSelectItem argument. */
  key: string;
  /** Single-line pill label. */
  title: string;
  /** Spine color. Falls back to the accent token. */
  color?: string;
  /** Selected banner gets an elevated ring; selection truth stays with the caller. */
  selected?: boolean;
  /** Quiet banners render at reduced opacity. */
  quiet?: boolean;
  /** Optional shared span across adjacent lanes, measured from the first lane. */
  startColumn?: number;
  columnSpan?: number;
  /** Stacked row in the shared banner strip. */
  row?: number;
  /** Caller-owned shared control for selecting this item into a batch. */
  selectionControl?: React.ReactNode;
}

export interface HourGridLane {
  /** Stable identity for the lane. */
  key: string;
  /** Caller-formatted header label (e.g. "Mon 20"). Omit to hide the header row. */
  headerLabel?: string;
  /** Optional short marker beside the heading, such as a day number. Caller-formatted. */
  headerBadge?: string;
  /** Emphasize this lane's header (e.g. today). */
  headerEmphasis?: boolean;
  /** Items positioned inside this lane. */
  items: HourGridItem[];
  /** Full-width untimed items rendered in the banner strip above the grid. */
  banners?: HourGridBanner[];
  /** Render the now-line in this lane (only meaningful with nowMinute set). */
  showNowLine?: boolean;
  /** Same-day available intervals for this lane. Empty means no available time;
   * undefined uses the grid's legacy workingHours. */
  workingIntervals?: HourGridWorkingHours[];
  /** Caller-owned time ranges drawn in this lane (for example slots being shared). */
  ranges?: HourGridRange[];
}

export interface HourGridRange {
  key: string;
  startMinute: number;
  endMinute: number;
  /** Caller-formatted label drawn in the band. */
  label: string;
  /** Caller-formatted accessible name of the control that removes the range. */
  removeLabel: string;
}

/** The rectangle, in the viewport, a chosen range covers in its lane: where a popover about the range opens. */
export interface HourGridAnchor { x: number; y: number; width: number; height: number }

export interface HourGridProps {
  /** Visible window start, in minutes (e.g. 420 = 7:00). */
  windowStartMinute: number;
  /** Visible window end, in minutes (e.g. 1260 = 21:00). */
  windowEndMinute: number;
  /** Vertical scale. Default 56px per hour. */
  hourHeightPx?: number;
  /** Caller-formatted gutter label for an hour row (hour = 0-23). */
  formatHourLabel: (hour: number) => string;
  /** Lanes (columns) left-to-right. */
  lanes: HourGridLane[];
  /** Minute for the now marker; omit to hide. */
  nowMinute?: number;
  /** `how.additive` is true when the pill was chosen with Command or Control held (a pick for a batch). */
  onSelectItem?: (key: string, how?: { additive: boolean }) => void;
  /** The caller owns the keys of a focused pill: the grid hands it what only the grid can do here and binds no key itself. */
  commandRef?: React.MutableRefObject<HourGridCommands | null>;
  /** A blank point in a lane was chosen. The caller owns the resulting time. */
  onSelectTime?: (laneKey: string, minute: number) => void;
  /** A pointer drag across a lane chose a time range, or the keyboard chose one snap interval. The caller owns the result. */
  onSelectRange?: (laneKey: string, startMinute: number, endMinute: number, anchor: HourGridAnchor) => void;
  /** The person removed one drawn lane range. */
  onRemoveRange?: (laneKey: string, rangeKey: string) => void;
  /** The keyboard help text supplied by the caller for slot selection. */
  selectionKeyboardHint?: string;
  /** The caller explicitly permits a resize by returning this callback. */
  onResizeItem?: (key: string, minutes: number) => void;
  /** Caller-formatted accessible label for a resize handle. */
  resizeLabel?: (title: string, minutes: number) => string;
  /** Snap interval used for slot selection and duration resize. Default 15 minutes. */
  snapMinutes?: number;
  /** Gutter width. Default 56px. */
  gutterWidthPx?: number;
  /** Minimum width for each day lane. Zero preserves the caller's fluid grid. */
  minLaneWidthPx?: number;
  /** Caller-formatted label for the banner-strip gutter cell (e.g. "All day"). */
  bannerGutterLabel?: string;
  /** Show only the first row of the banner strip; the rest are counted by `collapsedBannerLabel`. */
  bannersCollapsed?: boolean;
  collapsedBannerLabel?: (hidden: number) => string;
  /** Heading above the main gutter, and further gutters (other time zones) drawn to its left. */
  gutterHeading?: string;
  extraGutters?: HourGridGutter[];
  /** Holding Command or Control and dragging over the hour labels asks for this hour height (px), within the range. */
  onHourHeightChange?: (hourHeightPx: number) => void;
  minHourHeightPx?: number;
  maxHourHeightPx?: number;
  /** Accessible words for the label area while it can be dragged to zoom. */
  zoomDragLabel?: string;
  /** Where a drag would land, drawn in its lane. */
  dropMarker?: HourGridDropMarker | null;
  /** Local minutes in the day that are working time. Events remain visible outside this interval. */
  workingHours?: HourGridWorkingHours;
  /** The minute the hours start scrolled to when the grid first draws (e.g. 420 = 7:00). */
  initialScrollMinute?: number;
  /** The tallest the hours grow before they scroll inside the grid (any CSS length). Bounded by default to the screen,
   *  less room for what sits above it, so the hours scroll under their day headings wherever the grid is placed, even
   *  in a pane that scrolls as a whole. */
  maxScrollHeight?: string;
  className?: string;
}

// Amie reference (both real week-view and day-view screenshots, see
// 2026-07-19-real-amie-week-and-day-grid-evidence.md): hairlines at ~6%
// white opacity — barely-there row separators, not dominant grid lines.
const hairline = 'hour-grid-hairline';

/** Complement of available intervals, clipped to the displayed time window. */
function unavailableRanges(intervals: HourGridWorkingHours[], windowStart: number, windowEnd: number): HourGridWorkingHours[] {
  const available = intervals.filter(range => Number.isFinite(range.startMinute) && Number.isFinite(range.endMinute) && range.endMinute > range.startMinute)
    .map(range => ({ startMinute: Math.max(windowStart, range.startMinute), endMinute: Math.min(windowEnd, range.endMinute) }))
    .filter(range => range.endMinute > range.startMinute).sort((a, b) => a.startMinute - b.startMinute);
  const gaps: HourGridWorkingHours[] = [];
  let from = windowStart;
  for (const range of available) {
    if (range.startMinute > from) gaps.push({ startMinute: from, endMinute: range.startMinute });
    from = Math.max(from, range.endMinute);
  }
  if (from < windowEnd) gaps.push({ startMinute: from, endMinute: windowEnd });
  return gaps;
}

function clamp(minute: number, start: number, end: number): number {
  return Math.max(start, Math.min(end, minute));
}

function ItemPill({
  item,
  windowStartMinute,
  windowEndMinute,
  hourHeightPx,
  onSelect,
  onResize,
  resizeSnapMinutes,
  resizeLabel,
  ownsKeys,
}: {
  item: HourGridItem;
  windowStartMinute: number;
  windowEndMinute: number;
  hourHeightPx: number;
  onSelect?: (key: string, how?: { additive: boolean }) => void;
  onResize?: (key: string, minutes: number) => void;
  resizeSnapMinutes: number;
  resizeLabel?: (title: string, minutes: number) => string;
  ownsKeys: boolean;
}) {
  const start = clamp(item.startMinute, windowStartMinute, windowEndMinute);
  const end = Math.max(start + 15, clamp(item.endMinute, windowStartMinute, windowEndMinute));
  const startingMinutes = Math.max(1, end - start);
  const maxMinutes = Math.max(1, windowEndMinute - start);
  const canResize = Boolean(item.resizable && onResize && start < windowEndMinute);
  const [resizeMinutes, setResizeMinutes] = React.useState<number | null>(null);
  const [pointerResize, setPointerResize] = React.useState<{ id: number; y: number; minutes: number } | null>(null);
  const shownMinutes = Math.max(1, Math.min(maxMinutes, resizeMinutes ?? startingMinutes));
  const shownEnd = Math.min(windowEndMinute, start + shownMinutes);
  const top = ((start - windowStartMinute) / 60) * hourHeightPx;
  // Keep short appointments close to their actual duration. A 15-minute item
  // should read as a compact strip in a week view, not as a half-hour block.
  const height = Math.max(16, ((shownEnd - start) / 60) * hourHeightPx - 2);
  const wrapTitle = height >= 56;
  const widthPct = 100 / Math.max(1, item.columnCount);
  const color = item.color || 'var(--accent-purple)';
  const showSubtitle = !!item.subtitle && height >= (wrapTitle ? 72 : 40);

  const resizeTo = (raw: number) => Math.max(
    Math.min(resizeSnapMinutes, maxMinutes),
    Math.min(maxMinutes, Math.round(raw / Math.max(1, resizeSnapMinutes)) * Math.max(1, resizeSnapMinutes)),
  );
  const commitResize = (minutes: number) => {
    setPointerResize(null);
    setResizeMinutes(null);
    if (minutes !== startingMinutes) onResize?.(item.key, minutes);
  };

  // The wrapper owns absolute geometry and HTML dragging; the title and resize edge are sibling controls so the
  // accessible slider is never nested inside the selectable item.
  return (
    <div
      draggable={item.draggable || undefined}
      data-hour-grid-item={item.key}
      data-inactive={item.inactive || undefined}
      data-selected={item.selected || undefined}
      data-done={item.done || undefined}
      className={cn(
        'hour-grid-pill absolute text-left transition-[box-shadow,filter,opacity] duration-150',
        item.selected ? 'z-10 shadow-md' : 'hover:brightness-110',
        item.quiet ? 'opacity-60' : '',
        item.draggable ? 'cursor-grab active:cursor-grabbing' : '',
      )}
      style={{
        top,
        height,
        left: `calc(${item.column * widthPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        '--hour-grid-color': color,
      } as React.CSSProperties}
    >
      <ColorDot color={color} shape="spine" aria-hidden="true" />
      <div
        role="button"
        tabIndex={0}
        aria-pressed={item.selected ?? false}
        aria-label={item.actionLabel}
        className={cn(
          'hour-grid-pill-button absolute inset-0 overflow-hidden rounded-lg text-left',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
          item.draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        )}
        data-selection-control={item.selectionControl ? '' : undefined}
        onClick={(event) => { event.stopPropagation(); onSelect?.(item.key, { additive: event.metaKey || event.ctrlKey }); }}
        onKeyDown={(event) => {
          if (ownsKeys || !onSelect || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          event.stopPropagation();
          onSelect(item.key, { additive: false });
        }}
      >
        <span className={cn('hour-grid-pill-title block', wrapTitle ? 'hour-grid-pill-title--wrap' : 'truncate')}>{item.title}</span>
        {showSubtitle ? (
          <span className="hour-grid-pill-subtitle block truncate text-[length:var(--font-size-caption)]">{item.subtitle}</span>
        ) : null}
      </div>
      {item.selectionControl ? <span className="absolute left-0.5 top-0 z-10">{item.selectionControl}</span> : null}
      {canResize ? (
        <div
          role="slider"
          tabIndex={0}
          aria-label={resizeLabel?.(item.title, shownMinutes) ?? item.title}
          aria-orientation="vertical"
          aria-valuemin={Math.min(resizeSnapMinutes, maxMinutes)}
          aria-valuemax={maxMinutes}
          aria-valuenow={shownMinutes}
          aria-valuetext={resizeLabel?.(item.title, shownMinutes) ?? `${shownMinutes}`}
          aria-keyshortcuts="ArrowUp ArrowDown Home End Enter Escape"
          data-hour-grid-resize-handle
          className="hour-grid-resize-handle"
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            setResizeMinutes(startingMinutes);
            setPointerResize({ id: event.pointerId, y: event.clientY, minutes: startingMinutes });
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!pointerResize || pointerResize.id !== event.pointerId) return;
            const next = durationAtDelta(pointerResize.minutes, event.clientY - pointerResize.y, hourHeightPx, {
              snap: resizeSnapMinutes,
              min: Math.min(resizeSnapMinutes, maxMinutes),
              max: maxMinutes,
            });
            setResizeMinutes(next);
          }}
          onPointerUp={(event) => {
            if (!pointerResize || pointerResize.id !== event.pointerId) return;
            const next = durationAtDelta(pointerResize.minutes, event.clientY - pointerResize.y, hourHeightPx, {
              snap: resizeSnapMinutes,
              min: Math.min(resizeSnapMinutes, maxMinutes),
              max: maxMinutes,
            });
            event.preventDefault();
            event.stopPropagation();
            commitResize(next);
          }}
          onPointerCancel={(event) => {
            if (pointerResize?.id !== event.pointerId) return;
            setPointerResize(null);
            setResizeMinutes(null);
          }}
          onLostPointerCapture={(event) => {
            if (pointerResize?.id !== event.pointerId) return;
            setPointerResize(null);
            setResizeMinutes(null);
          }}
          onKeyDown={(event) => {
            const direction = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
            if (direction) {
              event.preventDefault();
              event.stopPropagation();
              setResizeMinutes((current) => resizeTo((current ?? startingMinutes) + direction * resizeSnapMinutes));
              return;
            }
            if (event.key === 'Home') {
              event.preventDefault();
              setResizeMinutes(Math.min(resizeSnapMinutes, maxMinutes));
            } else if (event.key === 'End') {
              event.preventDefault();
              setResizeMinutes(maxMinutes);
            } else if ((event.key === 'Enter' || event.key === ' ') && resizeMinutes !== null) {
              event.preventDefault();
              event.stopPropagation();
              commitResize(resizeMinutes);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setResizeMinutes(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function BannerPill({ banner, onSelect, laneCount }: { banner: HourGridBanner; onSelect?: (key: string, how?: { additive: boolean }) => void; laneCount: number }) {
  const color = banner.color || 'var(--accent-purple)';
  return (
    <div
      data-hour-grid-item={banner.key}
      data-selected={banner.selected || undefined}
      data-inactive={banner.inactive || undefined}
      className={cn('absolute', banner.quiet && 'opacity-60')}
      style={{
        zIndex: banner.selectionControl ? 2 : 1,
        left: `${((banner.startColumn ?? 0) / laneCount) * 100}%`,
        width: `${((banner.columnSpan ?? 1) / laneCount) * 100}%`,
        top: `${(banner.row ?? 0) * 1.75}rem`,
        height: '1.5rem',
      }}
    >
      <Button
        variant="ghost"
        aria-pressed={banner.selected ?? false}
        aria-label={banner.actionLabel}
        data-selected={banner.selected || undefined}
        className={cn(
          'hour-grid-banner h-full w-full min-w-0 justify-start truncate px-2 py-0.5 text-left text-[length:var(--font-size-caption)] font-semibold text-[var(--text-primary)]',
          'transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
        )}
        data-selection-control={banner.selectionControl ? '' : undefined}
        style={{ '--hour-grid-color': color } as React.CSSProperties}
        onClick={onSelect ? (event) => onSelect(banner.key, { additive: event.metaKey || event.ctrlKey }) : undefined}
      ><ColorDot color={color} shape="spine" aria-hidden="true" />{banner.title}</Button>
      {banner.selectionControl ? <span className="absolute left-0.5 top-0 z-10">{banner.selectionControl}</span> : null}
    </div>
  );
}

export function HourGrid({
  windowStartMinute,
  windowEndMinute,
  hourHeightPx = 56,
  formatHourLabel,
  lanes,
  nowMinute,
  onSelectItem,
  commandRef,
  onSelectTime,
  onSelectRange,
  onRemoveRange,
  selectionKeyboardHint,
  onResizeItem,
  resizeLabel,
  snapMinutes = 15,
  gutterWidthPx = 56,
  minLaneWidthPx = 0,
  bannerGutterLabel,
  bannersCollapsed = false,
  collapsedBannerLabel,
  gutterHeading,
  extraGutters = [],
  onHourHeightChange,
  minHourHeightPx = 24,
  maxHourHeightPx = 160,
  zoomDragLabel,
  dropMarker,
  workingHours,
  initialScrollMinute,
  maxScrollHeight = 'max(20rem, calc(100dvh - 14rem))',
  className,
}: HourGridProps) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const previousHourHeight = React.useRef(hourHeightPx);
  const selectionHintId = React.useId();
  const [slotMinutes, setSlotMinutes] = React.useState<Record<string, number>>({});
  const [zoomDrag, setZoomDrag] = React.useState<{ id: number; y: number; hourHeightPx: number } | null>(null);
  const focusNeighbor = (from: string, direction: 'up' | 'down' | 'left' | 'right') => {
    const target = neighborKey(lanes, from, direction);
    if (target === null) return;
    scroller.current?.querySelector<HTMLElement>(`[data-hour-grid-item="${CSS.escape(target)}"] .hour-grid-pill-button`)?.focus();
  };
  React.useEffect(() => {
    if (!commandRef) return undefined;
    commandRef.current = { focusNeighbor };
    return () => { commandRef.current = null; };
  });
  const [dragRange, setDragRangeState] = React.useState<{ laneKey: string; anchor: number; head: number } | null>(null);
  // The drag as the pointer last left it: pointerup can arrive before the render that follows the last move.
  const draggingRange = React.useRef<{ laneKey: string; anchor: number; head: number } | null>(null);
  const setDragRange = (next: { laneKey: string; anchor: number; head: number } | null) => { draggingRange.current = next; setDragRangeState(next); };
  const selecting = Boolean(onSelectTime || onSelectRange);
  const rangeAnchor = (bounds: DOMRect, start: number, end: number): HourGridAnchor => {
    const span = windowEndMinute - windowStartMinute;
    return { x: bounds.left, y: bounds.top + ((start - windowStartMinute) / span) * bounds.height, width: bounds.width, height: ((end - start) / span) * bounds.height };
  };
  const snapStep = Math.max(1, Math.floor(snapMinutes));
  // Scrolled to the starting minute when the grid first draws, and again as its pane takes its height (a grid drawn
  // inside a list that lays out after it cannot scroll that far yet), until it reaches that minute or the person
  // scrolls it themselves; after that the scroll position is the person's.
  React.useLayoutEffect(() => {
    const element = scroller.current;
    if (initialScrollMinute === undefined || !element) return;
    const target = Math.max(0, ((initialScrollMinute - windowStartMinute) / 60) * hourHeightPx);
    // The hour label sits half a rem above its grid line. Leave that much room
    // above the requested start so the first visible label is not clipped.
    const labelClearance = parseFloat(getComputedStyle(document.documentElement).fontSize) / 2;
    const scrollTarget = Math.max(0, target - labelClearance);
    const reached = () => { element.scrollTop = scrollTarget; return element.scrollHeight - element.clientHeight >= scrollTarget; };
    if (reached() || typeof ResizeObserver === 'undefined') return;
    const watcher = new ResizeObserver(() => { if (reached()) stop(); });
    const theirs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    const stop = () => { watcher.disconnect(); for (const kind of theirs) element.removeEventListener(kind, stop); };
    for (const kind of theirs) element.addEventListener(kind, stop, { passive: true });
    watcher.observe(element);
    for (const child of element.children) watcher.observe(child);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Keep the same time at the top when the caller changes zoom.
  React.useLayoutEffect(() => {
    const previous = previousHourHeight.current;
    previousHourHeight.current = hourHeightPx;
    if (scroller.current && previous > 0 && previous !== hourHeightPx) scroller.current.scrollTop *= hourHeightPx / previous;
  }, [hourHeightPx]);
  const firstHour = Math.floor(windowStartMinute / 60);
  const lastHour = Math.ceil(windowEndMinute / 60);
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  const nowOffset = nowMinute !== undefined && nowMinute >= windowStartMinute && nowMinute <= windowEndMinute
    ? ((nowMinute - windowStartMinute) / 60) * hourHeightPx
    : null;
  const laneMin = minLaneWidthPx > 0 ? `${minLaneWidthPx}px` : '0px';
  const minimumGridWidth = minLaneWidthPx > 0 ? gutterWidthPx + minLaneWidthPx * lanes.length : undefined;
  const gutters = [...extraGutters, { key: 'main', heading: gutterHeading, formatHourLabel }];
  const columnsStyle = { gridTemplateColumns: `${gutterWidthPx * gutters.length}px repeat(${Math.max(1, lanes.length)}, minmax(${laneMin}, 1fr))` };
  const hasHeaders = lanes.some((lane) => lane.headerLabel);
  const hasBanners = Boolean(bannerGutterLabel) || lanes.some((lane) => (lane.banners?.length ?? 0) > 0);
  const banners = lanes.flatMap((lane, laneIndex) => (lane.banners ?? []).map((banner, localRow) => ({
    ...banner,
    startColumn: banner.startColumn ?? laneIndex,
    columnSpan: banner.columnSpan ?? 1,
    row: banner.row ?? localRow,
  })));
  const allBannerRows = banners.reduce((max, banner) => Math.max(max, (banner.row ?? 0) + 1), 0);
  const bannerRows = bannersCollapsed ? Math.min(1, allBannerRows) : allBannerRows;
  const hiddenBanners = bannersCollapsed ? banners.filter(banner => (banner.row ?? 0) >= 1).length : 0;
  const shownBanners = bannersCollapsed ? banners.filter(banner => (banner.row ?? 0) < 1) : banners;
  const nonWorkingRanges: { startMinute: number; endMinute: number }[] = [];
  if (workingHours && Number.isFinite(workingHours.startMinute) && Number.isFinite(workingHours.endMinute)) {
    const start = Math.max(0, Math.min(1440, Math.floor(workingHours.startMinute)));
    const end = Math.max(0, Math.min(1440, Math.floor(workingHours.endMinute)));
    const raw = start < end
      ? [{ startMinute: 0, endMinute: start }, { startMinute: end, endMinute: 1440 }]
      : start > end
        ? [{ startMinute: end, endMinute: start }]
        : [{ startMinute: 0, endMinute: 1440 }];
    for (const range of raw) {
      const clipped = {
        startMinute: Math.max(windowStartMinute, range.startMinute),
        endMinute: Math.min(windowEndMinute, range.endMinute),
      };
      if (clipped.endMinute > clipped.startMinute) nonWorkingRanges.push(clipped);
    }
  }

  return (
    <div data-hour-grid className={cn('hour-grid flex min-h-0 flex-1 flex-col', className)} style={{ minWidth: minimumGridWidth }}>
      {selecting && selectionKeyboardHint ? <span id={selectionHintId} className="sr-only">{selectionKeyboardHint}</span> : null}
      {hasHeaders ? (
        <div className={cn('grid shrink-0 border-b', hairline)} style={columnsStyle}>
          <div className="flex" data-hour-grid-gutter-headings="">
            {gutters.map(gutter => <span key={gutter.key} className="hour-grid-gutter-heading min-w-0 flex-1 truncate px-1 text-right text-[length:var(--font-size-caption)] text-[var(--text-muted)]">{gutter.heading}</span>)}
          </div>
          {lanes.map((lane) => (
            <div key={lane.key} className="hour-grid-day-heading" data-hour-grid-heading={lane.key} data-emphasis={lane.headerEmphasis || undefined}>
              <span className="hour-grid-day-label">
                {lane.headerLabel}
              </span>
              {lane.headerBadge ? <span className={cn('hour-grid-day-number', lane.headerEmphasis && 'hour-grid-day-today')}>{lane.headerBadge}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {hasBanners ? (
        <div className={cn('grid shrink-0 border-b', hairline)} style={columnsStyle}>
          <div className="px-2 py-1.5">
            <span className="block text-[length:var(--font-size-caption)] text-[var(--text-muted)]">{bannerGutterLabel}</span>
            {hiddenBanners > 0 && collapsedBannerLabel ? <span data-hour-grid-banners-hidden="" className="block text-[length:var(--font-size-caption)] text-[var(--text-muted)]">{collapsedBannerLabel(hiddenBanners)}</span> : null}
          </div>
          <div className="relative min-w-0" style={{ gridColumn: '2 / -1', height: `${Math.max(1.75, bannerRows * 1.75)}rem` }}>
            {shownBanners.map((banner, index) => <BannerPill key={`${banner.startColumn}:${banner.row}:${index}:${banner.key}`} banner={banner} onSelect={onSelectItem} laneCount={lanes.length} />)}
          </div>
        </div>
      ) : null}

      <div ref={scroller} className="grid min-h-0 flex-1 overflow-auto" style={{ ...columnsStyle, maxHeight: maxScrollHeight }}>
        <div
          className={cn('flex border-r', hairline, onHourHeightChange && 'hour-grid-zoomable')}
          data-hour-grid-gutters=""
          data-zooming={zoomDrag ? '' : undefined}
          title={onHourHeightChange ? zoomDragLabel : undefined}
          onPointerDown={onHourHeightChange ? (event) => {
            if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            setZoomDrag({ id: event.pointerId, y: event.clientY, hourHeightPx });
            event.currentTarget.setPointerCapture(event.pointerId);
          } : undefined}
          onPointerMove={onHourHeightChange ? (event) => {
            if (!zoomDrag || zoomDrag.id !== event.pointerId) return;
            onHourHeightChange(Math.round(clamp(zoomDrag.hourHeightPx + (event.clientY - zoomDrag.y) / 4, minHourHeightPx, maxHourHeightPx)));
          } : undefined}
          onPointerUp={zoomDrag ? (event) => { if (zoomDrag.id === event.pointerId) setZoomDrag(null); } : undefined}
          onPointerCancel={zoomDrag ? () => setZoomDrag(null) : undefined}
        >
          {gutters.map(gutter => (
            <div key={gutter.key} data-hour-grid-gutter={gutter.key} className="min-w-0 flex-1">
              {hours.map((hour) => (
                // The label sits on its hour's line, placed absolutely: a negative margin here would collapse through the
                // row and pull every later row up with it.
                <div key={hour} className="relative" style={{ height: hourHeightPx }}>
                  <span data-hour-grid-time-label className="absolute inset-x-2 -top-2 block whitespace-nowrap text-right text-[length:var(--font-size-caption)] tabular-nums text-[var(--text-muted)]">
                    {gutter.formatHourLabel(hour)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {lanes.map((lane) => (
          <div
            key={lane.key}
            data-hour-grid-lane={lane.key}
            role={selecting ? 'group' : undefined}
            tabIndex={selecting ? 0 : undefined}
            aria-label={lane.headerLabel || undefined}
            aria-describedby={selecting && selectionKeyboardHint ? selectionHintId : undefined}
            aria-keyshortcuts={selecting ? 'ArrowUp ArrowDown Enter Space Home End' : undefined}
            className={cn('relative min-w-0 border-r', hairline, selecting ? 'focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--border-focus)]' : '')}
            onPointerDown={onSelectRange ? (event) => {
              if (event.button !== 0 || (event.target as Element).closest('[data-hour-grid-item],[data-hour-grid-range]')) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const minute = minuteAtOffset(event.clientY - bounds.top, bounds.height, { windowStart: windowStartMinute, windowEnd: windowEndMinute, snap: snapStep });
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setDragRange({ laneKey: lane.key, anchor: minute, head: minute });
            } : undefined}
            onPointerUp={onSelectRange ? (event) => {
              const drag = draggingRange.current;
              if (!drag || drag.laneKey !== lane.key) return;
              const upBounds = event.currentTarget.getBoundingClientRect();
              const head = minuteAtOffset(event.clientY - upBounds.top, upBounds.height, { windowStart: windowStartMinute, windowEnd: windowEndMinute, snap: snapStep });
              const start = Math.min(drag.anchor, head);
              const end = Math.min(windowEndMinute, Math.max(drag.anchor, head) + snapStep);
              event.currentTarget.releasePointerCapture?.(event.pointerId);
              setDragRange(null);
              onSelectRange(lane.key, start, end, rangeAnchor(upBounds, start, end));
            } : undefined}
            onPointerCancel={onSelectRange ? () => setDragRange(null) : undefined}
            onPointerMove={selecting ? (event) => {
              const drag = draggingRange.current;
              if (drag?.laneKey === lane.key) {
                const dragBounds = event.currentTarget.getBoundingClientRect();
                const head = minuteAtOffset(event.clientY - dragBounds.top, dragBounds.height, { windowStart: windowStartMinute, windowEnd: windowEndMinute, snap: snapStep });
                if (head !== drag.head) setDragRange({ ...drag, head });
                return;
              }
              if ((event.target as Element).closest('[data-hour-grid-item]')) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const minute = minuteAtOffset(event.clientY - bounds.top, bounds.height, {
                windowStart: windowStartMinute,
                windowEnd: windowEndMinute,
                snap: snapStep,
              });
              setSlotMinutes((current) => current[lane.key] === minute ? current : { ...current, [lane.key]: minute });
            } : undefined}
            onPointerLeave={selecting ? () => setSlotMinutes((current) => {
              if (!(lane.key in current)) return current;
              const next = { ...current };
              delete next[lane.key];
              return next;
            }) : undefined}
            onClick={onSelectTime ? (event) => {
              if ((event.target as Element).closest('[data-hour-grid-item]')) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const minute = minuteAtOffset(event.clientY - bounds.top, bounds.height, {
                windowStart: windowStartMinute,
                windowEnd: windowEndMinute,
                snap: snapStep,
              });
              setSlotMinutes((current) => ({ ...current, [lane.key]: minute }));
              onSelectTime(lane.key, minute);
            } : undefined}
            onKeyDown={selecting ? (event) => {
              // The lane's own keys: a key pressed on a pill inside it is the pill's (and the caller's), not a slot move.
              if (event.target !== event.currentTarget) return;
              const current = slotMinutes[lane.key] ?? windowStartMinute;
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                const next = Math.max(windowStartMinute, Math.min(windowEndMinute - snapStep, current + (event.key === 'ArrowDown' ? snapStep : -snapStep)));
                setSlotMinutes((minutes) => ({ ...minutes, [lane.key]: next }));
                return;
              }
              if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                const minute = event.key === 'Home' ? windowStartMinute : windowEndMinute - snapStep;
                setSlotMinutes((minutes) => ({ ...minutes, [lane.key]: minute }));
                return;
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (onSelectRange) onSelectRange(lane.key, current, Math.min(windowEndMinute, current + snapStep), rangeAnchor(event.currentTarget.getBoundingClientRect(), current, Math.min(windowEndMinute, current + snapStep)));
                else onSelectTime?.(lane.key, current);
              }
            } : undefined}
          >
            {(lane.workingIntervals === undefined ? nonWorkingRanges : unavailableRanges(lane.workingIntervals, windowStartMinute, windowEndMinute)).map((range) => (
              <div
                key={`${range.startMinute}-${range.endMinute}`}
                aria-hidden="true"
                className="hour-grid-non-working"
                style={{
                  top: ((range.startMinute - windowStartMinute) / 60) * hourHeightPx,
                  height: ((range.endMinute - range.startMinute) / 60) * hourHeightPx,
                }}
              />
            ))}
            {hours.map((hour) => (
              <div key={hour} className={cn('border-b', hairline)} style={{ height: hourHeightPx }} />
            ))}
            {selecting && slotMinutes[lane.key] !== undefined ? (
              <div
                data-hour-grid-time-preview
                aria-hidden="true"
                className="hour-grid-time-preview"
                style={{ top: ((clamp(slotMinutes[lane.key], windowStartMinute, windowEndMinute) - windowStartMinute) / 60) * hourHeightPx }}
              />
            ) : null}
            {(lane.ranges ?? []).map((range) => (
              <div
                key={range.key}
                data-hour-grid-range={range.key}
                className="hour-grid-range"
                style={{
                  top: ((clamp(range.startMinute, windowStartMinute, windowEndMinute) - windowStartMinute) / 60) * hourHeightPx,
                  height: ((clamp(range.endMinute, windowStartMinute, windowEndMinute) - clamp(range.startMinute, windowStartMinute, windowEndMinute)) / 60) * hourHeightPx,
                }}
              >
                <span className="hour-grid-range-label">{range.label}</span>
                {onRemoveRange ? <Button size="icon-xs" variant="ghost" className="hour-grid-range-remove" aria-label={range.removeLabel} onClick={() => onRemoveRange(lane.key, range.key)}>×</Button> : null}
              </div>
            ))}
            {dragRange && dragRange.laneKey === lane.key ? (
              <div
                data-hour-grid-range-draft
                aria-hidden="true"
                className="hour-grid-range hour-grid-range-draft"
                style={{
                  top: ((Math.min(dragRange.anchor, dragRange.head) - windowStartMinute) / 60) * hourHeightPx,
                  height: ((Math.min(windowEndMinute, Math.max(dragRange.anchor, dragRange.head) + snapStep) - Math.min(dragRange.anchor, dragRange.head)) / 60) * hourHeightPx,
                }}
              />
            ) : null}
            {nowOffset !== null && lane.showNowLine ? (
              <div data-hour-grid-now className="pointer-events-none absolute inset-x-0 z-20" style={{ top: nowOffset }}>
                {/* Amie reference (App Store day-view screenshot, App ID
                    1548277133): now-line 1.5px accent, full-width, with a
                    6px gutter dot centered on it. */}
                <div className="hour-grid-now-line h-[1.5px]" />
                <div className="hour-grid-now-dot absolute -left-[3px] -top-[2.25px] h-[6px] w-[6px] rounded-full" />
              </div>
            ) : null}
            {dropMarker && dropMarker.laneKey === lane.key ? (
              <div
                data-hour-grid-drop-marker
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 z-30"
                style={{ top: ((clamp(dropMarker.minute, windowStartMinute, windowEndMinute) - windowStartMinute) / 60) * hourHeightPx }}
              >
                <div className="h-[2px] bg-[var(--border-focus)]" />
                <span className="absolute left-1 top-0.5 max-w-[calc(100%-8px)] truncate rounded-md bg-[var(--surface-primary)] px-1.5 py-0.5 text-[length:var(--font-size-caption)] font-semibold text-[var(--text-primary)] shadow-sm">
                  {dropMarker.label}
                </span>
              </div>
            ) : null}
            {lane.items.map((item) => (
              <ItemPill
                key={item.key}
                item={item}
                windowStartMinute={windowStartMinute}
                windowEndMinute={windowEndMinute}
                hourHeightPx={hourHeightPx}
                onSelect={onSelectItem}
                onResize={onResizeItem}
                resizeSnapMinutes={snapStep}
                resizeLabel={resizeLabel}
                ownsKeys={Boolean(commandRef)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
