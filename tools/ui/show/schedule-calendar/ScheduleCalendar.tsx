// parts/ui/show/schedule-calendar/ScheduleCalendar.tsx
//
// PURPOSE
//   A calendar things are dragged onto: a month board (the shared CalendarGrid, each day holding its things as small
//   cards) or day lanes of hours (the shared HourGrid), a header to move back, forward and to today, and a tray of the
//   things with no time yet. Dragging a thing onto a day keeps its time of day; onto an hour lane, it takes the time
//   under the pointer (on the snap grid); onto the tray, it loses its time. While dragging, the place it would land is
//   drawn and read aloud. The caller is told the new time and decides what it means.
//   Anatomy follows Buffer's publishing calendar and Cofounder's month board with its unscheduled list (Mobbin screens
//   e018b95f and cc48070c): arrows, the month or range, Today; day number top left, compact cards with a colour spine
//   and time; things with no time in a column beside the board, below it when the pane is narrow.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Generic: no product words. A thing is DATA { id, title, at, day?, subtitle?, tone?, movable? }; every visible word is
//      the caller's (`words`), and month, weekday and hour names are the browser's own locale words (Intl).
//   2. The view is DATA ({ grid: "month" } or { grid: "hours", days }); the days, spans and drop times come from the
//      pure schedule-placement.mjs, so what the tests prove is what draws.
//   3. Nothing is owned: `anchor` comes in and onAnchorChange goes out; a drop is reported through onMove(id, at) and
//      the thing stays where the caller's items say until the caller changes them.
//   4. Only a thing marked movable can be picked up; a drop outside any day, lane or the tray changes nothing.
//   5. A whole-day thing (its `day`, or an `at` that is a day key, both read by wholeDayOf) sits on that day: in the
//      strip above the hour lanes (HourGrid's banners, under the caller's `allDay` word) and on the month board without
//      a time; it is never in the tray. One the caller marks by `day` is never picked up; a movable one whose `at` is a
//      day key moves as a whole day (dayDropTime keeps it a day key on a day).
//      Its anatomy follows the all-day row of Calendly's and Klaviyo's week views (Mobbin screens 54e3901e, 6b3dd16e).
//
//   6. The keyboard is the caller's one keymap (src/workspace/keymap.json through `registerVerb`): this file names what
//      it can do right now (move the view, switch the view, zoom, fold the all-day strip, new event now, focus the next
//      event, move one a step) and the caller binds keys to those names; a verb about the thing (done, delete, going,
//      colour...) is run through the caller's `contextActions`, the same actions the right-click menu offers, so a key
//      and a menu row cannot disagree. A thing the calendar cannot do now (no grid, no zoom handler) is not offered, so
//      its key goes on to the page. No key is bound anywhere in this file, and no listener is added for one.
//   7. How times and dates are written (12 or 24 hour clock, the order of day and month, other time zones in the hour
//      gutter) is caller DATA (`format`, `zoneGutters`); every word on the calendar is made by schedule-format.mjs.
//
// KEY CONCEPTS
//   target: where the thing being dragged would land now ({ kind: "day" | "lane" | "tray", key, minute? }).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, GripVertical, Plus } from 'lucide-react';
import { cn } from '../cn';
import { bindContainerSize } from '../container-size';
import { Button } from '../coss/ui/button';
import { Checkbox } from '../coss/ui/checkbox';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../coss/ui/select';
import { DatePicker } from '../date-picker/DatePicker';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from '../coss/ui/breadcrumb';
import { Tooltip } from '../tooltip';
import { ShortcutSheet, type ShortcutGroup } from '../keyboard-shortcuts/ShortcutSheet';
import { makeFormat, zoneHourLabel, zoneShiftMinutes, type ScheduleFormat, type ScheduleFormatChoice } from './schedule-format.mjs';
import { CalendarGrid, type CalendarGridCell } from '../calendar-grid';
import { SegmentedControl } from '../segmented-control';
import { HourGrid, type HourGridAnchor, type HourGridCommands, type HourGridLane, type HourGridWorkingHours } from '../hour-grid';
import { SortableRows, type SortableMove } from '../drag-reorder-list/SortableRows';
import { useNodeContextMenu, type NodeActionPack, type NodeRef } from '../node-actions';
import {
  allDayBannerLayout,
  dayDropTime,
  dayKey,
  dayOf,
  dayStart,
  isWholeDay,
  wholeDayOf,
  itemsByDay,
  laneLayout,
  minuteAtOffset,
  minuteOf,
  shiftAnchor,
  timeAt,
  visibleDays,
  weekNumber,
  moveToMonth,
} from './schedule-placement.mjs';

export type ScheduleView = { grid: 'month' } | { grid: 'hours'; days: number; rolling?: boolean };

export interface ScheduleItem {
  /** Stable identity: the key and the onMove/onOpen argument. */
  id: string;
  title: string;
  /** When it is, as anything a Date reads; null puts it in the tray. */
  at: string | null;
  /** A thing that lasts the whole day: its date key ("YYYY-MM-DD"). It sits on that day in every time zone, in the
   *  whole-day strip of the hour lanes and without a time on the month board; `at` is then not used to place it. */
  day?: string;
  /** Exclusive final day for a multi-day whole-day item, in the caller's date-key format. */
  dayEnd?: string;
  /** A second line (caller words), shown where there is room. */
  subtitle?: string;
  /** The colour of its spine: a tone the look names (blue, green, grey, red...), the same tone names a record list's
   *  tags use, so one status row colours both. */
  tone?: string;
  /** A caller's provider color overrides the shared tone when it is a valid RGB hex value. */
  color?: string;
  /** Drawn quietly (reduced emphasis): a calendar the person marked as background. */
  quiet?: boolean;
  /** Retained cancelled entries keep their time and color, with an inactive treatment. */
  cancelled?: boolean;
  /** The person declined it: drawn like a cancelled entry (struck through, hatched), still on the calendar. */
  declined?: boolean;
  /** It is over: drawn quieter than what is still to come. */
  past?: boolean;
  /** Whether it can be picked up and given another time. */
  movable?: boolean;
  /** How long it lasts, in minutes, on hour lanes; the calendar's `durationMinutes` when not said. */
  minutes?: number;
  /** The caller permits changing this timed item's duration. Whole-day items cannot be resized. */
  resizable?: boolean;
  /** Optional caller-owned checklist state: a box in the unscheduled tray, and on a placed thing a done box with the
   *  thing drawn done once marked (the caller says when it offers one by giving this a value). */
  checked?: boolean;
  checkDisabled?: boolean;
  /** Optional caller-owned tray relationship. Missing parents remain visible as roots. */
  parentId?: string | null;
  /** Caller-owned grouping in the tray; children follow their root group. */
  groupId?: string | null;
}

export interface ScheduleCalendarWords {
  previous: string;
  next: string;
  today: string;
  /** The tray's heading. */
  tray: string;
  /** What the tray says when it holds nothing. */
  trayEmpty: string;
  /** A day holding more than the board shows: "2 more". */
  more: (count: number) => string;
  /** Read aloud while dragging over a place: the thing and when it would be. */
  placing: (title: string, when: string) => string;
  /** Read aloud while dragging over the tray. */
  unplacing: (title: string) => string;
  /** Help text for choosing a time: arrows change the slot and Enter or Space selects it. */
  selectTimeHint?: string;
  /** Accessible label for a duration handle, formatted by the caller. */
  resizeHandle?: (title: string, minutes: number) => string;
  /** What the header's choice of month, week or day is called, when it offers one. */
  show?: string;
  /** Accessible name for the anchored date picker in the calendar header. */
  chooseDate?: string;
  /** The label beside the strip of whole-day things above the hour lanes ("All day"). */
  allDay?: string;
  /** Accessible name of the control that removes one drawn range, given its time in words. */
  removeRange?: (when: string) => string;
  checkItem?: (title: string, checked: boolean) => string;
  reorderItem?: (title: string) => string;
  /** Accessible name for selecting or removing one thing from the caller's batch selection. */
  selectItem?: (title: string, selected: boolean) => string;
  /** The names of the span the arrows move by, and the labels built from them: "Go to previous week". `{period}` is the name. */
  periods?: { day: string; week: string; month: string; days: string };
  previousPeriod?: string;
  nextPeriod?: string;
  /** The tooltip of the Today button ("Go to today"). */
  goToToday?: string;
  /** The week crumb: "W{week}". */
  weekLabel?: string;
  /** Names of the header's crumbs, for assistive technology. */
  breadcrumb?: string;
  chooseMonth?: string;
  chooseSection?: string;
  /** What the all-day strip says while it is folded: "2 more". */
  allDayMore?: (count: number) => string;
  /** The keyboard shortcuts sheet's title. */
  shortcuts?: string;
  /** Read aloud and shown as a tip on the hour labels while they can be dragged to zoom. */
  zoomDrag?: string;
}

