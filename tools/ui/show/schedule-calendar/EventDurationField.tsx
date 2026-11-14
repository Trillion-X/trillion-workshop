// parts/ui/show/schedule-calendar/EventDurationField.tsx
//
// Purpose: the new-event duration control of the calendar settings (CalendarControls): a slider and Base UI's NumberField
// inside a Field that move one value, its bounds, step, unit and words from the caller. CalendarControls fetches it the first time its settings are
// drawn, so the calendar's sources menu never carries the number field.
//
// Non-negotiable invariants:
// - A value is saved only when it is a whole number within the bounds and on a step; a commit that is not puts the
//   saved value back in the box. The slider saves where it rests (release or leaving it), never once per step.
import * as React from 'react';
import { Field } from '@base-ui/react/field';
import { NumberField } from '@base-ui/react/number-field';
import { Container, Text } from '../../index';
import { Slider } from '../slider/Slider';

export interface EventDurationFieldProps {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  /** A line under the label saying what the setting is for. */
  help?: string;
  /** The saved duration in minutes, or undefined for none saved (the box shows `min`). */
  saved?: number;
  onSave: (minutes: number) => void;
}

export function EventDurationField({ label, unit, min, max, step, help, saved, onSave }: EventDurationFieldProps): React.ReactElement {
  const savedValue = saved ?? min;
  const [draft, setDraft] = React.useState<number | null>(savedValue);
  const id = React.useId();
  React.useEffect(() => setDraft(savedValue), [savedValue]);
  const valid = (value: number | null): value is number => value !== null && Number.isInteger(value) && value >= min && value <= max && (value - min) % step === 0;
  // A slider moves through many values; the one it rests on is saved when the person lets go, not once per step.
  const commitSlider = () => { if (valid(draft) && draft !== savedValue) onSave(draft); };
  return <Field.Root className="calendar-control-duration-field">
    <Field.Label htmlFor={id} className="calendar-control-duration-label">{label}</Field.Label>
    {help ? <Text variant="caption" color="muted">{help}</Text> : null}
    <Slider label={label} value={draft ?? savedValue} min={min} max={max} step={step} unit={unit ? ` ${unit}` : ''}
      onValueChange={setDraft} onPointerUp={commitSlider} onBlur={commitSlider} />
    <Container layout="horizontal" gap="xs" alignItems="center">
      <NumberField.Root
        id={id}
        value={draft}
        min={min}
        max={max}
        step={step}
        snapOnStep
        onValueChange={value => {
          setDraft(value);
          if (valid(value)) onSave(value);
        }}
        onValueCommitted={value => {
          if (!valid(value)) setDraft(savedValue);
        }}
      >
        <NumberField.Input
          data-slot="number-field-input"
          aria-label={label}
          className="calendar-control-duration-input"
        />
      </NumberField.Root>
      <Text variant="caption" color="muted">{unit}</Text>
    </Container>
  </Field.Root>;
}
