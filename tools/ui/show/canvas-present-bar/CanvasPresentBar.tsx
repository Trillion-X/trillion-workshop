//
// =============================================================================
// PURPOSE — Present-mode control bar (bottom-center canvas chrome)
// =============================================================================
//
// The blind control bar shown while walking an ordered set of canvas targets as
// a story path (Figma "Present", Canva present, Pitch). Bottom-center pill:
//   ◀   {position}   {title}   ▶            ✕
// It owns NO durable state and NO domain meaning — the caller supplies the
// current index, the total, the current title, and the three intents (previous,
// next, exit). It never knows what a "frame" or a "board" is; it renders a
// position and routes three clicks. Positioning + surface follow the same
// token-styled canvas-chrome convention as CanvasMinimap (inline CSS vars so the
// bar reads the active theme without a Tailwind round-trip).
//
// `atFirst` / `atLast` disable the ends (a story path has a first + last; there
// is no wrap), so the disabled state is DATA the caller computes from its own
// clamp — the bar never re-derives navigation.
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface CanvasPresentBarProps {
  /** 0-based position of the current target within the path. */
  readonly index: number;
  /** Total number of targets in the path (≥1 while presenting). */
  readonly total: number;
  /** Human title of the current target (the frame's name); empty → untitled. */
  readonly title?: string;
  /** Speaker-note / caption for the current target, shown as a wrapped second line
   *  below the controls. When blank the bar stays a single control row. */
  readonly caption?: string;
  /** At the first target — the Previous control is disabled (no wrap). */
  readonly atFirst: boolean;
  /** At the last target — the Next control is disabled (no wrap). */
  readonly atLast: boolean;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onExit: () => void;
}

const BAR: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 24,
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '6px 8px',
  borderRadius: 'var(--radius-lg, 12px)',
  backgroundColor: 'var(--surface-overlay, var(--surface-secondary, rgba(20,20,24,0.92)))',
  border: '1px solid var(--border-primary)',
  boxShadow: 'var(--shadow-md, 0 6px 20px rgba(0,0,0,0.22))',
  zIndex: 40,
  maxWidth: 'min(560px, 92vw)',
  pointerEvents: 'auto',
};

const BTN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 'var(--radius-default, 8px)',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-primary)',
  cursor: 'pointer',
};

const BTN_DISABLED: React.CSSProperties = {
  ...BTN,
  color: 'var(--text-tertiary)',
  cursor: 'default',
};

const POSITION: React.CSSProperties = {
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--text-tertiary)',
  padding: '0 2px',
  whiteSpace: 'nowrap',
};

const TITLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: 320,
  padding: '0 6px',
};

const DIVIDER: React.CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  margin: '2px 4px',
  backgroundColor: 'var(--border-primary)',
};

// The pill becomes a vertical stack ONLY when a caption is present; the controls
// keep their horizontal row, and the caption wraps as a muted second line beneath.
const STACK: React.CSSProperties = {
  ...BAR,
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 6,
};

const CONTROLS_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
};

const CAPTION_LINE: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  color: 'var(--text-secondary, var(--text-tertiary))',
  padding: '0 6px 2px',
  maxWidth: 'min(540px, 90vw)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

export function CanvasPresentBar({
  index,
  total,
  title,
  caption,
  atFirst,
  atLast,
  onPrev,
  onNext,
  onExit,
}: CanvasPresentBarProps): React.ReactElement {
  const hasCaption = typeof caption === 'string' && caption.trim().length > 0;
  return (
    // The bar is chrome floating over the canvas. `stopPropagation` on pointerdown
    // keeps the canvas viewport underneath from hijacking the press as a pan/marquee
    // (which otherwise swallows the button's `click`) — without it the arrows work by
    // keyboard but not by mouse. The minimap uses the same isolation. When a caption
    // is present the pill stacks the controls over a wrapped speaker-note line.
    <div
      style={hasCaption ? STACK : BAR}
      role="toolbar"
      aria-label="Present controls"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div style={CONTROLS_ROW}>
        <button
          type="button"
          style={atFirst ? BTN_DISABLED : BTN}
          disabled={atFirst}
          onClick={onPrev}
          aria-label="Previous frame"
        >
          <ChevronLeft size={18} />
        </button>
        <span style={POSITION}>
          {index + 1} / {total}
        </span>
        <span style={TITLE}>{title && title.length > 0 ? title : 'Untitled'}</span>
        <button
          type="button"
          style={atLast ? BTN_DISABLED : BTN}
          disabled={atLast}
          onClick={onNext}
          aria-label="Next frame"
        >
          <ChevronRight size={18} />
        </button>
        <span style={DIVIDER} aria-hidden="true" />
        <button type="button" style={BTN} onClick={onExit} aria-label="Exit present mode">
          <X size={16} />
        </button>
      </div>
      {hasCaption ? (
        <div style={CAPTION_LINE} aria-label="Frame notes">
          {caption}
        </div>
      ) : null}
    </div>
  );
}
