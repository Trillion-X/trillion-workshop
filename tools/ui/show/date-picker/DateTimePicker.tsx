// The date and the clock share one local value. This composes Trillion's
// existing calendar and its reusable time control; callers alone convert the
// completed local value to an instant when their storage contract requires it.
import * as React from 'react';
import {DatePicker} from './DatePicker';
import {TimePicker} from './TimePicker';
import {combineLocalDateTime, isLocalDateTimeValid, splitLocalDateTime} from './date-values.mjs';
import {cn} from '../cn';

export interface DateTimePickerProps {
  value?: string | null;
  onChange: (value: string | null) => void;
  /** False for a partial or invalid draft; true for an explicitly cleared optional value. */
  onValidityChange?: (valid: boolean) => void;
  min?: string | null;
  max?: string | null;
  label?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  allowClear?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function DateTimePicker({value, onChange, onValidityChange, min, max, label, disabled = false, readOnly = false, required = false, allowClear = !required,
  className, 'aria-label': ariaLabel}: DateTimePickerProps) {
  const [parts, setParts] = React.useState(() => splitLocalDateTime(value));
  const [clockValid, setClockValid] = React.useState(true);
  const [clockReset, setClockReset] = React.useState(0);
  // Hosts commonly store a cleared form value as ''. Treat that and null as
  // the same published value, so their echo never erases a partial draft.
  const published = React.useRef<string | null>(value || null);
  React.useEffect(() => {
    const current = value || null;
    if (current === published.current) return;
    published.current = current;
    setParts(splitLocalDateTime(value));
  }, [value]);
  const title = ariaLabel ?? label ?? 'Date and time';
  const lower = splitLocalDateTime(min), upper = splitLocalDateTime(max);
  const change = (next: typeof parts) => {
    setParts(next);
    const complete = combineLocalDateTime(next.day, next.time, min, max);
    published.current = complete;
    onChange(complete);
  };
  const completeParts = Boolean(parts.day && parts.time);
  const nonexistent = completeParts && !isLocalDateTimeValid(parts.day, parts.time);
  const outside = completeParts && !nonexistent && !combineLocalDateTime(parts.day, parts.time, min, max);
  const incomplete = Boolean(parts.day) !== Boolean(parts.time);
  const valid = clockValid && (!parts.day && !parts.time ? !required : Boolean(combineLocalDateTime(parts.day, parts.time, min, max)));
  React.useLayoutEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  return <div className={cn('temporal-field', className)} role="group" aria-label={title}>
    {label ? <span className="temporal-label">{label}</span> : null}
    <div className="temporal-date-time">
      <DatePicker aria-label={`${title} date`} value={parts.day} min={lower.day} max={upper.day} disabled={disabled} readOnly={readOnly} allowClear={allowClear}
        onChange={day => { if (!day) {setClockReset(current => current + 1); setClockValid(true);} change(day ? {...parts, day} : {day: null, time: null}); }} />
      <TimePicker key={clockReset} aria-label={`${title} time`} value={parts.time} disabled={disabled} readOnly={readOnly} required={required} allowClear={allowClear} onValidityChange={setClockValid}
        min={parts.day === lower.day ? lower.time : null} max={parts.day === upper.day ? upper.time : null} aria-invalid={outside || nonexistent || undefined}
        onChange={time => change({...parts, time})} />
    </div>
    {nonexistent ? <span className="temporal-error" role="status">That local time does not exist. Choose another time.</span> : null}
    {outside ? <span className="temporal-error" role="status">Choose a date and time within the allowed range.</span> : null}
    {incomplete && !outside ? <span className="temporal-error" role="status">{parts.day ? 'Choose a time to complete this date.' : 'Choose a date to complete this time.'}</span> : null}
  </div>;
}
