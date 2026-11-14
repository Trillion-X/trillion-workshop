// bitfield/packages/ui/dropdown/Dropdown.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// L069 generative primitive for ALL selection-from-list UI. Screen-look, model
// selectors, icon pickers, font pickers — all are configurations of this one
// component via `renderItem`, `customTrigger`, `scrollable`, `header`, `align`.
//
// Uses Radix Popover for portal-based rendering that avoids overflow clipping
// from parent containers. Glassmorphism-styled with full ARIA support and
// keyboard navigation.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL colors use CSSOT design tokens (accent-purple, glass-surface, etc.)
// 2. Radix Popover handles portal rendering — no z-index hacks
// 3. Close on selection — single interaction pattern
// 4. Keyboard navigation: ArrowUp/Down to move, Enter to select, Escape to close
// 5. Disabled items are non-interactive and visually muted
// 6. customTrigger replaces default button entirely — no Tooltip wrappers
// 7. any open popover captures wheel events at its scroll bounds to prevent
//    page scroll bleed (the menu is always viewport-bounded + scrollable)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, ChevronRight, Check } from 'lucide-react';
import { cn } from '../cn';
import { NamedIcon } from '../icon';
import { LAYER_ORDER } from '../layer-order/layer-order';
import { searchDropdownItems } from './menu-search';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface DropdownItem {
  /** Unique value for this item */
  value: string;
  /** Display label */
  label: string;
  /** Whether the item is non-selectable */
  disabled?: boolean;
  /** Lucide icon name rendered before the label. Pure data — any icon name,
   *  resolved via NamedIcon. Omit = no icon, row indents stay aligned when
   *  any sibling has one. */
  icon?: string;
  /** Keyboard shortcut label rendered right-aligned (e.g. "⌘D"). Display-only
   *  data — the caller owns any actual key handling. */
  shortcut?: string;
  /** Row tint — ANY CSS color string applied to the icon + label, with a soft
   *  translucent wash of the same color on hover/focus. Arbitrary data, not a
   *  fixed set of variants. */
  tint?: string;
  /** Nested choices: the row renders a trailing chevron; hovering reveals a
   *  side panel of these items. Selecting one fires the parent onValueChange
   *  with the CHILD's value — one selection seam either way. */
  children?: DropdownItem[];
  /** One-line muted subtitle rendered under the label (model-picker anatomy —
   *  "super fast and cheap", "premier coding model"). Pure data. Presence of
   *  ANY item description puts the list in rich mode (descriptions + a trailing
   *  check on the selected row); absent = the flat compact row, unchanged. */
  description?: string;
  /** Section this item belongs to. Consecutive items sharing a section render
   *  under one caption header (Granola "Thinking Models" / "Standard Models").
   *  The caller orders items by section; the dropdown renders the header when
   *  the section changes. Pure data — any section name, no closed set. Absent =
   *  ungrouped (back-compat). */
  section?: string;
}

/** Render state passed to custom item renderers */
interface DropdownItemState {
  selected: boolean;
  focused: boolean;
}

