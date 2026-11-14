// packages/ui/show/action-control/ActionControl.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Browser-local action control for packages that intentionally choose direct
// source import instead of runtime reply-material discovery.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure browser presentation only — no addressed reads and no invokes
// 2. Styling consumes screen-look CSS variables, never feature records
// 3. Event behavior is supplied by the caller, not owned here
//
// =============================================================================

import React from 'react';
import { Spinner } from '../spinner/Spinner';

type ActionControlVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'success';
type ActionControlSize = 'sm' | 'md' | 'lg' | 'icon' | 'nav';
type ActionControlRadius = 'md' | 'inherit';

export interface ActionControlProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionControlVariant;
  size?: ActionControlSize;
  radius?: ActionControlRadius;
  loading?: boolean;
  active?: boolean;
}

const BASE_CLASS = [
  'inline-flex',
  'items-center',
  'justify-center',
  'gap-2',
  'font-medium',
  'transition-colors',
  'min-h-[44px]',
  'sm:min-h-0',
  'outline-hidden',
  'focus-visible:outline-solid',
  'focus-visible:outline-2',
  'focus-visible:outline-offset-2',
  'focus-visible:outline-[var(--focus-ring-color)]',
  'disabled:opacity-40',
  'disabled:cursor-not-allowed',
].join(' ');

const VARIANT_CLASSES: Record<ActionControlVariant, string> = {
  primary: 'font-semibold bg-[var(--button-primary-bg)] bg-[image:var(--button-sheen)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] shadow-[var(--button-highlight),var(--button-shadow)] active:shadow-[var(--button-pressed-highlight)]',
  secondary: 'bg-[var(--glass-bg-subtle)] text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
  ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
  danger: 'bg-status-error/15 text-status-error hover:bg-status-error/25',
  accent: 'bg-accent-purple/20 text-accent-purple hover:bg-accent-purple/30',
  success: 'bg-status-success/20 text-status-success hover:bg-status-success/30',
};

const SIZE_CLASSES: Record<ActionControlSize, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-6 text-base',
  icon: 'h-7 w-7 p-0 min-w-[44px] sm:min-w-0',
  nav: 'h-9 w-full gap-3 px-3 min-h-0 text-sm justify-start',
};

const RADIUS_CLASSES: Record<ActionControlRadius, string> = {
  md: 'rounded-lg',
  inherit: 'rounded-[inherit]',
};

const ACTIVE_CLASS = 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]';

function joinClassNames(values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}


export const ActionControl = React.forwardRef<HTMLButtonElement, ActionControlProps>(({
  active,
  children,
  className,
  disabled,
  loading,
  radius = 'md',
  size = 'md',
  variant = 'secondary',
  ...props
}, ref) => (
  <button
    ref={ref}
    className={joinClassNames([
      BASE_CLASS,
      VARIANT_CLASSES[variant],
      SIZE_CLASSES[size],
      RADIUS_CLASSES[radius],
      active && ACTIVE_CLASS,
      className,
    ])}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    aria-pressed={active != null ? active : undefined}
    {...props}
  >
    {loading && <Spinner aria-hidden />}
    {children}
  </button>
));

ActionControl.displayName = 'ActionControl';
