//
// Purpose:
//   One windowed vertical list for every large collection surface. Renders
//   O(visible) DOM rows no matter how many items the caller feeds it; below
//   the caller's threshold it renders the plain children path with zero
//   windowing machinery. Item shape, row markup, and keys are caller-owned —
//   this component owns only the windowing mechanics.

import React from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Container } from '../container';

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Stable identity per item — becomes the row key. */
  itemKey: (item: T, index: number) => string;
  /** Row renderer. Rows are measured after mount, so the estimate only seeds
   *  initial scroll geometry. */
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Estimated row height in px (per item — vary it for mixed row kinds). */
  estimateSize: (item: T, index: number) => number;
  /** Window only above this many items; below it, plain rows. */
  threshold: number;
  /** Where the scroll viewport lives:
   *  - 'self': this component renders its own bounded overflow-y viewport
   *    (requires maxHeight)
   *  - 'nearest': the closest overflow-y auto/scroll ancestor is the
   *    viewport (the surface already owns scrolling) */
  scrollParent: 'self' | 'nearest';
  /** Viewport height when scrollParent='self'. */
  maxHeight?: number;
  /** Extra px of gap below each windowed row (matches list gap). */
  rowGap?: number;
  /** Rows rendered beyond the visible window on each side. */
  overscan?: number;
  /** Follow an item without scrolling the page. A target inside the measured
   * row (for example the current word) may be centered instead of the row. */
  followIndex?: number;
  followKey?: string | number;
  followTarget?: string;
  followPausedRef?: React.RefObject<boolean>;
  /** Invalidate measured heights after text size or available width changes. */
  measurementKey?: string | number;
}

function nearestScrollAncestor(node: HTMLElement | null): HTMLElement | null {
  // A viewport is defined by CLIPPING, not by computed overflow alone: an
  // overflow-y:auto ancestor whose box grew to its own content height
  // (clientHeight === scrollHeight) scrolls nothing, so windowing against it
  // materializes every row. Prefer the nearest scroll-styled ancestor that
  // actually clips; fall back to the nearest scroll-styled one if none clip.
  let firstScrollStyled: HTMLElement | null = null;
  for (let parent = node?.parentElement ?? null; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
    if (parent.scrollHeight > parent.clientHeight) return parent;
    firstScrollStyled ??= parent;
  }
  return firstScrollStyled;
}

