// packages/tasks/show/TaskDAG.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Task dependency graph visualization. Renders DAG nodes and edges using
// SVG with glassmorphism styling. Uses the pure task DAG layout helper for
// positioning. Each node shows task ID, label, status badge, and agent
// count. Edges are drawn as SVG paths with arrowheads.
//
// Phase 2 will replace this with React Flow + dagre for interactive
// features (pan, zoom, node selection). This Phase 1 implementation
// is a correct, complete SVG renderer.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Uses computeDAGLayout for positioning — never hardcodes positions
// 2. Status colors use CSS variables: --color-success, --color-warning,
//    --color-error, --color-info
// 3. Glassmorphism node styling: --glass-bg-tertiary fill, --border-primary stroke
// 4. Responsive: fills parent container, auto-computes viewBox
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { computeDAGLayout, type PositionedNode } from './compute-task-dag-layout';
import type { DAGNode, DAGEdge, DAGDirection } from '@/packages/tasks/read-data/task-graph-types';
import { Text } from '../../../../ui';

// ============================================================================
// TYPES
// ============================================================================

export interface TaskDAGProps {
  nodes: DAGNode[];
  edges: DAGEdge[];
  direction?: DAGDirection;
  onNodeClick?: (nodeId: string) => void;
}

// ============================================================================
// STATUS COLORS
// ============================================================================

function statusColor(status: DAGNode['status']): string {
  switch (status) {
    case 'completed':
      return 'var(--color-success)';
    case 'in_progress':
      return 'var(--color-info)';
    case 'blocked':
      return 'var(--color-warning)';
    case 'pending':
      return 'rgba(255,255,255,0.3)';
  }
}

function statusLabel(status: DAGNode['status']): string {
  switch (status) {
    case 'completed':
      return 'Done';
    case 'in_progress':
      return 'Running';
    case 'blocked':
      return 'Blocked';
    case 'pending':
      return 'Pending';
  }
}

// ============================================================================
// DAG NODE COMPONENT
// ============================================================================

function DAGNodeRect({
  node,
  onClick,
}: {
  node: PositionedNode;
  onClick?: () => void;
}) {
  const color = statusColor(node.status);

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      onClick={onClick}
      className="cursor-pointer"
      role="button"
      tabIndex={0}
    >
      {/* Node background */}
      <rect
        width={node.width}
        height={node.height}
        rx={12}
        ry={12}
        fill="var(--glass-bg-tertiary)"
        stroke="var(--border-primary)"
        strokeWidth={1}
      />

      {/* Status indicator bar */}
      <rect
        x={0}
        y={0}
        width={4}
        height={node.height}
        rx={2}
        fill={color}
      />

      {/* Label */}
      <text
        x={16}
        y={22}
        fontSize={12}
        fontWeight={600}
        fill="currentColor"
        className="select-none"
      >
        {node.label}
      </text>

      {/* Status text */}
      <text x={16} y={40} fontSize={10} fill={color} className="select-none">
        {statusLabel(node.status)}
        {node.agentCount != null && node.agentCount > 0
          ? ` (${node.agentCount} agents)`
          : ''}
      </text>
    </g>
  );
}

// ============================================================================
// EDGE COMPONENT
// ============================================================================

function DAGEdgePath({
  sourceNode,
  targetNode,
}: {
  sourceNode: PositionedNode;
  targetNode: PositionedNode;
}) {
  const sx = sourceNode.x + sourceNode.width;
  const sy = sourceNode.y + sourceNode.height / 2;
  const tx = targetNode.x;
  const ty = targetNode.y + targetNode.height / 2;
  const mx = (sx + tx) / 2;

  return (
    <path
      d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`}
      fill="none"
      stroke="var(--border-secondary)"
      strokeWidth={1.5}
      markerEnd="url(#arrowhead)"
    />
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function TaskDAG({
  nodes,
  edges,
  direction = 'LR',
  onNodeClick,
}: TaskDAGProps) {
  const positioned = React.useMemo(
    () => computeDAGLayout(nodes, edges, direction),
    [nodes, edges, direction]
  );

  // Build node lookup for edge rendering
  const nodeMap = React.useMemo(() => {
    const map = new Map<string, PositionedNode>();
    for (const node of positioned) {
      map.set(node.id, node);
    }
    return map;
  }, [positioned]);

  if (positioned.length === 0) {
    return (
      <div className="flex items-center justify-center h-40">
        <Text variant="body" color="faint">No tasks in dependency graph.</Text>
      </div>
    );
  }

  // Compute viewBox from positioned nodes
  const maxX = Math.max(...positioned.map((n) => n.x + n.width)) + 20;
  const maxY = Math.max(...positioned.map((n) => n.y + n.height)) + 20;

  return (
    <svg
      viewBox={`-10 -10 ${maxX + 10} ${maxY + 10}`}
      className="w-full h-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Arrow marker definition */}
      <defs>
        <marker
          id="arrowhead"
          markerWidth={8}
          markerHeight={6}
          refX={8}
          refY={3}
          orient="auto"
        >
          <polygon
            points="0 0, 8 3, 0 6"
            fill="var(--border-secondary)"
          />
        </marker>
      </defs>

      {/* Edges (render behind nodes) */}
      {edges.map((edge) => {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (!source || !target) return null;
        return (
          <DAGEdgePath
            key={`${edge.source}-${edge.target}`}
            sourceNode={source}
            targetNode={target}
          />
        );
      })}

      {/* Nodes */}
      {positioned.map((node) => (
        <DAGNodeRect
          key={node.id}
          node={node}
          onClick={onNodeClick ? () => onNodeClick(node.id) : undefined}
        />
      ))}
    </svg>
  );
}
