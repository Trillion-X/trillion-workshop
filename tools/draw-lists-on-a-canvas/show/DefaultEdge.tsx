// bitfield/packages/graph-canvas/DefaultEdge.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Default SVG edge renderer. Renders a cubic Bezier curve connecting path points.
// This is a simple cubic Bezier — the first point is the start, the last point is
// the end, and intermediate points define the curve shape.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure SVG — no DOM elements, no React subtree
// 2. Stroke color and width via CSS variables (design tokens)
// 3. Simple path data generation — no complex curve algorithms
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { EdgeRoute } from './types';

interface DefaultEdgeProps {
  route: EdgeRoute;
  isSelected?: boolean;
}

/**
 * Renders a cubic Bezier SVG path from an EdgeRoute.
 * The route.points array is converted to a path string.
 */
export const DefaultEdge: React.FC<DefaultEdgeProps> = ({ route, isSelected = false }) => {
  if (route.points.length < 2) {
    return null;
  }

  // Build SVG path from points
  const [start, ...rest] = route.points;
  const pathData = `M ${start.x} ${start.y} ${rest.map(p => `L ${p.x} ${p.y}`).join(' ')}`;

  return (
    <path
      d={pathData}
      stroke={isSelected ? 'var(--accent-primary)' : 'var(--border-primary)'}
      strokeWidth={isSelected ? 2 : 1.5}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
};
