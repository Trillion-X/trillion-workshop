// packages/workflow-canvas/show/WorkflowEdge.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic SVG cubic Bezier edge renderer. Draws a directed arc between two
// world-space coordinate pairs with an arrowhead at the target end and an
// optional label at the curve midpoint.
//
// Zero domain vocabulary — "source" and "target" are coordinate pairs.
// This component can render edges for any graph structure.
//
// Must be rendered inside an <svg> element (provided by WorkflowCanvas).
// The parent SVG must contain <CanvasArrowMarker /> in its <defs>.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO domain vocabulary — no "workflow", "step", "trigger", "action", "gate"
// 2. All props are pre-computed coordinates — caller resolves node positions
// 3. SVG path uses cubic Bezier — smooth curves for horizontal and vertical edges
// 4. Arrowhead via SVG marker — defined once in <CanvasArrowMarker />, reused
// 5. Click propagation stopped — prevents canvas pan starting from edge click
// 6. SVG elements (<path>, <g>, <marker>, <rect>, <text>) are not raw HTML —
//    they are not blocked by the L065 HTML element rule
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const EDGE_STROKE_WIDTH = 1.5;
const EDGE_COLOR_DEFAULT = 'var(--text-tertiary)';
const EDGE_COLOR_SELECTED = 'var(--accent-primary)';
const EDGE_COLOR_HOVER = 'var(--text-secondary)';
const LABEL_FONT_SIZE = 11;
// Branch pills carry whole conditions ("if exit code = 0", "otherwise") —
// the pill sizes to its text up to this cap, then truncates with an ellipsis.
const LABEL_MAX_CHARS = 26;
/** Approximate mono glyph width at LABEL_FONT_SIZE — sizes the pill rect. */
const LABEL_CHAR_WIDTH = 6.6;
const LABEL_PAD_X = 8;
const HIT_AREA_WIDTH = 12; // invisible wider stroke for easier clicking

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface WorkflowEdgeProps {
  /** Unique identifier for this edge */
  edgeId: string;
  /** Source connection point X in world-space */
  sourceX: number;
  /** Source connection point Y in world-space */
  sourceY: number;
  /** Target connection point X in world-space */
  targetX: number;
  /** Target connection point Y in world-space */
  targetY: number;
  /** Optional label shown at the curve midpoint */
  label?: string;
  /** Whether this edge is currently selected */
  isSelected?: boolean;
  /**
   * Run status for the path: 'active' animates flow along the curve,
   * 'completed'/'failed' freeze the curve in a status color. Generic state
   * names — callers map their domain to these.
   */
  runStatus?: 'active' | 'completed' | 'failed' | null;
  /** Called when edge is clicked */
  onSelect?: (edgeId: string) => void;
  /**
   * Hover-revealed actionable pill at the curve midpoint — the caller's domain
   * word for "do something to this edge" (e.g. "Define a condition"). Shown only
   * when this edge has no `label` (a relationship pill already owns the
   * midpoint) and the cursor is over the edge, so dense graphs stay quiet.
   * Zero domain vocabulary here — the LABEL is data the caller supplies.
   */
  affordanceLabel?: string;
  /** Called when the hover affordance pill is clicked. */
  onAffordance?: (edgeId: string) => void;
}

// ---------------------------------------------------------------------------
// BEZIER GEOMETRY
// ---------------------------------------------------------------------------

/**
 * Compute a cubic Bezier SVG path from (x1,y1) to (x2,y2).
 *
 * Control points adapt to dominant direction:
 * - Horizontal-dominant: control points pulled horizontally (S-curve)
 * - Vertical-dominant: control points pulled vertically (bow)
 */
function computeBezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const horizontal = Math.abs(dx) >= Math.abs(dy);

  const cp1x = horizontal ? x1 + dx * 0.5 : x1;
  const cp1y = horizontal ? y1 : y1 + dy * 0.5;
  const cp2x = horizontal ? x2 - dx * 0.5 : x2;
  const cp2y = horizontal ? y2 : y2 - dy * 0.5;

  return `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
}

/**
 * Compute the world-space midpoint of the cubic Bezier at t=0.5.
 * Used to position the optional edge label.
 */
function bezierMidpoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const horizontal = Math.abs(dx) >= Math.abs(dy);

  const cp1x = horizontal ? x1 + dx * 0.5 : x1;
  const cp1y = horizontal ? y1 : y1 + dy * 0.5;
  const cp2x = horizontal ? x2 - dx * 0.5 : x2;
  const cp2y = horizontal ? y2 : y2 - dy * 0.5;

  // Cubic Bezier at t=0.5
  const t = 0.5;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * x1 + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * x2,
    y: mt * mt * mt * y1 + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * y2,
  };
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Renders a single directed edge as a cubic Bezier SVG path.
 *
 * Render inside the `<svg>` overlay in WorkflowCanvas. The parent SVG must
 * define `<CanvasArrowMarker />` for the arrowhead to appear.
 */
export const WorkflowEdge: React.FC<WorkflowEdgeProps> = ({
  edgeId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  isSelected = false,
  runStatus = null,
  onSelect,
  affordanceLabel,
  onAffordance,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const path = computeBezierPath(sourceX, sourceY, targetX, targetY);
  const mid = bezierMidpoint(sourceX, sourceY, targetX, targetY);

  const strokeColor = runStatus === 'active'
    ? 'var(--accent-primary)'
    : runStatus === 'completed'
      ? 'var(--status-success, #46a758)'
      : runStatus === 'failed'
        ? 'var(--status-error, #e5484d)'
        : isSelected
          ? EDGE_COLOR_SELECTED
          : isHovered
            ? EDGE_COLOR_HOVER
            : EDGE_COLOR_DEFAULT;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect?.(edgeId);
  };

  return (
    <g
      data-edge-id={edgeId}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      // The parent SVG overlay is pointerEvents:none so it never blocks
      // canvas panning — each edge group re-enables events for itself,
      // scoped to its painted strokes by the hit-area path below.
      style={{ cursor: 'pointer', pointerEvents: 'auto' }}
    >
      {/* Invisible wide hit area — makes clicking the edge much easier.
          pointerEvents:stroke keeps transparent strokes hit-testable. */}
      <path
        d={path}
        stroke="transparent"
        strokeWidth={HIT_AREA_WIDTH}
        fill="none"
        style={{ pointerEvents: 'stroke' }}
      />

      {/* Visible edge curve */}
      <path
        d={path}
        stroke={strokeColor}
        strokeWidth={isSelected || runStatus ? EDGE_STROKE_WIDTH + 0.5 : EDGE_STROKE_WIDTH}
        fill="none"
        markerEnd="url(#canvas-arrow)"
        style={{ transition: 'stroke 0.15s ease, stroke-width 0.15s ease' }}
      />

      {/* Active-run flow: dashes marching toward the target (n8n-style). */}
      {runStatus === 'active' && (
        <path
          d={path}
          stroke={strokeColor}
          strokeWidth={EDGE_STROKE_WIDTH + 1}
          strokeDasharray="6 10"
          strokeLinecap="round"
          fill="none"
          opacity={0.9}
          style={{ pointerEvents: 'none' }}
        >
          <animate
            attributeName="stroke-dashoffset"
            from="32"
            to="0"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </path>
      )}

      {/* Label pill at curve midpoint — always visible (Lindy shows edge
          relationship pills persistently), quiet at rest and brighter on
          hover/selection so it reads as part of the line, not chrome. */}
      {label && (() => {
        const shown = label.length > LABEL_MAX_CHARS
          ? label.slice(0, LABEL_MAX_CHARS - 1) + '…'
          : label;
        // Pill width follows the text — branch conditions read whole
        // ("if exit code = 0"), one-word relations stay compact ("runs").
        const pillWidth = Math.ceil(shown.length * LABEL_CHAR_WIDTH) + LABEL_PAD_X * 2;
        // Branch pills (anything beyond the generic one-word relation) are
        // the decision chrome — they stay fully readable at rest, the way
        // Lindy/Zapier print path conditions directly on the line.
        const isBranchPill = shown.includes(' ');
        return (
          <g
            transform={`translate(${mid.x}, ${mid.y})`}
            opacity={isHovered || isSelected || isBranchPill ? 1 : 0.65}
            style={{ transition: 'opacity 0.15s ease' }}
          >
            <rect
              x={-pillWidth / 2}
              y={-9}
              width={pillWidth}
              height={18}
              rx={9}
              fill="var(--glass-bg-primary)"
              stroke={isBranchPill ? 'var(--border-secondary, var(--border-primary))' : 'var(--border-primary)'}
              strokeWidth={1}
            />
            <text
              x={0}
              y={4}
              textAnchor="middle"
              fontSize={LABEL_FONT_SIZE}
              fill={isHovered || isSelected
                ? strokeColor
                : isBranchPill
                  ? 'var(--text-secondary)'
                  : 'var(--text-tertiary)'}
              style={{
                fontFamily: 'var(--font-mono)',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              {shown}
            </text>
          </g>
        );
      })()}

      {/* Hover-revealed action pill (Lindy "Define a condition"): amber,
          clickable, only on an unlabeled edge while hovered — so it offers the
          next move without cluttering a dense graph. The label is caller data;
          this component never names "condition". */}
      {affordanceLabel && !label && isHovered && (() => {
        const pillWidth = Math.ceil(affordanceLabel.length * LABEL_CHAR_WIDTH) + LABEL_PAD_X * 2 + 14;
        return (
          <g
            data-edge-affordance="true"
            transform={`translate(${mid.x}, ${mid.y})`}
            onClick={(event) => { event.stopPropagation(); onAffordance?.(edgeId); }}
            style={{ cursor: 'pointer' }}
          >
            <rect
              x={-pillWidth / 2}
              y={-10}
              width={pillWidth}
              height={20}
              rx={10}
              fill="var(--status-warning-bg, rgba(245,166,35,0.14))"
              stroke="var(--status-warning, #f5a623)"
              strokeWidth={1}
            />
            {/* leading + glyph */}
            <text
              x={-pillWidth / 2 + LABEL_PAD_X + 1}
              y={4}
              textAnchor="start"
              fontSize={LABEL_FONT_SIZE + 1}
              fill="var(--status-warning, #f5a623)"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              +
            </text>
            <text
              x={6}
              y={4}
              textAnchor="middle"
              fontSize={LABEL_FONT_SIZE}
              fill="var(--status-warning, #f5a623)"
              style={{ fontFamily: 'var(--font-primary)', pointerEvents: 'none', userSelect: 'none' }}
            >
              {affordanceLabel}
            </text>
          </g>
        );
      })()}
    </g>
  );
};

// ---------------------------------------------------------------------------
// ARROWHEAD MARKER
// ---------------------------------------------------------------------------

/**
 * SVG `<defs>` block that defines the arrowhead marker used by all
 * WorkflowEdge instances in the same `<svg>`. Render exactly once
 * inside the parent `<svg>` before any edges.
 *
 * @example
 * ```tsx
 * <svg>
 *   <CanvasArrowMarker />
 *   {edges.map(e => <WorkflowEdge key={e.id} ... />)}
 * </svg>
 * ```
 */
export const CanvasArrowMarker: React.FC = () => (
  <defs>
    <marker
      id="canvas-arrow"
      viewBox="0 0 10 10"
      refX={9}
      refY={5}
      markerWidth={6}
      markerHeight={6}
      orient="auto-start-reverse"
    >
      <path
        d="M 0 0 L 10 5 L 0 10 z"
        fill="var(--text-tertiary)"
      />
    </marker>
  </defs>
);
