// packages/ui/show/property-control/PropertyControl.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The ONE generic property control (L069) — the blind renderer that ANY
// "adjust a value" control is a DATA configuration of. It takes a
// `PropertyControlDescriptor` (a property key + human label + widget id + the
// widget's own DATA: min/max/step/unit/options/presets) and renders a labelled
// row whose control writes through the ONE generic `onSet(key, value)` — blind
// to what the key means. The widget is dispatched through a capability MAP keyed
// by the descriptor's `widget` id (enum-dissolution: this component never
// `if (widget === 'slider')` — it looks the widget up), so adding a widget kind
// is one map entry and adding a control for a new property is one descriptor row
// (ZERO code here).
//
// This is the shared elevation of the `group` package's proven
// `BoardDefaultControl` pattern (board appearance cascade), generalized so that
// visual-database's grid, group's boards, and any future surface all render their
// adjustable-property controls from ONE primitive instead of duplicating a
// slider/toggle/segmented control per package.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. ZERO domain vocabulary — the component never names a property. Everything
//    is `descriptor.key` / `descriptor.label` (DATA).
// 2. Widget dispatch is a MAP, never a branch. Adding `slider`/`toggle`/etc is a
//    map entry; the renderer stays byte-identical.
// 3. Built only from `ui` molecules (RangeInput / Toggle / SegmentedControl /
//    Dropdown / ColorPickerPopover / Input / Text / Container / Button) — zero
//    raw HTML (L065).
// 4. `onSet(key, undefined)` CLEARS the value (reset to the resolved default).
// =============================================================================

import React, { useRef, useState } from 'react';

import { Button } from '../button';
import { ColorDot } from '../color-dot';
import { ColorPickerPopover } from '../color-picker-popover';
import { Container } from '../container';
import { Dropdown } from '../dropdown';
import { Input } from '../input';
import { RangeInput } from '../range-input';
import { SegmentedControl } from '../segmented-control';
import { Text } from '../text';
import { Toggle } from '../toggle';

/** The neutral swatch shown when a color control has no override. */
const UNSET_COLOR_DOT = '#64748b';

/** A single adjustable property, expressed entirely as DATA. The renderer reads
 *  these fields and never assumes anything about what `key` controls. */
export interface PropertyControlDescriptor {
  /** The property key written through `onSet` — opaque to this component. */
  readonly key: string;
  /** Human label shown at the row's start — the ONLY user-facing string. */
  readonly label: string;
  /** Which widget renders this — looked up in the WIDGETS capability map. */
  readonly widget: string;
  /** How to coerce the raw control value before writing (a size → number). */
  readonly valueKind?: 'number' | 'string' | 'boolean';
  /** Numeric widget bounds (slider/number) — DATA, never hardcoded. */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Unit appended to a numeric readout (e.g. 'px'). Display only. */
  readonly unit?: string;
  /** Options for select/segmented widgets (DATA). */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** Quick color presets for the color widget. */
  readonly presets?: readonly string[];
}

export interface PropertyControlProps {
  readonly descriptor: PropertyControlDescriptor;
  /** The element's OWN value for this key as a string ('' = unset → default). */
  readonly value: string;
  /** Generic setter — writes at the descriptor's key; `undefined` CLEARS it. */
  readonly onSet: (key: string, value: unknown) => void;
}

/** Coerce a raw control string into the descriptor's value kind. Empty string
 *  is the reset signal (returns `undefined` so callers clear the key). */
export function coercePropertyValue(raw: string, kind?: string): unknown {
  if (raw === '') return undefined;
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === 'boolean') return raw === 'true' || raw === '1';
  return raw;
}

export function PropertyControl(props: PropertyControlProps): JSX.Element {
  const render = WIDGETS[props.descriptor.widget] ?? WIDGETS.number;
  return (
    <Container layout="horizontal" justify="between" align="center" gap="sm">
      <Text variant="body-sm">{props.descriptor.label}</Text>
      {render(props)}
    </Container>
  );
}

// The widget capability map: widget id → blind sub-renderer. `PropertyControl`
// dispatches through this, never by branching on the id. A new widget kind is
// ONE entry here — the renderer above is untouched.
const WIDGETS: Record<string, (p: PropertyControlProps) => React.ReactNode> = {
  slider: (p) => <SliderWidget {...p} />,
  toggle: (p) => <ToggleWidget {...p} />,
  segmented: (p) => <SegmentedWidget {...p} />,
  number: (p) => <NumberWidget {...p} />,
  select: (p) => <SelectWidget {...p} />,
  color: (p) => <ColorWidget {...p} />,
};