/** How a tray record was pressed: `additive` (Command or Control) adds it to a marked set, `range` (Shift) extends the set to it. */
export interface ScheduleOpenModifiers { additive: boolean; range: boolean }

/** One heading in the tray: its words, how many records sit under it, a way to add one there, and whether it shows with none. */
export interface ScheduleTrayGroup {
  id: string;
  label: string;
  count?: number;
  /** Shown beside the heading as a press that adds a record to this group; both are needed. */
  addLabel?: string;
  onAdd?: () => void;
  /** Draw the heading even when no record sits under it. */
  empty?: boolean;
  /** Words for the press that folds or opens the group. */
  toggleLabel?: string;
}

/** A caller-owned span of time drawn on the hour lanes (for example a slot being shared). */
export interface ScheduleRange {
  id: string;
  /** Start and end instants on one local day. */
  startAt: string;
  endAt: string;
}

export interface ScheduleCalendarProps {
  items: ScheduleItem[];
  view: ScheduleView;
  /** The day key ("YYYY-MM-DD") the view shows. */
  anchor: string;
  onAnchorChange: (anchor: string) => void;
  /** A drop: the thing and its new time (an ISO instant), or null when it was dropped on the tray. */
  onMove?: (id: string, at: string | null) => void;
  onOpen?: (id: string, modifiers?: ScheduleOpenModifiers) => void;
  /** Optional caller-owned actions shown when a person right-clicks a calendar item. The node is
   *  `{ family: 'schedule-calendar-item', parts: { id } }`; the id is the exact `ScheduleItem.id`. */
  contextActions?: NodeActionPack;
  /** Report a checklist change; persistence remains with the caller. */
  onCheckedChange?: (id: string, checked: boolean) => void;
  /** A day's number was chosen on the month board. */
  onSelectDay?: (key: string) => void;
  /** A blank time in an hour lane was selected. */
  onSelectTime?: (at: string) => void;
  /** A pointer drag (or keyboard choice) across one day's lane chose a span of time. */
  /** `anchor` is the rectangle the range covers on screen, for a popover about it. */
  onSelectRange?: (startAt: string, endAt: string, anchor: HourGridAnchor) => void;
  /** Caller-owned spans drawn on the hour lanes. */
  ranges?: ScheduleRange[];
  /** The person removed one drawn span. */
  onRemoveRange?: (id: string) => void;
  /** A caller-authorized timed item duration changed. */
  onResize?: (id: string, minutes: number) => void;
  words: ScheduleCalendarWords;
  ariaLabel: string;
  /** 0 = Sunday. */
  weekStartsOn?: number;
  windowStartMinute?: number;
  windowEndMinute?: number;
  /** Mark working time on hour lanes; timed things outside it remain drawn. */
  workingHours?: HourGridWorkingHours;
  /** Caller-owned availability by local date, including breaks and unavailable days. */
  workingIntervalsForDay?: (day: string) => HourGridWorkingHours[] | undefined;
  /** Hide Saturday and Sunday columns in month and whole-week-or-longer hour views. Defaults to true. */
  showWeekends?: boolean;
  hourHeightPx?: number;
  snapMinutes?: number;
  /** Where the hour lanes start scrolled to. */
  initialScrollMinute?: number;
  /** How long a thing lasts on an hour lane. */
  durationMinutes?: number;
  /** Whether the tray of things with no time is drawn (a calendar whose things all have a time has none). */
  tray?: boolean;
  /** Whether the calendar grid is drawn. A standalone task pane keeps the same scheduling owner and drag behavior. */
  showGrid?: boolean;
  /** Optional caller-selected tray records. Without this, the tray shows items with no time.
   *  Timed records may appear here too; selection, dragging and actions retain their exact identity. */
  trayItems?: ScheduleItem[];
  /** Reorder siblings within their tray group. Dragging the row body still schedules it.
   *  A rejected save restores the supplied order through the shared sortable. */
  onTrayReorder?: (move: SortableMove) => void | Promise<unknown>;
  trayReorderDisabled?: boolean;
  /** Optional caller controls shown in the tray beside its heading. */
  trayHeader?: React.ReactNode;
  /** Optional caller content shown between the tray heading and unplaced things. */
  trayContent?: React.ReactNode;
  /** Content after the tray records, retained independently of their selection. */
  trayAfterItems?: React.ReactNode;
  /** Ordered caller-owned headings for grouped tray records. */
  trayGroups?: ScheduleTrayGroup[];
  /** Tray records the caller has marked as a set (several chosen to act on together). */
  trayMarkedIds?: readonly string[];
  /** The tray record keys act on now; it is drawn focused and brought into view when it changes. */
  trayFocusedId?: string | null;
  /** Caller-owned details expanded inside one exact tray record. The shared
   *  calendar supplies placement; the caller owns fields, copy and actions. */
  trayItemDetail?: { id: string; content: React.ReactNode; replacesItem?: boolean } | null;
  /** Whether meaningful tray details should lead the grid in compact layout.
   *  Defaults to the presence of trayContent for existing callers. Mounted,
   *  inactive panels can explicitly leave this false. */
  trayDetailOpen?: boolean;
  /** Optional caller controls shown in the calendar's navigation header. */
  headerContent?: React.ReactNode;
  /** Hide the inner navigation row when a caller places its controls in a shared screen header. */
  showHeader?: boolean;
  /** Place navigation above the whole calendar or over the calendar grid pane. */
  headerPosition?: 'above' | 'grid';
  /** Which side the unplaced-items pane occupies in a wide calendar. Compact layout remains content-driven. */
  traySide?: 'start' | 'end';
  /** Cards a month day shows before "N more". */
  perDayLimit?: number;
  /** Minimum width of each day in month and multi-day hour views. Narrow panes scroll horizontally so dates stay readable. */
  minDayWidthPx?: number;
  /** Ways of showing the calendar the header offers (a month, a week, a day), each the caller's words; the caller keeps
   *  which is chosen (`choice`) and turns it into `view`. Absent: the header offers none. */
  choices?: { id: string; label: string }[];
  choice?: string;
  onChoiceChange?: (id: string) => void;
  /** Render the controlled view choices as a compact menu before the date; defaults to the existing segmented control. */
  choicePresentation?: 'segmented' | 'menu';
  /** The caller-selected item identity, used to expose selection on every calendar surface. */
  selectedId?: string | null;
  /** Identities that the caller permits in its explicit multi-selection. */
  selectableIds?: readonly string[];
  /** Caller-owned identities selected for batch actions. */
  selectedIds?: readonly string[];
  /** Select through the card's existing action, or opt into a separate shared checkbox. */
  selectionPresentation?: 'highlight' | 'checkbox';
  /** Report a caller-owned selection change. */
  onSelectionChange?: (id: string, selected: boolean) => void;
  /** Disable selection while the caller is carrying out a batch operation. */
  selectionDisabled?: boolean;
  /** Caller-owned batch actions, placed between navigation and the calendar panes. */
  selectionBar?: React.ReactNode;
  className?: string;
  /** The calendar's keyboard is the caller's keymap (see invariant 6): the calendar hands over each thing it can do now
   *  by name and the caller binds keys to them. Absent: no keyboard layer. Keep its identity stable. */
  registerVerb?: ScheduleVerbRegistrar;
  /** The keyboard shortcuts sheet (the `shortcuts` verb opens it), drawn from the caller's keymap in the person's own keys. */
  shortcutGroups?: ShortcutGroup[];
  /** The keys of the header's own buttons, drawn in their tooltips, by name (`previous`, `next`, `today`). */
  shortcutKeys?: Readonly<Record<string, string>>;
  /** How times and dates are written: the date locale and whether the clock has twelve hours. */
  format?: ScheduleFormatChoice;
  /** Other time zones drawn as extra hour gutters beside the first, each with its heading (a nickname). */
  zoneGutters?: { key: string; zone: string; heading: string }[];
  /** Heading above the first hour gutter (the device's own zone). */
  gutterHeading?: string;
  /** Hour height changes asked for by zoom keys or a Command-drag over the hour labels, within the range. */
  onHourHeightChange?: (hourHeightPx: number) => void;
  minHourHeightPx?: number;
  maxHourHeightPx?: number;
  zoomStepPx?: number;
  /** The week starts today (`view.rolling`) was toggled. */
  onRollingChange?: (rolling: boolean) => void;
  /** A thing was dropped with Option held: a copy of it at that time, not a move. */
  onDuplicate?: (id: string, at: string) => void;
  /** Sections the header's first crumb switches between, and the chosen one; the crumb is plain text without them. */
  sections?: { id: string; label: string }[];
  section?: string;
  onSectionChange?: (id: string) => void;
}

