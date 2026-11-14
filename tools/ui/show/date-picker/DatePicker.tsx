// packages/ui/show/date-picker/DatePicker.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical calendar date picker. Design ported from the hand-built grasshop
// date picker (dev/grasshop-app/components/ui/date-picker.tsx): month
// navigation, fixed 6x7 day grid, filled selection circle, quiet chrome.
// Web-native implementation on Radix Popover (same portal pattern as
// Dropdown), zero date libraries — plain Date math only.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic: no product vocabulary. Value in/out is a plain 'YYYY-MM-DD'
//    string or null — no timezone games, no Date objects across the boundary.
// 2. Tokens only: colors ride the same CSS variables / utility opacities the
//    rest of ui/ uses. No hardcoded brand colors.
// 3. Keyboard accessible: trigger opens with Enter/Space; Escape closes.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '../cn';
import { LAYER_ORDER } from '../layer-order/layer-order';
import { boundedDay, calendarDay, dayInRange, formatDay, localDay, parseDay, shiftDay } from './date-values.mjs';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Single-letter weekday header, Sunday-first (Amie calendar reference).
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function toDateString(year: number, month: number, day: number): string {
  return formatDay(year, month, day);
}

function parseDateString(value: string | null | undefined): { year: number; month: number; day: number } | null {
  return parseDay(calendarDay(value));
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Numeric Date constructors reinterpret years 0–99 as 1900–1999. A calendar
// must keep the same supported year that its value parser accepts.
function dateAt(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month, day);
  return date;
}

function formatTriggerLabel(value: string | null | undefined): string | null {
  const parsed = parseDateString(value);
  if (!parsed) return null;
  return `${MONTH_SHORT[parsed.month]} ${parsed.day}${parsed.year === new Date().getFullYear() ? '' : `, ${parsed.year}`}`;
}

/** Sunday-first offset of the 1st of the month (0..6) — Amie week shape. */
function firstCellOffset(year: number, month: number): number {
  return dateAt(year, month, 1).getDay(); // 0=Sun..6=Sat
}

function daysInMonth(year: number, month: number): number {
  return dateAt(year, month + 1, 0).getDate();
}

export interface DatePickerProps {
  /** Selected date as 'YYYY-MM-DD', or null/undefined for none. */
  value?: string | null;
  /** Receives 'YYYY-MM-DD', or null when cleared. */
  onChange: (value: string | null) => void;
  /** Custom trigger element. Defaults to a quiet bordered button. */
  trigger?: React.ReactElement;
  /** Placeholder text on the default trigger when no date is selected. */
  placeholder?: string;
  /** Optional visible field name before the selected date. */
  label?: string;
  /** Show the Clear action in the footer. Default true. */
  allowClear?: boolean;
  /** Inclusive calendar-day limits; no UTC conversion is applied. */
  min?: string | null;
  max?: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  /** Controlled opening, or open immediately for an inline date editor. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  name?: string;
  className?: string;
  /** `calendar`: today is marked by the look's calendar-today colour on its number and the chosen day is a quiet gray
   *  square (a calendar's own month picker). Default `neutral`: the chosen day takes the accent fill, today a gray square. */
  todayTone?: 'neutral' | 'calendar';
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  'aria-label'?: string;
}