interface DropdownProps {
  /** Items to display in the dropdown */
  items: DropdownItem[];
  /** Currently selected value */
  value: string;
  /** Called when selection changes */
  onValueChange: (value: string) => void;
  /** Trigger label when nothing is selected */
  placeholder?: string;
  /** Optional label rendered above the dropdown trigger */
  label?: string;
  /** Optional header inside the popover — a string renders as the standard
   *  caption in its own case; a ReactNode renders verbatim (e.g. inline rename). */
  header?: React.ReactNode;
  /** Optional footer ReactNode pinned below the items (e.g. add-option input). */
  footer?: React.ReactNode;
  /** Optional icon rendered before the label in the default trigger */
  icon?: React.ReactNode;
  /** Disabled state for the entire dropdown */
  disabled?: boolean;
  /** Optional aria-label for accessibility */
  'aria-label'?: string;
  /** Additional className for the trigger button */
  className?: string;
  /** Trigger size — 'sm' (compact config bars, default) or 'md' (matches Input height in toolbar rows) */
  size?: 'sm' | 'md';
  /** Replace the default trigger button with a custom element */
  customTrigger?: React.ReactElement;
  /** Custom item content renderer. Receives item data + selection/focus state. */
  renderItem?: (item: DropdownItem, state: DropdownItemState) => React.ReactNode;
  /** Enable scrollable popover. true = '50vh' max-height, string = custom max-height. */
  scrollable?: boolean | string;
  /** Popover alignment relative to trigger */
  align?: 'start' | 'center' | 'end';
  /** Extra class on the portaled popover content for shared, data-driven variants. */
  contentClassName?: string;
  /** Controlled open state. Omit for the default self-managed (uncontrolled) menu. */
  open?: boolean;
  /** Called whenever the menu wants to open/close (required for controlled use). */
  onOpenChange?: (open: boolean) => void;
  /** Open when the trigger is pointed at; the portaled panel stays open while
   *  the pointer moves into it and closes shortly after leaving both surfaces. */
  openOnHover?: boolean;
  /** Grace period for moving the pointer from a trigger into its portaled panel. */
  hoverCloseDelayMs?: number;
  /** Anchor the popover to a fixed viewport point (e.g. a right-click position)
   *  instead of a trigger. When set, NO trigger is rendered — the caller owns
   *  `open`. This turns the dropdown into a positioned context menu. */
  anchor?: { readonly x: number; readonly y: number } | null;
  /** Render arbitrary content inside the anchored glass popover INSTEAD of the
   *  item list (e.g. a color wheel or rename field). The dropdown stays blind to
   *  what the panel is — it only lends its anchoring + glass surface. When set,
   *  `items`/`header` are ignored. */
  panel?: React.ReactNode;
  /** Add a focused search field and flatten matching nested leaf actions into categorized results. */
  searchable?: boolean;
  /** Accessible name and placeholder for the optional search field. */
  searchLabel?: string;
  /** Where the popover is portaled; the page's body when absent. A trigger drawn in another window (the Mac recording
   *  window) passes that window's body, so its menu opens there. */
  container?: HTMLElement | null;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * L069 generative primitive — glassmorphism dropdown built on Radix Popover.
 *
 * Renders items in a portal to avoid overflow clipping. Supports keyboard
 * navigation, disabled items, custom triggers, custom item rendering,
 * scrollable lists, and configurable alignment.
 *
 * @example Basic usage
 * ```tsx
 * <Dropdown
 *   items={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]}
 *   value={selected}
 *   onValueChange={setSelected}
 *   placeholder="Choose..."
 * />
 * ```
 *
 * @example Custom trigger + custom items (screen-look chooser pattern)
 * ```tsx
 * <Dropdown
 *   items={themeItems}
 *   value={currentTheme}
 *   onValueChange={handleThemeSelect}
 *   customTrigger={<Button variant="ghost"><Icon icon={Palette} /></Button>}
 *   renderItem={(item, { selected }) => (
 *     <>
 *       <ColorSwatch color={item.value} />
 *       <span>{item.label}</span>
 *       {selected && <Icon icon={Check} />}
 *     </>
 *   )}
 *   scrollable
 *   header="Select Theme"
 *   align="end"
 * />
 * ```
 */
function Dropdown({
  items,
  value,
  onValueChange,
  placeholder = 'Select...',
  label,
  header,
  footer,
  icon,
  disabled = false,
  'aria-label': ariaLabel,
  className,
  size = 'sm',
  customTrigger,
  renderItem,
  scrollable,
  align = 'start',
  contentClassName,
  open: openProp,
  onOpenChange,
  openOnHover = false,
  hoverCloseDelayMs = 160,
  anchor,
  panel,
  searchable = false,
  searchLabel = 'Search',
  container,
}: DropdownProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  // Controlled when `open` is supplied; otherwise self-managed. One seam either way.
  const open = openProp !== undefined ? openProp : internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const [focusedIndex, setFocusedIndex] = useState(-1);
  /** Value of the parent row whose nested panel is open (submenu anatomy). */
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [submenuIndex, setSubmenuIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemElements = useRef(new Map<string, HTMLDivElement>());
  /**
   * Viewport rect of the open submenu's anchor row. The submenu flyout is
   * PORTALED to <body> and positioned `fixed` from this rect, so it escapes the
   * popover's `overflow:auto` scroll-clip. Without the portal, a flyout that
   * extends past the scrollable popover's box is clipped and not hit-testable —
   * clicks fall through to whatever is underneath (e.g. the freeform canvas
   * layer), so the submenu item silently never fires. (Incident: surface Mode →
   * Tiles was unclickable in canvas mode.)
   */
  const [submenuAnchorRect, setSubmenuAnchorRect] = useState<DOMRect | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The surface the trigger sits on: a menu opened from an island (surfaces.css) wears the island, though portaled out of it.
  const rootRef = useRef<HTMLDivElement>(null);
  const onIsland = open && Boolean(rootRef.current?.closest('.glass-island, .island-surface'));
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverClose = useCallback(() => {
    if (hoverCloseTimer.current !== null) {
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }, []);
  const scheduleHoverClose = useCallback(() => {
    if (!openOnHover) return;
    clearHoverClose();
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = null;
      setOpen(false);
    }, Math.max(0, hoverCloseDelayMs));
  }, [clearHoverClose, hoverCloseDelayMs, openOnHover, setOpen]);

  React.useEffect(() => clearHoverClose, [clearHoverClose]);

  // Context-menu mode: a virtual anchor measured straight from viewport
  // coordinates. getBoundingClientRect always reports viewport-relative
  // coords, so this is immune to transform / backdrop-filter ancestors that
  // would otherwise re-base a `position:fixed` element's painted rect (the
  // cause of the popover drifting right of the click point).
  const anchorRectRef = useRef<{ getBoundingClientRect(): DOMRect }>({
    getBoundingClientRect: () => new DOMRect(0, 0, 0, 0),
  });
  anchorRectRef.current.getBoundingClientRect = () =>
    new DOMRect(anchor?.x ?? 0, anchor?.y ?? 0, 0, 0);

  const displayItems = searchable && searchQuery.trim() ? searchDropdownItems(items, searchQuery) : items;
  const selectedItem = items.find((item) => item.value === value);
  const selectableItems = displayItems.filter((item) => !item.disabled);

  React.useEffect(() => {
    if (open && searchable) {
      searchInputRef.current?.focus();
      setFocusedIndex(0);
    }
    if (!open) setSearchQuery('');
  }, [open, searchable]);
  React.useEffect(() => {
    setFocusedIndex(searchable ? 0 : -1);
    setOpenSubmenu(null);
    setSubmenuIndex(-1);
  }, [searchQuery, searchable]);

  const handleSelect = useCallback(
    (itemValue: string) => {
      onValueChange(itemValue);
      setOpen(false);
      setFocusedIndex(-1);
      setOpenSubmenu(null);
      setSubmenuIndex(-1);
    },
    [onValueChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Editing a search query keeps ordinary text keys and caret navigation.
      // Space must not activate the highlighted result while composing a phrase.
      // WebKit may report the IME's commit Enter with isComposing already false;
      // keyCode 229 is its legacy composition sentinel. Let that keystroke commit
      // the query instead of selecting the currently highlighted action.
      if (e.target === searchInputRef.current && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
        || [' ', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(e.key))) return;
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpenSubmenu(null);
          setSubmenuIndex(-1);
          setOpen(true);
          setFocusedIndex(0);
        }
        return;
      }

      const children = displayItems.find(item => item.value === openSubmenu)?.children?.filter(item => !item.disabled);
      if (children && openSubmenu !== null) {
        if (['ArrowDown','ArrowUp','Home','End','Enter',' ','ArrowLeft','Escape'].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'ArrowLeft' || e.key === 'Escape') {
            setOpenSubmenu(null);
            setSubmenuIndex(-1);
          } else if (e.key === 'Enter' || e.key === ' ') {
            if (children[submenuIndex]) handleSelect(children[submenuIndex].value);
          } else if (children.length) {
            setSubmenuIndex(previous => e.key === 'Home' ? 0 : e.key === 'End' ? children.length - 1
              : e.key === 'ArrowDown' ? (previous + 1) % children.length
              : previous <= 0 ? children.length - 1 : previous - 1);
          }
          return;
        }
      }

