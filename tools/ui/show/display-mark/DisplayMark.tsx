// packages/ui/show/display-mark/DisplayMark.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE universal identity-mark renderer. One component paints the leading mark
// of any conversation row, participant chip, connection-catalog row, or member
// stack across every surface. Self-describing identity data in, mark out — the
// renderer NEVER enumerates sources (no "iMessage vs CLI vs Slack" branch).
//
// Grounded in the conversation-list anatomy of iMessage, WhatsApp, Discord,
// Telegram, Slack, X, Threads, OpenAI, Otter, Clubhouse, Beside, Meta
// (Mobbin reference corpus — see chat reference-grounded-screen-
// contract.md § Phase E). Every one of those rows is a configuration of this
// ONE primitive:
//
//   base   : image(src) | glyph(iconName) | monogram(text)
//   shape  : person | tile                        (DATA, not hardcoded per app)
//   tint   : { background?, foreground?, border? } (explicit wins; else hue(name))
//   badge  : dot | count | check | mark            (one kinded corner adornment)
//   members: DisplayMarkSpec[]                     (group → AvatarGroup of marks)
//
// This SUBSUMES and replaces ServiceMark, SelectableAvatar, and the chat
// package's ParticipantRouteMark (L030/L069 — three renderers of the same job
// collapse to one). AvatarGroup remains as the internal stack engine.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure presentation — no data reads, no durable state beyond image-onError,
//    zero feature/source vocabulary. Identity facts are caller-owned DATA.
// 2. Image → monogram fallback: a broken/missing image NEVER shows a broken-
//    image glyph; onError flips to the monogram tile (carried from ServiceMark).
// 3. Monogram background is deterministic from `name` (same name = same hue)
//    UNLESS the caller supplies an explicit tint — explicit always wins.
// 4. The base mark kind is closed by rendering Physics: a tile is painted from
//    a raster (image), a named vector (glyph), or rendered text (monogram).
//    There is no fourth way to paint a tile — this is NOT a source enumeration.
// 5. Styling via cva variants + cn. The ONLY inline style is the per-identity
//    tint, which is record DATA (same pattern ServiceMark/ParticipantRouteMark
//    already use) — never arbitrary layout className.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';
import { NamedIcon } from '../icon';
import { AvatarGroup, type AvatarGroupItem } from '../avatar-group';

// ---------------------------------------------------------------------------
// SELF-DESCRIBING IDENTITY DATA
// ---------------------------------------------------------------------------

/**
 * One corner adornment. Closed by corner anatomy: a corner can show a status
 * dot, a number, a selection check, or a tiny mark (e.g. the carrying-channel
 * glyph). Not a source enumeration — these are the visual shapes a corner takes.
 */
export type DisplayMarkBadge =
  | { kind: 'dot'; tone?: 'online' | 'busy' | 'away' | 'accent'; label?: string }
  | { kind: 'count'; value: number; label?: string }
  | { kind: 'check'; on: boolean }
  | { kind: 'mark'; glyph: string; background?: string; foreground?: string; label?: string };

/** Per-identity color, supplied by the owning record. Explicit beats derived. */
export interface DisplayMarkTint {
  background?: string;
  foreground?: string;
  border?: string;
}

/**
 * Everything needed to paint one identity mark. Caller-owned data; the renderer
 * adds zero meaning. `members` turns this into a group stack of sub-marks.
 */
export interface DisplayMarkSpec {
  /** Identity label — a11y title + monogram fallback source */
  name: string;
  /** Raster source (photo/logo). Wins when it loads; falls back to monogram. */
  image?: string;
  /** Named vector glyph (brand icon, `#` channel, terminal/source icon). */
  glyph?: string;
  /** Explicit initials override; absent → initialsOf(`name`). Only a person's mark draws letters: a thing (an app, a
   *  tool, a project, a course) passes `image` or `glyph` and is drawn with them. */
  monogram?: string;
  /** Tile shape — DATA: `person` for people (the look's chip radius, the product's soft square), `tile` for app,
   *  brand and thing tiles (the look's default radius). Both radii come from the selected look. */
  shape?: 'person' | 'tile';
  /** Per-identity color; explicit wins over the deterministic hue. */
  tint?: DisplayMarkTint;
  /** One corner adornment. */
  badge?: DisplayMarkBadge;
  /** Group members — when present, renders an overlapping stack of sub-marks. */
  members?: readonly DisplayMarkSpec[];
}

