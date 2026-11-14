// bitfield-studio/frontends/web/src/packages/ui/container/container.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic container component for layout — enables flex/grid wrapping,
// scrolling, and spacing without raw divs. Replaces all className="flex",
// className="overflow-y-auto", etc. throughout feature code.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. NO className or inline styles — props only
// 2. Layout modes: flex (row/col), grid, scroll (auto overflow)
// 3. All spacing through props, not className
// 4. Supports ref forwarding for DOM access (scroll events, etc.)
//
// =============================================================================

import React, { forwardRef, useCallback, useState } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';
import { useScrollFade, type ScrollFadeEdge } from '../scrollable-surface/scroll-fade';

const SCROLL_FADE_EDGES: Record<string, readonly ScrollFadeEdge[]> = {
  auto: ['top', 'right', 'bottom', 'left'],
  'x-auto': ['right', 'left'],
  'y-auto': ['top', 'bottom'],
};

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

export const containerVariants = cva('', {
  variants: {
    layout: {
      /** Horizontal flex layout (flex-row) */
      horizontal: 'flex flex-row',
      /** Vertical flex layout (flex-col) */
      vertical: 'flex flex-col',
      /** Grid layout */
      grid: 'grid',
      /** Master-detail split: stacks vertically on narrow viewports, side-by-side from the `sm` breakpoint up */
      'responsive-split': 'flex flex-col sm:flex-row',
      /** Plain block flow: words and inline pieces run on one line as text does (an editable's words, never flex items) */
      flow: 'block',
    },
    gap: {
      none: '',
      xs: 'gap-1',
      sm: 'gap-2',
      md: 'gap-3',
      lg: 'gap-4',
      xl: 'gap-6',
    },
    padding: {
      none: '',
      xs: 'p-1',
      sm: 'p-2',
      md: 'p-3',
      lg: 'p-4',
      xl: 'p-6',
    },
    overflow: {
      visible: 'overflow-visible',
      hidden: 'overflow-hidden',
      auto: 'overflow-auto',
      'y-auto': 'overflow-y-auto',
      'x-auto': 'overflow-x-auto',
    },
    flex: {
      1: 'flex-1',
      none: '',
    },
    wrap: {
      wrap: 'flex-wrap',
      true: 'flex-wrap',
      false: '',
    },
    height: {
      full: 'h-full',
      auto: 'h-auto',
    },
    minHeight: {
      '0': 'min-h-0',
      'auto': 'min-h-auto',
    },
    width: {
      full: 'w-full',
      auto: 'w-auto',
    },
    alignItems: {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch',
    },
    justifyContent: {
      start: 'justify-start',
      center: 'justify-center',
      end: 'justify-end',
      between: 'justify-between',
      stretch: 'justify-stretch',
    },
    maxWidth: {
      none: '',
      sm: 'max-w-sm',
      md: 'max-w-md',
      lg: 'max-w-lg',
      xl: 'max-w-xl',
      '2xl': 'max-w-2xl',
      '3xl': 'max-w-3xl',
      '4xl': 'max-w-4xl',
      '5xl': 'max-w-5xl',
      '6xl': 'max-w-6xl',
      '7xl': 'max-w-7xl',
      prose: 'max-w-prose',
      full: 'max-w-full',
    },
    border: {
      none: '',
      bottom: 'border-b border-[var(--border-primary)]',
      right: 'border-r border-[var(--border-primary)]',
      top: 'border-t border-[var(--border-primary)]',
      all: 'border border-[var(--border-primary)]',
      /** A quotation set apart as a quiet tinted block (words someone selected, a passage quoted); never a bar down its edge */
      quote: 'rounded-[var(--radius-control)] bg-[var(--glass-bg-subtle)] px-3 py-2',
    },
    position: {
      static: 'static',
      absolute: 'absolute',
      relative: 'relative',
      fixed: 'fixed',
      sticky: 'sticky',
    },
    inset: {
      none: '',
      '0': 'inset-0',
      '2': 'inset-2',
      'tr-2': 'top-2 right-2',
      /** Anchored popover below an inline anchor (composer autocomplete). */
      'below-left': 'top-full left-0 mt-1',
      /** Sticky footer pinned to the bottom of a scroll container. */
      'bottom-0': 'bottom-0',
    },
    zIndex: {
      'none': '',
      '10': 'z-10',
      '20': 'z-20',
      '40': 'z-40',
      '50': 'z-50',
    },
    pointerEvents: {
      auto: 'pointer-events-auto',
      none: 'pointer-events-none',
    },
    /** background: applies design system composite background class */
    background: {
      none: '',
      overlay: 'glass-overlay',
      /** Surface stack steps — the token-backed way to paint panel backgrounds
       *  without feature-code className (L065). */
      primary: 'bg-[var(--surface-primary)]',
      secondary: 'bg-[var(--surface-secondary)]',
      tertiary: 'bg-[var(--surface-tertiary)]',
      /** The island: a small surface floating over other apps, dark in every look (surfaces.css .glass-island). */
      island: 'glass-island',
    },
    /** rounded: token radius steps for panel/card corners */
    rounded: {
      none: '',
      md: 'rounded-md',
      lg: 'rounded-lg',
    },
    /** transition: applies transition preset for animated containers */
    transition: {
      none: '',
      all: 'transition-all duration-150',
    },
    /** marginX: horizontal margin — `auto` centers a max-width column (reading-column layouts) */
    marginX: {
      none: '',
      auto: 'mx-auto',
    },
    /** indent: how far a row sits in under the row above it, one level a step (a tree drawn a row at a time) */
    indent: {
      0: '',
      1: 'ms-5',
      2: 'ms-10',
      3: 'ms-15',
      4: 'ms-20',
    },
    gridCols: {
      1: 'grid-cols-1',
      2: 'grid-cols-2',
      3: 'grid-cols-3',
      4: 'grid-cols-4',
      auto: 'grid-cols-auto',
      /** Dense responsive catalog grid — as many ~280px tiles as fit the width; narrower than one tile, one column
       *  as wide as the grid (never wider, so a narrow pane never cuts a tile off) */
      'auto-fill-xs': 'grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))]',
      'auto-fill-sm': 'grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]',
      /** 30% / 70% two-column split for sidebar + main layouts */
      '3-7': 'grid-cols-[3fr_7fr]',
    },
  },
  defaultVariants: {
    layout: 'vertical',
    gap: 'md',
    padding: 'none',
    overflow: 'visible',
    flex: 'none',
    wrap: false,
    height: 'auto',
    width: 'auto',
    alignItems: 'stretch',
    justifyContent: 'start',
    maxWidth: 'none',
    gridCols: undefined,
    border: 'none',
    position: 'static',
    inset: 'none',
    zIndex: 'none',
    marginX: 'none',
    indent: 0,
    rounded: 'none',
  },
});

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

