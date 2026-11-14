// packages/ui/show/bulk-select-bar/BulkSelectBar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure sticky selection bar that appears when the caller's selection count is
// greater than zero. Shows "N selected · Clear" plus caller-supplied action
// buttons. The caller owns the selection state and every action handler —
// this component never knows WHAT is selected. Reference anatomy: StackAI
// bulk-select bar ("1 selected · Select All · Clear" + batch actions).
//
// When the caller supplies more actions than fit comfortably, the trailing
// actions fold into a "More" overflow menu rather than running off the edge of
// the screen. This is the universal canon for crowded batch bars — Dovetail's
// "···" field menu, Linear's "Actions" trigger, Google Drive's "⋮" menu. The
// bar keeps the highest-priority actions one click away (the caller passes
// actions already in priority order) and tucks the rest behind one trigger.
// The overflow rule is purely positional — the bar still knows nothing about
// what any action does.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure renderer — no selection ownership, no data reads, no durable state
//    beyond the transient open/closed flag of its own overflow menu.
// 2. selectedCount === 0 renders nothing (no hidden placeholder element)
// 3. All buttons through the Button primitive — zero raw button styling on the
//    inline actions. (The overflow menu rows are leaf list items in the ui
//    substrate, same family as DragHandleMenu's menu rows.)
// 4. The bar can never push its own actions off the visible edge: the inline
//    count is bounded, the rest are always reachable through the overflow menu.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../cn';
import { GLASS_POPOVER_BG_CLASS } from '../glass-tokens';
import { Button } from '../button';
import { Icon } from '../icon';
import { Text } from '../text';

export interface BulkSelectBarAction {
  /** Button label (e.g. "Archive", "Delete", "Chat together").
   *  @remarks Must be unique within the actions array — it is used as the React
   *  key for both the inline button and the overflow menu row, so a duplicate
   *  label would silently drop one action. */
  label: string;
  onClick: () => void;
  /** 'danger' renders the destructive button variant */
  variant?: 'default' | 'danger';
  /** Disable this action while a batch operation is in flight */
  disabled?: boolean;
}

export interface BulkSelectBarProps {
  /** Number of selected items. 0 = renders nothing. */
  selectedCount: number;
  /** Clears the caller's selection state */
  onClearAll: () => void;
  /** Retain the exact selection while its caller is changing those records. */
  clearDisabled?: boolean;
  /** Action buttons in priority order. The first `maxInline` render as inline
   *  buttons; any beyond that fold into the "More" overflow menu, so a long
   *  action list never runs off the edge of the screen. */
  actions: readonly BulkSelectBarAction[];
  /** Optional caller-owned words; defaults retain the shared English labels. */
  words?: { selected: (count: number) => string; clear: string; more: string; actions: string };
  /** Max inline action buttons before the rest fold into "More". Defaults to a
   *  placement-aware cap (the width-constrained floating pill folds sooner than
   *  the full-width sticky toolbar). Pass an explicit number when the caller
   *  knows it has room for more. */
  maxInline?: number;
  /** Arbitrary extra controls (e.g. Dropdown pickers) rendered after the
   *  action buttons — callers compose richer batch actions without this
   *  bar knowing what they are. */
  children?: React.ReactNode;
  /** 'floating' = centered pill above the bottom edge (ClickUp/Amie batch
   *  bar); 'top' (default) = sticky toolbar (StackAI anatomy). */
  placement?: 'top' | 'floating';
  /** For `placement="floating"` only: which box the pill is positioned against.
   *  'viewport' (default) = `position: fixed`, pinned to the bottom of the
   *  screen. 'container' = `position: absolute`, pinned to the bottom of the
   *  nearest positioned ancestor — use this when a `fixed` pill would be
   *  captured by an ancestor's backdrop-filter/transform containing block; the
   *  caller wraps its surface in a `position: relative` container. This is the
   *  CSS positioning scheme (fixed vs absolute), a closed pair, not an
   *  extensible set. */
  anchor?: 'viewport' | 'container';
  className?: string;
}

/** Placement-aware default inline cap. The floating pill is width-constrained
 *  (centered, sized to content) so it folds sooner; the sticky top toolbar
 *  spans the full width and can hold more before folding. */
const DEFAULT_MAX_INLINE: Record<'top' | 'floating', number> = { top: 8, floating: 5 };

/** The trailing "More" overflow menu — an always-visible trigger plus a popover
 *  list of the folded actions. Opens upward for the floating (bottom-anchored)
 *  bar and downward for the sticky (top-anchored) bar so it never opens off the
 *  near edge. Generic: rows are caller data, identical to the inline actions. */
