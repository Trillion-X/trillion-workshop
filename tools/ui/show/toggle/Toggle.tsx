import * as React from 'react';

import { cn } from '../cn';
import { Text } from '../text';

export type ToggleProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'aria-checked' | 'onChange'> & {
  label: string;
  checked: boolean;
  description?: string;
  onCheckedChange: (checked: boolean) => void;
};

export const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(({
  className,
  label,
  checked,
  description,
  disabled,
  onCheckedChange,
  ...props
}, ref) => (
  <button
    ref={ref}
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    className={cn(
      'flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-3 py-2 text-left transition-colors',
      'hover:bg-[var(--glass-bg-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50',
      checked && 'bg-[var(--glass-bg-active)]',
      className,
    )}
    onClick={() => onCheckedChange(!checked)}
    {...props}
  >
    <span className="min-w-0">
      <Text variant="body-xs" weight="semibold" className="truncate">{label}</Text>
      {description ? <Text variant="caption" color="faint" className="truncate">{description}</Text> : null}
    </span>
    <span
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full border border-[var(--border-primary)] bg-[var(--glass-bg-hover)] transition-colors',
        checked && 'bg-[var(--accent-primary)]',
      )}
      aria-hidden="true"
    >
      <span
        className={cn(
          'absolute left-1 top-1 h-4 w-4 rounded-full bg-[var(--surface-raised)] shadow-sm transition-transform',
          checked && 'translate-x-5',
        )}
      />
    </span>
  </button>
));

Toggle.displayName = 'Toggle';
