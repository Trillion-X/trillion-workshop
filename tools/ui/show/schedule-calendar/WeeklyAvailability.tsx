import * as React from 'react';
import { ActionMenu, Button, Container, Input, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text } from '../../index';
import { carveBreak, readScheduleDescription, type DescriptionIssue } from './schedule-description.mjs';

export interface WeeklyAvailabilityInterval {
  start_minute: number;
  end_minute: number;
}

export interface WeeklyAvailabilityDay {
  /** Sunday is 0 through Saturday is 6. */
  weekday: number;
  intervals: WeeklyAvailabilityInterval[];
}

export interface WeeklyAvailabilitySchedule {
  id: string;
  label: string;
  days: WeeklyAvailabilityDay[];
}

export interface WeeklyAvailabilityWords {
  title: string;
  newSchedule: string;
  newScheduleName: string;
  scheduleName: string;
  schedulePlaceholder: string;
  chooseSchedule: string;
  defaultSchedule: string;
  noDefault: string;
  empty: string;
  weekdayLabels: string[];
  available: string;
  unavailable: string;
  toggleDay: string;
  start: string;
  end: string;
  addInterval: string;
  removeInterval: string;
  /** Adds a break inside the day's longest hours. `{day}` is the weekday name. */
  addBreak: string;
  /** Names the gap between two hours of one day. `{start}` and `{end}` are times. */
  breakBetween: string;
  /** Heading of the box where the person describes the week in their own words. */
  describeLabel: string;
  describePlaceholder: string;
  /** Applies the described week to the schedule being edited. */
  describeConfirm: string;
  /** What the reader understood, before it is applied. `{hours}` is the summary. */
  describePreview: string;
  /** Why a description was not applied, by the reader's issue code. `{text}` is the part that was not understood. */
  describeIssues: Record<DescriptionIssue['code'], string>;
  /** The menu on a schedule: every row is a label and an icon name. */
  menu: {
    label: string;
    rename: { label: string; icon: string };
    makeDefault: { label: string; icon: string };
    createBookingLink: { label: string; icon: string };
    delete: { label: string; icon: string };
  };
  save: string;
  nameRequired: string;
  intervalInvalid: string;
}

export interface WeeklyAvailabilityProps {
  schedules: WeeklyAvailabilitySchedule[];
  /** The schedule used as the default for availability and scheduling. */
  workScheduleId?: string | null;
  /** Legacy preferences converted by the caller and used only when creating the first draft. */
  initialDays: WeeklyAvailabilityDay[];
  words: WeeklyAvailabilityWords;
  /** Sunday = 0. The caller's first weekday also orders the editor. */
  weekStartsOn?: number;
  onSave: (schedules: WeeklyAvailabilitySchedule[], workScheduleId: string | null) => void;
  /** Starts a booking link from the schedule being edited. Without it the menu has no such row. */
  onCreateBookingLink?: (schedule: WeeklyAvailabilitySchedule) => void;
}

