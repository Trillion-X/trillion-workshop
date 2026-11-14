// parts/ui/show/schedule-calendar/EventOptions.tsx
//
// PURPOSE
//   Caller-controlled repeat and reminder fields shared by event forms: a repeat choice (a preset row, a custom repeat
//   the caller opens, or what the event keeps) and a list of reminders (presets, a number and a unit, removal).
//   Labels, choices, units and limits are DATA, and values are never normalized or written merely because this
//   component mounted.

import * as React from 'react';
import { cn } from '../cn';
import { Button } from '../coss/ui/button';
import { Input } from '../coss/ui/input';
import { Popover, PopoverPopup, PopoverTrigger } from '../coss/ui/popover';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../coss/ui/select';
import { NamedIcon } from '../icon';
import { minutesOf, reminderLabel, withoutReminder, withReminder, type ReminderData } from './event-reminders.mjs';

export type EventRepeatSetting =
  | { kind: 'keep' }
  | { kind: 'set'; value: string };

export type EventReminderSetting =
  | { kind: 'keep' }
  | { kind: 'set'; minutes: readonly number[] };

export interface EventRepeatChoice {
  /** Stable caller-owned value (for example `none`, `daily`, `weekly`, or `monthly`). */
  value: string;
  /** Caller-supplied label, including for an existing custom provider rule. */
  label: string;
}

export interface EventOptionsWords {
  repeat: string;
  reminder: string;
  /** Heading over the reminders the event already has. */
  currentReminders: string;
  /** Heading over the preset reminders a person can add. */
  reminderPresets: string;
  /** Label of the custom reminder group, its number field and its unit field. */
  customReminder: string;
  reminderAmount: string;
  reminderUnit: string;
  addReminder: string;
  /** One reminder's remove control, with {label} the reminder's words. */
  removeReminder: string;
  /** Said when the list is full, with {count} the most. */
  reminderLimit: string;
  /** Present this option when an edit should retain recurrence it has not loaded. */
  keepExisting?: string;
  /** Present this control when a person can explicitly remove every reminder. */
  noReminder?: string;
}

export interface EventOptionsProps {
  /** `keep` leaves the provider's current recurrence untouched, even when it was not loaded. */
  repeat: EventRepeatSetting;
  repeatChoices: readonly EventRepeatChoice[];
  /** `keep` leaves provider state untouched; `set` holds every reminder, as minutes before the start (none for no reminder). */
  reminder: EventReminderSetting;
  words: EventOptionsWords;
  /** The reminder presets, units and limits (DATA). */
  reminderData: ReminderData;
  /** A custom repeat the caller opens: its choice is listed last and is never a value. */
  customRepeat?: { label: string; onSelect: () => void };
  onRepeatChange: (setting: EventRepeatSetting) => void;
  onReminderChange: (setting: EventReminderSetting) => void;
  disabled?: boolean;
  className?: string;
  /** Compact toolbar presentation; values and callbacks are identical to the default form. */
  variant?: 'default' | 'compact';
  repeatIcon?: string;
  reminderIcon?: string;
}

const KEEP_VALUE = '__event_options_keep_existing__';
const CUSTOM_VALUE = '__event_options_custom_repeat__';

