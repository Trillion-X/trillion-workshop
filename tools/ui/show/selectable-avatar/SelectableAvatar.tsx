// packages/ui/show/selectable-avatar/SelectableAvatar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure identity tile that doubles as a selection control. The initial mark is
// ALWAYS visible — selection is a small corner check badge that fades in on
// hover and stays while selected (Langdock/StackAI card anatomy). The caller
// owns the selection state and the toggle handler — this part only paints.
// An optional attention dot rides the opposite corner.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure renderer — no data reads, no durable state, no feature vocabulary
// 2. The identity mark never disappears or swaps — selection is additive
// 3. Click toggles selection and never bubbles to the parent card
// 4. dot=false renders no dot element at all (no hidden filler)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../cn';
import { Text } from '../text';

export interface SelectableAvatarProps {
  /** Name whose first character becomes the always-visible mark */
  name: string;
  /** Caller-owned selection state */
  selected: boolean;
  /** Toggle handler — fired on click, click never bubbles */
  onToggle: () => void;
  /** Attention dot (e.g. unread) */
  dot?: boolean;
  /** Accessible label for the dot */
  dotLabel?: string;
  className?: string;
}

export function SelectableAvatar({
  name,
  selected,
  onToggle,
  dot = false,
  dotLabel,
  className,
}: SelectableAvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={`Select ${name}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        'group/avatar relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--glass-bg-active)]',
        className,
      )}
    >
      <Text variant="body" weight="semibold" color="strong">{initial}</Text>
      <span
        aria-hidden
        className={cn(
          'absolute -left-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full transition-opacity duration-100',
          selected
            ? 'bg-accent-purple text-white opacity-100'
            : 'bg-[var(--glass-bg-active)] text-[var(--text-muted)] opacity-0 group-hover/avatar:opacity-100',
        )}
      >
        <Check className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
      {dot && (
        <span
          aria-label={dotLabel}
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-purple"
        />
      )}
    </button>
  );
}
