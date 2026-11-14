// packages/ui/show/nav-arrows/NavArrows.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A generic back/forward navigation control: two chevron buttons with disabled
// states. It knows NOTHING about what it navigates — tabs, URLs, records, undo
// stacks. The caller supplies can-go state and handlers. Any surface with a
// navigable sequence (a pane's visited tabs, a web frame's URL history) mounts
// this and wires its own back/forward. Pure presentational L3 molecule.
// =============================================================================

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Dropdown } from '../dropdown/Dropdown';

export interface NavHistoryItem {
  readonly ref: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface NavArrowsProps {
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  /** Accessible labels — caller-owned wording (default Back/Forward). */
  readonly backLabel?: string;
  readonly forwardLabel?: string;
  /** Optional visited destinations shown when either chevron is hovered/focused. */
  readonly historyItems?: readonly NavHistoryItem[];
  /** Current destination in `historyItems`. */
  readonly currentHistoryRef?: string | null;
  /** Jump directly to a visited destination. */
  readonly onSelectHistory?: (ref: string) => void;
  /** 'vertical' stacks the arrows (a bar docked on a left or right edge). */
  readonly orientation?: 'horizontal' | 'vertical';
}

// Holding an arrow this long opens the history list instead of stepping (a finger has no pointing).
const LONG_PRESS_MS = 450;

/** Two chevron buttons; each greys out when its direction is unavailable. */
export function NavArrows({
  canBack,
  canForward,
  onBack,
  onForward,
  backLabel = 'Back',
  forwardLabel = 'Forward',
  historyItems,
  currentHistoryRef,
  onSelectHistory,
  orientation = 'horizontal',
}: NavArrowsProps) {
  const [listOpen, setListOpen] = React.useState<'back' | 'forward' | null>(null);
  const hold = React.useRef<{ timer: ReturnType<typeof setTimeout> | null; opened: boolean }>({ timer: null, opened: false });
  const endHold = () => { if (hold.current.timer) clearTimeout(hold.current.timer); hold.current.timer = null; };
  React.useEffect(() => endHold, []);
  const btn =
    'inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-secondary)] ' +
    'transition-colors hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)] ' +
    'disabled:pointer-events-none disabled:opacity-30';
  const historyEnabled = !!historyItems?.length && !!onSelectHistory;
  const historyItemsForMenu = historyItems?.map((item) => ({
    value: item.ref,
    label: item.label,
    ...(item.description ? { description: item.description } : {}),
    ...(item.disabled ? { disabled: true } : {}),
  })) ?? [];

  const arrow = (label: string, direction: 'back' | 'forward', disabled: boolean, handler: () => void) => {
    const trigger = (
      <button
        type="button"
        aria-label={label}
        title={label}
        data-nav-back={direction === 'back' ? '1' : undefined}
        data-nav-forward={direction === 'forward' ? '1' : undefined}
        disabled={disabled && !historyEnabled}
        aria-disabled={disabled || undefined}
        onPointerDown={() => {
          if (!historyEnabled) return;
          hold.current.opened = false;
          endHold();
          hold.current.timer = setTimeout(() => { hold.current.opened = true; setListOpen(direction); }, LONG_PRESS_MS);
        }}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        onContextMenu={(event) => { if (historyEnabled) event.preventDefault(); }}
        onClick={() => {
          // A long press opened the list; the press that ends it does not also step.
          if (hold.current.opened) { hold.current.opened = false; return; }
          if (!disabled) handler();
        }}
        className={`${btn}${disabled && historyEnabled ? ' opacity-30' : ''}`}
      >
        {direction === 'back' ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
    );
    if (!historyEnabled) return trigger;
    return (
      <Dropdown
        value={currentHistoryRef ?? ''}
        onValueChange={onSelectHistory!}
        items={historyItemsForMenu}
        customTrigger={trigger}
        open={listOpen === direction}
        onOpenChange={(next) => setListOpen(next ? direction : null)}
        openOnHover
        // Same height as the filter's value list, then it scrolls.
        scrollable="var(--floating-list-max-height, 300px)"
        aria-label="Navigation history"
        contentClassName="min-w-[220px] max-w-[min(360px,calc(100vw-24px))]"
      />
    );
  };

  return (
    <div className={orientation === 'vertical' ? 'inline-flex flex-col items-center gap-[1px]' : 'inline-flex items-center gap-[1px]'} data-nav-arrows="1" data-no-drag="true">
      {arrow(backLabel, 'back', !canBack, onBack)}
      {arrow(forwardLabel, 'forward', !canForward, onForward)}
    </div>
  );
}