const fill = (text: string, values: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/**
 * Event repeat and reminder controls.
 *
 * For a new event, pass explicit `set` values. For an edit whose normalized
 * event does not contain these provider settings, pass `keep`; no write is
 * emitted until a person chooses or enters a replacement.
 */
export function EventOptions({
  repeat,
  repeatChoices,
  reminder,
  words,
  reminderData,
  customRepeat,
  onRepeatChange,
  onReminderChange,
  disabled = false,
  className,
  variant = 'default',
  repeatIcon = 'Repeat',
  reminderIcon = 'Bell',
}: EventOptionsProps) {
  const amountId = React.useId();
  const keepRepeatEnabled = Boolean(words.keepExisting);
  const [amount, setAmount] = React.useState('');
  const [unit, setUnit] = React.useState(reminderData.units[0]?.id ?? '');
  const list = reminder.kind === 'set' ? reminder.minutes : [];
  const full = list.length >= reminderData.max;
  const commit = (next: readonly number[]) => onReminderChange({ kind: 'set', minutes: next });
  const add = (minutes: number | null) => {
    if (minutes === null) return;
    const next = withReminder(list, minutes, reminderData);
    if (next) commit(next);
  };
  const customMinutes = minutesOf(amount, unit, reminderData);
  const addCustom = () => {
    if (customMinutes === null) return;
    add(customMinutes);
    setAmount('');
  };

  const selectedRepeat = repeat.kind === 'keep' ? KEEP_VALUE : repeat.value;
  const compact = variant === 'compact';

  const repeatControl = (
    <Select
      value={selectedRepeat}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next !== 'string' || next === selectedRepeat) return;
        if (next === CUSTOM_VALUE) customRepeat?.onSelect();
        else if (next === KEEP_VALUE) onRepeatChange({ kind: 'keep' });
        else onRepeatChange({ kind: 'set', value: next });
      }}
    >
      <SelectTrigger aria-label={words.repeat} title={repeatChoices.find((choice) => choice.value === selectedRepeat)?.label} data-event-options-repeat-trigger="">
        {compact ? <NamedIcon name={repeatIcon} size="sm" aria-hidden="true" /> : <SelectValue />}
      </SelectTrigger>
      <SelectPopup>
        {keepRepeatEnabled ? <SelectItem value={KEEP_VALUE}>{words.keepExisting}</SelectItem> : null}
        {repeatChoices.filter((choice) => choice.value !== KEEP_VALUE && choice.value !== CUSTOM_VALUE).map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>
        ))}
        {customRepeat ? <SelectItem value={CUSTOM_VALUE}>{customRepeat.label}</SelectItem> : null}
      </SelectPopup>
    </Select>
  );

  const reminderField = (
    <>
      <span data-event-options-label="reminder">{words.reminder}</span>
      {reminder.kind === 'keep' && words.keepExisting ? <span data-event-options-keep="" className="font-normal text-[var(--text-muted)]">{words.keepExisting}</span> : null}
      {list.length ? (
        <ul data-event-options-current="" aria-label={words.currentReminders} className="grid min-w-0 gap-1">
          {list.map((minutes) => {
            const label = reminderLabel(minutes, reminderData);
            return (
              <li key={minutes} className="flex min-w-0 items-center justify-between gap-2 font-normal">
                <span className="min-w-0 truncate">{label}</span>
                <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={fill(words.removeReminder, { label })} data-event-options-remove-reminder="" onClick={() => commit(withoutReminder(list, minutes))}>
                  <NamedIcon name="X" size="xs" aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {full ? <span data-event-options-limit="" className="font-normal text-[var(--text-muted)]">{fill(words.reminderLimit, { count: reminderData.max })}</span> : (
        <>
          <span data-event-options-label="presets" className="font-normal text-[var(--text-muted)]">{words.reminderPresets}</span>
          <span className="flex min-w-0 flex-wrap gap-1" data-event-options-presets="">
            {reminderData.presets.map((preset) => (
              <Button key={preset.minutes} type="button" size="sm" variant="outline" disabled={disabled || list.includes(preset.minutes)} data-event-options-preset={preset.minutes} onClick={() => add(preset.minutes)}>
                {reminderLabel(preset.minutes, reminderData)}
              </Button>
            ))}
          </span>
          <span data-event-options-label="custom" className="font-normal text-[var(--text-muted)]">{words.customReminder}</span>
          <span className="flex min-w-0 items-center gap-2">
            <Input
              id={amountId}
              data-event-options-reminder-amount=""
              aria-label={words.reminderAmount}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={amount}
              disabled={disabled}
              onChange={(event) => setAmount(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addCustom();
              }}
            />
            <Select value={unit} disabled={disabled} onValueChange={(next) => { if (typeof next === 'string') setUnit(next); }}>
              <SelectTrigger aria-label={words.reminderUnit} data-event-options-reminder-unit=""><SelectValue /></SelectTrigger>
              <SelectPopup>
                {reminderData.units.map((row) => <SelectItem key={row.id} value={row.id}>{row.other}</SelectItem>)}
              </SelectPopup>
            </Select>
            <Button type="button" size="sm" variant="outline" disabled={disabled || customMinutes === null || list.includes(customMinutes)} data-event-options-add-reminder="" onClick={addCustom}>{words.addReminder}</Button>
          </span>
        </>
      )}
      {words.noReminder ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-event-options-clear-reminder=""
          disabled={disabled || (reminder.kind === 'set' && !list.length)}
          onClick={() => commit([])}
        >
          {words.noReminder}
        </Button>
      ) : null}
    </>
  );

  return (
    <div data-event-options="" data-event-options-variant={variant} className={cn(compact ? 'flex min-w-0 items-center gap-1.5' : 'grid min-w-0 gap-3 sm:grid-cols-2', className)}>
      <div data-event-options-repeat="" data-option-mode={repeat.kind} className={cn('grid min-w-0 gap-1.5 text-sm font-medium text-[var(--text-primary)]', compact && 'contents')}>
        {!compact ? <span data-event-options-label="repeat">{words.repeat}</span> : null}
        {repeatControl}
      </div>

      <div data-event-options-reminder="" data-option-mode={reminder.kind} className={cn('grid min-w-0 gap-1.5 text-sm font-medium text-[var(--text-primary)]', compact && 'contents')}>
        {compact ? (
          <Popover>
            <PopoverTrigger
              render={<Button type="button" variant="ghost" size="icon" aria-label={words.reminder} title={words.reminder} disabled={disabled} />}
              data-event-options-reminder-trigger=""
            >
              <NamedIcon name={reminderIcon} size="sm" aria-hidden="true" />
            </PopoverTrigger>
            <PopoverPopup className="w-80" data-event-options-reminder-popup="">
              <div className="grid min-w-0 gap-2 text-sm font-medium text-[var(--text-primary)]">
                {reminderField}
              </div>
            </PopoverPopup>
          </Popover>
        ) : reminderField}
      </div>
    </div>
  );
}