export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  estimateSize,
  threshold,
  scrollParent,
  maxHeight,
  rowGap = 0,
  overscan = 10,
  followIndex = -1,
  followKey,
  followTarget,
  followPausedRef,
  measurementKey,
}: VirtualListProps<T>) {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const [viewportRevision, setViewportRevision] = React.useState(0);
  const followedViewportRevision = React.useRef(-1);
  const followedGeometry = React.useRef<{ index: number; start?: number; size?: number } | null>(null);
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  const focusedIndex = React.useMemo(() => focusedKey === null ? -1 : items.findIndex((item, index) => itemKey(item, index) === focusedKey), [focusedKey, items, itemKey]);
  // TanStack's measurement cache keys include this callback identity. An inline
  // callback would rebuild every item's offsets on each caller playback tick.
  const getItemKey = React.useCallback((index: number) => itemKey(items[index], index), [items, itemKey]);
  const enabled = items.length > threshold;
  // In 'nearest' mode the list rarely starts at the very top of the scroll
  // element (headers/toolbars sit above it). scrollMargin tells the
  // virtualizer where item 0 actually begins inside the scroller; row
  // transforms subtract it back out because they position within the spacer.
  const [nearestMargin, setNearestMargin] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!enabled || scrollParent !== 'nearest') return;
    const anchor = anchorRef.current;
    const scroller = nearestScrollAncestor(anchor);
    if (!anchor || !scroller) return;
    const margin = anchor.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top
      + scroller.scrollTop;
    setNearestMargin((current) => (Math.abs(current - margin) > 1 ? margin : current));
  });
  const scrollMargin = scrollParent === 'nearest' ? nearestMargin : 0;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => (
      scrollParent === 'self' ? anchorRef.current : nearestScrollAncestor(anchorRef.current)
    ),
    estimateSize: (index) => {
      const item = items[index];
      return (item === undefined ? 0 : estimateSize(item, index)) + rowGap;
    },
    overscan,
    getItemKey,
    rangeExtractor: (range) => {
      const rows = defaultRangeExtractor(range);
      // Scrolling must not unmount a person's focused control.
      if (focusedIndex >= 0 && focusedIndex < items.length && !rows.includes(focusedIndex)) rows.push(focusedIndex);
      // Keep the followed row measurable while a distant seek corrects its
      // estimated position. It is still one bounded row, including tall text.
      if (!followPausedRef?.current && followIndex >= 0 && followIndex < items.length && !rows.includes(followIndex)) rows.push(followIndex);
      return rows.sort((left, right) => left - right);
    },
    enabled,
    scrollMargin,
  });

  const measureMountedRows = React.useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const selector = scrollParent === 'nearest'
      ? ':scope > [data-virtual-list-row]'
      : ':scope > [data-virtual-list-spacer] > [data-virtual-list-row]';
    // Cache invalidation must not leave mounted rows at estimated offsets
    // until the next ResizeObserver delivery. Measure only this owner's slice.
    for (const row of anchor.querySelectorAll<HTMLDivElement>(selector)) virtualizer.measureElement(row);
  }, [scrollParent, virtualizer]);

  React.useLayoutEffect(() => {
    if (enabled) { virtualizer.measure(); measureMountedRows(); }
  }, [enabled, measurementKey, virtualizer, measureMountedRows]);

  React.useLayoutEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return;
    const viewport = scrollParent === 'self' ? anchorRef.current : nearestScrollAncestor(anchorRef.current);
    if (!viewport) return;
    let geometry = '';
    const observer = new ResizeObserver(() => {
      const current = `${viewport.clientWidth}:${viewport.clientHeight}`;
      if (current === geometry) return;
      geometry = current;
      // Cached offscreen heights also depend on wrapping width, including a
      // parent resized without changing any of the caller's React props. A
      // paused followed item must be recentered after either viewport dimension
      // changes; measuring alone leaves its old scroll offset in the new layout.
      virtualizer.measure();
      measureMountedRows();
      setViewportRevision(revision => revision + 1);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [enabled, scrollParent, virtualizer, measureMountedRows]);

  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!enabled || !anchor) return;
    const focus = (event: FocusEvent) => {
      const row = (event.target as Element | null)?.closest('[data-virtual-list-row]');
      setFocusedKey(row?.getAttribute('data-virtual-list-key') ?? null);
    };
    const blur = (event: FocusEvent) => {
      if (!anchor.contains(event.relatedTarget as Node | null)) setFocusedKey(null);
    };
    anchor.addEventListener('focusin', focus);
    anchor.addEventListener('focusout', blur);
    return () => {
      anchor.removeEventListener('focusin', focus);
      anchor.removeEventListener('focusout', blur);
    };
  }, [enabled]);

  // The visible slice includes the followed row. Its measured offset can
  // change after earlier rows resize, even when caller props stay identical.
  // Read only that bounded slice, never the complete measurement cache.
  const followedItem = enabled ? virtualizer.getVirtualItems().find(row => row.index === followIndex) : undefined;
  const followedStart = followedItem?.start;
  const followedSize = followedItem?.size;

  React.useLayoutEffect(() => {
    if (followIndex < 0 || followIndex >= items.length || followPausedRef?.current) return;
    const scroller = scrollParent === 'self' ? anchorRef.current : nearestScrollAncestor(anchorRef.current);
    if (!scroller) return;
    const rowSelector = `[data-virtual-list-row][data-index="${followIndex}"]`;
    const mountedRow = anchorRef.current?.querySelector(rowSelector);
    const rowBounds = mountedRow?.getBoundingClientRect();
    const viewportBounds = scroller.getBoundingClientRect();
    const distant = !rowBounds || rowBounds.bottom < viewportBounds.top || rowBounds.top > viewportBounds.bottom;
    // A far seek first mounts the estimated row. TanStack corrects that jump as
    // actual heights arrive; centering its measured target then handles rows
    // taller than the viewport. Dynamic measurement cannot safely smooth-jump.
    if (distant && enabled) virtualizer.scrollToIndex(followIndex, { align: 'center', behavior: 'auto' });
    const centerTarget = (behavior: ScrollBehavior = 'auto') => {
      if (followPausedRef?.current) return;
      const row = anchorRef.current?.querySelector(rowSelector);
      const target = ((followTarget ? row?.querySelector(followTarget) : null) ?? row) as HTMLElement | null;
      if (!target) return;
      const bounds = target.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      const offset = scroller.scrollTop + bounds.top - viewport.top - scroller.clientTop - scroller.clientHeight / 2 + bounds.height / 2;
      // Replace the virtualizer's provisional row target with the measured
      // inner target. A raw DOM scroll leaves scrollToIndex reconciliation
      // active, which can pull a tall row's current word out of view later.
      if (enabled) virtualizer.scrollToOffset(offset, { align: 'start', behavior });
      else scroller.scrollTo({ top: offset, behavior });
    };
    const previousGeometry = followedGeometry.current;
    const measuredReflowed = previousGeometry?.index === followIndex
      && (previousGeometry.start !== followedStart || previousGeometry.size !== followedSize);
    followedGeometry.current = { index: followIndex, start: followedStart, size: followedSize };
    const reflowed = followedViewportRevision.current !== viewportRevision || measuredReflowed;
    followedViewportRevision.current = viewportRevision;
    const behavior = !distant && !reflowed && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto';
    if (mountedRow) centerTarget(behavior);
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      centerTarget(behavior);
      secondFrame = requestAnimationFrame(() => centerTarget(behavior));
    });
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); };
  }, [enabled, followIndex, followKey, followTarget, followPausedRef, items.length, measurementKey, scrollParent, viewportRevision, followedStart, followedSize, virtualizer]);

  if (!enabled) {
    if (followPausedRef || followTarget || followIndex >= 0) return (
      <Container ref={anchorRef} layout="vertical" gap="none" padding="none" width="full">
        {items.map((item, index) => <Container key={itemKey(item, index)} layout="vertical" gap="none" padding="none" width="full"
          data-virtual-list-row="true" data-index={index} data-virtual-list-key={itemKey(item, index)}
        >{renderItem(item, index)}</Container>)}
      </Container>
    );
    return (
      <>
        {items.map((item, index) => (
          <React.Fragment key={itemKey(item, index)}>{renderItem(item, index)}</React.Fragment>
        ))}
      </>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const spacer = (
    <Container
      ref={scrollParent === 'self' ? undefined : anchorRef}
      layout="vertical"
      gap="none"
      padding="none"
      position="relative"
      width="full"
      style={{ height: virtualizer.getTotalSize(), flexShrink: 0 }}
      data-virtual-list-spacer="true"
    >
      {virtualItems.map((virtualRow) => {
        const item = items[virtualRow.index];
        if (item === undefined) return null;
        return (
          <Container
            key={itemKey(item, virtualRow.index)}
            ref={virtualizer.measureElement as React.Ref<HTMLDivElement>}
            data-index={virtualRow.index}
            data-virtual-list-row="true"
            data-virtual-list-key={itemKey(item, virtualRow.index)}
            layout="vertical"
            gap="none"
            padding="none"
            width="full"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
              paddingBottom: rowGap,
            }}
          >
            {renderItem(item, virtualRow.index)}
          </Container>
        );
      })}
    </Container>
  );

  if (scrollParent === 'nearest') return spacer;
  return (
    <Container
      ref={anchorRef}
      layout="vertical"
      gap="none"
      padding="none"
      overflow="y-auto"
      minHeight="0"
      width="full"
      style={{ maxHeight }}
      data-virtual-list-viewport="true"
    >
      {spacer}
    </Container>
  );
}
