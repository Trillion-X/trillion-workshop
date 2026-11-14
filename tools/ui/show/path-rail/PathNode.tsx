// packages/ui/show/path-rail/PathNode.tsx
//
// One circular node on a winding learning path (Duolingo-style "coin" button):
// an icon inside a raised circle, an optional pulsing ring (the active node), an
// optional floating bubble, and a dimmed/locked look. Pure presentation — it
// paints an already-resolved view (color + flags) and never decides status, so
// the path layer carries no status enum (status is resolved upstream, L090).
// Generic: no domain vocabulary. Raw <button> is allowed here (ui primitive).

import * as React from 'react';
import { Check, Lock } from 'lucide-react';

import { cn } from '../cn';

/** A node's resolved presentation (decoded upstream from a raw status key via
 *  DATA tone overrides — keeps this layer free of any status enum). */
export interface PathNodeView {
  id: string;
  label: string;
  icon?: React.ComponentType<{ size?: number | string; color?: string; strokeWidth?: number }>;
  /** Resolved circle color (CSS var or hex), e.g. 'var(--status-success)'. */
  toneColor: string;
  /** Pulsing ring on the current/active node. */
  ring?: boolean;
  /** Floating bubble text above the node. */
  bubble?: string;
  /** Desaturated/flat locked look + disabled interaction. */
  dimmed?: boolean;
  /** Check overlay for a finished node. */
  complete?: boolean;
  /** Text shown directly beneath the node; leave unset for icon-only nodes. */
  caption?: string;
  action?: Record<string, unknown>;
}

export interface PathNodeProps {
  node: PathNodeView;
  /** Horizontal offset from the centerline (px), computed by PathRail. */
  offsetX: number;
  /** Position in the path (staggers the pop-in). */
  index?: number;
  /** Called with node.id when an enabled node is activated. */
  onActivate?: (id: string) => void;
  /** Circle diameter in px. Default 64. */
  size?: number;
}

const DEFAULT_SIZE = 64;

export function PathNode({ node, offsetX, index = 0, onActivate, size = DEFAULT_SIZE }: PathNodeProps) {
  const Icon = node.icon ?? (node.complete ? Check : node.dimmed ? Lock : undefined);
  const interactive = !node.dimmed && typeof onActivate === 'function';
  const iconColor = node.dimmed ? 'var(--text-muted)' : 'var(--text-on-accent, #ffffff)';

  return (
    // OUTER holds ONLY the winding translateX (static). The pop-in animation
    // lives on the INNER wrapper: its keyframe ends on `transform: none` with
    // fill-mode `both`, so if the winding transform sat on the SAME element the
    // animation would reset it to 0 and every node would snap back to the
    // centerline (leaving the connectors, which DO wind, pointing at empty
    // space). Splitting them keeps the node on its winding offset AND animated.
    <div
      style={{ transform: `translateX(${offsetX}px)` }}
      className="relative flex flex-col items-center"
    >
     <div
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
      className="bf-path-animated bf-path-pop relative flex flex-col items-center"
    >
      {node.bubble ? (
        <div
          className="bf-path-animated bf-path-bob"
          style={{
            marginBottom: '0.375rem',
            padding: '0.25rem 0.625rem',
            borderRadius: '0.625rem',
            fontSize: '0.6875rem',
            fontWeight: 700,
            letterSpacing: '0.05em',
            background: 'var(--surface-raised, rgba(255,255,255,0.12))',
            color: node.toneColor,
            border: `1px solid ${node.toneColor}`,
          }}
        >
          {node.bubble}
        </div>
      ) : null}

      <button
        type="button"
        aria-label={node.label}
        aria-disabled={node.dimmed ? true : undefined}
        disabled={node.dimmed}
        onClick={interactive ? () => onActivate?.(node.id) : undefined}
        className={cn('relative inline-flex items-center justify-center rounded-full', interactive ? 'cursor-pointer' : 'cursor-default')}
        style={{
          width: size,
          height: size,
          background: node.dimmed ? 'var(--surface-sunken, rgba(255,255,255,0.06))' : node.toneColor,
          boxShadow: node.dimmed
            ? 'inset 0 -3px 0 rgba(0,0,0,0.18)'
            : '0 4px 0 rgba(0,0,0,0.22), inset 0 -3px 0 rgba(0,0,0,0.18)',
          opacity: node.dimmed ? 0.6 : 1,
          border: 'none',
          transition: 'transform 120ms ease, filter 120ms ease',
        }}
      >
        {node.ring ? (
          <span
            aria-hidden
            className="bf-path-animated bf-path-ring"
            style={{ position: 'absolute', inset: -6, borderRadius: '9999px', border: `3px solid ${node.toneColor}` }}
          />
        ) : null}
        {Icon ? <Icon size={Math.round(size * 0.42)} color={iconColor} strokeWidth={2.5} /> : null}
      </button>

      {node.caption ? (
        <span
          className="mt-1.5 max-w-[9rem] text-center text-xs font-medium leading-tight"
          style={{ color: node.dimmed ? 'var(--text-muted)' : 'var(--text-primary)' }}
        >
          {node.caption}
        </span>
      ) : null}
     </div>
    </div>
  );
}