      const focusedItem = selectableItems[focusedIndex];
      if (focusedItem?.children?.length && ['ArrowRight','Enter',' '].includes(e.key)) {
        const element = itemElements.current.get(focusedItem.value);
        if (element) {
          e.preventDefault();
          setSubmenuAnchorRect(element.getBoundingClientRect());
          setOpenSubmenu(focusedItem.value);
          setSubmenuIndex(focusedItem.children.some(child => !child.disabled) ? 0 : -1);
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          setFocusedIndex((prev) => {
            const next = prev + 1;
            return next >= selectableItems.length ? 0 : next;
          });
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          setFocusedIndex((prev) => {
            const next = prev - 1;
            return next < 0 ? selectableItems.length - 1 : next;
          });
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < selectableItems.length) {
            handleSelect(selectableItems[focusedIndex].value);
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          setOpen(false);
          setFocusedIndex(-1);
          break;
        }
        case 'Home': {
          e.preventDefault();
          setFocusedIndex(0);
          break;
        }
        case 'End': {
          e.preventDefault();
          setFocusedIndex(selectableItems.length - 1);
          break;
        }
      }
    },
    [open, focusedIndex, selectableItems, handleSelect, displayItems, openSubmenu, submenuIndex],
  );

  // -------------------------------------------------------------------------
  // Scroll containment — prevents wheel events from bleeding to the page over
  // ANY open menu (the menu is always viewport-bounded + scrollable now, #144).
  // At a scroll boundary (or on a menu that fits, where top==bottom) the wheel is
  // swallowed so scrolling over a menu never triggers page-level handlers (e.g.
  // keyhole zoom animations on the landing page, or the canvas pan behind it).
  // -------------------------------------------------------------------------
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atTop = el.scrollTop <= 0 && e.deltaY < 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight && e.deltaY > 0;
    if (atTop || atBottom) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, []);

  // -------------------------------------------------------------------------
  // Viewport-bound height (L063) — a menu must NEVER render taller than the
  // visible space, regardless of whether the caller opted into `scrollable`.
  // Radix exposes `--radix-popover-content-available-height` (the gap between the
  // trigger and the colliding viewport edge; avoidCollisions is on by default).
  // We cap to it ALWAYS and scroll on overflow:
  //   - no `scrollable`     → max-height = available  (was: unbounded → off-screen rows)
  //   - `scrollable: true`  → min(50vh, available)
  //   - `scrollable: '40vh'`→ min(40vh, available)
  // A menu that fits is untouched (overflow:auto only scrolls when needed); a
  // menu that would overflow the window is capped + scrolls instead of pushing
  // its last rows off-screen. Inline (not CVA) — arbitrary values + the radix var.
  // -------------------------------------------------------------------------
  const availableHeight = 'var(--radix-popover-content-available-height)';
  const explicitMax = scrollable ? (typeof scrollable === 'string' ? scrollable : '50vh') : undefined;
  const scrollStyle: React.CSSProperties = {
    maxHeight: explicitMax ? `min(${explicitMax}, ${availableHeight})` : availableHeight,
    overflowY: 'auto',
  };

  // -------------------------------------------------------------------------
  // Trigger — a positioned anchor (context-menu mode), a custom element, or the
  // default button. `anchor` wins: the popover floats at a viewport point and
  // the caller owns `open` (no visible trigger).
  // -------------------------------------------------------------------------
  const triggerContent = anchor ? (
    <Popover.Anchor virtualRef={anchorRectRef} />
  ) : customTrigger ? (
    <Popover.Trigger
      asChild
      onKeyDown={handleKeyDown}
      onPointerEnter={openOnHover ? () => { clearHoverClose(); setOpen(true); } : undefined}
      onPointerLeave={openOnHover ? scheduleHoverClose : undefined}
    >
      {customTrigger}
    </Popover.Trigger>
  ) : (
    <Popover.Trigger
      asChild
      onPointerEnter={openOnHover ? () => { clearHoverClose(); setOpen(true); } : undefined}
      onPointerLeave={openOnHover ? scheduleHoverClose : undefined}
    >
      <button
        type="button"
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1.5 bg-[var(--glass-bg-subtle)] border border-[var(--border-primary)]',
          // Fixed heights, not padding-derived: md matches the h-9 toolbar
          // family (Input, Button md, SegmentedControl) so a toolbar row of
          // [segments | search | sort] sits flush; sm matches Button sm (h-8).
          size === 'md'
            ? 'h-9 hover:bg-[var(--glass-bg-hover)] rounded-[var(--radius-control)] px-3 text-sm'
            : 'h-8 hover:bg-[var(--glass-bg-hover)] rounded-[var(--radius-control)] px-2.5 text-xs',
          'transition-colors focus:outline-none focus:ring-1 focus:ring-accent-purple/50',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          className,
        )}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span className={cn('truncate', selectedItem ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>
          {selectedItem?.label ?? placeholder}
        </span>
        <ChevronDown
          className={cn(
            'h-3 w-3 flex-shrink-0 text-[var(--text-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
    </Popover.Trigger>
  );

  return (
    // inline-flex root: the dropdown participates in its host row's flex
    // alignment — a block wrapper baseline-shifts the trigger ~4px against
    // sibling chips (the misaligned Status pill).
    <div ref={rootRef} className={label ? undefined : 'inline-flex items-center'}>
      {label && <label className="text-xs text-[var(--text-tertiary)] mb-1">{label}</label>}
      <Popover.Root open={open} onOpenChange={setOpen}>
        {triggerContent}

        {/* The WHOLE portal subtree is gated on `open` (R17 dead-clicks fix).
            Radix Presence keeps closed content mounted while it believes an
            exit animation is running — it detects that by diffing the
            content's computed animation-name at close time against the name it
            recorded at mount. When the compiled global-css record arrives
            AFTER mount, `animate-in` resolves to no animation at mount and a
            real keyframe name at close, so Presence enters unmountSuspended
            and waits for an animationend that never fires. The closed
            `data-radix-popper-content-wrapper` then lingers in the DOM at
            LAYER_ORDER.menu, INTERACTIVE, swallowing every pointer click on
            the UI beneath it (the walkthrough Next button, the timer panel,
            "Read in order" — all dead for the real user). Gating on `open`
            makes a lingering interactive wrapper structurally impossible: a
            closed dropdown renders NOTHING, regardless of what Presence's
            animation bookkeeping concluded. */}
        {open && (
        <Popover.Portal container={container ?? undefined}>
          <Popover.Content
            ref={listRef}
            side="bottom"
            align={align}
            // Clicks inside the popover are POPOVER interactions — they must
            // never bubble into the trigger's host row (row expand/collapse).
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
            onPointerEnter={openOnHover ? clearHoverClose : undefined}
            onPointerLeave={openOnHover ? scheduleHoverClose : undefined}
            onEscapeKeyDown={(event) => {
              if (openSubmenu !== null) {
                event.preventDefault();
                setOpenSubmenu(null);
                setSubmenuIndex(-1);
              }
            }}
            // The submenu flyout is PORTALED to <body> (outside this Content), so
            // a pointer-down on it reads as "outside" to Radix and would dismiss
            // the whole popover before the child row's click fires. Keep it open
            // when the interaction target is our own submenu.
            onInteractOutside={(event) => {
              // Radix exposes the real DOM target on detail.originalEvent, NOT
              // event.target (which is the Content). Without this, a pointer-down
              // on the portaled submenu dismisses the popover and unmounts the
              // submenu mid-click, so the child selection never fires.
              const target = (event.detail?.originalEvent?.target ?? null) as Element | null;
              if (target?.closest?.('[data-dropdown-submenu]')) event.preventDefault();
            }}
            sideOffset={4}
            className={cn("glass-popover p-1 min-w-[140px] flex flex-col gap-0.5 animate-in fade-in-0 zoom-in-95 bg-[var(--glass-popover-background,var(--glass-bg-active,var(--glass-bg-subtle)))] backdrop-blur-2xl backdrop-saturate-150", onIsland && 'island-surface', contentClassName)}
            style={{ ...scrollStyle, zIndex: LAYER_ORDER.menu }}
            // Shared floating-layer marker (same as AnchoredOverlay) so a host with a
            // multi-layer focus session (a rich-text editor whose Add menu portals
            // here) recognises this menu as part of the session and does not collapse
            // when focus moves into it.
            data-floating-layer=""
            role="listbox"
            aria-label={ariaLabel ?? label ?? placeholder}
            onKeyDown={handleKeyDown}
            onWheel={handleWheel}
          >
            {panel != null && (
              <div className="p-1" onPointerDown={(e) => e.stopPropagation()}>{panel}</div>
            )}
            {panel == null && header && (
              typeof header === 'string' ? (
                <div className="px-3 py-1 text-[length:var(--font-size-caption)] font-medium text-[var(--text-muted)]">
                  {header}
                </div>
              ) : (
                <div className="px-3 py-1.5">{header}</div>
              )
            )}
            {panel == null && searchable && (
              <div className="px-2 pb-1" role="search">
                <input
                  ref={searchInputRef}
                  type="search"
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.currentTarget.value)}
                  aria-label={searchLabel}
                  placeholder={searchLabel}
                  className="h-8 w-full rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--bg-surface)] px-2.5 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus,var(--accent-primary))]"
                />
              </div>
            )}
            {panel == null && displayItems.length === 0 && searchable && searchQuery.trim() && (
              <div className="px-3 py-2 text-xs text-[var(--text-muted)]" role="presentation">Nothing matches</div>
            )}
            {panel == null && displayItems.map((item, idx) => {
              const isSelected = item.value === value;
              const selectableIdx = selectableItems.indexOf(item);
              const isFocused = selectableIdx >= 0 && selectableIdx === focusedIndex;
              const anyIcon = displayItems.some((candidate) => candidate.icon);
              // Rich mode (model-picker anatomy) activates purely from data:
              // any item carrying a description or section turns on descriptions
              // + a trailing check on the selected row. No item has either =
              // the flat compact list, byte-identical to before.
              const richMode = displayItems.some((candidate) => candidate.description || candidate.section);
              // A section caption renders when this item starts a new section
              // (caller orders items by section). Non-interactive, skipped by
              // keyboard nav (it is not in selectableItems).
              const shownSection = searchable && !searchQuery.trim() ? undefined : item.section;
              const previousShownSection = idx > 0
                ? (searchable && !searchQuery.trim() ? undefined : displayItems[idx - 1]?.section)
                : undefined;
              const showSectionHeader = !!shownSection && shownSection !== previousShownSection;

              // Tinted rows (Amie anatomy): the tint colors icon + label, and
              // a soft translucent wash of the SAME color paints the hovered
              // row. color-mix keeps the wash proportional for ANY color.
              const tintStyle: React.CSSProperties | undefined = item.tint
                ? {
                    color: item.tint,
                    ...(isFocused && !item.disabled
                      ? { backgroundColor: `color-mix(in srgb, ${item.tint} 14%, transparent)` }
                      : {}),
                  }
                : undefined;

              const hasChildren = Array.isArray(item.children) && item.children.length > 0;
              const selectableChildren = item.children?.filter(child => !child.disabled) ?? [];
              const focusedChild = selectableChildren[submenuIndex];
              return (
                <React.Fragment key={item.value}>
                {showSectionHeader && (
                  <div
                    className="px-3 pt-2 pb-1 text-[length:var(--font-size-caption)] font-medium text-[var(--text-muted)]"
                    role="presentation"
                  >
                    {shownSection}
                  </div>
                )}
                <div
                  ref={element => {
                    if (element) itemElements.current.set(item.value, element);
                    else itemElements.current.delete(item.value);
                  }}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={item.disabled || undefined}
                  aria-haspopup={hasChildren || undefined}
                  aria-expanded={hasChildren ? openSubmenu === item.value : undefined}
                  data-focused={isFocused || undefined}
                  className={cn(
                    'relative flex items-center gap-2.5 px-3 py-1.5 text-xs cursor-pointer transition-colors rounded-[var(--radius-control)]',
                    !item.tint && 'hover:bg-[var(--glass-bg-hover)]',
                    isSelected ? 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                    item.disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent',
                    isFocused && !item.tint && 'bg-[var(--glass-bg-hover)]',
                  )}
                  style={tintStyle}
                  onClick={(event) => {
                    if (item.disabled) return;
                    if (hasChildren) {
                      setSubmenuIndex(-1);
                      setSubmenuAnchorRect(event.currentTarget.getBoundingClientRect());
                      setOpenSubmenu(item.value);
                    } else handleSelect(item.value);
                  }}
                  onMouseEnter={(event) => {
                    if (item.disabled) return;
                    setFocusedIndex(selectableIdx);
                    setSubmenuIndex(-1);
                    if (hasChildren) setSubmenuAnchorRect(event.currentTarget.getBoundingClientRect());
                    setOpenSubmenu(hasChildren ? item.value : null);
                  }}
                >
                  {renderItem
                    ? renderItem(item, { selected: isSelected, focused: isFocused })
                    : (
                      <>
                        {item.icon ? (
                          <NamedIcon name={item.icon} size="sm" className="shrink-0" />
                        ) : anyIcon ? (
                          <span aria-hidden className="w-3.5 shrink-0" />
                        ) : null}
                        {item.description ? (
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{item.label}</span>
                            <span className="truncate text-[length:var(--font-size-caption)] leading-tight text-[var(--text-muted)]">{item.description}</span>
                          </span>
                        ) : (
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        )}
                        {item.shortcut && (
                          <span className="ml-4 shrink-0 text-[length:var(--font-size-caption)] tracking-wide text-[var(--text-muted)]" style={item.tint ? { color: item.tint, opacity: 0.8 } : undefined}>
                            {item.shortcut}
                          </span>
                        )}
                        {hasChildren && (
                          <ChevronRight className="ml-2 h-3 w-3 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                        )}
                        {richMode && isSelected && !hasChildren && (
                          <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-accent-purple" aria-hidden="true" />
                        )}
                      </>
                    )}
                  {hasChildren && openSubmenu === item.value && submenuAnchorRect && createPortal(
                    // Nested panel (Amie ref 47 "Set priority →"): the same glass
                    // panel anchored beside the parent row. PORTALED to <body> and
                    // positioned `fixed` from the anchor rect so it escapes the
                    // popover's `overflow:auto` scroll-clip (an in-flow flyout that
                    // overruns the scroll box is clipped + un-hittable). Flips to the
                    // left when there is no room on the right (collision-aware).
                    (() => {
                    // R45: a dense submenu (e.g. "Archived (79)") must be VIEWPORT-BOUND
                    // and scrollable, exactly like the top-level content — an unbounded
                    // flyout ran off the bottom of the screen. Pin `top` so at least a
                    // usable list height remains below it, then cap maxHeight to the space
                    // that's left and scroll the overflow. Same anatomy the parent menu uses.
                    const MARGIN = 12;
                    const submenuTop = Math.min(submenuAnchorRect.top, Math.max(8, window.innerHeight - 180));
                    const submenuMaxH = window.innerHeight - submenuTop - MARGIN;
                    return (
                    <div
                      data-dropdown-submenu
                      data-floating-layer=""
                      className={cn("glass-popover fixed flex min-w-[150px] flex-col gap-0.5 rounded-[var(--radius-card)] p-1 overflow-y-auto overscroll-contain bg-[var(--glass-popover-background,var(--glass-bg-active,var(--glass-bg-subtle)))] backdrop-blur-2xl backdrop-saturate-150", onIsland && 'island-surface')}
                      style={{
                        top: submenuTop,
                        maxHeight: submenuMaxH,
                        left: submenuAnchorRect.right + 4 + 170 > window.innerWidth
                          ? Math.max(8, submenuAnchorRect.left - 4 - 170)
                          : submenuAnchorRect.right + 4,
                        zIndex: LAYER_ORDER.menu,
                      }}
                      role="listbox"
                      // React portals bubble SYNTHETIC events through the React
                      // tree, not the DOM tree — so a pointer/mouse-down here would
                      // otherwise reach an ancestor in the React tree (e.g. a
                      // freeform window's `onMouseDown` bring-to-front / drag-start)
                      // even though this panel paints on top in the DOM. Stop them
                      // so the submenu's own selection is the only effect.
                      onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
                      onMouseDown={(event: React.MouseEvent) => event.stopPropagation()}
                      onClick={(event: React.MouseEvent) => event.stopPropagation()}
                    >
                      {item.children!.map((child) => (
                        <div
                          key={child.value}
                          role="option"
                          aria-selected={child.value === value}
                          aria-disabled={child.disabled || undefined}
                          data-focused={focusedChild === child || undefined}
                          className={cn(
                            'flex items-center gap-2.5 px-3 py-1.5 text-xs cursor-pointer transition-colors rounded-[var(--radius-control)]',
                            !child.tint && 'hover:bg-[var(--glass-bg-hover)]',
                            child.value === value ? 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                            child.disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent',
                            focusedChild === child && 'bg-[var(--glass-bg-hover)]',
                          )}
                          style={child.tint ? { color: child.tint } : undefined}
                          onClick={() => {
                            if (!child.disabled) handleSelect(child.value);
                          }}
                          onMouseEnter={() => {
                            if (!child.disabled) setSubmenuIndex(selectableChildren.indexOf(child));
                          }}
                        >
                          {child.icon ? <NamedIcon name={child.icon} size="sm" className="shrink-0" /> : null}
                          <span className="min-w-0 flex-1 truncate">{child.label}</span>
                          {child.shortcut && (
                            <span className="ml-4 shrink-0 text-[length:var(--font-size-caption)] tracking-wide text-[var(--text-muted)]">
                              {child.shortcut}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    );
                    })(),
                    container ?? document.body,
                  )}
                </div>
                </React.Fragment>
              );
            })}
            {footer && (
              <div className="border-t border-[var(--border-primary)] px-1 pt-1 mt-1">{footer}</div>
            )}
            {searchable && !footer && (
              <div className="mt-1 flex items-center gap-3 border-t border-[var(--border-primary)] px-3 pt-2 text-[length:var(--font-size-caption)] text-[var(--text-muted)]" role="presentation">
                <span><kbd className="mr-1 rounded bg-[var(--glass-bg-hover)] px-1">↑</kbd><kbd className="mr-1 rounded bg-[var(--glass-bg-hover)] px-1">↓</kbd>Navigate</span>
                <span><kbd className="mr-1 rounded bg-[var(--glass-bg-hover)] px-1">↵</kbd>Select</span>
                <span><kbd className="mr-1 rounded bg-[var(--glass-bg-hover)] px-1">Esc</kbd>Close</span>
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
        )}
      </Popover.Root>
    </div>
  );
}

Dropdown.displayName = 'Dropdown';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { Dropdown };
export type { DropdownProps, DropdownItem, DropdownItemState };