type Target = { kind: 'day' | 'lane' | 'tray'; key: string; minute?: number };
type PaneViewState = {
  active: HTMLElement | null;
  selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' | null } | null;
  scroll: { element: HTMLElement; top: number; left: number }[];
};

class OrderedPanes extends React.Component<{ children: React.ReactNode }> {
  private root = React.createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: Readonly<{ children: React.ReactNode }>): PaneViewState | null {
    const keys = (children: React.ReactNode) => React.Children.toArray(children).map(child => React.isValidElement(child) ? child.key : null);
    if (JSON.stringify(keys(previous.children)) === JSON.stringify(keys(this.props.children))) return null;
    const root = this.root.current;
    if (!root) return null;
    const active = document.activeElement;
    return {
      active: active instanceof HTMLElement && root.contains(active) ? active : null,
      selection: active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? (active.selectionStart === null || active.selectionEnd === null ? null : {
          start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection,
        }) : null,
      scroll: [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
        .filter(element => element.scrollTop !== 0 || element.scrollLeft !== 0)
        .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft })),
    };
  }

  componentDidUpdate(_previous: Readonly<{ children: React.ReactNode }>, _state: unknown, snapshot: PaneViewState | null) {
    if (!snapshot) return;
    for (const row of snapshot.scroll) {
      if (!row.element.isConnected) continue;
      row.element.scrollTop = row.top;
      row.element.scrollLeft = row.left;
    }
    if (snapshot.active?.isConnected) {
      if (document.activeElement !== snapshot.active) snapshot.active.focus({ preventScroll: true });
      if (snapshot.selection && (snapshot.active instanceof HTMLInputElement || snapshot.active instanceof HTMLTextAreaElement)) {
        snapshot.active.setSelectionRange(snapshot.selection.start, snapshot.selection.end, snapshot.selection.direction ?? undefined);
      }
    }
  }

  render() {
    return <div ref={this.root} data-schedule-panes className="flex min-h-0 flex-1 flex-col gap-3 @3xl:flex-row @3xl:gap-4">{this.props.children}</div>;
  }
}

// A tone is a colour the look names (parts/screen-look coss-workspace.css `--record-kind-<tone>`); a tone the look does
// not name draws muted. A new tone is one variable in the look, never a row here.
const toneColor = (tone?: string) => (tone && /^[a-z][a-z0-9-]*$/.test(tone) ? `var(--record-kind-${tone}, var(--text-muted))` : 'var(--text-muted)');
const itemColor = (item: ScheduleItem) => /^#[0-9a-f]{6}$/i.test(item.color ?? '') ? item.color! : toneColor(item.tone);

// A whole day ("YYYY-MM-DD") has no time of day to say, and is read as that local day, never as a UTC instant.
const FormatContext = React.createContext<ScheduleFormat>(makeFormat());
const timeWords = (at: string, fmt: ScheduleFormat) => (isWholeDay(at) ? '' : fmt.time(at));
const whenWords = (at: string, fmt: ScheduleFormat) => (isWholeDay(at) ? fmt.whenDay(at) : fmt.when(at));
const fillName = (text: string, name: string) => text.replace('{period}', name);
const periodOf = (view: ScheduleView): 'day' | 'week' | 'month' | 'days' => (view.grid === 'month' ? 'month' : view.days === 1 ? 'day' : view.days % 7 === 0 ? 'week' : 'days');
const itemIdOf = (target: EventTarget | null) => {
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-hour-grid-item], [data-schedule-item]') : null;
  return element ? element.dataset.hourGridItem ?? element.dataset.scheduleItem ?? null : null;
};

/** What the calendar does when a key the caller bound to `verb` is pressed: the verb's own arguments and the key press. */
export type ScheduleVerbRun = (args: Readonly<Record<string, unknown>> | undefined, press: KeyboardEvent | undefined) => void;
/** Gives one thing the calendar can do now a name the caller can bind a key to; the answer takes it away again. */
export type ScheduleVerbRegistrar = (verb: string, run: ScheduleVerbRun) => () => void;

/** One thing as a small card: a month day, or the tray. */
function ItemCard({ item, depth = 0, onOpen, onCheckedChange, checkLabel, actionLabel, selected = false, marked = false, focused = false, variant = 'board', orderHandle, selectionControl }: { item: ScheduleItem; depth?: number; onOpen?: (id: string, modifiers?: ScheduleOpenModifiers) => void; onCheckedChange?: (id: string, checked: boolean) => void; checkLabel?: string; actionLabel?: string; selected?: boolean; marked?: boolean; focused?: boolean; variant?: 'board' | 'tray'; orderHandle?: React.ReactNode; selectionControl?: React.ReactNode }) {
  const color = itemColor(item);
  const fmt = React.useContext(FormatContext);
  const inTray = variant === 'tray';
  if (inTray) return <div data-control-row data-schedule-item={item.id} data-schedule-parent={item.parentId ?? undefined} data-schedule-depth={depth} style={{ '--schedule-depth': depth } as React.CSSProperties} data-selected={selected || undefined} data-marked={marked || undefined} data-focused={focused || undefined} data-completed={item.checked || undefined} draggable={item.movable || undefined} className={cn('schedule-tray-item schedule-checklist-row', selected && 'ring-1 ring-[var(--border-focus)]')}>
    {orderHandle}
    {selectionControl}
    {typeof item.checked === 'boolean' && onCheckedChange && checkLabel ? <Checkbox className="schedule-checklist-check" aria-label={checkLabel} checked={item.checked} disabled={item.checkDisabled} onCheckedChange={checked => onCheckedChange(item.id, checked)} /> : null}
    <Button variant="ghost" className="schedule-checklist-open" title={item.title} aria-pressed={selected || marked} onClick={onOpen ? event => onOpen(item.id, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey }) : undefined}>
      <span className="schedule-checklist-title">{item.title}</span>
      {item.subtitle ? <span className="schedule-checklist-detail">{item.subtitle}</span> : null}
    </Button>
  </div>;
  if (selectionControl) return <div
    role="group"
    aria-label={item.title}
    data-schedule-item={item.id}
    data-selected={selected || undefined}
    draggable={(item.movable && !item.day) || undefined}
    title={item.title}
    className={cn('flex min-w-0 items-center gap-1.5 overflow-hidden rounded-md border px-1 py-0.5 text-left text-[length:var(--font-size-caption)]', selected && 'ring-1 ring-[var(--border-focus)]')}
    style={{ borderColor: `color-mix(in srgb, ${color} 55%, transparent)`, background: `color-mix(in srgb, ${color} 18%, var(--surface-primary))` }}
  >
    {selectionControl}
    <Button variant="ghost" size="xs" disabled={!onOpen} onClick={onOpen ? () => onOpen(item.id) : undefined} className="min-w-0 flex-1 justify-start gap-1.5 px-0.5 text-left">
      {item.at && !wholeDayOf(item) ? <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{timeWords(item.at, fmt)}</span> : null}
      <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">{item.title}</span>
    </Button>
  </div>;
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={(item.movable && !item.day) || undefined}
      data-schedule-item={item.id}
      data-selected={selected || undefined}
      data-inactive={item.cancelled || item.declined || undefined}
      data-past={item.past || undefined}
      aria-label={actionLabel}
      aria-pressed={selected}
      title={item.title}
      className={cn(
        'flex min-w-0 items-center gap-1.5 overflow-hidden text-left text-[length:var(--font-size-caption)]',
        inTray
          ? 'schedule-tray-item rounded px-1.5 py-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]'
        : 'rounded-md border px-1.5 py-0.5 transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
        !inTray && 'schedule-calendar-card',
        item.movable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
      )}
      style={inTray ? undefined : { '--schedule-item-color': color, borderColor: `color-mix(in srgb, ${color} 55%, transparent)`, background: `color-mix(in srgb, ${color} 18%, var(--surface-primary))` } as React.CSSProperties}
      onClick={onOpen ? () => onOpen(item.id) : undefined}
      onKeyDown={onOpen ? (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen(item.id);
      } : undefined}
    >
      {item.at && !wholeDayOf(item) ? <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{timeWords(item.at, fmt)}</span> : null}
      <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">{item.title}</span>
    </div>
  );
}

