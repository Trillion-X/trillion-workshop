// bitfield-studio/frontends/web/src/packages/ui/status-dot/HealthDot.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical HealthDot component for rendering a HealthLevel as a glowing
// StatusDot. This is a UI primitive, not a zone-local widget.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. HealthLevel maps only to semantic StatusDot variants
// 2. Red health pulses; green and yellow do not
// 3. Glow color comes only from canonical status design tokens
// 4. Owns no current-world shell or zone vocabulary
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { StatusDot } from './StatusDot';

export type HealthLevel = 'green' | 'yellow' | 'red';

export interface HealthDotProps {
  level: HealthLevel;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}

const LEVEL_TO_STATUS: Record<HealthLevel, 'success' | 'warning' | 'error'> = {
  green: 'success',
  yellow: 'warning',
  red: 'error',
};

const GLOW_COLORS: Record<HealthLevel, string> = {
  green: 'var(--color-status-success)',
  yellow: 'var(--color-status-warning)',
  red: 'var(--color-status-error)',
};

export function HealthDot({ level, label, size = 'md' }: HealthDotProps) {
  return (
    <StatusDot
      status={LEVEL_TO_STATUS[level]}
      size={size}
      pulse={level === 'red'}
      label={label ?? `Health: ${level}`}
      style={{ boxShadow: `0 0 6px ${GLOW_COLORS[level]}` }}
    />
  );
}
