// packages/ui/show/media-thumb/MediaThumb.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Small rounded thumbnail placeholder tile for the source-media rail in
// DreamCut. Renders a gradient-tinted square with a faint media glyph. The
// tint is keyed by `family` string prefix so any consumer can pass a MIME
// family or a custom category name. No real image loading — purely decorative
// placeholder until a real thumbnail is available.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. family tints are derived from a static map — unknown families → neutral
// 2. ALL base colors use CSS vars; gradient stops are accent vars at low opacity
// 3. selected state → accent-primary ring only
// 4. Pure presentational — no click logic; parent composes onClick
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Film, Music, ImageIcon, FileVideo } from 'lucide-react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// FAMILY MAP
// ---------------------------------------------------------------------------

interface FamilyStyle {
  /** Tailwind gradient classes using accent vars */
  gradient: string;
  GlyphIcon: React.ElementType;
}

const FAMILY_MAP: Record<string, FamilyStyle> = {
  video: {
    gradient: 'from-[color-mix(in_srgb,var(--accent-blue)_22%,transparent)] to-[color-mix(in_srgb,var(--accent-blue)_6%,transparent)]',
    GlyphIcon: Film,
  },
  audio: {
    gradient: 'from-[color-mix(in_srgb,var(--accent-emerald)_22%,transparent)] to-[color-mix(in_srgb,var(--accent-emerald)_6%,transparent)]',
    GlyphIcon: Music,
  },
  image: {
    gradient: 'from-[color-mix(in_srgb,var(--accent-purple)_22%,transparent)] to-[color-mix(in_srgb,var(--accent-cyan)_10%,transparent)]',
    GlyphIcon: ImageIcon,
  },
};

const NEUTRAL_STYLE: FamilyStyle = {
  gradient: 'from-[var(--glass-bg-active)] to-[var(--glass-bg-subtle)]',
  GlyphIcon: FileVideo,
};

function resolveFamilyStyle(family: string): FamilyStyle {
  const key = family.toLowerCase().split('/')[0];
  return FAMILY_MAP[key] ?? NEUTRAL_STYLE;
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface MediaThumbProps {
  /**
   * Media family key. Accepts a MIME family prefix ("video", "audio", "image")
   * or a full MIME type ("video/mp4") — the prefix is used for tint lookup.
   */
  family: string;
  selected?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Gradient-tinted thumbnail placeholder for the source-media rail.
 *
 * @example
 * ```tsx
 * <MediaThumb family="video" selected />
 * <MediaThumb family="audio/wav" />
 * <MediaThumb family="image/png" />
 * ```
 */
export function MediaThumb({ family, selected = false, className }: MediaThumbProps) {
  const { gradient, GlyphIcon } = resolveFamilyStyle(family);

  return (
    <div
      className={cn(
        'relative flex items-center justify-center',
        'w-12 h-12 shrink-0 rounded-xl',
        'bg-gradient-to-br',
        gradient,
        'border',
        selected
          ? 'border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]'
          : 'border-[var(--border-primary)]',
        className,
      )}
    >
      <GlyphIcon className="w-5 h-5 text-[var(--text-muted)] opacity-60 shrink-0" />
    </div>
  );
}
