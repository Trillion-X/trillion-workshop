// bitfield-studio/frontends/web/src/packages/ui/button/Button.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical Button component for Bitfield Studio. Every button
// in the application uses this component. Built on class-variance-authority for
// type-safe variant composition, with glassmorphism design system tokens.
//
// Consumer files MUST NOT pass styling classes (bg-*, text-*, border-*) via
// className. All visual states are handled through variant, size, and active
// props. className is ONLY for layout (flex, gap, w-*, h-*, absolute, etc.).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL colors use CSSOT design tokens (status-*, accent-*, glass-*, bdr-*)
// 2. Variant + size composition via CVA — no manual class string building
// 3. Loading state disables interaction and shows accessible spinner. A press whose handler returns a promise is the
//    button's work, said in the button itself (./press-work.tsx): pending, then a check or a mark, then its label
// 4. Mobile a11y: 44px min touch target on small screens, natural height on desktop
// 5. Forward ref for DOM access and composition with other libraries
// 6. Active/pressed state via `active` prop — consumer NEVER styles active state
// 7. Labeled icon buttons expose their label on hover and keyboard focus
// 8. Consumer className is for LAYOUT ONLY — never bg-*, text-*, border-*
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
import { PressWorkFace, usePressWork, type ButtonWork } from './press-work';
import { InsideTooltipContext, Tooltip } from '../tooltip/Tooltip';
import {
  controlTargetAttributes,
  controlTargetClass,
  type ControlTargetRole,
} from '../control-target';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

const buttonVariants = cva(
  // Base: shared across all variants. Mobile touch target + keyboard focus ring. The press shrink, the primary fill's
  // light top edge and soft drop, and the default corner are the look's button tokens (screen-look's
  // resolveScreenLookPalette: --button-pressed-scale, --button-highlight, --button-shadow, --button-pressed-highlight,
  // --radius-control), the same values the extension and the iPhone apps read.
  // The face is the look's sheen as a background-image over the fill (bg-[image:var(--button-sheen)]) and Tailwind's
  // shadow (shadow-[...]) for its edge, top line and drop, never a raw box-shadow. The keyboard focus mark is an outline
  // 2px outside the face (solid named outright: outline-hidden sets the outline style to none, which outline-2 would
  // otherwise keep), so it never touches the face: a ring drawn in box-shadow sat on the edge and read as a thicker
  // border, and a raw box-shadow was replaced by the ring, which left every autofocused button (a tour's first step) flat.
  // `whitespace-nowrap` (R47): a button label is a single action name and must never
  // wrap — under width pressure (a crowded bulk-select bar, a squeezed toolbar row) a
  // wrapping label spills its text past the pill's rounded bounds ("text bleeding out of
  // their buttons"). Nowrap keeps every label on one line; a too-narrow container reflows
  // via its own overflow/collapse logic instead of breaking the button's text.
  // A button keeps its raised face in every state: at work, and disabled for any reason, when it is only dimmed. A flat
  // face reads as a broken button, so no state removes the sheen or the drop.
  // A press at work is drawn from its state, over any variant: pending keeps full strength (it is not unavailable), done
  // fills with the look's good colour, failed reads in its danger colour.
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background-color,color,scale] motion-reduce:transition-none active:scale-[var(--button-pressed-scale)] cursor-pointer outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring-color)] disabled:opacity-40 disabled:cursor-not-allowed data-[work=pending]:cursor-progress data-[work=pending]:disabled:opacity-100 data-[work=done]:bg-status-success data-[work=done]:text-white data-[work=done]:shadow-none data-[work=error]:text-status-error [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'font-semibold bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] bg-[image:var(--button-sheen)] shadow-[var(--button-highlight),var(--button-shadow)] active:shadow-[var(--button-pressed-highlight)]',
        secondary: 'bg-[var(--glass-bg-subtle)] text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
        ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
        plain: 'bg-transparent text-[var(--text-secondary)] hover:bg-transparent hover:text-[var(--text-primary)]',
        chevron: 'bg-[var(--glass-bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]',
        outline: 'border border-[var(--border-primary)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
        /** Destructive: the look's danger colour in the words and edge on a neutral face, never a fill, so it can never
         *  be mistaken for the strong action, which wears the look's accent (one-look-rules `destructive-is-never-a-fill`). */
        danger: 'border border-status-error/40 bg-transparent text-status-error font-semibold hover:bg-status-error/10',
        accent: 'bg-accent-purple/20 text-accent-purple hover:bg-accent-purple/30',
        solid: 'font-semibold bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] bg-[image:var(--button-sheen)] shadow-[var(--button-highlight),var(--button-shadow)] active:shadow-[var(--button-pressed-highlight)]',
        success: 'bg-status-success/20 text-status-success hover:bg-status-success/30',
        /** Quiet confirm: neutral at rest, success hue on hover (the close X's
         *  danger-hover pattern with the success hue). */
        confirm: 'text-[var(--text-secondary)] hover:bg-status-success/15 hover:text-status-success',
      },
      size: {
        xs: 'h-6 px-2 text-[length:var(--font-size-caption)]',
        sm: 'h-7 px-2 text-[length:var(--font-size-label)]',
        md: 'h-9 px-4 text-[length:var(--font-size-body)]',
        lg: 'h-11 px-6 text-[length:var(--font-size-body-lg)]',
        icon: 'h-7 w-7 p-0',
        /** Square micro icon button matched to row checkboxes/rings (18px)
         *  — inline row affordances (expand chevrons) that must not
         *  outweigh their sibling controls. */
        'icon-xs': 'h-[18px] w-[18px] p-0',
        nav: 'h-9 w-full gap-3 px-3 min-h-0 text-[length:var(--font-size-body)] justify-start text-start',
        /** Menu/option row inside popovers: full-width, LEFT-aligned (a
         *  centered menu row reads as a button, not an option). */
        menu: 'h-7 w-full gap-2 px-2 min-h-0 text-[length:var(--font-size-label)] justify-start text-start',
        /** Result/list row inside a scrollable column (command palette,
         *  search results): full-width, LEFT-aligned, TOP-aligned, and
         *  AUTO-HEIGHT so a 2-line title+description establishes real height.
         *  `shrink-0` is load-bearing — in a `flex-col` scroll container the
         *  base `sm:min-h-0` otherwise lets flex collapse every row to 0px,
         *  overlapping the rows. `min-h-11` keeps a single-line row tappable. */
        'option-row': 'w-full shrink-0 min-h-11 h-auto gap-2 px-3 py-2 items-start justify-start text-start text-[length:var(--font-size-body)]',
      },
      radius: {
        md: 'rounded-[var(--radius-control)]',
        /** Pill — fully rounded. The primary-action anatomy of calm/wellness
         *  hero cards (Calm "Start Practicing", Headspace "Play", Open "Begin →",
         *  Hers "Get started"): a large, high-contrast, fully-rounded CTA. */
        full: 'rounded-full',
        inherit: 'rounded-[inherit]',
      },
      /** Block button — spans its container. The reference primary action on a
       *  hero card is full-width; pairs with `radius:"full"` + `size:"lg"`. */
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
      radius: 'md',
      fullWidth: false,
    },
  }
);

