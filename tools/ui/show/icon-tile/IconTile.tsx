// packages/ui/show/icon-tile/IconTile.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical IconTile: a Lucide icon centered inside a fixed-size, rounded,
// tinted surface square. The recurring "icon chip" used by hero blocks, status
// headers, and feature cards across surfaces. Replaces the ad-hoc
// `<Container className="h-14 w-14 rounded-2xl bg-...">  <Icon/> </Container>`
// pattern that would otherwise leak inline styling into feature code (L065).
//
// The tile owns its size and its tint; callers pass only the icon and a
// semantic tone. Tone maps to a design-token background + icon color, so tiles
// stay consistent with the rest of the system.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Composes the canonical Icon — never raw <svg> or a hardcoded glyph.
// 2. Tint comes from semantic tone tokens, never an arbitrary inline color.
// 3. Size is a fixed set of square dimensions (sm/md/lg) — no per-call sizing.
// 4. No consumer className required; the tile is self-contained.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../cn';
import { Icon } from '../icon';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

// EVERY tone shares the SAME container depth (the nested surface) — tone
// differentiates only the icon color and the glow halo. A tinted-background-only
// tone read as a flat/invisible square next to a neutral tile's visible surface
// (inconsistent depth across sibling option cards); one uniform surface kills
// that category for every current and future tone (L063).
const iconTileVariants = cva(
  'flex items-center justify-center shrink-0 rounded-2xl bg-[var(--surface-nested)]',
  {
    variants: {
      size: {
        sm: 'h-10 w-10',
        md: 'h-12 w-12',
        lg: 'h-14 w-14',
      },
      tone: {
        neutral: '',
        success: '',
        warning: '',
        error: '',
        info: '',
        accent: '',
      },
    },
    defaultVariants: {
      size: 'md',
      tone: 'neutral',
    },
  },
);

// Tone -> icon color. The icon picks up the same semantic as the tile tint.
const TONE_TO_ICON_COLOR = {
  neutral: 'muted',
  success: 'success',
  warning: 'warning',
  error: 'error',
  info: 'info',
  accent: 'accent',
} as const;

const SIZE_TO_ICON_SIZE = {
  sm: 'sm',
  md: 'md',
  lg: 'lg',
} as const;

// Tone -> glow color (the soft halo cast when `glow` is set). The tile owns the
// exact shadow recipe so callers never hand-roll a box-shadow (L065). Neutral's
// halo is deliberately FAINT (not full text-primary white) so a neutral tile
// carries the same visual weight as its tonal siblings — uniform depth across
// an option row, tone changes hue only.
// Every entry carries an rgba fallback — a var() whose token is absent makes
// the WHOLE box-shadow invalid (ring + halo silently vanish), which is exactly
// the inconsistent-depth bug across sibling tiles.
const TONE_TO_GLOW = {
  neutral: 'rgba(255,255,255,0.28)',
  success: 'var(--color-status-success, rgba(74,222,128,0.55))',
  warning: 'var(--color-status-warning, rgba(251,191,36,0.55))',
  error: 'var(--color-status-error, rgba(248,113,113,0.55))',
  info: 'var(--color-status-info, rgba(96,165,250,0.55))',
  accent: 'var(--accent-purple, rgba(255,255,255,0.28))',
} as const;

// A defined hairline ring + a soft downward halo in the tone colour — the Calm /
// Headspace "glowing badge" lift, on-theme for a dark monochrome surface where a
// faint tint fill alone would read as invisible.
function glowStyle(tone: keyof typeof TONE_TO_GLOW): React.CSSProperties {
  return {
    boxShadow: `0 0 0 1px var(--border-subtle, rgba(255,255,255,0.10)), 0 10px 30px -12px ${TONE_TO_GLOW[tone]}`,
  };
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface IconTileProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'>,
    VariantProps<typeof iconTileVariants> {
  /** Lucide icon component rendered when no image is given. */
  icon?: LucideIcon;
  /** Image URL rendered INSTEAD of the glyph when present (any source — cas,
   *  byte-address, remote). Same tile container, so depth stays uniform across
   *  glyph tiles and image tiles; the image is data, the tile never knows what
   *  it shows. */
  image?: string;
  /** Accessible label for the tile (icon is decorative without it). */
  label?: string;
  /** Cast a soft tone-coloured halo + a defined hairline ring (feature-card
   *  "glowing badge" treatment). Opt-in — plain tiles are unchanged. */
  glow?: boolean;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Icon centered in a rounded, tinted square.
 *
 * @example
 * ```tsx
 * <IconTile icon={ShieldCheck} tone="success" size="lg" label="Protected" />
 * ```
 */
// Image glyph fills most of the tile (the 3D icon sets carry their own
// internal padding/shadow); the box itself still provides the uniform surface.
const SIZE_TO_IMAGE_CLASS = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
  lg: 'h-11 w-11',
} as const;

const IconTile = React.forwardRef<HTMLDivElement, IconTileProps>(
  ({ icon, image, tone = 'neutral', size = 'md', label, glow = false, className, style, ...props }, ref) => {
    const safeTone = tone ?? 'neutral';
    const safeSize = size ?? 'md';
    return (
      <div
        ref={ref}
        className={cn(iconTileVariants({ tone: safeTone, size: safeSize }), className)}
        style={glow ? { ...glowStyle(safeTone), ...style } : style}
        aria-label={label}
        role={label ? 'img' : undefined}
        {...props}
      >
        {image ? (
          <img src={image} alt="" aria-hidden className={cn('object-contain', SIZE_TO_IMAGE_CLASS[safeSize])} draggable={false} />
        ) : icon ? (
          <Icon icon={icon} size={SIZE_TO_ICON_SIZE[safeSize]} color={TONE_TO_ICON_COLOR[safeTone]} />
        ) : null}
      </div>
    );
  },
);

IconTile.displayName = 'IconTile';

export { IconTile, iconTileVariants };
