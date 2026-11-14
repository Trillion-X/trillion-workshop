// frontends/web/src/packages/ui/copyable-path/CopyablePath.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical clickable file path component with copy-to-clipboard functionality.
// Displays a shortened version of the file path (configurable segment count),
// shows full path on hover, and provides visual feedback on copy success.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL styling through CVA variants — no inline styles
// 2. Mono font for all file paths — always consistent rendering
// 3. Copy feedback: icon switches to Check for 1500ms after successful copy
// 4. Full path shown via title attribute on hover (native browser tooltip)
// 5. Uses Icon component for lucide-react icons
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Copy, Check } from 'lucide-react';
import { cn } from '../cn';
import { Icon } from '../icon';
import { useCopy } from '../copy-button/CopyButton';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

const copyablePathVariants = cva(
  'inline-flex items-center gap-1.5 cursor-pointer rounded-lg transition-colors font-mono',
  {
    variants: {
      size: {
        sm: 'text-xs px-2 py-1',
        md: 'text-sm px-2.5 py-1.5',
      },
      variant: {
        default: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--glass-bg-subtle)]',
        subtle: 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--glass-bg-subtle)]',
      },
    },
    defaultVariants: { size: 'sm', variant: 'default' },
  }
);

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface CopyablePathProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof copyablePathVariants> {
  /** Full absolute path to display and copy */
  path: string;
  /** How many path segments to show (default: 1 = just filename) */
  displaySegments?: number;
  /** Show full path as title attribute on hover (default: true) */
  showFullOnHover?: boolean;
  /** Callback after successful copy */
  onCopy?: () => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Clickable file path component with copy-to-clipboard.
 *
 * Displays last N segments of the path (default just filename).
 * On hover: full path appears as browser tooltip + copy icon visible.
 * On click: copies full absolute path to clipboard.
 * Visual feedback: icon switches to Check for 1500ms after copy.
 *
 * @example
 * ```tsx
 * <CopyablePath path="/srv/project/src/index.ts" />
 * <CopyablePath path="/srv/project/src/index.ts" displaySegments={2} />
 * <CopyablePath path="/srv/project/src/index.ts" size="md" variant="subtle" />
 * ```
 */
export const CopyablePath = React.forwardRef<HTMLDivElement, CopyablePathProps>(
  (
    {
      path,
      displaySegments = 1,
      showFullOnHover = true,
      onCopy,
      className,
      variant,
      size,
      ...props
    },
    ref
  ) => {
    // The shared copy (copy-button): the mark turns to a check only once the clipboard verifiably took the path.
    const { copy, status } = useCopy({ timeout: 1500 });
    const copied = status === 'copied';

    // Extract the last N segments from the path
    const segments = path.split('/').filter(Boolean);
    const displayPath = segments.slice(-displaySegments).join('/');

    const handleCopy = useCallback(async () => {
      if (await copy(path)) onCopy?.();
    }, [copy, path, onCopy]);

    return (
      <div
        ref={ref}
        className={cn(copyablePathVariants({ variant, size }), className)}
        onClick={handleCopy}
        title={showFullOnHover ? path : undefined}
        role="button"
        tabIndex={0}
        aria-label={`Copy path: ${path}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCopy();
          }
        }}
        {...props}
      >
        <span className="truncate">{displayPath}</span>
        <Icon
          icon={copied ? Check : Copy}
          size="sm"
          color={copied ? 'success' : 'muted'}
        />
      </div>
    );
  }
);

CopyablePath.displayName = 'CopyablePath';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { copyablePathVariants };
