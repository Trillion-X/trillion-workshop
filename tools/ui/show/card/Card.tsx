// bitfield-studio/frontends/web/src/packages/ui/card/Card.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical Card component for the Bitfield Studio. Every card-like
// container in the application uses this component. Built on class-variance-
// authority for type-safe variant composition, consuming glassmorphism design
// system composite classes (glass-surface, glass-nested) from global.css.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL visual styling uses CSSOT design tokens via composite classes
// 2. Variant + padding + interactive composition via CVA
// 3. Forward ref for DOM access and composition with other libraries
// 4. glass-surface = primary containers, glass-nested = inner cards
// 5. ghost variant provides layout-only container (no background/border)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';
import { GLASS_POPOVER_BG_CLASS } from '../glass-tokens';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

const cardVariants = cva('', {
  variants: {
    variant: {
      /** Primary glass surface — panels, cards, main containers */
      surface: 'glass-surface',
      /** Transparent frame — token corners and hairline without adding fill, shadow or padding. */
      outline: 'glass-outline',
      /** Strong selected surface — same primitive family with stronger fill */
      solid: 'bg-[var(--glass-bg-hover)] border border-[var(--border-primary)] rounded-[var(--radius-default)]',
      /** Inner cards — sub-panels, stat blocks, nested content */
      nested: 'glass-nested',
      /** Popover/dropdown panel — high-opacity glass for readability */
      popover: 'glass-popover border border-[var(--border-primary)] ' + GLASS_POPOVER_BG_CLASS + ' shadow-2xl backdrop-blur-2xl rounded-[var(--radius-default)]',
      /** Tooltip — a small popover of the worn look: its popover surface, ink and font (screen-look surfaces.css
       *  `.floating-tooltip`) */
      tooltip: 'floating-tooltip',
      /** SOLID opaque panel — for floating editors that overlay UNPREDICTABLE
       *  user content (board images/video, bright canvases). Glass surfaces are
       *  8% fills that depend on backdrop-blur and read as see-through over
       *  bright content; this variant is a fully-opaque token fill so the panel
       *  is always readable regardless of what is behind it. */
      panel: 'bg-[var(--black-rich)] border border-[var(--border-primary)] rounded-[var(--radius-default)] shadow-2xl',
      /** Layout-only container — no background, no border */
      ghost: 'rounded-[var(--radius-default)]',
      /** Accent-tinted card — purple highlight callouts */
      accent: 'bg-accent-purple/10 border border-accent-purple/20 rounded-[var(--radius-default)]',
      /** Chat message bubble — solid neutral fill, NO border (reference:
          ChatGPT user pill — #303030-class solid surface, authorship carried
          by alignment + fill, never an outline ring) */
      bubble: 'bg-[var(--glass-bg-hover)] rounded-[var(--radius-card)]',
      /** Error-tinted card — error state callouts, warning containers */
      error: 'bg-status-error/10 border border-status-error/20 rounded-[var(--radius-default)]',
    },
    padding: {
      none: '',
      xs: 'p-2',
      sm: 'p-3',
      md: 'p-4',
      lg: 'p-6',
    },
    layout: {
      /** Vertical stack with gap — for card bodies with multiple children */
      stack: 'flex flex-col gap-4',
      /** Vertical column, no gap — for panels where children control own spacing */
      column: 'flex flex-col',
      /** Horizontal row — for headers, toolbars, inline items */
      row: 'flex flex-row items-center gap-3',
      /** No layout — children flow naturally (default) */
      none: '',
    },
    /** flex-1: card participates in parent flex layout and grows to fill space */
    flex: {
      1: 'flex-1',
      none: '',
    },
    /** min-h-0: allow card to shrink below content height (required for flex children with overflow) */
    minHeight: {
      '0': 'min-h-0',
    },
    /** min-w-0 + w-full: card never grows wider than its parent — required on
     *  any card whose children scroll horizontally (kanban rails, wide
     *  tables). Flex/grid children default to min-width:auto, so without
     *  this the wide child stretches the card and the page instead of
     *  scrolling inside its own rail. */
    minWidth: {
      '0': 'min-w-0 w-full max-w-full',
    },
    interactive: {
      true: 'cursor-pointer transition-colors hover:bg-[var(--glass-bg-subtle)]',
      false: '',
    },
    borderless: {
      true: 'border-0',
      false: '',
    },
    /** selected: adds accent ring — for canvas nodes, list items, and any selectable card */
    selected: {
      true: 'ring-1 ring-accent-purple/60',
      false: '',
    },
    /** height: fill parent height — for cards inside fixed-size containers */
    height: {
      full: 'h-full',
      auto: '',
    },
    /** radius: corner-radius override — `pill` for chat-style message bubbles (24px, reference: ChatGPT user pill) */
    radius: {
      default: '',
      pill: 'rounded-3xl',
      /** The large design-token radius (`--radius-lg`) — for floating editor/toolbar panels
       *  that want the token radius rather than Tailwind's fixed `rounded-lg`. */
      lg: 'rounded-[var(--radius-lg)]',
    },
  },
  defaultVariants: {
    variant: 'surface',
    padding: 'md',
    layout: 'none',
    interactive: false,
    borderless: false,
    selected: false,
    height: 'auto',
    radius: 'default',
  },
});

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

interface CardProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof cardVariants> {
  as?: React.ElementType;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Canonical card container for the Bitfield Studio.
 *
 * Visual variants map directly to the glassmorphism design system:
 * - `surface` — primary glass container (blur, border, shadow)
 * - `nested` — inner card for sub-content (subtle bg, border)
 * - `popover` — high-opacity glass for dropdown/popover panels (bg-black/85)
 * - `ghost` — layout-only (rounded corners, no visual chrome)
 *
 * @example
 * ```tsx
 * <Card variant="surface" padding="lg">Main panel content</Card>
 * <Card variant="nested" padding="sm">Stat block</Card>
 * <Card variant="ghost" interactive onClick={handleClick}>Clickable row</Card>
 * ```
 */
const Card = React.forwardRef<HTMLElement, CardProps>(
  ({ as: Component = 'div', className, variant, padding, layout, flex, minHeight, minWidth, interactive, borderless, selected, height, radius, ...props }, ref) => {
    // Filter out layout-control props that are not valid DOM attributes.
    // These are CVA variant props — they've already been consumed to build the className.
    // Spreading them onto the DOM element causes React warnings about non-standard HTML attributes.
    const { alignItems, justifyContent, gap, padding: _padding, ...domProps } = props as any;

    return (
      <Component
        ref={ref}
        className={cn(cardVariants({ variant, padding, layout, flex, minHeight, minWidth, interactive, borderless, selected, height, radius }), className)}
        {...domProps}
      />
    );
  }
);

Card.displayName = 'Card';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { Card, cardVariants };
export type { CardProps };
