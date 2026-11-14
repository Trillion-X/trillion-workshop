// A time is a local clock value, independent of any date or timezone. Typed
// minutes/seconds remain available beside the same quiet popover used by the
// calendar; the quarter-hour choices are conveniences, never a restriction.
// Appearance belongs to screen-look/show/temporal-input.css.
import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import {Clock3} from 'lucide-react';
import {cn} from '../cn';
import {LAYER_ORDER} from '../layer-order/layer-order';
import {normalizeTime, timeInRange} from './date-values.mjs';

export interface TimePickerProps {
  value?: string | null;
  onChange: (value: string | null) => void;
  /** Form owners can keep invalid text from becoming an omitted optional time. */
  onValidityChange?: (valid: boolean) => void;
  min?: string | null;
  max?: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  allowClear?: boolean;
  id?: string;
  name?: string;
  className?: string;
  placeholder?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

const OPTIONS = Array.from({length: 96}, (_, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String(index % 4 * 15).padStart(2, '0')}`);

export function TimePicker({value, onChange, onValidityChange, min, max, disabled = false, readOnly = false, required = false, allowClear = !required,
  id, name, className, placeholder = 'HH:mm', 'aria-label': label = 'Time', 'aria-invalid': invalid, 'aria-describedby': describedBy}: TimePickerProps) {
  const [draft, setDraft] = React.useState(value ?? '');
  const [open, setOpen] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const published = React.useRef<string | null>(value || null);
  const input = React.useRef<HTMLInputElement>(null);
  const options = React.useRef(new Map<string, HTMLButtonElement>());
  const normalized = normalizeTime(draft);
  const valid = Boolean(normalized && timeInRange(normalized, min, max));
  const error = draft && !valid ? (normalized ? 'Choose a time within the allowed range.' : 'Use a time such as 09:30.') : '';
  const errorId = React.useId();
  React.useEffect(() => {
    const current = value || null;
    if (current === published.current) return;
    published.current = current;
    setDraft(value ?? '');
    setTouched(false);
  }, [value]);
  React.useLayoutEffect(() => { input.current?.setCustomValidity(error); }, [error]);
  const complete = !error && (draft !== '' || !required);
  React.useLayoutEffect(() => { onValidityChange?.(complete); }, [complete, onValidityChange]);

  const publish = (next: string) => {
    setDraft(next);
    const time = normalizeTime(next);
    const kept = time && timeInRange(time, min, max) ? time : null;
    published.current = kept;
    onChange(kept);
  };
  const choose = (next: string) => {
    publish(next);
    setTouched(false);
    setOpen(false);
    requestAnimationFrame(() => input.current?.focus());
  };
  const available = OPTIONS.filter(option => timeInRange(option, min, max));
  const focused = available.includes(normalized ?? '') ? normalized! : available[0];
  const keyAt = (event: React.KeyboardEvent, option: string) => {
    const current = available.indexOf(option);
    const next = event.key === 'ArrowDown' ? Math.min(current + 1, available.length - 1)
      : event.key === 'ArrowUp' ? Math.max(current - 1, 0)
      : event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); event.stopPropagation();
    options.current.get(available[next])?.focus();
  };

  return <span className={cn('temporal-time', className)}>
    <input ref={input} id={id} name={name} type="text" inputMode="text" autoComplete="off" value={draft} placeholder={placeholder}
      required={required} disabled={disabled} readOnly={readOnly} aria-label={label} aria-invalid={invalid || (touched && Boolean(error)) || undefined}
      aria-describedby={[describedBy, touched && error ? errorId : undefined].filter(Boolean).join(' ') || undefined}
      onChange={event => publish(event.currentTarget.value)}
      onBlur={() => { setTouched(true); if (valid && normalized) setDraft(normalized); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !disabled && !readOnly) { event.preventDefault(); setOpen(true); } }} />
    <Popover.Root open={open && !disabled && !readOnly} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="temporal-clock-trigger" disabled={disabled || readOnly} aria-label={`Choose ${label.toLocaleLowerCase()}`}><Clock3 size={15} aria-hidden="true" /></button></Popover.Trigger>
      {/* Closed portals render nothing, matching DatePicker's dead-click fix. */}
      {open && !disabled && !readOnly ? <Popover.Portal><Popover.Content sideOffset={4} collisionPadding={12} align="start" className="glass-popover temporal-time-popup" style={{zIndex: LAYER_ORDER.menu}} aria-label={label}
        onClick={event => event.stopPropagation()}
        onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => { const node = options.current.get(focused); node?.focus({preventScroll: true}); node?.scrollIntoView({block: 'nearest'}); }); }}>
        <div className="temporal-time-options" role="listbox" aria-label={label}>
          {OPTIONS.map(option => <button key={option} type="button" role="option" aria-selected={normalized === option} disabled={!timeInRange(option, min, max)}
            tabIndex={option === focused ? 0 : -1} ref={node => { if (node) options.current.set(option, node); else options.current.delete(option); }}
            onKeyDown={event => keyAt(event, option)} onClick={() => choose(option)}>{option}</button>)}
        </div>
        {allowClear ? <button type="button" className="temporal-clear" onClick={() => choose('')}>Clear time</button> : null}
      </Popover.Content></Popover.Portal> : null}
    </Popover.Root>
    {touched && error ? <span id={errorId} className="temporal-error" role="status">{error}</span> : null}
  </span>;
}