/** A bare `RangeInput` track + a live numeric readout (value + unit). The
 *  caller owns the chrome; this brings track + readout. Empty value renders at
 *  the descriptor's `min` (or 0) but does NOT write until the user drags. */
function SliderWidget({ descriptor, value, onSet }: PropertyControlProps) {
  const min = descriptor.min ?? 0;
  const max = descriptor.max ?? 100;
  const current = value === '' ? min : Number(value);
  const shown = Number.isFinite(current) ? current : min;
  return (
    <Container layout="horizontal" align="center" gap="xs">
      <RangeInput
        value={shown}
        min={min}
        max={max}
        step={descriptor.step ?? 1}
        aria-label={descriptor.label}
        onValueChange={(n) => onSet(descriptor.key, n)}
      />
      <Text variant="caption" color="muted">{value === '' ? 'Default' : `${shown}${descriptor.unit ?? ''}`}</Text>
    </Container>
  );
}

/** A two-state `Toggle`. The stored value is a string the descriptor's
 *  `options` map to on/off faces — options[0]=off face, options[1]=on face. */
function ToggleWidget({ descriptor, value, onSet }: PropertyControlProps) {
  const off = descriptor.options?.[0]?.value ?? 'false';
  const on = descriptor.options?.[1]?.value ?? 'true';
  const checked = value === on;
  return (
    <Toggle
      label={descriptor.label}
      checked={checked}
      onCheckedChange={(next) => onSet(descriptor.key, next ? on : off)}
    />
  );
}

/** A `SegmentedControl` over the descriptor's `options` DATA (e.g. label sizes,
 *  alignment, or a "This / All / Selected" scope). Selecting the unset marker
 *  clears the key. */
function SegmentedWidget({ descriptor, value, onSet }: PropertyControlProps) {
  const options = descriptor.options ?? [];
  return (
    <SegmentedControl
      items={options.map((o) => ({ id: o.value, label: o.label }))}
      value={value}
      aria-label={descriptor.label}
      onValueChange={(v) => onSet(descriptor.key, coercePropertyValue(v, descriptor.valueKind))}
    />
  );
}

/** A bounded numeric `Input`. Empty clears the key (placeholder "Default" →
 *  resolved fallback shows); `min`/`max`/`step` are DATA from the descriptor. */
function NumberWidget({ descriptor, value, onSet }: PropertyControlProps) {
  return (
    <Input
      type="number"
      value={value}
      placeholder="Default"
      min={descriptor.min}
      max={descriptor.max}
      step={descriptor.step}
      aria-label={descriptor.label}
      onChange={(e) => onSet(descriptor.key, coercePropertyValue(e.target.value, descriptor.valueKind))}
    />
  );
}

/** A labelled `Dropdown` over the descriptor's `options` DATA with a leading
 *  "Default" that clears the key. */
function SelectWidget({ descriptor, value, onSet }: PropertyControlProps) {
  const options = descriptor.options ?? [];
  return (
    <Dropdown
      items={[{ value: '', label: 'Default' }, ...options.map((o) => ({ value: o.value, label: o.label }))]}
      value={value}
      align="end"
      aria-label={descriptor.label}
      onValueChange={(v) => onSet(descriptor.key, coercePropertyValue(v, descriptor.valueKind))}
    />
  );
}

/** A color swatch button + `ColorPickerPopover` (wheel + descriptor `presets`)
 *  with a first-class Reset that clears the key. */
function ColorWidget({ descriptor, value, onSet }: PropertyControlProps) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Container layout="horizontal" align="center" gap="xs">
      <Button ref={anchor} variant="ghost" size="icon" aria-label={descriptor.label} onClick={() => setOpen((o) => !o)}>
        <ColorDot color={value || UNSET_COLOR_DOT} size="md" />
      </Button>
      <ColorPickerPopover
        anchorRef={anchor}
        open={open}
        value={value || UNSET_COLOR_DOT}
        presets={descriptor.presets}
        title={descriptor.label}
        onChange={(hex) => onSet(descriptor.key, hex)}
        onSave={(hex) => { onSet(descriptor.key, hex); setOpen(false); }}
        saveLabel="Done"
        onDismiss={() => setOpen(false)}
      />
      {value ? (
        <Button variant="ghost" size="sm" aria-label={`Reset ${descriptor.label.toLowerCase()}`} onClick={() => onSet(descriptor.key, undefined)}>
          Reset
        </Button>
      ) : null}
    </Container>
  );
}
