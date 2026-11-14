// frontends/web/src/packages/ui/severity-row/SeverityRow.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Row container tinted by its severity (never a bar down its side). Used for issue lists
// and error/warning displays where visual hierarchy by severity matters.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. SeverityRow tints its background (8%) in its severity colour
// 2. Severity: 'critical' = error color, 'warning' = warning color, 'info' = info color
// 3. Border color specified via CSS variables (--color-error, --color-warning, --color-info)
// 4. Internal style attribute ONLY for border — no other inline styling
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';

export interface SeverityRowProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Issue severity level */
  severity: 'critical' | 'warning' | 'info';
}

/**
 * Row tinted by its severity.
 *
 * Border colors:
 * - critical: --color-error (red)
 * - warning: --color-warning (amber)
 * - info: --color-info (blue)
 *
 * @example
 * ```tsx
 * <SeverityRow severity="critical">
 *   <Badge variant="error">critical</Badge>
 *   <Text>Database connection failed</Text>
 * </SeverityRow>
 * ```
 */
const SeverityRow = React.forwardRef<HTMLDivElement, SeverityRowProps>(
  ({ severity, style, ...props }, ref) => {
    const tone =
      severity === 'critical'
        ? 'var(--color-error)'
        : severity === 'warning'
          ? 'var(--color-warning)'
          : 'var(--color-info)';

    const mergedStyle = {
      ...style,
      background: `color-mix(in srgb, ${tone} 8%, transparent)`,
      borderRadius: 'var(--radius-control)',
      paddingTop: '0.375rem',
      paddingBottom: '0.375rem',
    };

    return <div ref={ref} style={mergedStyle} {...props} />;
  }
);

SeverityRow.displayName = 'SeverityRow';

export { SeverityRow };
