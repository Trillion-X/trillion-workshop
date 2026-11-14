// packages/ui/show/completion-ring/CompletionRing.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Amie-style task completion circle: an 18px ring that previews a check
// mark on hover, fills with the success color when done, and animates the
// transition. One primitive — every list/board/row surface renders the same
// completion affordance.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic: no product vocabulary. `done` in/out is a plain boolean.
// 2. Tokens only: success color rides --status-success with a system fallback;
//    rest-state ring rides white-opacity utilities like the rest of ui/. The
//    done check rides a contrast token so dark and light themes stay readable.
// 3. Raw <button> is legal ONLY here (ui primitive). Feature code passes
//    done/onToggle and never touches the element.
// 4. Click never bubbles — completion lives inside clickable rows/cards.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '../cn';

export interface CompletionRingProps {
  /** Current completion state. */
  done: boolean;
  /** Called with the NEXT state when the user clicks. */
  onToggle: (next: boolean) => void;
  /** Disable interaction (busy, read-only). */
  disabled?: boolean;
  'aria-label'?: string;
}

export function CompletionRing({
  done,
  onToggle,
  disabled = false,
  'aria-label': ariaLabel,
}: CompletionRingProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? (done ? 'Mark incomplete' : 'Mark complete')}
      aria-pressed={done}
      disabled={disabled}
      className={cn(
        // Rounded SQUARE, same radius family as the calendar day cell —
        // not a circle. mr-1 keeps clear air between the mark and the title.
        'group/ring mr-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border-[1.5px]',
        'transition-all duration-150 disabled:opacity-50',
        done
          ? 'border-[var(--status-success,#34c759)] bg-[var(--status-success,#34c759)]'
          : 'border-white/25 hover:border-white/60',
      )}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(!done);
      }}
    >
      <Check
        size={11}
        strokeWidth={3}
        aria-hidden="true"
        className={cn(
          'transition-colors duration-150',
          done ? 'text-[var(--completion-check-color,var(--text-on-success,#fff))]' : 'text-white/0 group-hover/ring:text-white/45',
        )}
      />
    </button>
  );
}
