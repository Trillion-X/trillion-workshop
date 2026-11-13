// src/workspace/planning-settings.tsx
//
// Purpose
//   The form for what the planner reads about a person's days: the most planned work in a day (with a caution band),
//   whether a task they move pushes planned ones out of the way, and different hours for one date. Each writes through
//   /work/api/calendar/tasks (src/calendar-tasks.mjs set_capacity, set_preferences, set_day_hours, clear_day_hours).
//
// Non-negotiable invariants
//   1. Every word is DATA (planning-settings.json); every control is a shared ui part.
//   2. The form shows what is stored, read from the same road it writes to; a failed write says so and changes nothing.
//   3. A change that answers an undo can be undone from the form.
import React from 'react';
import { Button, Container, errorWords, Input, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text, timeboxPolicies } from '../../parts/ui';
import { SegmentedControl } from '../../parts/ui/show/segmented-control';
import quietModes from '../../../../run-work-later-or-on-a-repeat/do-work/quiet-hours.json' with { type: 'json' };
import words from './planning-settings.json' with { type: 'json' };
import { postJson, readJson } from './api';

type Hours = { start: string; end: string; time_zone: string; weekdays?: number[]; mode: string };
type Stored = { working_hours?: Hours | null; capacity: { default_minutes: number | null; caution_band_minutes: number } | null; preferences: { refit_on_move: boolean; external_display?: string; ai_scheduling?: boolean; default_todo_visibility?: string } };
type Undo = Record<string, unknown>;
const ROAD = '/work/api/calendar/tasks';
const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