type ContainerVariantProps = VariantProps<typeof containerVariants>;

export type ContainerProps<T extends React.ElementType = 'div'> = {
  as?: T;
  className?: string;
  flex?: ContainerVariantProps['flex'] | '1';
  gridCols?: ContainerVariantProps['gridCols'] | number;
  wrap?: ContainerVariantProps['wrap'] | 'wrap';
  gridColumns?: number;
  gridColumnSpan?: number | 'full';
  minHeight?: string;
  /** maxHeight: passed directly to style.maxHeight — accepts any CSS length value */
  maxHeight?: string;
  /** minWidth: passed directly to style.minWidth — accepts any CSS length value.
   *  Style-backed (not a utility class) because the compiled stylesheet has no
   *  JIT for arbitrary widths. Enables fixed-width lanes in horizontal rails. */
  minWidth?: string;
  /** heightPx: an EXACT height (any CSS length, e.g. "460px"). Style-backed, the
   *  sibling of the arbitrary `width` string — the `height` VARIANT prop only covers
   *  auto/full/screen, so a computed pixel height (e.g. an aspect-ratio canvas frame)
   *  goes here. */
  heightPx?: string;
  /** cursor: interaction affordance (any CSS cursor keyword, e.g. "ew-resize",
   *  "pointer", "wait"). Style-backed so it works whether or not the compiled
   *  sheet includes the utility class. A Physics-level interaction prop, the
   *  sibling of `pointerEvents`. Use this instead of a raw `style` in feature code. */
  cursor?: string;
  /** touchAction: pointer-gesture policy (any CSS touch-action value, e.g. "none"
   *  so a custom pointer drag owns the gesture). Style-backed. Pairs with a
   *  `cursor` scrub affordance plus pointer handlers for a drag surface. */
  touchAction?: string;
  /** clearsDockedEdges: keep clear of whatever is docked to the edges of the
   *  surface this sits in. A docked rail overlays its container and publishes
   *  the space it takes as `--stage-inset-<edge>`; content that sets this moves
   *  out of that space instead of sitting underneath the rail. */
  clearsDockedEdges?: boolean;
  /** left/top: absolute offset (any CSS length/percent, e.g. "42%", "12px").
   *  Style-backed positioning primitives — pair with `position="absolute"` +
   *  `transform` to place a child freely on the X/Y plane (e.g. a draggable
   *  caption anchored anywhere over a preview). Physics-level, no corner enum. */
  left?: string;
  top?: string;
  /** transform: any CSS transform (e.g. "translate(-50%,-50%)"). Style-backed so
   *  a freeform-positioned element can self-offset by its own size, matching a
   *  normalized {x,y} anchor exactly. */
  transform?: string;
  position?: string;
  inset?: string;
  zIndex?: string;
  pointerEvents?: 'auto' | 'none';
} & Omit<ContainerVariantProps, 'flex' | 'gridCols' | 'wrap'>
  & Omit<React.ComponentPropsWithoutRef<T>, 'as'>;

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

