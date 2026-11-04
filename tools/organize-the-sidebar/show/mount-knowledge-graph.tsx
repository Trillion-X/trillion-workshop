// packages/group/show/mount-knowledge-graph.tsx
//
// W8 §8 T2 — the knowledge-graph surface: a THIN React shell over the shared
// `graph-canvas` render primitive (the same P4 primitive W4 funnel uses live).
// ALL logic lives in the pure, offline-tested `buildKnowledgeGraphView`
// (read-data/knowledge-graph-view.ts); this file only wires the feed → that
// builder → CanvasView, and renders each node as a human-labelled CanvasNode.
// No record truth, no layout math, no rendering engine owned here.

import React from 'react';
import { Container, Text, ErrorBoundary, CanvasNode, mountReactSurface } from '../../ui';
import { useBitfieldData } from '#workspace-records';
import { CanvasView } from '../../graph-canvas/show/CanvasView';
import { useGraphCanvas } from '../../graph-canvas/show/use-graph-canvas';
import type { CanvasNodeFrame } from '../../graph-canvas/show/types';
import { buildKnowledgeGraphView } from '../read-data/knowledge-graph-view';
import { projectKnowledgeGraph } from '../read-data/read-knowledge-graph';

/** Never-empty input names so `useBitfieldData('')` can never throw (funnel precedent). */
const RECORDS_FALLBACK_INPUT = 'knowledge-graph-records';
const DESCRIPTORS_FALLBACK_INPUT = 'knowledge-graph-descriptors';

export type KnowledgeGraphInputs = { recordsInput: string; descriptorsInput: string };

/** Resolve the two surface inputs: the raw EEAF records feed + the T1 edge-source
 *  descriptor DATA feed. Both are DATA (bound by the placeable-surface record). */
export function readInputs(rawProps: Record<string, unknown>): KnowledgeGraphInputs {
  const si = (rawProps.surfaceInput && typeof rawProps.surfaceInput === 'object'
    ? (rawProps.surfaceInput as Record<string, unknown>)
    : rawProps);
  const pick = (a: unknown, b: unknown, fallback: string): string => {
    const v = typeof a === 'string' && a.length > 0 ? a : (typeof b === 'string' && b.length > 0 ? b : fallback);
    return v;
  };
  return {
    recordsInput: pick(si.records_input, rawProps.records_input, RECORDS_FALLBACK_INPUT),
    descriptorsInput: pick(si.descriptors_input, rawProps.descriptors_input, DESCRIPTORS_FALLBACK_INPUT),
  };
}

export function KnowledgeGraphRoot({ recordsInput, descriptorsInput }: KnowledgeGraphInputs) {
  // The mount reads RAW records + descriptor DATA and projects CLIENT-SIDE
  // (mirrors funnel): records + descriptors -> connection graph -> render frames.
  const records = useBitfieldData(recordsInput || RECORDS_FALLBACK_INPUT);
  const descriptors = useBitfieldData(descriptorsInput || DESCRIPTORS_FALLBACK_INPUT);
  const view = React.useMemo(
    () => buildKnowledgeGraphView(projectKnowledgeGraph(records, descriptors)),
    [records, descriptors],
  );

  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const graph = useGraphCanvas({ nodes: view.frames, canvasRef });

  const renderNode = React.useCallback((frame: CanvasNodeFrame) => {
    const node = view.nodes.get(frame.id);
    if (!node) return null;
    return (
      <CanvasNode
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        selected={graph.selectedNodeId === frame.id}
        data-graph-node
      >
        <Container layout="vertical" gap="xs" alignItems="center" justifyContent="center" padding="sm">
          <Text variant="body-xs" color={node.missing ? 'muted' : 'primary'} align="center">
            {node.label}
          </Text>
        </Container>
      </CanvasNode>
    );
  }, [view.nodes, graph.selectedNodeId]);

  return (
    <CanvasView
      containerRef={containerRef}
      canvasRef={canvasRef}
      reachRole="knowledge-graph"
      nodes={view.frames}
      edgeRoutes={view.edgeRoutes}
      renderNode={renderNode}
      camera={graph.camera}
      selectedNodeId={graph.selectedNodeId}
      draggedNodeId={graph.draggedNodeId}
      draggedNodePosition={graph.draggedNodePosition}
      selectNode={graph.selectNode}
      startNodeDrag={graph.startNodeDrag}
      updateNodeDragPosition={graph.updateNodeDragPosition}
      endNodeDrag={graph.endNodeDrag}
      zoomToFit={graph.zoomToFit}
      onCanvasPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest('[data-graph-node]')) {
          graph.selectNode(null);
          graph.startCanvasPan(event.clientX, event.clientY);
        }
      }}
      emptyState={(
        <Container layout="vertical" gap="md" alignItems="center" data-reach-role="empty-state">
          <Text variant="heading-sm" color="muted">No connections yet</Text>
          <Text variant="body-xs" color="muted" align="center">
            As your people, messages, and work connect, the map fills in here.
          </Text>
        </Container>
      )}
    />
  );
}

export function mountKnowledgeGraph(el: HTMLElement, rawProps: Record<string, unknown>) {
  const inputs = readInputs(rawProps ?? {});
  return mountReactSurface(
    el,
    <ErrorBoundary>
      <KnowledgeGraphRoot recordsInput={inputs.recordsInput} descriptorsInput={inputs.descriptorsInput} />
    </ErrorBoundary>,
  );
}