// ---------------------------------------------------------------------------
// ACTIVE STATE — applied when button is toggled/pressed/selected
// ---------------------------------------------------------------------------

// Selected reads at a glance on every look: the active fill plus an inset outline in the look's firmer line colour, so a
// chosen chip differs from its neighbours even where the active and resting fills are close.
const ACTIVE_CLASS = 'bg-[var(--glass-bg-active)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-secondary)]';


// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'>,
    VariantProps<typeof buttonVariants> {
  /** Loading state — shows spinner, disables button */
  loading?: boolean;
  /** The work this button runs elsewhere, said in the button; a press that returns a promise needs none. `null`: the
   *  button draws its own work, so a promise its press returns is not said again. */
  work?: ButtonWork | null;
  /** Words while the work runs (else the button's own), when it worked ("Done") and when it failed ("Try again"). */
  pendingLabel?: React.ReactNode;
  doneLabel?: React.ReactNode;
  errorLabel?: React.ReactNode;
  /** Active/pressed/selected state — overrides variant colors with active styling */
  active?: boolean;
  /** Compatibility alias for account-style action tones; ignored when `variant` is explicit. */
  tone?: 'primary' | 'quiet' | 'danger';
  /** Compatibility alias for older solid action buttons; ignored by non-solid variants. */
  color?: 'primary' | 'secondary' | 'accent' | 'success' | 'danger' | 'error';
  /** Shared hit-geometry role. Reorder/reference controls expand to 44×44 on
   * coarse input; all controls retain at least a 24×24 actionable rectangle. */
  targetRole?: ControlTargetRole;
}

function variantForTone(tone: ButtonProps['tone']) {
  if (tone === 'danger') return 'danger';
  if (tone === 'quiet') return 'ghost';
  return 'primary';
}

function variantForSolidColor(color: ButtonProps['color']) {
  if (color === 'success') return 'success';
  if (color === 'danger' || color === 'error') return 'danger';
  if (color === 'accent') return 'accent';
  if (color === 'secondary') return 'secondary';
  return 'primary';
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Canonical button for Bitfield Studio.
 *
 * Supports six visual variants (primary, secondary, ghost, danger, accent,
 * success), four sizes (sm, md, lg, icon), active toggle state, and a
 * loading state with accessible spinner. A press that returns a promise says its work in the button.
 *
 * @example
 * ```tsx
 * <Button variant="primary" size="md">Save</Button>
 * <Button variant="danger" loading>Deleting...</Button>
 * <Button variant="ghost" size="icon"><Trash2 className="h-4 w-4" /></Button>
 * <Button variant="ghost" size="sm" active={isSelected}>Filter</Button>
 * <Button variant="success" size="sm">Live</Button>
 * ```
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, radius, fullWidth, loading, work: givenWork, pendingLabel, doneLabel, errorLabel, disabled, active, tone, color, targetRole = 'action', children, onClick, ...props }, ref) => {
    const insideTooltip = React.useContext(InsideTooltipContext);
    const iconOnly = size === 'icon' || size === 'icon-xs';
    const { work, onClick: press } = usePressWork(onClick, givenWork, loading);
    const pending = work === 'pending';
    const button = (
      <button
        ref={ref}
        className={cn(
          buttonVariants({
            variant: variant === 'solid'
              ? variantForSolidColor(color)
              : variant ?? (tone ? variantForTone(tone) : undefined),
            size,
            radius,
            fullWidth,
          }),
          controlTargetClass(targetRole),
          active && ACTIVE_CLASS,
          className,
        )}
        {...controlTargetAttributes(targetRole)}
        data-tone={tone}
        data-work={work}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        aria-pressed={active != null ? active : undefined}
        {...props}
        onClick={press}
      >
        <PressWorkFace work={work} iconOnly={iconOnly} pendingLabel={pendingLabel} doneLabel={doneLabel} errorLabel={errorLabel}>{children}</PressWorkFace>
      </button>
    );
    const label = props['aria-label'];

    return !insideTooltip && iconOnly && typeof label === 'string' && label.trim()
      ? <Tooltip label={label}>{button}</Tooltip>
      : button;
  }
);

Button.displayName = 'Button';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { Button, buttonVariants };
export type { ButtonProps };
