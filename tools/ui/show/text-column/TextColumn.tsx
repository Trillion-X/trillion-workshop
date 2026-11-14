// packages/ui/show/text-column/TextColumn.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Simple flex-column wrapper for vertical text layouts (title + subtitle/description).
// Replaces raw <div className="min-w-0 flex-1"> in result rows, buttons, and lists.
// Provides consistent vertical spacing and text overflow handling across the system.
//
// =============================================================================

import React from 'react';
import { cn } from '../cn';

export interface TextColumnProps {
  children: React.ReactNode;
  className?: string;
}

export const TextColumn = React.forwardRef<HTMLDivElement, TextColumnProps>(
  function TextColumn({ children, className }, ref) {
    return (
      <div
        ref={ref}
        className={cn('min-w-0 flex-1 flex flex-col', className)}
      >
        {children}
      </div>
    );
  },
);

TextColumn.displayName = 'TextColumn';
