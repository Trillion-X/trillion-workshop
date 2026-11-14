// packages/ui/show/canvas-tools/CanvasToolPicker.tsx
//
// A generic toolbar over a CanvasToolDescriptor[] — sorted icon buttons, active
// highlight on the current tool, tooltip = label + shortcut, click → setActive.
// Zero domain knowledge: it renders whatever tool rows it is given. Adding a tool
// is a DATA row; this component never changes.
//
// Reuses existing ui molecules only (Button active-state + NamedIcon string→icon
// resolver + Tooltip) — no raw HTML, no new primitive (L065/L100).
//
// Chrome-less by design (R21): the strip is a bare run of ghost icon buttons —
// no own border, background, or shadow — so it sits flush with the sibling
// header controls (the same ghost anatomy). The ONLY visual state is the active
// tool's pressed highlight via Button's `active` prop.

import React from 'react';
import { Button } from '../button';
import { NamedIcon } from '../icon/NamedIcon';
import { Tooltip } from '../tooltip';
import { cn } from '../cn';
import type { CanvasToolDescriptor } from './canvas-tool-types';

export interface CanvasToolPickerProps {
  tools: readonly CanvasToolDescriptor[];
  activeToolId: string;
  onSelect: (id: string) => void;
  /** 'horizontal' (default) for a top/floating rail; 'vertical' for a side rail. */
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

/** A floating rail of tool buttons, active-highlighted, tooltip = label + shortcut. */
export function CanvasToolPicker({
  tools,
  activeToolId,
  onSelect,
  orientation = 'horizontal',
  className,
}: CanvasToolPickerProps) {
  const ordered = React.useMemo(() => [...tools].sort((a, b) => a.order - b.order), [tools]);
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      className={cn(
        'inline-flex items-center gap-1',
        orientation === 'vertical' ? 'flex-col' : 'flex-row',
        className,
      )}
    >
      {ordered.map((tool) => {
        const shortcut = tool.shortcuts[0] ? tool.shortcuts[0].toUpperCase() : undefined;
        return (
          <Tooltip key={tool.id} label={tool.label} shortcut={shortcut} side={orientation === 'vertical' ? 'right' : undefined}>
            <Button
              variant="ghost"
              size="icon"
              active={tool.id === activeToolId}
              aria-pressed={tool.id === activeToolId}
              aria-label={tool.label}
              onClick={() => onSelect(tool.id)}
            >
              <NamedIcon name={tool.icon} size="md" />
            </Button>
          </Tooltip>
        );
      })}
    </div>
  );
}