function OverflowMenu({ actions, placement, label }: { actions: readonly BulkSelectBarAction[]; placement: 'top' | 'floating'; label: string }) {
  const [open, setOpen] = React.useState(false);
  // Which way the menu opens. Defaults by placement, but the toggle re-measures
  // the trigger's real viewport position and opens toward whichever side has
  // more room — so the menu never runs off the top or bottom regardless of
  // where the bar actually lands (a "floating" bar can be pinned to the top of
  // its containing block, in which case it must open downward, not up).
  const [openUp, setOpenUp] = React.useState(placement === 'floating');
  const rootRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const toggle = () => {
    setOpen((value) => {
      const next = !value;
      if (next && rootRef.current && typeof window !== 'undefined') {
        const r = rootRef.current.getBoundingClientRect();
        setOpenUp(r.top > window.innerHeight - r.bottom); // open toward the larger gap
      }
      return next;
    });
  };

  return (
    <span ref={rootRef} className="relative inline-flex">
      <Button
        variant="secondary"
        size="sm"
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
      >
        <Icon icon={MoreHorizontal} size="sm" />
        {label}
      </Button>
      {open ? (
        <span
          role="menu"
          aria-label={label}
          className={cn(
            'absolute right-0 z-50 flex min-w-40 flex-col gap-0.5 rounded-xl p-1',
            // Height-capped + scrollable so a long action list never runs past
            // the top or bottom of the screen — the menu always fits the view.
            'max-h-[60vh] overflow-y-auto overscroll-contain',
            'border border-[var(--border-primary)] bg-[var(--glass-bg-strong)] backdrop-blur-xl',
            openUp ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-left text-xs font-medium disabled:opacity-50',
                action.variant === 'danger'
                  ? 'text-status-error hover:bg-status-error/10'
                  : 'text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
              )}
              onClick={() => {
                setOpen(false);
                action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export function BulkSelectBar({ selectedCount, onClearAll, clearDisabled = false, actions, words, maxInline, children, placement = 'top', anchor = 'viewport', className }: BulkSelectBarProps) {
  const cap = Math.min(maxInline ?? DEFAULT_MAX_INLINE[placement], actions.length);
  const barRef = React.useRef<HTMLDivElement>(null);
  // How many actions render inline right now. Starts at the cap and collapses
  // to whatever fits the bar's measured width (the pane forms its containing
  // block, so a wide action list on a narrow pane folds into "More" instead of
  // spilling off the edge). Browser layout does the measuring — no hand-tuned
  // pixel constants to drift out of sync with the button styles.
  const [inlineCount, setInlineCount] = React.useState(cap);

  // Reset to the cap whenever the inputs change, then let the collapse pass
  // below shrink to fit. A ResizeObserver re-runs the same reset when the pane
  // resizes so the bar grows its inline set back when there is room again.
  React.useLayoutEffect(() => {
    setInlineCount(cap);
    const bar = barRef.current;
    if (!bar?.parentElement || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setInlineCount(cap));
    observer.observe(bar.parentElement);
    return () => observer.disconnect();
  }, [cap, selectedCount]);

  // Collapse-to-fit: if the current inline set overflows the bounded bar, drop
  // one inline action (it moves into the "More" menu) and re-measure on the
  // next layout pass. Runs before paint, so the user never sees the spill.
  React.useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    if (inlineCount > 0 && bar.scrollWidth > bar.clientWidth + 1) {
      setInlineCount((n) => Math.max(0, n - 1));
    }
  });

  if (selectedCount === 0) return null;

  // When the pane is wide enough that the collapse pass never fired
  // (inlineCount still at the cap) and the whole list is at most one past the
  // cap, show everything inline — a single leftover action is cheaper inline
  // than behind a "More" trigger. Otherwise fold to the measured inline count.
  const widthConstrained = inlineCount < cap;
  const showAll = !widthConstrained && actions.length <= cap + 1;
  const visibleInline = showAll ? actions.length : inlineCount;
  const inlineActions = actions.slice(0, visibleInline);
  const overflowActions = actions.slice(visibleInline);

  return (
    <div
      ref={barRef}
      className={cn(
        'flex flex-row items-center gap-3 px-3 py-2',
        placement === 'floating'
          ? cn(
            // Floating batch pill: bottom-center, dark popover glass, soft
            // rise-in — same surface family as toast/walkthrough cards.
            // anchor=viewport → fixed (pinned to the screen); anchor=container →
            // absolute (pinned to the caller's positioned wrapper, escaping any
            // backdrop-filter containing block that would trap a fixed pill).
            anchor === 'container' ? 'absolute' : 'fixed',
            // Centered with auto-margins (left-0 right-0 mx-auto w-fit), NOT a
            // translate — the slide-in-from-bottom animation drives transform,
            // so a translate-based center gets clobbered to none. The max-width
            // bound lives in the INLINE STYLE below, NOT an arbitrary Tailwind
            // class — a consuming app whose CSS content-glob does not scan this
            // `ui` package silently drops `max-w-[calc(...)]` (computes to none),
            // un-bounding the pill so it escapes the pane AND defeating the
            // w-fit collapse pass (scrollWidth never exceeds clientWidth).
            // Inline style is always applied, no build dependency (L089).
            'bottom-6 left-0 right-0 z-50 mx-auto w-fit rounded-2xl',
            GLASS_POPOVER_BG_CLASS + ' backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.4)]',
            'animate-in slide-in-from-bottom-3 fade-in duration-200',
          )
          : 'glass-surface sticky top-0 z-10 animate-in slide-in-from-top-2 fade-in duration-150',
        className,
      )}
      // The floating pill is anchored to the BOTTOM. Pin top:auto + bottom
      // inline so this wins deterministically over any stray cascaded `top`
      // (an inherited top:0 would otherwise beat `bottom-6`, since for a
      // fixed-height positioned box a set `top` wins over a set `bottom`).
      style={placement === 'floating' ? { top: 'auto', bottom: '1.5rem', maxWidth: 'calc(100% - 1rem)' } : undefined}
      role="toolbar"
      aria-label={words?.actions ?? 'Selection actions'}
    >
      <Text variant="body-xs" weight="medium">{words?.selected(selectedCount) ?? `${selectedCount} selected`}</Text>
      <Button variant="ghost" size="xs" disabled={clearDisabled} onClick={onClearAll}>{words?.clear ?? 'Clear'}</Button>
      <div className={placement === 'floating' ? 'w-2' : 'flex-1'} />
      {children}
      {inlineActions.map((action) => (
        <Button
          key={action.label}
          variant={action.variant === 'danger' ? 'danger' : 'secondary'}
          size="sm"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      ))}
      {overflowActions.length > 0 ? <OverflowMenu actions={overflowActions} placement={placement} label={words?.more ?? 'More'} /> : null}
    </div>
  );
}
