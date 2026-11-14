// parts/ui/show/switch/Switch.tsx
//
// PURPOSE
//   The one on/off switch every screen uses: a pill track that fills from the left as it turns on and a pill thumb
//   that slides across it. Built on Base UI's Switch primitive (role="switch", aria-checked, Space and Enter,
//   focus-visible, disabled), so this file only names its parts; how they look and move is
//   screen-look/show/switch.css (`.ui-switch`, `.ui-switch-thumb`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. There is one switch in parts/ui; coss/ui/switch re-exports this one.
//   2. `label` is the switch's accessible name when no visible label names it.
//   3. A press on the switch toggles it and goes no further, so a switch inside a row never opens the row.
//
// Anatomy and motion adapted from 21st.dev component 21948 (serafimcloud/switch, MIT): the gradient track whose
// background slides, and the spring-eased pill thumb.

import * as React from 'react';
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '../cn';

export type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The accessible name, when nothing visible labels the switch. */
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
};

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, label, disabled, size = 'md', className }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      data-size={size}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onCheckedChange={next => onCheckedChange(next)}
      onClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      className={cn('ui-switch', className)}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className="ui-switch-thumb" />
    </SwitchPrimitive.Root>
  ),
);

Switch.displayName = 'Switch';
