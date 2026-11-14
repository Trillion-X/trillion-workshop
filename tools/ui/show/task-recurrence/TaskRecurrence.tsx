// A domain-blind, controlled editor for repeating things (tasks, events). Choices and copy are DATA. With no `nextTodoChoices`
// the "create next todo" choice is not offered (an event repeats on its calendar, not when a todo is done).
import * as React from 'react';
import { cn } from '../cn';
import { Input } from '../input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../coss/ui/select';
import { Switch } from '../switch';
import { Checkbox } from '../coss/ui/checkbox';

export interface TaskRecurrenceValue {
  frequency: string;
  interval: number;
  weekdays: string[];
  timeZone?: string;
  ends: { kind: 'never' } | { kind: 'date'; value: string } | { kind: 'count'; value: number };
  nextTodo: string;
}

export interface TaskRecurrenceChoice { value: string; label: string; weekdays?: boolean }
export interface TaskRecurrenceWords {
  repeat: string;
  every: string;
  interval: string;
  on: string;
  ends: string;
  never: string;
  onDate: string;
  after: string;
  occurrences: string;
  createNextTodo: string;
  weekdays: readonly TaskRecurrenceChoice[];
}

export interface TaskRecurrenceProps {
  value: TaskRecurrenceValue | null;
  frequencies: readonly TaskRecurrenceChoice[];
  nextTodoChoices: readonly TaskRecurrenceChoice[];
  words: TaskRecurrenceWords;
  onChange: (value: TaskRecurrenceValue | null) => void;
  disabled?: boolean;
  className?: string;
}

const defaultValue = (frequencies: readonly TaskRecurrenceChoice[], nextTodoChoices: readonly TaskRecurrenceChoice[]): TaskRecurrenceValue => ({
  frequency: frequencies[0]?.value ?? '',
  interval: 1,
  weekdays: [],
  ends: { kind: 'never' },
  nextTodo: nextTodoChoices[0]?.value ?? '',
});

export function TaskRecurrence({ value, frequencies, nextTodoChoices, words, onChange, disabled = false, className }: TaskRecurrenceProps) {
  const enabled = value !== null;
  const current = value ?? defaultValue(frequencies, nextTodoChoices);
  const patch = (change: Partial<TaskRecurrenceValue>) => onChange({ ...current, ...change });
  const setWeekday = (day: string, checked: boolean) => patch({
    weekdays: checked ? [...new Set([...current.weekdays, day])] : current.weekdays.filter(value => value !== day),
  });

  return <section data-task-recurrence="" data-enabled={enabled || undefined} className={cn('task-recurrence grid min-w-0 gap-3', className)}>
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="text-sm text-[var(--text-secondary)]">{words.repeat}</span>
      <Switch label={words.repeat} checked={enabled} disabled={disabled} onCheckedChange={checked => onChange(checked ? defaultValue(frequencies, nextTodoChoices) : null)} />
    </div>
    {enabled ? <>
      <div className="grid min-w-0 grid-cols-[auto_minmax(4rem,1fr)_minmax(7rem,1fr)] items-center gap-2" data-task-recurrence-rule="">
        <span className="text-sm text-[var(--text-secondary)]">{words.every}</span>
        <Input aria-label={words.interval} type="number" min={1} max={999} step={1} inputMode="numeric" value={current.interval}
          disabled={disabled} onChange={event => {
            const interval = Number(event.target.value);
            if (Number.isSafeInteger(interval) && interval >= 1 && interval <= 999) patch({ interval });
          }} />
        <Select value={current.frequency} disabled={disabled} onValueChange={frequency => { if (typeof frequency === 'string') patch({ frequency, weekdays: frequencies.find(choice => choice.value === frequency)?.weekdays ? current.weekdays : [] }); }}>
          <SelectTrigger aria-label={words.repeat}><SelectValue /></SelectTrigger>
          <SelectPopup portalProps={{ className: 'coss-ui' }}>
            {frequencies.map(choice => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}
          </SelectPopup>
        </Select>
      </div>
      {words.weekdays.length && frequencies.find(choice => choice.value === current.frequency)?.weekdays ? <fieldset className="grid min-w-0 gap-2" data-task-recurrence-weekdays="">
        <legend className="text-sm text-[var(--text-secondary)]">{words.on}</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-2">
          {words.weekdays.map(day => <label key={day.value} className="inline-flex min-h-8 items-center gap-2 text-sm text-[var(--text-primary)]">
            <Checkbox checked={current.weekdays.includes(day.value)} disabled={disabled} onCheckedChange={checked => setWeekday(day.value, checked === true)} />
            {day.label}
          </label>)}
        </div>
      </fieldset> : null}
      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(6rem,.7fr)_minmax(0,1fr)] sm:items-center">
        <span className="text-sm text-[var(--text-secondary)]">{words.ends}</span>
        <Select value={current.ends.kind} disabled={disabled} onValueChange={kind => {
          if (kind === 'never') patch({ ends: { kind } });
          else if (kind === 'date') patch({ ends: { kind, value: '' } });
          else if (kind === 'count') patch({ ends: { kind, value: 10 } });
        }}>
          <SelectTrigger aria-label={words.ends}><SelectValue /></SelectTrigger>
          <SelectPopup portalProps={{ className: 'coss-ui' }}>
            <SelectItem value="never">{words.never}</SelectItem>
            <SelectItem value="date">{words.onDate}</SelectItem>
            <SelectItem value="count">{words.after}</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {current.ends.kind === 'date' ? <Input aria-label={words.onDate} type="date" value={current.ends.value} disabled={disabled}
        onChange={event => patch({ ends: { kind: 'date', value: event.target.value } })} /> : null}
      {current.ends.kind === 'count' ? <label className="grid min-w-0 grid-cols-[auto_minmax(4rem,1fr)] items-center gap-2 text-sm text-[var(--text-secondary)]">
        {words.occurrences}<Input aria-label={words.occurrences} type="number" min={1} max={9999} step={1} inputMode="numeric" value={current.ends.value}
          disabled={disabled} onChange={event => {
            const count = Number(event.target.value);
            if (Number.isSafeInteger(count) && count >= 1 && count <= 9999) patch({ ends: { kind: 'count', value: count } });
          }} />
      </label> : null}
      {nextTodoChoices.length ? <div className="grid min-w-0 gap-1.5">
        <span className="text-sm text-[var(--text-secondary)]">{words.createNextTodo}</span>
        <Select value={current.nextTodo} disabled={disabled} onValueChange={nextTodo => { if (typeof nextTodo === 'string') patch({ nextTodo }); }}>
          <SelectTrigger aria-label={words.createNextTodo}><SelectValue /></SelectTrigger>
          <SelectPopup portalProps={{ className: 'coss-ui' }}>
            {nextTodoChoices.map(choice => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}
          </SelectPopup>
        </Select>
      </div> : null}
    </> : null}
  </section>;
}
