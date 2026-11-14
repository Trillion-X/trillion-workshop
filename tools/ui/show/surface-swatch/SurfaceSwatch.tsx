// packages/ui/show/surface-swatch/SurfaceSwatch.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A selectable PREVIEW TILE for a canvas surface look: a small framed box that
// renders an actual {@link CanvasSurface} miniature (color + tile) with a label
// beneath and a check when selected. The "Background" picker canon (Craft, Miro,
// Mural): you choose a surface by SEEING it, not by reading a name. This is the
// shared molecule for that — feature packages compose it from their own surface
// catalog DATA and never hand-roll a swatch.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Blind to MEANING — it takes an opaque { color?, tile? } and a label; it
//    never knows whether it previews "dots", "blueprint", or anything else.
// 2. The preview reuses CanvasSurface at zoom 1 / pan 0 (one source of truth for
//    how a surface renders — the live canvas and the swatch agree by construction).
// 3. Token-driven chrome (border/radius/accent); no domain vocabulary.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Check } from 'lucide-react';
import { Icon } from '../icon';
import { Text } from '../text';
import { CanvasSurface, type CanvasSurfaceTile } from '../canvas-surface/CanvasSurface';

export interface SurfaceSwatchProps {
  /** Human label shown beneath the preview (e.g. "Dots", "Blueprint"). */
  readonly label: string;
  /** Solid backdrop color of the previewed surface (opaque DATA). */
  readonly color?: string;
  /** Repeating tile of the previewed surface (opaque DATA). */
  readonly tile?: CanvasSurfaceTile;
  /** Whether this is the currently-chosen surface (ringed + checked). */
  readonly selected?: boolean;
  /** Chosen this surface. */
  readonly onSelect: () => void;
}

/** A click-to-choose surface preview tile. */
export const SurfaceSwatch: React.FC<SurfaceSwatchProps> = ({ label, color, tile, selected = false, onSelect }) => (
  <button
    type="button"
    aria-label={`Background: ${label}`}
    aria-pressed={selected}
    onClick={onSelect}
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      padding: 4,
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
    }}
  >
    <span
      style={{
        position: 'relative',
        width: 56,
        height: 40,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        border: selected ? '2px solid var(--accent-primary)' : '1px solid var(--border-primary)',
        backgroundColor: 'var(--surface-secondary)',
      }}
    >
      <CanvasSurface panX={0} panY={0} zoom={1} color={color} tile={tile} />
      {selected ? (
        <span style={{ position: 'absolute', top: 2, right: 2, display: 'flex' }}>
          <Icon icon={Check} size="xs" color="accent" />
        </span>
      ) : null}
    </span>
    <Text variant="body-xs" color={selected ? 'accent' : 'muted'}>{label}</Text>
  </button>
);
