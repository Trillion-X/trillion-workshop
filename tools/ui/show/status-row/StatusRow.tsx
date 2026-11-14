// frontends/web/src/packages/ui/status-row/StatusRow.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Row container with semantic status background tint based on a pass rate (0-1).
// Pass rates <70% get error tint, 70-89% get warning tint, >=90% get no tint.
// Used by check pass rate tables and audit result lists.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. StatusRow is a layout container (div with flex)
// 2. Background tint (if any) determined by passRate prop
// 3. Only applies tint for low/warning pass rates
// 4. No other styling — consumer controls content
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';

export interface StatusRowProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Pass rate (0-1) determining background tint. <0.7 = error, 0.7-0.89 = warning, >=0.9 = none */
  passRate: number;
}

/**
 * Flex row with optional status background tint.
 *
 * Applies background tinting based on passRate:
 * - >=0.9: no tint (clean)
 * - 0.7-0.89: amber/warning tint (bg-amber-500/5)
 * - <0.7: red/error tint (bg-red-500/5)
 *
 * @example
 * ```tsx
 * <StatusRow passRate={0.65}>
 *   <Text>Check: AUDIT_GIT_001</Text>
 *   <ProgressBar value={65} />
 *   <Text>25/40 passed</Text>
 * </StatusRow>
 * ```
 */
const StatusRow = React.forwardRef<HTMLDivElement, StatusRowProps>(
  ({ passRate, style, ...props }, ref) => {
    let backgroundColor = '';
    let borderRadius = '';
    let paddingLeft = '';
    let paddingRight = '';

    if (passRate < 0.7) {
      backgroundColor = 'rgba(239, 68, 68, 0.05)'; // red-500/5
      borderRadius = '0.375rem';
      paddingLeft = '0.25rem';
      paddingRight = '0.25rem';
    } else if (passRate < 0.9) {
      backgroundColor = 'rgba(245, 158, 11, 0.05)'; // amber-500/5
      borderRadius = '0.375rem';
      paddingLeft = '0.25rem';
      paddingRight = '0.25rem';
    }

    const mergedStyle = {
      ...style,
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      ...(backgroundColor && { backgroundColor, borderRadius, paddingLeft, paddingRight }),
    };

    return <div ref={ref} style={mergedStyle} {...props} />;
  }
);

StatusRow.displayName = 'StatusRow';

export { StatusRow };
