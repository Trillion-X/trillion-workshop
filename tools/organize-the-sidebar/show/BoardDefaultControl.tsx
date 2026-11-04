// packages/group/show/BoardDefaultControl.tsx
//
// The ONE board-default control primitive (L069) — the blind renderer that every board-default
// appearance control (Text size, Note density, Connector color/weight, and any future cascade key)
// is a DATA configuration of. It takes a `BoardDefaultControlDescriptor` (the row's cascade key +
// label + widget id + widget DATA) and renders a labelled row whose control writes through the ONE
// generic `onSet(key, value)` — blind to what the key means. The widget is dispatched through a
// capability MAP keyed by the descriptor's `widget` id (enum-dissolution: this component never
// `if (widget === 'color')` — it looks the widget up), so adding a widget kind is one map entry and
// adding a control for a new cascade key is one descriptor row (ZERO code here). Built only from `ui`
// molecules (Dropdown / ColorDot + ColorPickerPopover / Button / Text / Container) — zero raw HTML (L065).

import React, { useRef, useState } from 'react';
import { Button, ColorDot, ColorPickerPopover, Container, Dropdown, Input, Text } from '../../ui';
import { type BoardDefaultControlDescriptor, coerceBoardDefaultValue } from './item-appearance';
import { SettingInfoOverlay, type SettingInfoDescriptor } from './SettingInfoOverlay';

/** The swatch shown when a color control has NO override — a neutral slate mirroring the global IDLE
 *  line (`rgba(100,116,139)`); the global default is a CSS var the `ColorDot` can't render as a swatch. */
const UNSET_COLOR_DOT = '#64748b';

export interface BoardDefaultControlProps {
  descriptor: BoardDefaultControlDescriptor;
  /** The board's OWN override value for this key as a string ('' when unset → the "Default"/reset state). */
  value: string;
  /** Generic setter: writes the value at the descriptor's cascade key; `undefined` CLEARS it (reset). */
  onSet: (key: string, value: unknown) => void;
  /** Optional: info descriptor for displaying help (i) affordance. Absent → no info icon rendered. */
  infoDescriptor?: SettingInfoDescriptor;
}

export function BoardDefaultControl(props: BoardDefaultControlProps) {
  const render = WIDGETS[props.descriptor.widget];
  return (
    <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm">
      <Container layout="horizontal" alignItems="center" gap="xs">
        <Text variant="body-sm">{props.descriptor.label}</Text>
        {props.infoDescriptor ? <SettingInfoOverlay descriptor={props.infoDescriptor} /> : null}
      </Container>
      {render ? render(props) : null}
    </Container>
  );
}

// The widget capability map: widget id → blind sub-renderer. The control dispatches through this,
// never by branching on the id. A new widget kind (slider, toggle, segmented…) is one entry here.
const WIDGETS: Record<string, (p: BoardDefaultControlProps) => React.ReactNode> = {
  select: (p) => <SelectWidget {...p} />,
  color: (p) => <ColorWidget {...p} />,
  number: (p) => <NumberWidget {...p} />,
};

/** A labelled `Dropdown` over the descriptor's `options` DATA with a leading "Default" that clears the
 *  key (reset to global). The set value is coerced by the descriptor's `valueKind` (a weight → number). */
function SelectWidget({ descriptor, value, onSet }: BoardDefaultControlProps) {
  const options = descriptor.options ?? [];
  return (
    <Dropdown
      items={[{ value: '', label: 'Default' }, ...options.map((o) => ({ value: o.value, label: o.label }))]}
      value={value}
      onValueChange={(v) => onSet(descriptor.key, coerceBoardDefaultValue(v, descriptor.valueKind))}
      align="end"
      aria-label={descriptor.label}
    />
  );
}

/** A color swatch button + `ColorPickerPopover` (full wheel + the descriptor's quick `presets`) with a
 *  first-class Reset that clears the key (global fallback returns). Owns its own popover open state. */
function ColorWidget({ descriptor, value, onSet }: BoardDefaultControlProps) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Container layout="horizontal" alignItems="center" gap="xs">
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

/** A bounded numeric `Input` (px) over a numeric cascade key. Empty clears the key (placeholder
 *  "Default" → global fallback shows); `min`/`max`/`step` are DATA from the descriptor (not hardcoded).
 *  The set value is coerced by `valueKind` (a size is stored as a number, not a string). */
function NumberWidget({ descriptor, value, onSet }: BoardDefaultControlProps) {
  return (
    <Input
      type="number"
      value={value}
      placeholder="Default"
      min={descriptor.min}
      max={descriptor.max}
      step={descriptor.step}
      onChange={(e) => onSet(descriptor.key, coerceBoardDefaultValue(e.target.value, descriptor.valueKind))}
      aria-label={descriptor.label}
    />
  );
}