type TrayRow = { item: ScheduleItem; depth: number; groupId?: string | null };
type TrayNode = { row: TrayRow; children: TrayNode[] };
const trayNodeId = (node: TrayNode) => node.row.item.id;
const SCHEDULE_ITEM_DRAG_TYPE = 'application/x-trillion-schedule-item';

function TrayBranch({ nodes, onReorder, disabled, renderEntry }: {
  nodes: TrayNode[]; onReorder?: ScheduleCalendarProps['onTrayReorder']; disabled: boolean;
  renderEntry: (row: TrayRow, reorderable: boolean) => React.ReactNode;
}) {
  const render = (node: TrayNode) => <>
    {renderEntry(node.row, Boolean(onReorder && nodes.length > 1))}
    {node.children.length ? <TrayBranch nodes={node.children} onReorder={onReorder} disabled={disabled} renderEntry={renderEntry} /> : null}
  </>;
  return onReorder && nodes.length > 1
    ? <SortableRows items={nodes} getId={trayNodeId} disabled={disabled} onReorder={(_, move) => onReorder(move)} renderItem={render} className="schedule-tray-branch" />
    : <>{nodes.map(node => <React.Fragment key={trayNodeId(node)}>{render(node)}</React.Fragment>)}</>;
}

export function ScheduleCalendar({
  items,
  view,
  anchor,
  onAnchorChange,
  onMove,
  onOpen,
  contextActions,
  onCheckedChange,
  onSelectDay,
  onSelectTime,
  onSelectRange,
  ranges,
  onRemoveRange,
  onResize,
  words,
  ariaLabel,
  weekStartsOn = 0,
  windowStartMinute = 0,
  windowEndMinute = 1440,
  workingHours,
  workingIntervalsForDay,
  showWeekends = true,
  hourHeightPx = 48,
  snapMinutes = 15,
  initialScrollMinute = 420,
  durationMinutes = 30,
  tray = true,
  showGrid = true,
  trayItems,
  onTrayReorder,
  trayReorderDisabled = false,
  trayHeader,
  trayContent,
  trayAfterItems,
  trayGroups,
  trayMarkedIds,
  trayFocusedId,
  trayItemDetail,
  trayDetailOpen = Boolean(trayContent),
  headerContent,
  showHeader = true,
  headerPosition = 'above',
  traySide,
  perDayLimit = 3,
  minDayWidthPx = 0,
  choices,
  choice,
  onChoiceChange,
  choicePresentation = 'segmented',
  selectedId,
  selectableIds = [],
  selectedIds = [],
  onSelectionChange,
  selectionDisabled = false,
  selectionPresentation = 'checkbox',
  selectionBar,
  className,
  registerVerb,
  shortcutGroups,
  shortcutKeys,
  format,
  zoneGutters = [],
  gutterHeading,
  onHourHeightChange,
  minHourHeightPx,
  maxHourHeightPx,
  zoomStepPx = 6,
  onRollingChange,
  onDuplicate,
  sections,
  section,
  onSectionChange,
}: ScheduleCalendarProps) {
  const contextMenu = useNodeContextMenu(contextActions ?? []);
  const host = React.useRef<HTMLDivElement>(null);
  const fmt = React.useMemo(() => makeFormat(format), [format?.dateLocale, format?.hour12]);
  const [allDayFolded, setAllDayFolded] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [wide, setWide] = React.useState(false);
  const firstContainerMeasurement = React.useRef(true);
  const changePaneOrder = (nextWide: boolean) => setWide(nextWide);
  React.useLayoutEffect(() => {
    if (!host.current) return;
    return bindContainerSize(host.current, {
      classes: [{ id: 'compact', below_px: 48 * parseFloat(getComputedStyle(document.documentElement).fontSize) }, { id: 'wide' }],
      onChange: size => {
        const nextWide = size === 'wide';
        if (firstContainerMeasurement.current) {
          firstContainerMeasurement.current = false;
          // Descendant layout effects, including HourGrid's initial scroll, finish
          // before this microtask snapshots the pane for its first reorder.
          queueMicrotask(() => changePaneOrder(nextWide));
          return;
        }
        changePaneOrder(nextWide);
      },
    });
  }, []);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState<Target | null>(null);
  const today = dayKey(new Date());
  const days = React.useMemo(() => visibleDays(view, anchor, weekStartsOn), [view, anchor, weekStartsOn]);
  const hideWeekendColumns = !showWeekends && (view.grid === 'month' || (view.days >= 7 && view.days % 7 === 0));
  const displayDays = hideWeekendColumns ? days.filter((key) => {
    const day = dayStart(key).getDay();
    return day !== 0 && day !== 6;
  }) : days;
  const byDay = React.useMemo(() => itemsByDay(items.filter((item) => item.at || item.day), displayDays), [items, displayDays.join(',')]);
  const unplaced = React.useMemo(() => trayItems ?? items.filter((item) => !item.at && !item.day), [items, trayItems]);
  const trayRows = React.useMemo(() => {
    const ids = new Set(unplaced.map(item => item.id));
    const children = new Map<string, ScheduleItem[]>();
    for (const item of unplaced) if (item.parentId && item.parentId !== item.id && ids.has(item.parentId)) {
      if (!children.has(item.parentId)) children.set(item.parentId, []);
      children.get(item.parentId)!.push(item);
    }
    const seen = new Set<string>();
    const rows: { item: ScheduleItem; depth: number; groupId?: string | null }[] = [];
    // Iterative traversal preserves long chains, orphans and cyclic caller records.
    const roots = unplaced.filter(item => !item.parentId || item.parentId === item.id || !ids.has(item.parentId));
    const order = new Map((trayGroups ?? []).map((group, index) => [group.id, index]));
    const candidates = [...roots, ...unplaced].sort((a, b) => (order.get(a.groupId ?? "") ?? order.size) - (order.get(b.groupId ?? "") ?? order.size));
    for (const root of candidates) {
      const stack = [{ item: root, depth: 0, groupId: root.groupId }];
      while (stack.length) {
        const row = stack.pop()!;
        if (seen.has(row.item.id)) continue;
        seen.add(row.item.id); rows.push(row);
        const nested = children.get(row.item.id) ?? [];
        for (let index = nested.length - 1; index >= 0; index -= 1) stack.push({ item: nested[index], depth: row.depth + 1, groupId: row.groupId });
      }
    }
    return rows;
  }, [unplaced, trayGroups]);
  const byId = React.useMemo(() => new Map([...items, ...(trayItems ?? [])].map((item) => [item.id, item])), [items, trayItems]);
  const selectableIdSet = React.useMemo(() => new Set(selectableIds), [selectableIds]);
  const selectedIdSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const markedSet = React.useMemo(() => new Set(trayMarkedIds ?? []), [trayMarkedIds]);
  const [foldedGroups, setFoldedGroups] = React.useState<ReadonlySet<string>>(() => new Set());
  const trayPane = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!trayFocusedId) return;
    const entry = Array.from(trayPane.current?.querySelectorAll<HTMLElement>('[data-schedule-tray-entry]') ?? []).find(node => node.dataset.scheduleTrayEntry === trayFocusedId);
    entry?.scrollIntoView?.({ block: 'nearest' });
    // Keys carry on from the record they moved to, so focus follows when it was already inside the tray.
    if (entry && trayPane.current?.contains(document.activeElement)) entry.querySelector<HTMLElement>('.schedule-checklist-open')?.focus({ preventScroll: true });
  }, [trayFocusedId]);
  const openItem = (id: string, how?: { additive: boolean }) => {
    if ((how?.additive || selectionPresentation === 'highlight') && selectableIdSet.has(id) && onSelectionChange) {
      if (!selectionDisabled) onSelectionChange(id, !selectedIdSet.has(id));
    } else onOpen?.(id);
  };
  const selectionLabelFor = (item: ScheduleItem) => selectionPresentation === 'highlight' && selectableIdSet.has(item.id)
    ? words.selectItem?.(item.title, selectedIdSet.has(item.id)) : undefined;
  const selectionControlFor = (item: ScheduleItem) => selectionPresentation === 'checkbox' && selectableIdSet.has(item.id) && onSelectionChange && words.selectItem
    ? <Checkbox
      aria-label={words.selectItem(item.title, selectedIdSet.has(item.id))}
      checked={selectedIdSet.has(item.id)}
      disabled={selectionDisabled}
      onCheckedChange={checked => onSelectionChange(item.id, checked === true)}
      onClick={event => event.stopPropagation()}
    />
    : null;
  // A placed thing the caller lets be marked done wears the same box a tray task does, and is drawn done once marked.
  const doneControlFor = (item: ScheduleItem) => item.at && typeof item.checked === 'boolean' && onCheckedChange && words.checkItem
    ? <Checkbox
      aria-label={words.checkItem(item.title, item.checked)}
      checked={item.checked}
      disabled={item.checkDisabled}
      onCheckedChange={checked => onCheckedChange(item.id, checked === true)}
      onClick={event => event.stopPropagation()}
    />
    : null;
  const controlFor = (item: ScheduleItem) => selectionControlFor(item) ?? doneControlFor(item);
  const minDayWidth = view.grid === 'month' || view.days > 1 ? Math.max(0, minDayWidthPx) : 0;
  const held = dragging ? byId.get(dragging) ?? null : null;
  const onItemContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!contextActions?.length) return;
    const itemElement = (event.target as Element).closest<HTMLElement>('[data-schedule-item], [data-hour-grid-item]');
    const id = itemElement?.dataset.scheduleItem ?? itemElement?.dataset.hourGridItem;
    if (!id || !byId.has(id)) return;
    event.preventDefault();
    event.stopPropagation();
    const nodeRef: NodeRef = { family: 'schedule-calendar-item', parts: { id } };
    contextMenu.openFor(nodeRef, { x: event.clientX, y: event.clientY });
  };

  // Where the thing would land, from the element under the pointer.
  const targetAt = (element: Element | null, clientY: number): Target | null => {
    const lane = element?.closest<HTMLElement>('[data-hour-grid-lane]');
    if (lane) {
      const bounds = lane.getBoundingClientRect();
      return { kind: 'lane', key: lane.dataset.hourGridLane!, minute: minuteAtOffset(clientY - bounds.top, bounds.height, { windowStart: windowStartMinute, windowEnd: windowEndMinute, snap: snapMinutes }) };
    }
    const cell = element?.closest<HTMLElement>('[data-calendar-cell-key]');
    if (cell) return { kind: 'day', key: cell.dataset.calendarCellKey! };
    if (element?.closest('[data-schedule-tray]')) return { kind: 'tray', key: 'tray' };
    return null;
  };
  const timeOf = (place: Target, item: ScheduleItem) => (place.kind === 'lane' ? timeAt(place.key, place.minute!) : place.kind === 'day' ? dayDropTime(place.key, item.at) : null);
  const finish = () => { setDragging(null); setTarget(null); };

  const onDragStart = (event: React.DragEvent) => {
    if ((event.target as Element).closest('[data-hour-grid-resize-handle]')) { event.preventDefault(); return; }
    const picked = (event.target as Element).closest<HTMLElement>('[data-schedule-item], [data-hour-grid-item]');
    const id = picked?.dataset.scheduleItem ?? picked?.dataset.hourGridItem;
    const item = id ? byId.get(id) : undefined;
    if (!item?.movable || item.day) { event.preventDefault(); return; }
    event.dataTransfer.setData('text/plain', item.title);
    event.dataTransfer.setData(SCHEDULE_ITEM_DRAG_TYPE, JSON.stringify({ id: item.id, title: item.title, at: item.at, movable: item.movable, day: item.day }));
    event.dataTransfer.effectAllowed = onDuplicate && item.at ? 'copyMove' : 'move';
    setDragging(item.id);
  };
  const onDragOver = (event: React.DragEvent) => {
    const external = !held && event.dataTransfer.types.includes(SCHEDULE_ITEM_DRAG_TYPE);
    if (!held && !external) return;
    const place = targetAt(event.target as Element, event.clientY);
    if (!place || (place.kind === 'tray' && held && !held.at)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.altKey && onDuplicate && place.kind !== 'tray' ? 'copy' : 'move';
    if (place.kind !== target?.kind || place.key !== target.key || place.minute !== target.minute) setTarget(place);
  };
  const onDragLeave = (event: React.DragEvent) => {
    if (!(event.currentTarget as Element).contains(event.relatedTarget as Node | null)) setTarget(null);
  };
  const onDrop = (event: React.DragEvent) => {
    if (!held) {
      let item: { id?: unknown; at?: unknown; movable?: unknown; day?: unknown } | null = null;
      try { item = JSON.parse(event.dataTransfer.getData(SCHEDULE_ITEM_DRAG_TYPE)); } catch { return; }
      if (typeof item?.id !== 'string' || item.movable !== true || item.day) return;
      const place = targetAt(event.target as Element, event.clientY);
      if (!place || (place.kind === 'tray' && !item.at)) return;
      event.preventDefault();
      const destination = timeOf(place, { id: item.id, title: '', at: typeof item.at === 'string' ? item.at : null } as ScheduleItem);
      finish();
      if (event.altKey && onDuplicate && destination && typeof item.at === 'string') { onDuplicate(item.id, destination); return; }
      if (destination !== (item.at ?? null)) onMove?.(item.id, destination);
      return;
    }
    const place = targetAt(event.target as Element, event.clientY);
    if (!place || (place.kind === 'tray' && !held.at)) return finish();
    event.preventDefault();
    const at = timeOf(place, held);
    finish();
    if (event.altKey && onDuplicate && at && held.at) { onDuplicate(held.id, at); return; }
    if (at !== held.at && !(at && held.at && Date.parse(at) === Date.parse(held.at))) onMove?.(held.id, at);
  };

  const heard = held && target ? (target.kind === 'tray' ? words.unplacing(held.title) : words.placing(held.title, whenWords(timeOf(target, held)!, fmt))) : '';

  const monthCells: CalendarGridCell[] = view.grid === 'month'
    ? displayDays.map((key) => ({
      key,
      label: String(dayStart(key).getDate()),
      ariaLabel: fmt.longDay(key),
      current: key === today,
      muted: key.slice(0, 7) !== anchor.slice(0, 7),
      dropTarget: target?.kind === 'day' && target.key === key,
    }))
    : [];
  const weekdayLabels = days.slice(0, 7)
    .filter((key) => !hideWeekendColumns || (dayStart(key).getDay() !== 0 && dayStart(key).getDay() !== 6))
    .map((key) => fmt.weekday(key));

  const lanes: HourGridLane[] = view.grid === 'hours'
    ? (() => {
      const spans = allDayBannerLayout(items, displayDays);
      const bannersByLane = displayDays.map(() => [] as { key: string; title: string; color: string; selected: boolean; inactive?: boolean; actionLabel?: string; startColumn: number; columnSpan: number; row: number; selectionControl?: React.ReactNode }[]);
      for (const span of spans) bannersByLane[span.startColumn].push({
        key: span.item.id, title: span.item.title, color: itemColor(span.item), selected: span.item.id === selectedId || selectedIdSet.has(span.item.id),
        inactive: span.item.cancelled || span.item.declined, actionLabel: selectionLabelFor(span.item),
        selectionControl: controlFor(span.item),
        startColumn: span.startColumn, columnSpan: span.columnSpan, row: span.row,
      });
      return displayDays.map((key, index) => ({
      key,
      headerLabel: fmt.weekday(key),
      headerBadge: fmt.dayNumber(key),
      headerEmphasis: key === today,
      showNowLine: key === today,
      workingIntervals: workingIntervalsForDay?.(key),
      ranges: (ranges ?? []).filter(range => dayOf(range.startAt) === key).map(range => {
        const from = timeWords(range.startAt);
        const to = timeWords(range.endAt);
        // "10:45–1:15 PM": the unit both ends share is said once.
        const unit = from.includes(' ') && from.split(' ').pop() === to.split(' ').pop() ? ` ${to.split(' ').pop()}` : '';
        const when = `${unit ? from.slice(0, -unit.length) : from}–${to}`;
        return { key: range.id, startMinute: minuteOf(range.startAt), endMinute: minuteOf(range.endAt) || 1440, label: when, removeLabel: words.removeRange?.(when) ?? when };
      }),
      banners: bannersByLane[index],
      items: laneLayout((byDay.get(key) ?? []).filter((item) => !wholeDayOf(item)), durationMinutes).map(({ item, startMinute, endMinute, column, columnCount }) => ({
        key: item.id,
        startMinute,
        endMinute,
        column,
        columnCount,
        color: itemColor(item),
        title: item.title,
        subtitle: [timeWords(item.at, fmt), item.subtitle].filter(Boolean).join(' · '),
        selected: item.id === selectedId || selectedIdSet.has(item.id),
        inactive: item.cancelled || item.declined, actionLabel: selectionLabelFor(item),
        selectionControl: controlFor(item),
        done: Boolean(item.at && item.checked === true),
        draggable: Boolean(item.movable),
        resizable: Boolean(item.movable && item.resizable && !item.day),
        quiet: dragging === item.id || item.quiet,
      })),
      }));
    })()
    : [];
  const now = new Date();

  // The keyboard: the caller's keymap binds keys to the verbs below, which are the only code that acts on them.
  const zoomRange = { min: minHourHeightPx ?? 24, max: maxHourHeightPx ?? 160 };
  const baseZone = React.useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } }, []);
  const extraGutters = zoneGutters.map(gutter => ({
    key: gutter.key,
    heading: gutter.heading,
    formatHourLabel: (hour: number) => zoneHourLabel(hour, zoneShiftMinutes(gutter.zone, baseZone, displayDays[0] ?? anchor), fmt),
  }));
  const gridCommands = React.useRef<HourGridCommands | null>(null);
  const moveItemBy = (id: string, minutes: number) => {
    const item = byId.get(id);
    if (!item?.movable || item.day || !item.at || isWholeDay(item.at)) return;
    onMove?.(id, new Date(Date.parse(item.at) + minutes * 60_000).toISOString());
  };
  const pendingFocus = React.useRef<string | null>(null);
  const focusItem = (id: string) => {
    const element = host.current?.querySelector<HTMLElement>(`[data-hour-grid-item="${CSS.escape(id)}"] .hour-grid-pill-button, [data-schedule-item="${CSS.escape(id)}"]`);
    if (!element) return false;
    element.focus();
    return true;
  };
  React.useEffect(() => {
    const id = pendingFocus.current;
    if (id && focusItem(id)) pendingFocus.current = null;
  });
  const verbs: Record<string, ScheduleVerbRun> = {};
  if (registerVerb && showGrid) {
    const hours = view.grid === 'hours';
    const itemOfPress = (press: KeyboardEvent | undefined) => itemIdOf(press?.target ?? null);
    verbs['calendar-shift'] = args => onAnchorChange(shiftAnchor(view, anchor, Number(args?.by)));
    // Left and right move the period; with an event focused they move to the event on the previous or next day instead.
    verbs['calendar-sideways'] = (args, press) => {
      const id = itemOfPress(press);
      if (id && gridCommands.current) gridCommands.current.focusNeighbor(id, Number(args?.by) < 0 ? 'left' : 'right');
      else onAnchorChange(shiftAnchor(view, anchor, Number(args?.by)));
    };
    verbs['calendar-today'] = () => onAnchorChange(today);
    verbs['calendar-date-picker'] = () => host.current?.querySelector<HTMLElement>('[data-schedule-date-trigger]')?.click();
    if (onChoiceChange) verbs['calendar-view'] = args => { if (choices?.some(row => row.id === args?.choice)) onChoiceChange(String(args?.choice)); };
    if (onChoiceChange && choices && choices.length > 1) verbs['calendar-cycle-view'] = () => onChoiceChange(choices[(choices.findIndex(row => row.id === choice) + 1) % choices.length].id);
    if (hours && onRollingChange) verbs['calendar-rolling'] = () => onRollingChange(!view.rolling);
    if (hours) verbs['calendar-all-day'] = () => setAllDayFolded(folded => !folded);
    if (hours && onHourHeightChange) verbs['calendar-zoom'] = args => {
      const next = Math.min(zoomRange.max, Math.max(zoomRange.min, hourHeightPx + Number(args?.steps) * zoomStepPx));
      if (next !== hourHeightPx) onHourHeightChange(next);
    };
    if (shortcutGroups) verbs['calendar-shortcuts'] = () => setSheetOpen(true);
    if (onSelectTime) verbs['calendar-new-now'] = () => {
      const at = new Date();
      onSelectTime(timeAt(dayKey(at), Math.floor((at.getHours() * 60 + at.getMinutes()) / snapMinutes) * snapMinutes));
    };
    verbs['calendar-focus-upcoming'] = () => {
      const stamp = Date.now();
      const upcoming = items.filter(item => item.at && !isWholeDay(item.at) && !item.day && !item.cancelled
        && Date.parse(item.at) + (item.minutes ?? durationMinutes) * 60_000 > stamp)
        .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!))[0];
      if (!upcoming) return;
      pendingFocus.current = upcoming.id;
      if (!focusItem(upcoming.id)) onAnchorChange(dayOf(upcoming.at)!);
      if (selectableIdSet.has(upcoming.id) && onSelectionChange && !selectionDisabled && !selectedIdSet.has(upcoming.id)) onSelectionChange(upcoming.id, true);
    };
    verbs['calendar-focus-neighbor'] = (args, press) => {
      const id = itemOfPress(press);
      if (id) gridCommands.current?.focusNeighbor(id, args?.direction as 'up' | 'down' | 'left' | 'right');
    };
    verbs['calendar-open'] = (_args, press) => { const id = itemOfPress(press); if (id) openItem(id); };
    if (hours) verbs['calendar-move'] = (args, press) => { const id = itemOfPress(press); if (id) moveItemBy(id, Number(args?.direction) * snapMinutes); };
    // A verb about the thing (done, delete, going, colour...) runs the first of its actions the thing accepts: the same
    // actions the right-click menu offers, so a key and a menu row cannot disagree.
    if (contextActions) verbs['calendar-action'] = (args, press) => {
      const id = itemOfPress(press);
      if (!id) return;
      const node: NodeRef = { family: 'schedule-calendar-item', parts: { id, ...(typeof args?.choice === 'string' ? { choice: args.choice } : {}) } };
      for (const action of Array.isArray(args?.action) ? args.action as string[] : []) {
        const capability = contextActions.find(row => row.id === action);
        if (capability?.run && !capability.disabled && capability.accepts(node)) { void capability.run(node); return; }
      }
    };
  }
  const latestVerbs = React.useRef(verbs);
  latestVerbs.current = verbs;
  const verbNames = Object.keys(verbs).join(' ');
  React.useEffect(() => {
    if (!registerVerb || !verbNames) return undefined;
    const stops = verbNames.split(' ').map(name => registerVerb(name, (args, press) => latestVerbs.current[name]?.(args, press)));
    return () => { for (const stop of stops) stop(); };
  }, [registerVerb, verbNames]);
  const period = periodOf(view);
  const periodName = words.periods?.[period] ?? '';
  const previousLabel = words.previousPeriod && periodName ? fillName(words.previousPeriod, periodName) : words.previous;
  const nextLabel = words.nextPeriod && periodName ? fillName(words.nextPeriod, periodName) : words.next;
  const keyFor = (id: string) => shortcutKeys?.[id];
  const weekCrumb = view.grid === 'hours' && view.days % 7 === 0 && words.weekLabel
    ? words.weekLabel.replace('{week}', String(weekNumber(days[0], weekStartsOn))) : fmt.shortDay(anchor);
  const sectionChoice = sections?.find(row => row.id === section);
  const navigationHeader = showHeader ? <div data-schedule-calendar-header data-header-position={headerPosition} className="schedule-calendar-header flex shrink-0 flex-wrap items-center gap-1">
    <Tooltip label={previousLabel} shortcut={keyFor('previous')}>
      <Button size="icon-sm" variant="ghost" aria-label={previousLabel} onClick={() => onAnchorChange(shiftAnchor(view, anchor, -1))}><ChevronLeft /></Button>
    </Tooltip>
    <Tooltip label={nextLabel} shortcut={keyFor('next')}>
      <Button size="icon-sm" variant="ghost" aria-label={nextLabel} onClick={() => onAnchorChange(shiftAnchor(view, anchor, 1))}><ChevronRight /></Button>
    </Tooltip>
    {choicePresentation === 'menu' && choices && choices.length > 1 && choice && onChoiceChange ? (
      <Select value={choice} onValueChange={value => { if (typeof value === 'string') onChoiceChange(value); }}>
        <SelectTrigger className="w-auto min-w-0" aria-label={words.show ?? ariaLabel} data-schedule-view-menu="">
          <SelectValue>{choices.find(item => item.id === choice)?.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>{choices.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectPopup>
      </Select>
    ) : null}
    <Breadcrumb aria-label={words.breadcrumb ?? ariaLabel} data-schedule-breadcrumb="" className="schedule-calendar-breadcrumb min-w-0">
      <BreadcrumbList className="flex-nowrap gap-0.5 sm:gap-0.5">
        {sections && sections.length > 0 ? <>
          <BreadcrumbItem>
            {sections.length > 1 && onSectionChange ? <Select value={section ?? sections[0].id} onValueChange={value => { if (typeof value === 'string') onSectionChange(value); }}>
              <SelectTrigger className="schedule-calendar-crumb" aria-label={words.chooseSection ?? ariaLabel} data-schedule-section-crumb="">
                <SelectValue>{(sectionChoice ?? sections[0]).label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>{sections.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectPopup>
            </Select> : <span className="schedule-calendar-crumb-text" data-schedule-section-crumb="">{(sectionChoice ?? sections[0]).label}</span>}
          </BreadcrumbItem>
          <BreadcrumbSeparator />
        </> : null}
        <BreadcrumbItem>
          <Select value={Number(anchor.slice(5, 7)) - 1} onValueChange={value => { if (typeof value === 'number') onAnchorChange(moveToMonth(anchor, value)); }}>
            <SelectTrigger className="schedule-calendar-crumb" aria-label={words.chooseMonth ?? ariaLabel} data-schedule-month-crumb="">
              <SelectValue>{fmt.monthYear(anchor)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>{Array.from({ length: 12 }, (_, month) => <SelectItem key={month} value={month}>{fmt.monthName(month)}</SelectItem>)}</SelectPopup>
          </Select>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <DatePicker
            value={anchor}
            onChange={date => { if (date) onAnchorChange(date); }}
            allowClear={false}
            todayTone="calendar"
            aria-label={words.chooseDate ?? ariaLabel}
            trigger={<Button data-schedule-date-trigger variant="ghost" size="sm" className="schedule-calendar-crumb shrink-0 whitespace-nowrap px-1 text-sm font-semibold text-[var(--text-primary)]" aria-label={words.chooseDate ?? ariaLabel}>
              {weekCrumb}<ChevronDown aria-hidden="true" className="ml-0.5 size-3.5 text-[var(--text-muted)]" />
            </Button>}
          />
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
    {headerContent ? <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{headerContent}</div> : null}
    {choicePresentation === 'segmented' && choices && choices.length > 1 && choice && onChoiceChange ? (
      <SegmentedControl className={headerContent ? undefined : 'ml-auto'} items={choices} value={choice} ariaLabel={words.show ?? ariaLabel} onValueChange={onChoiceChange} />
    ) : null}
    <Tooltip label={words.goToToday ?? words.today} shortcut={keyFor('today')}>
      <Button size="xs" variant="outline" className={choices && choices.length > 1 || headerContent ? undefined : 'ml-auto'} onClick={() => onAnchorChange(today)}>{words.today}</Button>
    </Tooltip>
  </div> : null;

  const gridContents = view.grid === 'month' ? (
            <div className="min-h-full" style={{ minWidth: minDayWidth ? `${minDayWidth * (hideWeekendColumns ? 5 : 7)}px` : undefined }}>
              <CalendarGrid
                cells={monthCells}
                columns={hideWeekendColumns ? 5 : 7}
                columnLabels={weekdayLabels}
                density="comfortable"
                ariaLabel={ariaLabel}
                onSelectCell={onSelectDay}
                renderCell={(cell) => {
                  const onDay = byDay.get(cell.key) ?? [];
                  const shown = onDay.slice(0, perDayLimit);
                  return (
                    <>
                      {shown.map((item) => <ItemCard key={item.id} item={item} onOpen={openItem} actionLabel={selectionLabelFor(item)} selected={item.id === selectedId || selectedIdSet.has(item.id)} selectionControl={controlFor(item)} />)}
                      {onDay.length > shown.length ? (
                        <span className="px-1 text-[length:var(--font-size-caption)] text-[var(--text-muted)]">{words.more(onDay.length - shown.length)}</span>
                      ) : null}
                    </>
                  );
                }}
              />
            </div>
          ) : (
            <HourGrid
              windowStartMinute={windowStartMinute}
              windowEndMinute={windowEndMinute}
              workingHours={workingHours}
              hourHeightPx={hourHeightPx}
              formatHourLabel={fmt.hour}
              lanes={lanes}
              nowMinute={now.getHours() * 60 + now.getMinutes()}
              onSelectItem={openItem}
              commandRef={registerVerb ? gridCommands : undefined}
              bannersCollapsed={allDayFolded}
              collapsedBannerLabel={words.allDayMore}
              gutterHeading={gutterHeading}
              extraGutters={extraGutters}
              onHourHeightChange={onHourHeightChange}
              minHourHeightPx={zoomRange.min}
              maxHourHeightPx={zoomRange.max}
              zoomDragLabel={words.zoomDrag}
              onSelectTime={onSelectTime ? (laneKey, minute) => onSelectTime(timeAt(laneKey, minute)) : undefined}
              onSelectRange={onSelectRange ? (laneKey, start, end, anchor) => onSelectRange(timeAt(laneKey, start), timeAt(laneKey, end), anchor) : undefined}
              onRemoveRange={onRemoveRange ? (_laneKey, id) => onRemoveRange(id) : undefined}
              selectionKeyboardHint={words.selectTimeHint}
              onResizeItem={onResize ? (id, minutes) => {
                const item = byId.get(id);
                if (!item?.movable || !item.resizable || item.day || wholeDayOf(item)) return;
                onResize(id, minutes);
              } : undefined}
              resizeLabel={words.resizeHandle}
              snapMinutes={snapMinutes}
              dropMarker={held && target?.kind === 'lane' ? { laneKey: target.key, minute: target.minute!, label: `${held.title} · ${timeWords(timeAt(target.key, target.minute!), fmt)}` } : null}
              initialScrollMinute={initialScrollMinute}
              bannerGutterLabel={words.allDay}
              minLaneWidthPx={minDayWidth}
            />
          );
  const gridHeaderPositioned = Boolean(navigationHeader && headerPosition === 'grid');
  const gridPane = showGrid ? (
    <div key="grid" data-schedule-grid data-schedule-pane="grid" className={cn('schedule-calendar-grid-pane flex min-h-0 min-w-0 flex-1 flex-col overscroll-contain', gridHeaderPositioned ? 'overflow-hidden' : 'overflow-auto')}>
      {gridHeaderPositioned ? navigationHeader : null}
      {gridHeaderPositioned
        ? <div data-schedule-grid-body className="schedule-calendar-grid-body min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">{gridContents}</div>
        : gridContents}
    </div>
  ) : null;
  const trayTrees = new Map<string, TrayNode[]>();
  const ancestors: TrayNode[] = [];
  for (const row of trayRows) {
    const node: TrayNode = { row, children: [] };
    ancestors.length = Math.min(ancestors.length, row.depth);
    const parent = ancestors.at(-1);
    if (parent) parent.children.push(node);
    else {
      const group = row.groupId ?? '';
      if (!trayTrees.has(group)) trayTrees.set(group, []);
      trayTrees.get(group)!.push(node);
    }
    ancestors.push(node);
  }
  // Headings in the caller's order, including the ones it asks to show empty; records under no heading follow.
  const trayGroupEntries: [string, TrayNode[]][] = [
    ...(trayGroups ?? []).filter(group => trayTrees.has(group.id) || group.empty).map(group => [group.id, trayTrees.get(group.id) ?? []] as [string, TrayNode[]]),
    ...[...trayTrees].filter(([groupId]) => !(trayGroups ?? []).some(group => group.id === groupId)),
  ];
  const renderTrayEntry = ({ item, depth }: TrayRow, reorderable: boolean) => {
    const expanded = trayItemDetail?.id === item.id;
    const replaced = expanded && trayItemDetail.replacesItem;
    const handle = reorderable && words.reorderItem ? <Button
      data-reorder-handle="" className="schedule-tray-order-handle" size="icon-xs" variant="ghost"
      aria-label={words.reorderItem(item.title)} disabled={trayReorderDisabled}
      draggable={false} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
    ><GripVertical aria-hidden="true" /></Button> : null;
    return <div data-schedule-tray-entry={item.id} data-expanded={expanded || undefined}
      data-schedule-item={replaced ? item.id : undefined}
      draggable={replaced ? item.movable || undefined : undefined} className="schedule-tray-entry">
      {replaced ? handle : <ItemCard item={item} depth={depth} onOpen={onOpen} onCheckedChange={onCheckedChange}
        checkLabel={words.checkItem?.(item.title, Boolean(item.checked))} selected={item.id === selectedId || selectedIdSet.has(item.id)} marked={markedSet.has(item.id)} focused={trayFocusedId === item.id} variant="tray" orderHandle={handle} selectionControl={selectionControlFor(item)} />}
      {expanded ? trayItemDetail.content : null}
    </div>;
  };
  const taskPane = tray ? <div
          key="tray"
          ref={trayPane}
          data-schedule-tray
          data-schedule-pane="tray"
          data-detail-open={trayDetailOpen || undefined}
          className={cn(
            'schedule-calendar-tray flex min-h-0 shrink-0 flex-col gap-1.5 overflow-y-auto @3xl:w-60 @3xl:pr-4',
          )}
          data-drop-active={target?.kind === 'tray' || undefined}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={trayHeader ? 'sr-only' : 'text-xs font-semibold text-[var(--text-secondary)]'}>{words.tray}</span>
            {trayHeader ? <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{trayHeader}</div> : null}
          </div>
          {trayContent ? <div className="flex min-h-0 min-w-0 flex-col gap-2">{trayContent}</div> : null}
          {trayGroupEntries.length ? trayGroupEntries.map(([groupId, nodes]) => {
            const group = trayGroups?.find(row => row.id === groupId);
            const folded = Boolean(group) && foldedGroups.has(groupId);
            return <React.Fragment key={groupId}>
              {group ? <div className="schedule-tray-group-row" data-schedule-tray-group-row={groupId}>
                <Button variant="ghost" size="xs" className="schedule-tray-group" data-schedule-tray-group={groupId} data-folded={folded || undefined}
                  aria-expanded={!folded} aria-label={group.toggleLabel} title={group.toggleLabel}
                  onClick={() => setFoldedGroups(current => { const next = new Set(current); if (!next.delete(groupId)) next.add(groupId); return next; })}>
                  <ChevronDown aria-hidden="true" className="schedule-tray-group-chevron" />
                  <span className="schedule-tray-group-label">{group.label}</span>
                  {group.count !== undefined ? <span className="schedule-tray-group-count">{group.count}</span> : null}
                </Button>
                {group.onAdd && group.addLabel ? <Button variant="ghost" size="icon-xs" className="schedule-tray-group-add" aria-label={group.addLabel} title={group.addLabel} onClick={group.onAdd}><Plus aria-hidden="true" /></Button> : null}
              </div> : null}
              {folded || !nodes.length ? null : <TrayBranch nodes={nodes} onReorder={words.reorderItem ? onTrayReorder : undefined} disabled={trayReorderDisabled} renderEntry={renderTrayEntry} />}
            </React.Fragment>;
          }) : (
            <span className="px-0.5 text-[length:var(--font-size-caption)] text-[var(--text-muted)]">{words.trayEmpty}</span>
          )}
          {trayAfterItems ? <div className="schedule-tray-after-items min-w-0">{trayAfterItems}</div> : null}
        </div> : null;
  // DOM order follows the visible order, including details opened above a narrow grid.
  const trayFirst = wide || trayDetailOpen;
  return (
    <FormatContext.Provider value={fmt}>
    <div
      ref={host}
      data-schedule-calendar
      data-tray-side={traySide}
      aria-label={ariaLabel}
      className={cn('@container flex h-full min-h-0 flex-col gap-3', className)}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={finish}
      onContextMenu={onItemContextMenu}
    >
      {navigationHeader && headerPosition === 'above' ? navigationHeader : null}
      {selectionBar ? <div data-schedule-selection-bar className="min-w-0">{selectionBar}</div> : null}
      <p role="status" aria-live="polite" className="sr-only">{heard}</p>
      {!tray && trayContent ? <div data-schedule-action-content className="min-w-0 shrink-0">{trayContent}</div> : null}
      <OrderedPanes>
        {trayFirst ? [taskPane, gridPane] : [gridPane, taskPane]}
      </OrderedPanes>
      {contextMenu.contextMenu}
      {shortcutGroups ? <ShortcutSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={words.shortcuts} groups={shortcutGroups} /> : null}
    </div>
    </FormatContext.Provider>
  );
}