export function DatePicker({
  value,
  onChange,
  trigger,
  placeholder = 'Pick a date',
  label,
  allowClear = true,
  min,
  max,
  disabled = false,
  readOnly = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  id,
  name,
  className,
  todayTone = 'neutral',
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
  'aria-label': ariaLabel,
}: DatePickerProps) {
  const [ownOpen, setOwnOpen] = React.useState(defaultOpen);
  const open = !disabled && !readOnly && (controlledOpen ?? ownOpen);
  const setOpen = (next: boolean) => {
    if (next && (disabled || readOnly)) return;
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const today = new Date();
  const selectedDay = calendarDay(value);
  const startDay = boundedDay(selectedDay ?? localDay(today), min, max) ?? localDay(today);
  const selected = parseDateString(startDay);
  const [viewYear, setViewYear] = React.useState(selected?.year ?? today.getFullYear());
  const [viewMonth, setViewMonth] = React.useState(selected?.month ?? today.getMonth());
  const [focusedDay, setFocusedDay] = React.useState(startDay);
  const dayButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = React.useRef(false);
  const headingId = React.useId();
  React.useLayoutEffect(() => {
    if (open && pendingFocus.current) {
      pendingFocus.current = false;
      dayButtons.current.get(focusedDay)?.focus();
    }
  }, [open, focusedDay, viewYear, viewMonth]);

  React.useEffect(() => {
    if (open) {
      const current = parseDateString(startDay);
      setViewYear(current?.year ?? today.getFullYear());
      setViewMonth(current?.month ?? today.getMonth());
      setFocusedDay(startDay);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function shiftMonth(delta: number) {
    const next = dateAt(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
    const first = boundedDay(toDateString(next.getFullYear(), next.getMonth(), 1), min, max);
    if (first) setFocusedDay(first);
  }

  function focusDay(nextDay: string | null) {
    const next = boundedDay(nextDay, min, max);
    const date = parseDateString(next);
    if (!next || !date) return;
    pendingFocus.current = true;
    setFocusedDay(next);
    setViewYear(date.year);
    setViewMonth(date.month);
  }

  function keyOnDay(event: React.KeyboardEvent, date: string) {
    const offsets: Record<string, number> = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7};
    if (event.key in offsets) { event.preventDefault(); event.stopPropagation(); focusDay(shiftDay(date, offsets[event.key])); }
    else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); event.stopPropagation();
      const weekday = new Date(`${date}T12:00:00`).getDay();
      focusDay(shiftDay(date, event.key === 'Home' ? -weekday : 6 - weekday));
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault(); event.stopPropagation();
      const part = parseDateString(date)!;
      const next = dateAt(part.year, part.month + (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1), 1);
      focusDay(toDateString(next.getFullYear(), next.getMonth(), Math.min(part.day, daysInMonth(next.getFullYear(), next.getMonth()))));
    }
  }

  function choose(day: string | null) {
    if (disabled || readOnly || (day && !dayInRange(day, min, max))) return;
    onChange(day);
    setOpen(false);
  }

  const offset = firstCellOffset(viewYear, viewMonth);
  const total = daysInMonth(viewYear, viewMonth);
  // Full 6x7 grid: leading cells carry the prior month's trailing days and
  // trailing cells the next month's leading days, rendered dim but live
  // (Amie calendar reference — the number block is always complete).
  interface DayCell { day: number; month: number; year: number; outside: boolean }
  const cells: DayCell[] = Array.from({ length: 42 }, (_, index) => {
    const dayOffset = index - offset + 1;
    const date = dateAt(viewYear, viewMonth, dayOffset);
    return {
      day: date.getDate(),
      month: date.getMonth(),
      year: date.getFullYear(),
      outside: dayOffset < 1 || dayOffset > total,
    };
  });
  const todayString = toDateString(today.getFullYear(), today.getMonth(), today.getDate());

  const defaultTrigger = (
    <button
      type="button"
      id={id}
      disabled={disabled || readOnly}
      aria-readonly={readOnly || undefined}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      aria-label={ariaLabel ?? 'Pick a date'}
      className={cn(
        'flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1 text-[13px] transition-colors duration-100',
        value
          ? 'bg-white/10 text-[var(--text-primary)] hover:bg-white/15'
          : 'text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)]',
        open && 'bg-white/15 text-[var(--text-primary)]',
        className,
      )}
    >
      {label ? <span className="text-[var(--text-muted)]">{label}</span> : null}
      <CalendarDays size={13} aria-hidden="true" className="shrink-0 opacity-70" />
      {formatTriggerLabel(value) ?? placeholder}
    </button>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {name ? <input type="hidden" name={name} value={selectedDay ?? ''} disabled={disabled} /> : null}
      <Popover.Trigger asChild disabled={disabled || readOnly}>{trigger ?? defaultTrigger}</Popover.Trigger>
      {/* Portal subtree gated on `open` (R17 dead-clicks fix, same as Dropdown):
          with `animate-in` on the content, radix Presence can wedge in
          unmountSuspended when the compiled global-css record arrives after
          mount (animation-name differs at close, animationend never fires) and
          the closed popper wrapper stays mounted + interactive, swallowing
          clicks on UI beneath it. Closed = rendered NOTHING, structurally. */}
      {open && (
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          aria-label={ariaLabel ?? 'Pick a date'}
          onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => dayButtons.current.get(startDay)?.focus()); }}
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
          className="glass-popover p-3 animate-in fade-in-0 zoom-in-95 bg-[var(--glass-popover-background,var(--glass-bg-active,var(--glass-bg-subtle)))] backdrop-blur-2xl backdrop-saturate-150"
          style={{ width: 252, zIndex: LAYER_ORDER.menu }}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              aria-label="Previous month"
              disabled={Boolean(min && toDateString(viewYear, viewMonth, 1) <= min.slice(0, 10))}
              className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)] transition-colors"
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span id={headingId} aria-live="polite" className="text-sm font-medium text-[var(--text-primary)]">
              {`${MONTHS[viewMonth]} ${viewYear}`}
            </span>
            <button
              type="button"
              aria-label="Next month"
              disabled={Boolean(max && toDateString(viewYear, viewMonth, daysInMonth(viewYear, viewMonth)) >= max.slice(0, 10))}
              className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)] transition-colors"
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="mb-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 32px)' }}>
            {WEEKDAYS.map((weekday, weekdayIndex) => (
              <span key={`${weekday}-${weekdayIndex}`} className="flex h-7 items-center justify-center text-[12px] font-semibold text-[var(--text-tertiary)]">
                {weekday}
              </span>
            ))}
          </div>
          <div role="grid" aria-labelledby={headingId} style={{ display: 'grid', rowGap: 2 }}>
            {Array.from({length: 6}, (_, week) => <div role="row" key={week} style={{display: 'grid', gridTemplateColumns: 'repeat(7, 32px)'}}>{cells.slice(week * 7, week * 7 + 7).map((cell, index) => {
              const dateString = toDateString(cell.year, cell.month, cell.day);
              const isSelected = selectedDay === dateString;
              const isToday = dateString === todayString;
              const unavailable = !dayInRange(dateString, min, max);
              return (
                <button
                  key={index}
                  type="button"
                  role="gridcell"
                  ref={node => { if (node) dayButtons.current.set(dateString, node); else dayButtons.current.delete(dateString); }}
                  aria-label={new Date(`${dateString}T12:00:00`).toLocaleDateString(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})}
                  aria-selected={isSelected}
                  aria-current={isToday ? 'date' : undefined}
                  disabled={unavailable}
                  tabIndex={dateString === focusedDay ? 0 : -1}
                  onKeyDown={event => keyOnDay(event, dateString)}
                  onFocus={() => setFocusedDay(dateString)}
                  style={{ width: 30, height: 30, margin: '0 auto' }}
                  className={cn(
                    // Amie cells are rounded SQUARES: selected = accent fill,
                    // today = quiet gray square, adjacent months dim but live.
                    'flex items-center justify-center rounded-[var(--radius-control)] text-sm font-medium transition-colors duration-100',
                    isSelected
                      // On-accent text comes from the theme's computed contrast
                      // token — light accents invert to dark text correctly.
                      ? todayTone === 'calendar' ? cn('bg-white/20', !isToday && 'text-[var(--text-primary)]') : 'bg-[var(--accent-primary,#3B82F6)] text-[var(--button-primary-text,#fff)]'
                      : cell.outside
                        ? 'text-[var(--text-tertiary)] hover:bg-white/5 hover:text-[var(--text-muted)]'
                        : 'text-[var(--text-primary)] hover:bg-white/10',
                    !isSelected && isToday && todayTone === 'neutral' && 'bg-white/10',
                    isToday && todayTone === 'calendar' && 'font-semibold text-[var(--calendar-today-fill)]',
                    'disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring-color)]',
                  )}
                  onClick={() => choose(dateString)}
                >
                  {cell.day}
                </button>
              );
            })}</div>)}
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/10">
            <button
              type="button"
              disabled={!dayInRange(todayString, min, max)}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              onClick={() => choose(todayString)}
            >
              Today
            </button>
            {allowClear ? (
              <button
                type="button"
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                onClick={() => choose(null)}
              >
                Clear
              </button>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
      )}
    </Popover.Root>
  );
}
