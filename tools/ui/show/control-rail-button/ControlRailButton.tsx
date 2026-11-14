// packages/ui/show/control-rail-button/ControlRailButton.tsx
//
// The one shared molecule for a sidebar/toolbar control-rail button: a ghost
// button with a leading icon and an optional label that collapses to icon-only.
// Encapsulates the h-9 control sizing + vertical (full-width stacked) vs
// horizontal (inline) layout so feature code (e.g. DesktopSidebar) composes it
// WITHOUT raw className (L065). Position compass / collapse / undock / auto-hide
// are all configurations of this one molecule (L063).

import React from 'react';
import { Button } from '../button';
import { Icon } from '../icon';
import { Text } from '../text';
import { Tooltip } from '../tooltip';
import { cn } from '../cn';
import type { LucideIcon } from 'lucide-react';

interface ControlRailButtonProps {
  /** Leading icon (lucide). */
  icon: LucideIcon;
  /** Label shown when `showLabel`; also the tooltip when collapsed. */
  label: string;
  /** Show the text label inline (expanded rail) vs icon-only (collapsed rail). */
  showLabel?: boolean;
  /** Vertical rail → full-width stacked rows; horizontal rail → inline. */
  vertical?: boolean;
  onClick?: () => void;
  /** A custom node rendered before the label instead of the icon (e.g. a compass). */
  leading?: React.ReactNode;
}

/** A ghost control-rail button with leading icon + optional collapsing label. */
function ControlRailButton({ icon, label, showLabel = false, vertical = false, onClick, leading }: ControlRailButtonProps) {
  const layout = cn('gap-3 px-3 h-9 min-h-0', vertical ? 'w-full' : 'flex-shrink-0 whitespace-nowrap');
  const body = (
    <Button variant="ghost" onClick={onClick} className={layout}>
      {leading ?? <Icon icon={icon} size="lg" className="flex-shrink-0" />}
      {showLabel && <Text className="truncate flex-1 text-left">{label}</Text>}
    </Button>
  );
  return showLabel ? body : (
    <Tooltip label={label}>
      {body}
    </Tooltip>
  );
}

ControlRailButton.displayName = 'ControlRailButton';

export { ControlRailButton };
export type { ControlRailButtonProps };
