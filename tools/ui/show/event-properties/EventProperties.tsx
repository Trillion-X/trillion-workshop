// parts/ui/show/event-properties/EventProperties.tsx
//
// PURPOSE
//   Controlled, provider-neutral event color, privacy and availability fields.
//   A caller supplies only the properties its selected calendar can write and
//   keeps persistence, provider vocabulary and draft state in its own owner.

import * as React from 'react';
import { Button } from '../coss/ui/button';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../coss/ui/select';
import { Kbd } from '../kbd';
import { cn } from '../cn';
import { NamedIcon } from '../icon';
import '../../../screen-look/show/event-properties.css';

export type EventPropertySetting =
  | { kind: 'keep' }
  | { kind: 'set'; value: string };

export interface EventPropertyChoice {
  /** Stable value owned by the caller, such as a provider color or privacy value. */
  value: string;
  label: string;
  /** Optional display color for a calendar color choice. */
  color?: string;
  icon?: string;
  /** The key that chooses this choice while its list is open (drawn beside its label). */
  shortcut?: string;
}

export interface EventPropertyField {
  label: string;
  setting: EventPropertySetting;
  choices: readonly EventPropertyChoice[];
  keepExisting?: string;
  icon?: string;
  triggerDisplay?: 'choice' | 'swatch' | 'icon' | 'toggle';
  /** A two-choice field drawn as one button that flips between them: the value shown before one is chosen, the words
   *  saying what pressing it will do per current value, and an icon per current value. */
  toggle?: { defaultValue: string; tooltips: Readonly<Record<string, string>>; icons?: Readonly<Record<string, string>>; labels?: Readonly<Record<string, string>> };
  onChange: (setting: EventPropertySetting) => void;
}

export interface EventPropertiesProps {
  color?: EventPropertyField;
  privacy?: EventPropertyField;
  availability?: EventPropertyField;
  disabled?: boolean;
  className?: string;
  variant?: 'fields' | 'compact';
}

const KEEP_VALUE = '__event_properties_keep_existing__';

function EventPropertyToggle({ field, id, property, disabled }: { field: EventPropertyField; id: string; property: string; disabled: boolean }) {
  const toggle = field.toggle!;
  const current = field.setting.kind === 'set' ? field.setting.value : toggle.defaultValue;
  const next = field.choices.find(choice => choice.value !== current);
  return (
    <div className="event-properties-field" data-event-property={property} data-property-mode={field.setting.kind}>
      <span className="event-properties-label" id={`${id}-label`}>{field.label}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !next}
        aria-labelledby={`${id}-label ${id}-value`}
        title={toggle.tooltips[current]}
        data-trigger-display="toggle"
        data-toggle-value={current}
        onClick={() => { if (next) field.onChange({ kind: 'set', value: next.value }); }}
      >
        {toggle.icons?.[current] ? <NamedIcon name={toggle.icons[current]} size="sm" /> : null}
        <span id={`${id}-value`} data-event-property-value="">{toggle.labels?.[current] ?? field.choices.find(choice => choice.value === current)?.label}</span>
      </Button>
    </div>
  );
}

function EventPropertySelect({ field, id, property, disabled }: { field: EventPropertyField; id: string; property: string; disabled: boolean }) {
  const [open, setOpen] = React.useState(false);
  const selected = field.setting.kind === 'keep' ? KEEP_VALUE : field.setting.value;
  const choices = field.choices.filter(choice => choice.value !== KEEP_VALUE);
  // While the list is open a key picks the choice that names it.
  React.useEffect(() => {
    if (!open || !choices.some(choice => choice.shortcut)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toUpperCase();
      const chosen = choices.find(choice => choice.shortcut?.toUpperCase() === key);
      if (!chosen) return;
      field.onChange({ kind: 'set', value: chosen.value });
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, field, choices]);
  const selectedChoice = field.choices.find(choice => choice.value === selected);
  const valueLabel = selected === KEEP_VALUE ? field.keepExisting : selectedChoice?.label;

  return (
    <div className="event-properties-field" data-event-property={property} data-property-mode={field.setting.kind}>
      <span className="event-properties-label" id={`${id}-label`}>{field.label}</span>
      <Select
        value={selected}
        disabled={disabled}
        open={open}
        onOpenChange={setOpen}
        onValueChange={next => {
          if (typeof next !== 'string' || next === selected) return;
          if (next === KEEP_VALUE) field.onChange({ kind: 'keep' });
          else field.onChange({ kind: 'set', value: next });
        }}
      >
        <SelectTrigger aria-labelledby={`${id}-label`} aria-describedby={`${id}-value`} title={valueLabel} data-trigger-display={field.triggerDisplay ?? 'choice'}>
          <SelectValue><span className="event-properties-choice">{selectedChoice?.color || field.triggerDisplay === 'swatch' ? <span className="event-properties-swatch" style={selectedChoice?.color ? { backgroundColor: selectedChoice.color } : undefined} aria-hidden="true" /> : null}{field.icon || selectedChoice?.icon ? <NamedIcon name={selectedChoice?.icon ?? field.icon} size="sm" /> : null}<span id={`${id}-value`} data-event-property-value="">{valueLabel}</span></span></SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {field.keepExisting ? <SelectItem value={KEEP_VALUE}>{field.keepExisting}</SelectItem> : null}
          {choices.map(choice => (
            <SelectItem key={choice.value} value={choice.value}>
              <span className="event-properties-choice">
                {choice.color ? <span className="event-properties-swatch" style={{ backgroundColor: choice.color }} aria-hidden="true" /> : null}
                <span>{choice.label}</span>
                {choice.shortcut ? <Kbd size="sm">{choice.shortcut}</Kbd> : null}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/**
 * Provider-neutral event properties. Omit a field when the selected calendar
 * does not expose that write; use `keep` for edit values the caller has not
 * loaded so opening and saving another field cannot erase provider state.
 */
export function EventProperties({ color, privacy, availability, disabled = false, className, variant = 'fields' }: EventPropertiesProps) {
  const id = React.useId().replace(/:/g, '');
  const fields = [
    color ? { key: 'color', field: color } : null,
    privacy ? { key: 'privacy', field: privacy } : null,
    availability ? { key: 'availability', field: availability } : null,
  ].filter((row): row is { key: string; field: EventPropertyField } => Boolean(row && row.field.choices.length));

  if (!fields.length) return null;
  return (
    <div className={cn('event-properties', variant === 'compact' && 'event-properties-compact', className)} data-event-properties="">
      {fields.map(row => (row.field.toggle ? <EventPropertyToggle key={row.key} property={row.key} id={`${id}-${row.key}`} field={row.field} disabled={disabled} /> : <EventPropertySelect key={row.key} property={row.key} id={`${id}-${row.key}`} field={row.field} disabled={disabled} />))}
    </div>
  );
}