export function PlanningSettings({ notify }: { notify: (message: string, options?: { kind?: 'info' | 'error'; actions?: { id: string; label: string; onAction: () => void }[] }) => void }): React.ReactElement {
  const [stored, setStored] = React.useState<Stored | null>(null);
  const [capacity, setCapacity] = React.useState('');
  const [band, setBand] = React.useState('0');
  const [day, setDay] = React.useState('');
  const [off, setOff] = React.useState(false);
  const [start, setStart] = React.useState('09:00');
  const [end, setEnd] = React.useState('17:00');
  const [hoursStart, setHoursStart] = React.useState('09:00');
  const [hoursEnd, setHoursEnd] = React.useState('17:00');
  const [zone, setZone] = React.useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [days, setDays] = React.useState<number[]>([1, 2, 3, 4, 5]);
  const [mode, setMode] = React.useState(quietModes.default_mode);
  const load = React.useCallback(async () => {
    const read = await readJson<Stored>(`${ROAD}?check=${crypto.randomUUID()}`);
    setStored(read);
    setCapacity(read.capacity?.default_minutes ? String(read.capacity.default_minutes) : '');
    setBand(String(read.capacity?.caution_band_minutes ?? 0));
    if (read.working_hours) {
      setHoursStart(read.working_hours.start); setHoursEnd(read.working_hours.end); setZone(read.working_hours.time_zone);
      setDays(read.working_hours.weekdays ?? [0, 1, 2, 3, 4, 5, 6]); setMode(read.working_hours.mode);
    }
  }, []);
  React.useEffect(() => { void load().catch(() => {}); }, [load]);
  const write = async (body: Record<string, unknown>) => {
    try {
      const answer = await postJson<{ undo?: Undo }>(ROAD, body);
      notify(words.saved, { kind: 'info', actions: answer.undo ? [{ id: 'undo', label: words.undo, onAction: () => { void postJson(ROAD, answer.undo).then(load).catch(error => notify(errorWords(error), { kind: 'error' })); } }] : [] });
      await load();
    } catch (error) { notify(errorWords(error) || words.failed, { kind: 'error' }); }
  };
  if (!stored?.preferences) return <></>;
  return <Container layout="vertical" gap="sm" data-planning-settings>
    <Text variant="body-sm" weight="semibold">{words.heading}</Text>
    <Input label={words.capacity} type="number" min={1} max={1440} placeholder={words.capacity_none} value={capacity} onChange={event => setCapacity(event.target.value)} />
    <Input label={words.band} type="number" min={0} max={1440} value={band} onChange={event => setBand(event.target.value)} />
    <Button size="sm" variant="outline" onClick={() => write({ action: 'set_capacity', ...(capacity ? { default_minutes: Number(capacity), caution_band_minutes: Number(band) || 0 } : {}) })}>{words.save_capacity}</Button>
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="body-sm">{words.refit}</Text>
      <Switch checked={stored.preferences.refit_on_move} label={words.refit} size="sm" onCheckedChange={value => void write({ action: 'set_preferences', refit_on_move: value })} />
    </Container>
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="body-sm">{words.ai_scheduling}</Text>
      <Switch checked={stored.preferences.ai_scheduling !== false} label={words.ai_scheduling} size="sm" onCheckedChange={value => void write({ action: 'set_preferences', ai_scheduling: value })} />
    </Container>
    <Text variant="caption" color="muted">{words.ai_scheduling_note}</Text>
    <Container layout="vertical" gap="xs">
      <Text variant="caption" color="muted">{words.busy_default}</Text>
      <Select items={timeboxPolicies.map(row => ({ value: row.id, label: row.label }))} value={stored.preferences.external_display ?? 'off'} onValueChange={value => { if (typeof value === 'string') void write({ action: 'set_preferences', external_display: value }); }}>
        <SelectTrigger aria-label={words.busy_default}><SelectValue /></SelectTrigger>
        <SelectPopup>{timeboxPolicies.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectPopup>
      </Select>
      <Text variant="caption" color="muted">{words.timebox_note}</Text>
    </Container>
    <Container layout="vertical" gap="xs">
      <Text variant="caption" color="muted">{words.privacy_default}</Text>
      <SegmentedControl ariaLabel={words.privacy_default} value={stored.preferences.default_todo_visibility ?? 'private'}
        items={[{ id: 'private', label: words.privacy_private }, { id: 'visible', label: words.privacy_visible }]}
        onValueChange={value => void write({ action: 'set_preferences', default_todo_visibility: value })} />
      <Text variant="caption" color="muted">{words.privacy_note}</Text>
    </Container>
    <Text variant="body-sm" weight="semibold">{words.hours_heading}</Text>
    <Container layout="horizontal" gap="sm" wrap>
      <Input label={words.hours_start} type="time" value={hoursStart} onChange={event => setHoursStart(event.target.value)} />
      <Input label={words.hours_end} type="time" value={hoursEnd} onChange={event => setHoursEnd(event.target.value)} />
    </Container>
    <Input label={words.hours_zone} value={zone} onChange={event => setZone(event.target.value)} />
    <Text variant="caption" color="muted">{words.hours_days}</Text>
    <Container layout="horizontal" gap="xs" wrap>
      {words.weekdays.map((label, weekday) => <Button key={label} size="xs" variant={days.includes(weekday) ? 'primary' : 'outline'} aria-pressed={days.includes(weekday)}
        onClick={() => setDays(days.includes(weekday) ? days.filter(day => day !== weekday) : [...days, weekday].sort())}>{label}</Button>)}
    </Container>
    <Text variant="caption" color="muted">{words.hours_mode}</Text>
    <Select items={Object.keys(quietModes.modes).map(id => ({ value: id, label: (words.modes as Record<string, string>)[id] ?? id }))} value={mode} onValueChange={value => { if (typeof value === 'string') setMode(value); }}>
      <SelectTrigger aria-label={words.hours_mode}><SelectValue /></SelectTrigger>
      <SelectPopup>{Object.keys(quietModes.modes).map(id => <SelectItem key={id} value={id}>{(words.modes as Record<string, string>)[id] ?? id}</SelectItem>)}</SelectPopup>
    </Select>
    <Text variant="caption" color="muted">{words.hours_note}</Text>
    <Container layout="horizontal" gap="xs" wrap>
      <Button size="sm" variant="outline" disabled={!days.length} onClick={() => write({ action: 'set_working_hours', start: hoursStart, end: hoursEnd, time_zone: zone, weekdays: days, mode })}>{words.save_hours}</Button>
      <Button size="sm" variant="ghost" disabled={!stored.working_hours} onClick={() => write({ action: 'clear_working_hours' })}>{words.clear_hours}</Button>
    </Container>
    <Text variant="body-sm" weight="semibold">{words.day_heading}</Text>
    <Input label={words.day} type="date" value={day} onChange={event => setDay(event.target.value)} />
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="body-sm">{words.day_off}</Text><Switch checked={off} label={words.day_off} size="sm" onCheckedChange={setOff} />
    </Container>
    {off ? null : <Container layout="horizontal" gap="sm" wrap>
      <Input label={words.day_start} type="time" value={start} onChange={event => setStart(event.target.value)} />
      <Input label={words.day_end} type="time" value={end} onChange={event => setEnd(event.target.value)} />
    </Container>}
    <Container layout="horizontal" gap="xs" wrap>
      <Button size="sm" variant="outline" disabled={!day} onClick={() => write({ action: 'set_day_hours', day, ...(off ? { off: true } : { start_minute: minutesOf(start), end_minute: minutesOf(end) }) })}>{words.save_day}</Button>
      <Button size="sm" variant="ghost" disabled={!day} onClick={() => write({ action: 'clear_day_hours', day })}>{words.clear_day}</Button>
    </Container>
  </Container>;
}
