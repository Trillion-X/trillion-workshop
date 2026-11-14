// packages/ui/show/dockable-placement/PositionCompass.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic 4-cardinal position picker for any dockable chrome. Extracted from
// the sidebar (which proved it) so every dockable consumer shares one compass.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { Compass } from 'lucide-react';
import { Button } from '../button';
import { Icon } from '../icon';
import { Dropdown } from '../dropdown/Dropdown';
import type { DockPosition } from './dockable-placement';

export interface PositionCompassProps {
  current: DockPosition;
  onSelect: (position: DockPosition) => void;
  /** The places to offer (a show rule can limit them); every place when absent. */
  choices?: readonly DockPosition[];
}

export function PositionCompass({ current, onSelect, choices }: PositionCompassProps) {
  // One regular control replaces four 14px hit targets inside the same icon.
  // The shared menu owns keyboard/touch selection and marks the current edge.
  return (
    <Dropdown
      items={[
        { value: 'left', label: 'Move to left', icon: 'PanelLeft' },
        { value: 'right', label: 'Move to right', icon: 'PanelRight' },
        { value: 'top', label: 'Move to top', icon: 'PanelTop' },
        { value: 'bottom', label: 'Move to bottom', icon: 'PanelBottom' },
      ].filter(item => !choices || choices.includes(item.value as DockPosition))}
      value={current}
      onValueChange={value => onSelect(value as DockPosition)}
      align="start"
      aria-label="Position"
      customTrigger={<Button variant="ghost" size="icon" work={null} aria-label="Position"><Icon icon={Compass} size="sm" /></Button>}
    />
  );
}
