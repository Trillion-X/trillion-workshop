import * as React from 'react';
import { Button } from '../button';
import { cn } from '../cn';

export interface ExpandableRegionProps {
  children: React.ReactNode;
  /** Starting visible height in pixels. */
  initialHeight?: number;
  /** Smallest height the person can drag to. */
  minHeight?: number;
  /** Largest height the person can drag to before using Show more. */
  maxHeight?: number;
  moreLabel?: string;
  lessLabel?: string | null;
  className?: string;
}

/** A scrollable region with a draggable height limit and an unbounded disclosure. */
export function ExpandableRegion({
  children,
  initialHeight = 240,
  minHeight = 96,
  maxHeight = 480,
  moreLabel = 'Show more',
  lessLabel = 'Show less',
  className,
}: ExpandableRegionProps): React.ReactElement {
  const contentId = React.useId();
  const lower = Math.max(0, minHeight);
  const upper = Math.max(lower, maxHeight);
  const viewport = React.useRef<HTMLDivElement>(null);
  const content = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(() => Math.max(lower, Math.min(upper, initialHeight)));
  const [expanded, setExpanded] = React.useState(false);
  const [overflowing, setOverflowing] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const drag = React.useRef<{ y: number; height: number } | null>(null);
  const heightRef = React.useRef(height);
  heightRef.current = height;

  React.useEffect(() => {
    const viewportElement = viewport.current;
    const contentElement = content.current;
    if (!viewportElement || !contentElement || typeof ResizeObserver === 'undefined') return;
    const measure = () => setOverflowing(viewportElement.scrollHeight > viewportElement.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(viewportElement);
    observer.observe(contentElement);
    measure();
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      const next = Math.max(lower, Math.min(upper, start.height + event.clientY - start.y));
      heightRef.current = next;
      setHeight(next);
    };
    const end = () => {
      drag.current = null;
      setDragging(false);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
  }, [dragging, lower, upper]);

  const resizeTo = (next: number) => {
    const bounded = Math.max(lower, Math.min(upper, next));
    heightRef.current = bounded;
    setHeight(bounded);
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (expanded) return;
    event.preventDefault();
    drag.current = { y: event.clientY, height: heightRef.current };
    setDragging(true);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className={cn('min-w-0', className)} data-expandable-region>
      <div
        ref={viewport}
        id={contentId}
        className="min-w-0 overflow-y-auto overscroll-contain"
        style={{ maxHeight: expanded ? undefined : height }}
        data-expandable-region-viewport
      >
        <div ref={content}>{children}</div>
      </div>
      {overflowing || expanded ? (
        <div className="flex items-center justify-between gap-2 pt-1">
          {expanded ? (lessLabel ? <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded(false)}>{lessLabel}</Button> : null) : (
            <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded(true)} aria-controls={contentId} aria-expanded={false}>{moreLabel}</Button>
          )}
          {!expanded ? (
            <div
              role="separator"
              aria-label="Resize visible content"
              aria-orientation="horizontal"
        aria-valuemin={lower}
        aria-valuemax={upper}
              aria-valuenow={height}
              tabIndex={0}
              className="group flex h-5 min-w-8 flex-1 cursor-ns-resize touch-none items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
              onPointerDown={beginResize}
              onKeyDown={event => {
                if (event.key === 'ArrowUp') { event.preventDefault(); resizeTo(height + 16); }
                else if (event.key === 'ArrowDown') { event.preventDefault(); resizeTo(height - 16); }
                else if (event.key === 'Home') { event.preventDefault(); resizeTo(lower); }
                else if (event.key === 'End') { event.preventDefault(); resizeTo(upper); }
              }}
              data-resizing={dragging || undefined}
              title="Drag to change the visible height"
            >
              <span aria-hidden className="h-0.5 w-8 rounded-full bg-[var(--border-primary)] transition-colors group-hover:bg-[var(--text-tertiary)] group-focus-visible:bg-[var(--text-tertiary)]" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
