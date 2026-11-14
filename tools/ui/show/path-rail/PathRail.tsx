// packages/ui/show/path-rail/PathRail.tsx
// Winding learning-path rail (Duolingo-style): stacks resolved PathNode views on
// an oscillating vertical centerline with an optional sticky header. Generic +
// data-driven; owns the shared keyframes once; motion off under reduced-motion.

import * as React from 'react';

import { cn } from '../cn';
import { PathConnector } from './PathConnector';
import { PathNode, type PathNodeView } from './PathNode';
import { connectorSegments, windingOffsets, type WindingConfig } from './path-rail-geometry';

/** Muted stroke for an upcoming (not-yet-traversed) connector segment. */
const UPCOMING_CONNECTOR_COLOR = 'var(--border-strong, rgba(255,255,255,0.16))';

export interface PathRailProps {
  nodes: PathNodeView[];
  header?: React.ReactNode;
  gap?: number;
  nodeSize?: number;
  winding?: WindingConfig;
  onActivate?: (id: string) => void;
  emptyState?: React.ReactNode;
  className?: string;
}

const KEYFRAMES = `
@keyframes bfPathPop { from { transform: translateY(6px) scale(0.82); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes bfPathRing { 0% { transform: scale(1); opacity: 0.9; } 70% { transform: scale(1.35); opacity: 0; } 100% { transform: scale(1.35); opacity: 0; } }
@keyframes bfPathBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
.bf-path-pop { animation: bfPathPop 320ms cubic-bezier(0.34,1.56,0.64,1) both; }
.bf-path-ring { animation: bfPathRing 1600ms ease-out infinite; }
.bf-path-bob { animation: bfPathBob 1800ms ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .bf-path-animated { animation: none !important; } }
`;

export function PathRail({
  nodes,
  header,
  gap = 28,
  nodeSize = 64,
  winding,
  onActivate,
  emptyState,
  className,
}: PathRailProps) {
  const offsets = windingOffsets(nodes.length, winding);
  // Connectors thread node CENTER to node CENTER. Adjacent centers are
  // `nodeSize + gap` apart vertically (a node's full height plus the flex gap),
  // NOT just `gap`. The connector <div> occupies the `gap` row between two nodes
  // and its rule is centered in that row, which is exactly the midpoint between
  // the two centers, so a rule whose vertical span is `nodeSize + gap` reaches
  // both centers. Passing `gap` alone drew a too-short rule that floated off
  // between the coins instead of connecting them.
  const segments = connectorSegments(offsets, gap + nodeSize);

  return (
    <div className={cn('relative flex flex-col items-center w-full', className)}>
      <style>{KEYFRAMES}</style>
      {header ? (
        <div className="sticky top-0 z-10 w-full" style={{ marginBottom: gap }}>
          {header}
        </div>
      ) : null}

      {nodes.length === 0 ? (
        <div className="w-full">{emptyState}</div>
      ) : (
        // The connectors provide the inter-node spacing (rowGap 0), so each rule
        // spans exactly the gap between the node it follows and the next one.
        <div className="flex flex-col items-center w-full" style={{ rowGap: 0 }}>
          {nodes.map((node, index) => (
            <React.Fragment key={node.id}>
              <PathNode
                node={node}
                offsetX={offsets[index] ?? 0}
                index={index}
                onActivate={onActivate}
                size={nodeSize}
              />
              {index < segments.length ? (
                // Segment i threads node i → node i+1. It reads as "traversed"
                // (solid, tinted with the upper node's tone) once that node is
                // complete, else "upcoming" (dashed, muted) — status resolved
                // upstream, so this layer names no status (L090).
                <PathConnector
                  segment={segments[index]}
                  gap={gap}
                  color={node.complete ? node.toneColor : UPCOMING_CONNECTOR_COLOR}
                  dashed={!node.complete}
                />
              ) : null}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
