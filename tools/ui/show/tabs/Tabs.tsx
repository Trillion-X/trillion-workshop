// frontends/web/src/packages/ui/tabs/Tabs.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical compound Tabs component for the Bitfield Studio. Provides
// accessible tabbed navigation with context-driven active state management.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Compound component pattern — Tabs, TabsList, TabsTrigger, TabsContent
// 2. Active tab state shared via React Context (single source of truth)
// 3. Base UI owns linked tab/panel identities, focus and keyboard navigation.
// 4. Design tokens: accent-purple active indicator, white/10 borders, white/40 inactive text
// 5. TabsContent renders null when inactive by default. Explicit keepMounted
//    preserves caller state while hidden panels stay outside focus and layout.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { createContext, useContext } from 'react';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn } from '../cn';
import { ActionMenu, type ActionMenuItem } from '../action-menu/ActionMenu';

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('Tabs compound components must be used within <Tabs>');
  }
  return ctx;
}

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

export interface TabsProps {
  /** Currently active tab value */
  value: string;
  /** Called when tab changes */
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

export interface TabsListProps {
  children: React.ReactNode;
  className?: string;
  /** Name of the menu that lists every tab when they do not all fit (it appears only then). */
  moreLabel?: string;
  /** The menu's open state, for a caller that opens it with a key; omit to let the list keep it. */
  moreOpen?: boolean;
  onMoreOpenChange?: (open: boolean) => void;
  /** When true, removes the bottom border (for embedding in containers with their own borders) */
  borderless?: boolean;
}

export interface TabsTriggerProps extends Omit<React.ComponentPropsWithoutRef<'button'>, 'value' | 'children' | 'className' | 'disabled'> {
  /** Value identifier for this tab */
  value: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

export interface TabsContentProps {
  /** Value identifier — content shown when this matches active tab */
  value: string;
  children: React.ReactNode;
  className?: string;
  /** Preserve local drafts and pending work when another panel is active. */
  keepMounted?: boolean;
}

// -----------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------

/**
 * Root container. Provides active tab context to all descendants.
 */
export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={cn('flex flex-col', className)}>
        {children}
      </TabsPrimitive.Root>
    </TabsContext.Provider>
  );
}

/**
 * Horizontal tab bar. Wraps TabsTrigger buttons. When they do not all fit it scrolls, fades the edge that has more beyond
 * it, keeps the chosen tab in view, and offers a menu of every tab (the menu is read from the tabs themselves, so a bar
 * of any tabs gets it).
 */
export function TabsList({ children, className, borderless = false, moreLabel = 'More tabs', moreOpen, onMoreOpenChange }: TabsListProps) {
  const { value } = useTabsContext();
  const scroller = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ start: false, end: false });
  const [ownOpen, setOwnOpen] = React.useState(false);
  const [rows, setRows] = React.useState<ActionMenuItem[]>([]);
  const open = moreOpen ?? ownOpen;
  const measure = React.useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const start = node.scrollLeft > 1, end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setEdges(current => (current.start === start && current.end === end ? current : { start, end }));
  }, []);
  React.useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    if (node.firstElementChild) watch.observe(node.firstElementChild);
    return () => watch.disconnect();
  }, [measure, children]);
  React.useEffect(() => {
    scroller.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  React.useEffect(() => {
    const tabs = [...(scroller.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    setRows(tabs.map((tab, index) => ({ id: String(index), label: tab.textContent?.trim() ?? '', icon: { glyph: <span className="size-1.5 rounded-full bg-current opacity-50" /> }, checked: tab.getAttribute('aria-selected') === 'true' })));
  }, [open, value, children, edges.start, edges.end]);
  const fade = edges.start && edges.end ? '[mask-image:linear-gradient(to_right,transparent,#000_1.25rem,#000_calc(100%-1.25rem),transparent)]'
    : edges.start ? '[mask-image:linear-gradient(to_right,transparent,#000_1.25rem)]'
      : edges.end ? '[mask-image:linear-gradient(to_left,transparent,#000_1.25rem)]' : '';
  return (
    <div className="flex min-w-0 items-center gap-1" data-tabs-list-frame>
      <div ref={scroller} onScroll={measure} className={cn('min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', fade)}>
        <TabsPrimitive.List
          activateOnFocus
          className={cn(
            'flex w-max min-w-full items-center gap-1',
            !borderless && 'border-b border-[var(--border-primary)] pb-px',
            className,
          )}
        >
          {children}
        </TabsPrimitive.List>
      </div>
      {edges.start || edges.end || open ? <ActionMenu label={moreLabel} items={rows} align="end" modal={false} open={open}
        onOpenChange={next => { setOwnOpen(next); onMoreOpenChange?.(next); }}
        onAction={id => { scroller.current?.querySelectorAll<HTMLElement>('[role="tab"]')[Number(id)]?.click(); }} /> : null}
    </div>
  );
}

/**
 * Individual tab button. Reads active state from context.
 */
export function TabsTrigger({
  value,
  children,
  className,
  disabled = false,
  ...rest
}: TabsTriggerProps) {
  const { value: activeValue } = useTabsContext();
  const isActive = value === activeValue;

  return (
    <TabsPrimitive.Tab
      {...rest}
      value={value}
      disabled={disabled}
      className={cn(
        'text-xs px-3 py-1.5 transition-colors focus:outline-none focus:ring-1 focus:ring-accent-purple',
        isActive
          ? 'text-[var(--text-primary)] border-b-2 border-accent-purple'
          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
        disabled && 'opacity-40 cursor-not-allowed',
        className,
      )}
    >
      {children}
    </TabsPrimitive.Tab>
  );
}

/**
 * Tab panel. Inactive content is omitted unless the caller needs state preserved.
 */
export function TabsContent({ value, children, className, keepMounted = false }: TabsContentProps) {
  return (
    <TabsPrimitive.Panel value={value} keepMounted={keepMounted} className={className}>
      {children}
    </TabsPrimitive.Panel>
  );
}