// ---------------------------------------------------------------------------
// VARIANTS
// ---------------------------------------------------------------------------

export const displayMarkVariants = cva(
  'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden border font-semibold leading-none tracking-[-0.02em]',
  {
    variants: {
      size: {
        // Fixed width MATCHING the fixed height on every size — a min-width
        // alone leaves the upper bound unconstrained, so a wide source image
        // (an intrinsically non-square logo) stretched the tile into a pill.
        // w-* + min-w-* enforces a hard 1:1 box regardless of image aspect.
        xs: 'h-4 w-4 min-w-4 text-[length:var(--font-size-micro)]',
        sm: 'h-5 w-5 min-w-5 text-[length:var(--font-size-caption)]',
        md: 'h-8 w-8 min-w-8 text-[13px]',
        lg: 'h-10 w-10 min-w-10 text-[16px]',
        xl: 'h-14 w-14 min-w-14 text-[20px]',
      },
      shape: {
        person: 'rounded-[var(--radius-chip)]',
        tile: 'rounded-[var(--radius-default)]',
      },
    },
    defaultVariants: { size: 'md', shape: 'person' },
  },
);

type DisplayMarkSize = NonNullable<VariantProps<typeof displayMarkVariants>['size']>;

const ICON_SIZE: Record<DisplayMarkSize, 'xs' | 'sm' | 'md'> = {
  xs: 'xs',
  sm: 'xs',
  md: 'sm',
  lg: 'md',
  xl: 'md',
};

const BADGE_TONE: Record<NonNullable<Extract<DisplayMarkBadge, { kind: 'dot' }>['tone']>, string> = {
  online: 'bg-emerald-400',
  busy: 'bg-rose-400',
  away: 'bg-amber-400',
  accent: 'bg-accent-purple',
};

// ---------------------------------------------------------------------------
// MONOGRAM COLOR — deterministic hue from the name (the sole SSOT now that
// ServiceMark is deleted) so a given identity always renders the same tile
// color across surfaces/sessions.
// ---------------------------------------------------------------------------

