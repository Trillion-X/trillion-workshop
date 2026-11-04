// parts/screen-look/show/ScreenLookSwitch.tsx
//
// PURPOSE
//   One setting of the look choosers: the shared ui Switch with its name and one line saying what it does beside it
//   (the anatomy of the Mac's Screen look settings rows).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The switch is ui's one Switch; its accessible name is the visible label.
//   2. Words come from the caller; this file holds none of its own.

import React from 'react';
import { Switch, Text } from '../../ui';

export function ScreenLookSwitch({ label, description, checked, onCheckedChange }: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3" data-screen-look-switch>
      <div className="grid min-w-0 gap-0.5">
        <Text variant="label" color="strong" weight="medium">{label}</Text>
        <Text variant="caption" color="faint">{description}</Text>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} label={label} size="sm" />
    </div>
  );
}