const NO_DEFAULT = '__no_default__';
const timeOptions = Array.from({ length: 97 }, (_, index) => {
  const minutes = index * 15;
  const value = String(minutes);
  const label = minutes === 1440
    ? new Date(2000, 0, 2).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return { value, label };
});
const timeLabel = (minutes: number) => timeOptions.find(option => Number(option.value) === minutes)?.label
  ?? new Date(2000, 0, 1 + Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const cloneSchedules = (schedules: WeeklyAvailabilitySchedule[]) => schedules.map(schedule => ({
  ...schedule,
  days: schedule.days.map(day => ({ ...day, intervals: day.intervals.map(interval => ({ ...interval })) })),
}));

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

function dayOf(schedule: WeeklyAvailabilitySchedule, weekday: number): WeeklyAvailabilityDay {
  return schedule.days.find(day => day.weekday === weekday) ?? { weekday, intervals: [] };
}

function nextInterval(intervals: WeeklyAvailabilityInterval[]): WeeklyAvailabilityInterval | null {
  for (let start = 9 * 60; start + 60 <= 1440; start += 30) {
    const end = start + 60;
    if (intervals.every(interval => end <= interval.start_minute || start >= interval.end_minute)) return { start_minute: start, end_minute: end };
  }
  for (let start = 0; start + 60 <= 9 * 60; start += 30) {
    const end = start + 60;
    if (intervals.every(interval => end <= interval.start_minute || start >= interval.end_minute)) return { start_minute: start, end_minute: end };
  }
  return null;
}

function validSchedule(schedule: WeeklyAvailabilitySchedule | undefined): boolean {
  if (!schedule || typeof schedule.label !== 'string' || !schedule.label.trim() || !Array.isArray(schedule.days)) return false;
  const seenDays = new Set<number>();
  for (const day of schedule.days) {
    if (!day || typeof day !== 'object' || !Number.isSafeInteger(day.weekday) || day.weekday < 0 || day.weekday > 6
      || seenDays.has(day.weekday) || !Array.isArray(day.intervals)) return false;
    seenDays.add(day.weekday);
    let previousEnd = -1;
    for (const interval of day.intervals) {
      if (!interval || typeof interval !== 'object' || !Number.isSafeInteger(interval.start_minute) || !Number.isSafeInteger(interval.end_minute)
        || interval.start_minute < 0 || interval.end_minute > 1440
        || interval.end_minute <= interval.start_minute || interval.start_minute < previousEnd) return false;
      previousEnd = interval.end_minute;
    }
  }
  return true;
}

/**
 * Edits named weekly availability locally and commits the complete schedule set only on Save.
 * All visible words and weekday names come from the caller.
 */
export function WeeklyAvailability({ schedules, workScheduleId = null, initialDays, words, weekStartsOn = 0, onSave, onCreateBookingLink }: WeeklyAvailabilityProps): React.ReactElement {
  const inputKey = JSON.stringify([schedules, workScheduleId]);
  const [draftSchedules, setDraftSchedules] = React.useState(() => cloneSchedules(schedules));
  const [draftDefaultId, setDraftDefaultId] = React.useState<string | null>(workScheduleId && schedules.some(row => row.id === workScheduleId) ? workScheduleId : null);
  const [editingId, setEditingId] = React.useState<string | null>(() => workScheduleId && schedules.some(row => row.id === workScheduleId)
    ? workScheduleId : schedules[0]?.id ?? null);
  const previousInputKey = React.useRef(inputKey);
  const nameField = React.useRef<HTMLInputElement>(null);
  const [description, setDescription] = React.useState('');
  const described = React.useMemo(() => description.trim() ? readScheduleDescription(description) : null, [description]);

  React.useEffect(() => {
    if (previousInputKey.current === inputKey) return;
    previousInputKey.current = inputKey;
    const next = cloneSchedules(schedules);
    setDraftSchedules(next);
    setDraftDefaultId(workScheduleId && next.some(row => row.id === workScheduleId) ? workScheduleId : null);
    setEditingId(workScheduleId && next.some(row => row.id === workScheduleId) ? workScheduleId : next[0]?.id ?? null);
  }, [inputKey, schedules, workScheduleId]);

  const current = draftSchedules.find(schedule => schedule.id === editingId);
  const setCurrent = (update: (schedule: WeeklyAvailabilitySchedule) => WeeklyAvailabilitySchedule) => {
    if (!current) return;
    setDraftSchedules(rows => rows.map(schedule => schedule.id === current.id ? update(schedule) : schedule));
  };
  const updateDay = (weekday: number, update: (day: WeeklyAvailabilityDay) => WeeklyAvailabilityDay) => setCurrent(schedule => {
    const existing = dayOf(schedule, weekday);
    const nextDay = update({ ...existing, intervals: existing.intervals.map(interval => ({ ...interval })) });
    const days = schedule.days.some(day => day.weekday === weekday)
      ? schedule.days.map(day => day.weekday === weekday ? nextDay : day)
      : [...schedule.days, nextDay];
    return { ...schedule, days: days.sort((a, b) => a.weekday - b.weekday) };
  });

  const createSchedule = () => {
    const id = crypto.randomUUID();
    const created: WeeklyAvailabilitySchedule = {
      id,
      label: words.newScheduleName,
      days: initialDays.map(day => ({ ...day, intervals: day.intervals.map(interval => ({ ...interval })) })),
    };
    setDraftSchedules(rows => [...rows, created]);
    setEditingId(id);
    setDraftDefaultId(id);
  };

  const deleteSchedule = () => {
    if (!current) return;
    const rows = draftSchedules.filter(schedule => schedule.id !== current.id);
    setDraftSchedules(rows);
    if (draftDefaultId === current.id) setDraftDefaultId(null);
    setEditingId(rows[0]?.id ?? null);
  };

  const confirmDescription = () => {
    if (!described || described.issues.length) return;
    if (current) setCurrent(schedule => ({ ...schedule, days: described.days.map(day => ({ ...day, intervals: day.intervals.map(interval => ({ ...interval })) })) }));
    else {
      const id = crypto.randomUUID();
      setDraftSchedules(rows => [...rows, { id, label: words.newScheduleName, days: described.days }]);
      setEditingId(id);
      setDraftDefaultId(id);
    }
    setDescription('');
  };
  // One phrase per run of neighbouring days with the same hours, in the order the week is shown.
  const summary = (days: WeeklyAvailabilityDay[]) => {
    const order = words.weekdayLabels.map((_, index) => (index + weekStartsOn) % words.weekdayLabels.length);
    const hoursOf = (weekday: number) => (days.find(day => day.weekday === weekday)?.intervals ?? [])
      .map(interval => `${timeLabel(interval.start_minute)}–${timeLabel(interval.end_minute)}`).join(', ');
    const runs: { first: number; last: number; hours: string }[] = [];
    for (const weekday of order) {
      const hours = hoursOf(weekday);
      if (!hours) continue;
      const run = runs[runs.length - 1];
      if (run && run.hours === hours && order.indexOf(weekday) === order.indexOf(run.last) + 1) run.last = weekday;
      else runs.push({ first: weekday, last: weekday, hours });
    }
    return runs.map(run => `${words.weekdayLabels[run.first]}${run.last === run.first ? '' : `–${words.weekdayLabels[run.last]}`} ${run.hours}`).join('; ');
  };
  const menuAction = (id: string) => {
    if (!current) return;
    if (id === 'rename') nameField.current?.focus();
    else if (id === 'makeDefault') setDraftDefaultId(current.id);
    else if (id === 'createBookingLink') onCreateBookingLink?.(cloneSchedules([current])[0]);
    else if (id === 'delete') deleteSchedule();
  };
  const menuRows = current ? [
    { id: 'rename', ...words.menu.rename },
    { id: 'makeDefault', ...words.menu.makeDefault, disabled: draftDefaultId === current.id },
    ...(onCreateBookingLink ? [{ id: 'createBookingLink', ...words.menu.createBookingLink, disabled: !validSchedule(current) }] : []),
    { id: 'delete', ...words.menu.delete, tone: 'destructive' as const, group: 'danger' },
  ] : [];

  const describeBlock = <Container data-weekly-availability-describe layout="vertical" gap="xs">
    <Input label={words.describeLabel} placeholder={words.describePlaceholder} maxLength={600} value={description}
      onChange={event => setDescription(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); confirmDescription(); } }} />
    {described ? <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="caption" color={described.issues.length ? 'error' : 'muted'}>
        {described.issues.length
          ? described.issues.map(issue => fill(words.describeIssues[issue.code], { text: issue.text })).join(' ')
          : fill(words.describePreview, { hours: summary(described.days) })}
      </Text>
      <Button size="xs" variant="outline" disabled={described.issues.length > 0} onClick={confirmDescription}>{words.describeConfirm}</Button>
    </Container> : null}
  </Container>;

  const selectDefault = (value: string | number) => setDraftDefaultId(value === NO_DEFAULT || typeof value !== 'string' ? null : value);
  const canSave = draftSchedules.every(validSchedule);

  return <Container data-weekly-availability layout="vertical" gap="sm" className="weekly-availability">
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="body" weight="semibold">{words.title}</Text>
      <Button size="xs" variant="outline" onClick={createSchedule}>{words.newSchedule}</Button>
    </Container>

    {draftSchedules.length ? <Container layout="vertical" gap="sm">
      <Container layout="horizontal" gap="xs" alignItems="center" wrap>
        <Container layout="vertical" gap="xs" className="weekly-availability-choice">
          <Text variant="caption" color="muted">{words.chooseSchedule}</Text>
          <Select value={editingId ?? ''} onValueChange={value => { if (typeof value === 'string') setEditingId(value); }}>
            <SelectTrigger className="weekly-availability-schedule-select" aria-label={words.chooseSchedule}><SelectValue>{draftSchedules.find(schedule => schedule.id === editingId)?.label || words.schedulePlaceholder}</SelectValue></SelectTrigger>
            <SelectPopup>{draftSchedules.map(schedule => <SelectItem key={schedule.id} value={schedule.id}>{schedule.label || words.schedulePlaceholder}</SelectItem>)}</SelectPopup>
          </Select>
        </Container>
        <Container layout="vertical" gap="xs" className="weekly-availability-choice">
          <Text variant="caption" color="muted">{words.defaultSchedule}</Text>
          <Select value={draftDefaultId ?? NO_DEFAULT} onValueChange={selectDefault}>
            <SelectTrigger className="weekly-availability-default-select" aria-label={words.defaultSchedule}><SelectValue>{draftSchedules.find(schedule => schedule.id === draftDefaultId)?.label || words.noDefault}</SelectValue></SelectTrigger>
            <SelectPopup>
              <SelectItem value={NO_DEFAULT}>{words.noDefault}</SelectItem>
              {draftSchedules.map(schedule => <SelectItem key={schedule.id} value={schedule.id}>{schedule.label || words.schedulePlaceholder}</SelectItem>)}
            </SelectPopup>
          </Select>
        </Container>
        {current ? <ActionMenu label={words.menu.label} items={menuRows} onAction={menuAction} /> : null}
      </Container>

      {current ? <>
        <Input ref={nameField} label={words.scheduleName} placeholder={words.schedulePlaceholder} value={current.label}
          onChange={event => setCurrent(schedule => ({ ...schedule, label: event.target.value }))} />
        {describeBlock}
        <Container data-weekly-availability-days layout="vertical" gap="xs">
          {words.weekdayLabels.map((_, index) => (index + weekStartsOn) % words.weekdayLabels.length).map(weekday => {
            const label = words.weekdayLabels[weekday];
            const day = dayOf(current, weekday);
            const available = day.intervals.length > 0;
            return <Container key={weekday} data-weekly-availability-day={weekday} data-available={available} layout="vertical" gap="xs" className="weekly-availability-day">
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                <Text variant="body-sm" weight="medium">{label}</Text>
                <Container layout="horizontal" gap="xs" alignItems="center">
                  <Text variant="caption" color="muted">{available ? words.available : words.unavailable}</Text>
                  <Switch size="sm" label={fill(words.toggleDay, { day: label })} checked={available}
                    onCheckedChange={checked => updateDay(weekday, value => ({
                      ...value,
                      intervals: checked ? (value.intervals.length ? value.intervals : [{ start_minute: 9 * 60, end_minute: 17 * 60 }]) : [],
                    }))} />
                </Container>
              </Container>
              {day.intervals.map((interval, index) => <React.Fragment key={`${weekday}-${index}`}>
                {index > 0 ? <Text variant="caption" color="muted" data-weekly-availability-break>{fill(words.breakBetween, { start: timeLabel(day.intervals[index - 1].end_minute), end: timeLabel(interval.start_minute) })}</Text> : null}
                <Container data-weekly-availability-interval layout="horizontal" gap="xs" alignItems="center" className="weekly-availability-interval">
                <Select value={String(interval.start_minute)} onValueChange={choice => {
                  if (typeof choice === 'string' && Number.isSafeInteger(Number(choice))) updateDay(weekday, dayValue => ({
                    ...dayValue,
                    intervals: dayValue.intervals.map((row, rowIndex) => rowIndex === index ? { ...row, start_minute: Number(choice) } : row).sort((a, b) => a.start_minute - b.start_minute),
                  }));
                }}>
                  <SelectTrigger aria-label={fill(words.start, { day: label, interval: String(index + 1) })}><SelectValue>{timeLabel(interval.start_minute)}</SelectValue></SelectTrigger>
                  <SelectPopup>{timeOptions.filter(option => Number(option.value) < 1440).map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
                </Select>
                <Text variant="caption" color="muted">–</Text>
                <Select value={String(interval.end_minute)} onValueChange={choice => {
                  if (typeof choice === 'string' && Number.isSafeInteger(Number(choice))) updateDay(weekday, dayValue => ({
                    ...dayValue,
                    intervals: dayValue.intervals.map((row, rowIndex) => rowIndex === index ? { ...row, end_minute: Number(choice) } : row).sort((a, b) => a.start_minute - b.start_minute),
                  }));
                }}>
                  <SelectTrigger aria-label={fill(words.end, { day: label, interval: String(index + 1) })}><SelectValue>{timeLabel(interval.end_minute)}</SelectValue></SelectTrigger>
                  <SelectPopup>{timeOptions.filter(option => Number(option.value) > 0).map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
                </Select>
                <Button size="xs" variant="ghost" className="weekly-availability-remove" aria-label={fill(words.removeInterval, { day: label, interval: String(index + 1) })}
                  onClick={() => updateDay(weekday, value => ({ ...value, intervals: value.intervals.filter((_, rowIndex) => rowIndex !== index) }))}>×</Button>
              </Container></React.Fragment>)}
              {available ? <Button size="xs" variant="ghost" className="weekly-availability-add-break" disabled={carveBreak(day.intervals) === day.intervals}
                onClick={() => updateDay(weekday, value => ({ ...value, intervals: carveBreak(value.intervals) }))}>{fill(words.addBreak, { day: label })}</Button> : null}
              <Button size="xs" variant="ghost" className="weekly-availability-add" disabled={!nextInterval(day.intervals)} onClick={() => {
                const interval = nextInterval(day.intervals);
                if (interval) updateDay(weekday, value => ({ ...value, intervals: [...value.intervals, interval].sort((a, b) => a.start_minute - b.start_minute) }));
              }}>{fill(words.addInterval, { day: label })}</Button>
            </Container>;
          })}
        </Container>
      </> : null}
      {!canSave ? <Text variant="caption" color="error">{draftSchedules.some(schedule => !schedule.label.trim()) ? words.nameRequired : words.intervalInvalid}</Text> : null}
      <Container layout="horizontal" justifyContent="end">
        <Button size="sm" variant="primary" disabled={!current || !canSave} onClick={() => onSave(cloneSchedules(draftSchedules), draftDefaultId)}>{words.save}</Button>
      </Container>
    </Container> : <>
      <Text variant="caption" color="muted">{words.empty}</Text>
      {describeBlock}
      <Container layout="horizontal" justifyContent="end">
        <Button size="sm" variant="primary" onClick={() => onSave([], null)}>{words.save}</Button>
      </Container>
    </>}
  </Container>;
}