const ContainerBase = forwardRef<HTMLDivElement, ContainerProps>(
  (
    {
      as: Component = 'div',
      className,
      layout,
      gap,
      padding,
      overflow,
      flex,
      wrap,
      height,
      minHeight,
      maxHeight,
      minWidth,
      heightPx,
      cursor,
      touchAction,
      clearsDockedEdges,
      left,
      top,
      transform,
      width,
      alignItems,
      justifyContent,
      maxWidth,
      gridCols,
      gridColumns,
      gridColumnSpan,
      border,
      position,
      inset,
      zIndex,
      pointerEvents,
      background,
      rounded,
      transition,
      marginX,
      indent,
      ...rest
    },
    ref,
  ) => {
    const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null);
    const edges = SCROLL_FADE_EDGES[overflow ?? ''] ?? [];
    const setNode = useCallback((node: HTMLDivElement | null) => {
      setScrollNode(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    }, [ref]);
    useScrollFade(scrollNode, edges);

    // Extract any remaining props, explicitly destructuring away variant-like keys
    // that might be passed but were already handled above. Only pass true DOM props.
    const { minHeight: minHeightProp, position: positionProp, inset: insetProp, zIndex: zIndexProp, pointerEvents: pointerEventsProp, style, ...domProps } = rest as any;
    const resolvedGridColumns = gridColumns ?? (typeof gridCols === 'number' ? gridCols : undefined);
    const resolvedGridColsVariant = typeof gridCols === 'number' ? undefined : gridCols;
    const resolvedFlex = flex === '1' ? 1 : flex;
    const resolvedStyle: React.CSSProperties = { ...style };

    if (maxHeight) {
      resolvedStyle.maxHeight = maxHeight;
    }
    // minHeight beyond the tokenized 0/auto variants (e.g. "7rem") is style-backed,
    // same rationale as minWidth: no JIT for arbitrary lengths in the compiled sheet.
    if (minHeight && minHeight !== '0' && minHeight !== 'auto') {
      resolvedStyle.minHeight = minHeight;
    }
    if (minWidth) {
      resolvedStyle.minWidth = minWidth;
    }
    if (heightPx) {
      resolvedStyle.height = heightPx;
    }
    if (cursor) {
      resolvedStyle.cursor = cursor;
    }
    if (touchAction) {
      resolvedStyle.touchAction = touchAction;
    }
    if (clearsDockedEdges) {
      resolvedStyle.marginLeft = 'var(--stage-inset-left, 0px)';
      resolvedStyle.marginRight = 'var(--stage-inset-right, 0px)';
      resolvedStyle.marginTop = 'var(--stage-inset-top, 0px)';
      resolvedStyle.marginBottom = 'var(--stage-inset-bottom, 0px)';
      resolvedStyle.transition = 'margin var(--stage-inset-transition, 0s)';
    }
    if (left !== undefined) {
      resolvedStyle.left = left;
    }
    if (top !== undefined) {
      resolvedStyle.top = top;
    }
    if (transform !== undefined) {
      resolvedStyle.transform = transform;
    }

    if (layout === 'grid') {
      resolvedStyle.display = 'grid';
      if (typeof resolvedGridColumns === 'number') {
        resolvedStyle.gridTemplateColumns = `repeat(${resolvedGridColumns}, minmax(0, 1fr))`;
      }
    }
    if (width === 'full') {
      resolvedStyle.width = '100%';
    } else if (typeof width === 'string' && width !== 'auto') {
      // Arbitrary width (e.g. "25.9%", "320px") is style-backed, same rationale as
      // minWidth/maxHeight: the compiled stylesheet has no JIT for arbitrary widths,
      // so a percentage/px width passed here becomes inline style, not a dropped CVA
      // variant. Enables proportional timeline clip widths.
      resolvedStyle.width = width;
    }
    if (typeof gridColumnSpan === 'number') {
      resolvedStyle.gridColumn = `span ${gridColumnSpan} / span ${gridColumnSpan}`;
    } else if (gridColumnSpan === 'full') {
      resolvedStyle.gridColumn = '1 / -1';
    }

    return (
      <Component
        ref={setNode}
        style={resolvedStyle}
        className={cn(
          containerVariants({
            layout,
            gap,
            padding,
            overflow,
            flex: resolvedFlex,
            wrap,
            height,
            minHeight,
            width,
            alignItems,
            justifyContent,
            maxWidth,
            gridCols: resolvedGridColsVariant,
            border,
            position,
            inset,
            zIndex,
            pointerEvents,
            background,
            rounded,
            transition,
            marginX,
            indent,
          }),
          className,
        )}
        {...domProps}
      />
    );
  },
);

ContainerBase.displayName = 'Container';

export const Container = ContainerBase as <T extends React.ElementType = 'div'>(
  props: ContainerProps<T> & { ref?: React.Ref<HTMLDivElement> },
) => React.ReactElement | null;