function monogramHue(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** A person's initials: the first letter of their first two words ("Ada Lovelace" → "AL", "Sam" → "S"). The one
 *  place letters are made for a mark (parts/screen-look/one-look-rules.json `initials-only-from-the-person-mark`). */
export function initialsOf(name: string): string {
  return name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map(word => word[0]!.toLocaleUpperCase()).join('') || '?';
}

function monogramText(spec: DisplayMarkSpec): string {
  return spec.monogram?.trim() || initialsOf(spec.name);
}

// ---------------------------------------------------------------------------
// BADGE — one kinded corner adornment
// ---------------------------------------------------------------------------

function DisplayMarkCorner({ badge, size }: { badge: DisplayMarkBadge; size: DisplayMarkSize }) {
  // Selection rides the top-left corner (SelectableAvatar anatomy); everything
  // else rides the bottom-right (presence/unread/channel anatomy).
  const corner = badge.kind === 'check' ? '-left-0.5 -top-0.5' : '-bottom-0.5 -right-0.5';
  const base = cn('absolute z-10 flex items-center justify-center rounded-full', corner);

  if (badge.kind === 'dot') {
    return (
      <span
        aria-label={badge.label}
        className={cn(base, 'h-2.5 w-2.5 ring-2 ring-[var(--glass-bg-subtle)]', BADGE_TONE[badge.tone ?? 'accent'])}
      />
    );
  }
  if (badge.kind === 'count') {
    if (badge.value <= 0) return null;
    return (
      <span
        aria-label={badge.label ?? `${badge.value}`}
        className={cn(base, 'min-w-3.5 px-1 h-3.5 text-[length:var(--font-size-micro)] font-semibold text-white ring-2 ring-[var(--glass-bg-subtle)] bg-accent-purple')}
      >
        {badge.value > 99 ? '99+' : badge.value}
      </span>
    );
  }
  if (badge.kind === 'check') {
    if (!badge.on) return null;
    return (
      <span aria-hidden className={cn(base, 'h-3.5 w-3.5 bg-accent-purple text-white')}>
        <NamedIcon name="Check" fallback="Check" size="xs" color="inherit" />
      </span>
    );
  }
  // kind === 'mark' — the carrying-channel glyph (the user's "which channel")
  return (
    <span
      aria-label={badge.label}
      title={badge.label}
      style={{
        ...(badge.background ? { backgroundColor: badge.background } : {}),
        ...(badge.foreground ? { color: badge.foreground } : {}),
      }}
      className={cn(base, 'h-3.5 w-3.5 ring-2 ring-[var(--glass-bg-subtle)] bg-[var(--glass-bg-active)] text-[var(--text-secondary)]')}
    >
      <NamedIcon name={badge.glyph} fallback="MessageCircle" size="xs" color="inherit" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export interface DisplayMarkProps {
  spec: DisplayMarkSpec;
  size?: DisplayMarkSize;
  /** Max sub-marks shown before "+N" overflow (group case). */
  maxMembers?: number;
  className?: string;
}

export function DisplayMark({ spec, size = 'md', maxMembers = 4, className }: DisplayMarkProps) {
  const [imageFailed, setImageFailed] = useState(false);

  // GROUP — compose AvatarGroup of DisplayMarks. The stack engine owns overlap
  // and ring; each member is itself a DisplayMark (mixed kinds emerge for free).
  if (spec.members && spec.members.length > 0) {
    const groupSize = size === 'lg' ? 'md' : size === 'md' ? 'sm' : 'xs';
    // Each member is itself a full DisplayMark — its own badge and nested members
    // render for free (L069: every composition of base x shape x tint x badge x
    // members emerges with zero special-casing; the primitive renders what it is
    // given and never decides "no badges in groups").
    const items: AvatarGroupItem[] = spec.members.map((member, index) => ({
      key: `${member.name}-${index}`,
      node: <DisplayMark spec={member} size={groupSize} />,
    }));
    return <AvatarGroup items={items} size={groupSize} max={maxMembers} ariaLabel={spec.name} />;
  }

  const shape = spec.shape ?? 'person';
  const showImage = Boolean(spec.image) && !imageFailed;
  const showGlyph = !showImage && Boolean(spec.glyph);
  const hue = monogramHue(spec.name);

  // Tint: explicit record color wins; else deterministic hue for the monogram.
  const tintStyle: React.CSSProperties = spec.tint
    ? {
        ...(spec.tint.background ? { backgroundColor: spec.tint.background } : {}),
        ...(spec.tint.foreground ? { color: spec.tint.foreground } : {}),
        ...(spec.tint.border ? { borderColor: spec.tint.border } : {}),
      }
    : showImage || showGlyph
      ? { borderColor: 'var(--glass-border-muted)' }
      // The person's own hue, mixed into the look's card and text colours so it reads in every look, light or dark.
      : { backgroundColor: `color-mix(in srgb, hsl(${hue} 60% 50%) 18%, var(--color-card, var(--glass-bg-subtle)))`, color: `color-mix(in srgb, hsl(${hue} 60% 42%) 70%, var(--color-foreground, var(--text-strong)))`, borderColor: 'transparent' };

  return (
    <span className="relative inline-flex">
      <span
        aria-hidden="true"
        title={spec.name}
        style={tintStyle}
        className={cn(displayMarkVariants({ size, shape }), 'border-[var(--glass-border-muted)]', className)}
      >
        {showImage ? (
          <ImageInner src={spec.image as string} onError={() => setImageFailed(true)} />
        ) : showGlyph ? (
          <NamedIcon name={spec.glyph as string} fallback="MessageCircle" size={ICON_SIZE[size]} color="inherit" />
        ) : (
          monogramText(spec)
        )}
      </span>
      {spec.badge ? <DisplayMarkCorner badge={spec.badge} size={size} /> : null}
    </span>
  );
}

// Raster inner — full-bleed cover with graceful onError handoff to monogram.
function ImageInner({ src, onError }: { src: string; onError: () => void }) {
  return <img src={src} alt="" className="h-full w-full object-cover" onError={onError} />;
}
