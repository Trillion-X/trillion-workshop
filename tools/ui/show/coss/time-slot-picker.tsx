// parts/ui/show/coss/time-slot-picker.tsx
//
// PURPOSE
//   Pick one open time: a month of days where the days that have open times can be chosen (the shared CalendarGrid in
//   its picker density, each such day marked with how many times it has), and the chosen day's times as buttons.
//   Anatomy follows Calendly's "Select a Date & Time" and HoneyBook's scheduler block (Mobbin screens 254dc09b and
//   b5fed4af): a month grid with the open days lit, the chosen day's times in a column beside it, stacked under it on a
//   narrow screen. Appearance lives in screen-look/show/guide.css (`.time-slot-picker`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Generic: no product words. Days and times arrive as DATA ({ date: 'YYYY-MM-DD', label, options: [{ value,
//      label }] }), already in the viewer's time zone; this part only lays them out and reports the chosen value.
//   2. Only a day that has times can be chosen, and only one of its times can be the value.
//   3. Selection is routed, not owned: `value` comes in, `onChange` goes out.
//   4. Month and weekday names are the browser's own locale words (Intl), never written here.
//
// KEY CONCEPTS
//   `TimeSlotDay`: one day with its open times. The month shown starts at the chosen time's day, else the first day
//   with times; the arrows move between months that have times.

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { CalendarGrid, type CalendarGridCell } from '../calendar-grid';

export type TimeSlotOption = { value: string; label: string };
export type TimeSlotDay = { date: string; label: string; options: TimeSlotOption[] };
export type TimeSlotPickerProps = { days: TimeSlotDay[]; value: string | null; onChange: (value: string) => void; label: string };

const monthOf = (date: string) => date.slice(0, 7);
const utc = (date: string) => new Date(`${date}T12:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (date: string, days: number) => { const next = utc(date); next.setUTCDate(next.getUTCDate() + days); return iso(next); };
const monthWords = (month: string) => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(`${month}-01`));
// Sunday-first weekday initials in the browser's locale (2026-09-27 is a Sunday).
const WEEKDAYS = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(undefined, { weekday: 'narrow', timeZone: 'UTC' }).format(utc(addDays('2026-09-27', index))));

export function TimeSlotPicker({ days, value, onChange, label }: TimeSlotPickerProps) {
  const byDate = React.useMemo(() => new Map(days.filter(day => day.options.length).map(day => [day.date, day])), [days]);
  const months = React.useMemo(() => [...new Set([...byDate.keys()].map(monthOf))].sort(), [byDate]);
  const chosenDay = days.find(day => day.options.some(option => option.value === value))?.date ?? null;
  const [day, setDay] = React.useState<string | null>(chosenDay ?? days.find(item => item.options.length)?.date ?? null);
  const [month, setMonth] = React.useState<string | null>(day ? monthOf(day) : months[0] ?? null);
  React.useEffect(() => { if (chosenDay) { setDay(chosenDay); setMonth(monthOf(chosenDay)); } }, [chosenDay]);
  if (!month) return null;

  // Six weeks from the Sunday on or before the 1st, so every month has the same shape.
  const first = `${month}-01`;
  const start = addDays(first, -utc(first).getUTCDay());
  const cells: CalendarGridCell[] = Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    const open = byDate.get(date);
    return {
      key: date, label: String(Number(date.slice(8))), muted: monthOf(date) !== month, disabled: !open, selected: date === day,
      ariaLabel: open ? `${open.label}, ${open.options.length} ${open.options.length === 1 ? 'time' : 'times'}` : undefined,
      count: open ? open.options.length : undefined,
    };
  });
  const at = months.indexOf(month);
  const shown = day ? byDate.get(day) : undefined;
  return (
    <div className="time-slot-picker" role="group" aria-label={label}>
      <div className="time-slot-picker-month">
        <div className="time-slot-picker-month-top">
          <p className="time-slot-picker-month-name">{monthWords(month)}</p>
          <span className="time-slot-picker-month-moves">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Earlier month" disabled={at <= 0} onClick={() => setMonth(months[at - 1])}><ChevronLeft aria-hidden /></Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Later month" disabled={at < 0 || at >= months.length - 1} onClick={() => setMonth(months[at + 1])}><ChevronRight aria-hidden /></Button>
          </span>
        </div>
        <CalendarGrid cells={cells} columnLabels={WEEKDAYS} density="picker" countLimit={9} ariaLabel={monthWords(month)} onSelectCell={key => setDay(key)} />
      </div>
      <div className="time-slot-picker-times">
        {shown ? (
          <>
            <p className="time-slot-picker-day">{shown.label}</p>
            <div className="time-slot-picker-options" role="radiogroup" aria-label={shown.label}>
              {shown.options.map(option => (
                <Button key={option.value} type="button" role="radio" aria-checked={option.value === value} variant={option.value === value ? 'default' : 'outline'} size="sm" className="time-slot-picker-option" onClick={() => onChange(option.value)}>
                  {option.label}
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
