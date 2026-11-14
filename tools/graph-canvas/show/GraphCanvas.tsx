// bitfield/packages/graph-canvas/GraphCanvas.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic 2D spatial canvas with pan/zoom/drag and node rendering.
// Completely domain-agnostic — renders a list of node frames and edge routes
// as provided by the consumer.
//
// Canvas interaction state is owned by the caller-facing graph primitive
// (use-graph-canvas) and passed in through props/callbacks. This component
// stays a pure renderer over node frames, edge routes, and camera state.
//
// Architecture:
//   - useGraphCanvas (or another local owner) owns camera + interaction state
//   - Consumer controls data flow via props (nodes, edgeRoutes)
//   - CanvasWorldTransform applies pan/zoom transform
//   - Nodes are rendered via CanvasNode wrapper
//   - Edges are SVG overlay via CanvasEdgeOverlay
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Canvas has ZERO application vocabulary — only generic node/edge terms
// 2. All DOM elements use ui/ components (Container, CanvasNode, etc.)
// 3. No inline styles except computed transforms (Physics-layer exception)
// 4. Node rendering via renderNode() callback — canvas only handles positioning
// 5. Edge rendering via renderEdge() callback or DefaultEdge
// 6. Loading/error states use ui components (Spinner, Text, Container)
// 7. Empty state defers to consumer emptyState prop
// 8. ZERO application-owned interaction state here — callers own that seam
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useCallback, useRef } from 'react';
import { DefaultEdge } from './DefaultEdge';
import { Container, Spinner, Text, CanvasNode, CanvasWorldTransform, CanvasEdgeOverlay } from '../../ui';
import type { CanvasNodeFrame, EdgeRoute, EngineState, EngineError, CanvasCamera } from './types';

const CANVAS_SURFACE_STYLE = {
  backgroundColor: 'var(--bg-primary)',
} satisfies React.CSSProperties;

const GRAPH_NODE_INTERACTIVE_TARGET_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[data-graph-node-interactive]',
  '[data-no-drag]',
].join(',');

function isGraphNodeInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && !!target.closest(GRAPH_NODE_INTERACTIVE_TARGET_SELECTOR);
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface GraphCanvasProps {
  /** Array of visible node frames (position + bounding box) */
  nodes: CanvasNodeFrame[];
  /** Array of edge routes (path points) */
  edgeRoutes?: EdgeRoute[];
  /** Called when a node drag ends with final world-space position */
  onNodeDragEnd?: (nodeId: string, position: { x: number; y: number }) => void;
  /** Called when a node is clicked (not dragged) */
  onNodeSelect?: (nodeId: string) => void;
  /** Custom edge renderer — if not provided, uses DefaultEdge */
  renderEdge?: (route: EdgeRoute, isSelected?: boolean) => React.ReactNode;
  /** Custom node renderer — must handle positioning and content */
  renderNode: (node: CanvasNodeFrame) => React.ReactNode;
  /** Empty state content (shown when nodes.length === 0 && engineState === 'ready') */
  emptyState?: React.ReactNode;
  /** Overlay children (inspector panels, AI overlays, etc.) */
  children?: React.ReactNode;
  /**
   * Generic visual underlay rendered behind the world transform and nodes (e.g.
   * a region wallpaper / dot-grid layer stack). GraphCanvas stays domain-blind —
   * it receives a node, never a background "kind". The neutral theme surface
   * (var(--bg-primary)) remains; the underlay paints on top of it, behind nodes.
   */
  underlay?: React.ReactNode;
  /** Engine lifecycle state for loading/error display */
  engineState?: EngineState;
  /** Engine error object */
  engineError?: EngineError | null;
  /** Custom empty state renderer — overrides default */
  renderEmptyState?: () => React.ReactNode;
  /** Camera state supplied by the caller-owned graph interaction seam */
  camera?: CanvasCamera;
  /** Selected node ID supplied by the caller-owned graph interaction seam */
  selectedNodeId?: string | null;
  /** Dragged node ID supplied by the caller-owned graph interaction seam */
  draggedNodeId?: string | null;
  /** Node selection callback supplied by the caller */
  selectNode?: (nodeId: string | null) => void;
  /** Drag-start callback supplied by the caller */
  startNodeDrag?: (nodeId: string, screenX: number, screenY: number, pointerId: number) => void;
  /** Drag-move callback supplied by the caller */
  updateNodeDragPosition?: (screenX: number, screenY: number, nodeStartX: number, nodeStartY: number) => void;
  /** Drag-end callback supplied by the caller */
  endNodeDrag?: (callback: (nodeId: string, finalX: number, finalY: number) => void) => void;
  /** Zoom-to-fit callback supplied by the caller */
  zoomToFit?: (nodes: Array<{ x: number; y: number; width: number; height: number }>) => boolean | void;
  /** Ref to the canvas container owned by the caller */
  canvasRef?: React.RefObject<HTMLDivElement | null>;
  /** Background pointer-down handler for pan/deselect ownership */
  onCanvasPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Live position for the currently dragged node */
  draggedNodePosition?: { x: number; y: number } | null;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Generic 2D spatial canvas for rendering graphs of nodes and edges.
 * Pure renderer — interaction state and callbacks are owned by the caller.
 *
 * Pan:   caller wires background pointer / wheel behavior
 * Zoom:  caller wires wheel / pinch behavior
 * Zoom-to-fit: double-click on background
 * Select: click on node
 * Deselect: caller-owned
 * Drag: pointer-down on node → pointer-move → pointer-up
 */
export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  nodes,
  edgeRoutes = [],
  onNodeDragEnd,
  onNodeSelect,
  renderEdge,
  renderNode,
  emptyState,
  children,
  underlay,
  engineState = 'ready',
  engineError = null,
  renderEmptyState,
  camera = { pan_x: 0, pan_y: 0, zoom: 1 },
  selectedNodeId = null,
  draggedNodeId = null,
  selectNode,
  startNodeDrag,
  updateNodeDragPosition,
  endNodeDrag,
  zoomToFit,
  canvasRef: externalCanvasRef,
  onCanvasPointerDown,
  draggedNodePosition = null,
}) => {
  const internalCanvasRef = useRef<HTMLDivElement>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;

  // Track node start position for drag calculation
  const nodeStartPositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // True when the pointer-up that just happened ended a REAL move (not a tap).
  // Browsers fire a click event after every pointer-up — selecting a node the
  // user was actually dragging is wrong, so the post-drag click is swallowed.
  const dragMovedRef = useRef(false);
  const pointerDownScreenRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const DRAG_SELECT_SUPPRESS_DISTANCE_PX = 4;
  const [autoFitViewportVersion, setAutoFitViewportVersion] = React.useState(0);

  // ---------------------------------------------------------------------------
  // LIFECYCLE: Zoom-to-fit on initial load
  // ---------------------------------------------------------------------------

  const didInitialFitRef = useRef(false);
  useEffect(() => {
    if (didInitialFitRef.current || nodes.length === 0 || engineState !== 'ready' || !zoomToFit) return;
    const element = canvasRef.current;
    if (!element) return;

    if (typeof ResizeObserver === 'undefined') {
      const frame = window.requestAnimationFrame(() => {
        setAutoFitViewportVersion((version) => version + 1);
      });
      return () => window.cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver(() => {
      setAutoFitViewportVersion((version) => version + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasRef, engineState, nodes.length, zoomToFit]);

  useEffect(() => {
    if (nodes.length > 0 && !didInitialFitRef.current && engineState === 'ready' && zoomToFit) {
      const didFit = zoomToFit(nodes);
      if (didFit === false) return;
      didInitialFitRef.current = true;
    }
  }, [autoFitViewportVersion, engineState, nodes, nodes.length, zoomToFit]);

  // ---------------------------------------------------------------------------
  // NODE INTERACTION — thin wrappers calling SDK callbacks
  // ---------------------------------------------------------------------------

  const handleNodePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, nodeId: string, node: CanvasNodeFrame) => {
      if (isGraphNodeInteractiveTarget(e.target)) return;
      // Drags are primary-button only. A secondary-button press must not
      // capture the pointer or enter drag state — it would swallow the
      // contextmenu event that follows (right-click menus die silently).
      if (e.button !== 0) return;
      e.stopPropagation();
      // Recorded whether or not nodes drag: the move-distance check that tells a drag from a click measures from
      // this press, and without it any pointer movement reads as a drag and swallows the click.
      pointerDownScreenRef.current = { x: e.clientX, y: e.clientY };
      dragMovedRef.current = false;
      if (!startNodeDrag) return;
      nodeStartPositionRef.current = { x: node.x, y: node.y };
      e.currentTarget.setPointerCapture(e.pointerId);
      startNodeDrag(nodeId, e.clientX, e.clientY, e.pointerId);
    },
    [startNodeDrag]
  );

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragMovedRef.current) {
        const dx = e.clientX - pointerDownScreenRef.current.x;
        const dy = e.clientY - pointerDownScreenRef.current.y;
        if ((dx * dx + dy * dy) > DRAG_SELECT_SUPPRESS_DISTANCE_PX * DRAG_SELECT_SUPPRESS_DISTANCE_PX) {
          dragMovedRef.current = true;
        }
      }
      updateNodeDragPosition?.(e.clientX, e.clientY, nodeStartPositionRef.current.x, nodeStartPositionRef.current.y);
    },
    [updateNodeDragPosition]
  );

  const handleCanvasPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      endNodeDrag?.((nodeId, finalX, finalY) => {
        onNodeDragEnd?.(nodeId, { x: finalX, y: finalY });
      });
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [endNodeDrag, onNodeDragEnd]
  );

  const handleNodeClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, nodeId: string) => {
      if (isGraphNodeInteractiveTarget(e.target)) return;
      // A drag is not a click: the post-drag click event must not select.
      if (dragMovedRef.current) {
        dragMovedRef.current = false;
        return;
      }
      selectNode?.(nodeId);
      onNodeSelect?.(nodeId);
    },
    [selectNode, onNodeSelect]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-graph-node]') && zoomToFit) {
        zoomToFit(nodes);
      }
    },
    [zoomToFit, nodes]
  );

  // ---------------------------------------------------------------------------
  // LOADING STATE
  // ---------------------------------------------------------------------------

  if (engineState === 'booting' || engineState === 'setting_scene') {
    return (
      <Container
        ref={canvasRef}
        layout="vertical"
        height="full"
        width="full"
        flex={1}
        minHeight="0"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
        style={CANVAS_SURFACE_STYLE}
      >
        <Container layout="vertical" gap="md" alignItems="center">
          <Spinner size="md" aria-label={engineState === 'booting' ? 'Initializing engine' : 'Loading scene'} />
          <Text variant="body-xs" color="muted">
            {engineState === 'booting' ? 'Initializing engine' : 'Loading scene'}
          </Text>
        </Container>
      </Container>
    );
  }

  // ---------------------------------------------------------------------------
  // ERROR STATE
  // ---------------------------------------------------------------------------

  if (engineState === 'error' || engineError) {
    return (
      <Container
        ref={canvasRef}
        layout="vertical"
        height="full"
        width="full"
        flex={1}
        minHeight="0"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
        padding="lg"
        style={CANVAS_SURFACE_STYLE}
      >
        <Container layout="vertical" gap="sm" alignItems="center" maxWidth="md">
          <Text variant="body-xs" color="error" weight="semibold">
            {engineError?.type ?? 'Error'}
          </Text>
          <Text variant="body-xs" color="muted">
            {engineError?.message ?? 'An error occurred'}
          </Text>
        </Container>
      </Container>
    );
  }

  // ---------------------------------------------------------------------------
  // EMPTY STATE
  // ---------------------------------------------------------------------------

  if (nodes.length === 0) {
    return (
      <Container
        ref={canvasRef}
        layout="vertical"
        height="full"
        width="full"
        flex={1}
        minHeight="0"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
        position="relative"
        style={CANVAS_SURFACE_STYLE}
      >
        {renderEmptyState?.() ?? emptyState ?? <Text variant="heading-sm" color="muted">No nodes to display</Text>}
        {children}
      </Container>
    );
  }

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  // Pan/zoom/keyboard handled by SDK via canvasRef event listeners.
  // Only node-level pointer events need React handlers (for drag + click).

  return (
    <Container
      ref={canvasRef}
      layout="vertical"
      height="full"
      width="full"
      flex={1}
      minHeight="0"
      overflow="hidden"
      position="relative"
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      onPointerDown={onCanvasPointerDown}
      onDoubleClick={handleDoubleClick}
      tabIndex={0}
      style={{
        backgroundColor: 'var(--bg-primary)',
        boxShadow: 'inset 0 0 0 1px var(--border-primary)',
      }}
    >
      {/* Visual underlay (region wallpaper / dot-grid layer stack), behind nodes. */}
      {underlay ? (
        <Container position="absolute" inset="0" pointerEvents="none">
          {underlay}
        </Container>
      ) : null}
      {/* World layer: applies pan/zoom transform via CanvasWorldTransform */}
      <CanvasWorldTransform panX={camera.pan_x} panY={camera.pan_y} zoom={camera.zoom}>
        {/* Nodes — rendered via CanvasNode wrapper */}
        {nodes.map(node => {
          const renderX = draggedNodeId === node.id && draggedNodePosition
            ? draggedNodePosition.x
            : node.x;
          const renderY = draggedNodeId === node.id && draggedNodePosition
            ? draggedNodePosition.y
            : node.y;
          return (
          <CanvasNode
            key={node.id}
            x={renderX}
            y={renderY}
            width={node.width}
            height={node.height}
            isDragging={draggedNodeId === node.id}
            selected={selectedNodeId === node.id}
            onPointerDown={e => handleNodePointerDown(e, node.id, node)}
            onClick={e => handleNodeClick(e, node.id)}
          >
            {renderNode(node)}
          </CanvasNode>
          );
        })}
      </CanvasWorldTransform>

      {/* SVG overlay: renders edges via CanvasEdgeOverlay */}
      <CanvasEdgeOverlay panX={camera.pan_x} panY={camera.pan_y} zoom={camera.zoom}>
        {edgeRoutes.map(route => (
          <g key={route.edge_id}>
            {renderEdge ? renderEdge(route, selectedNodeId === route.edge_id) : <DefaultEdge route={route} isSelected={selectedNodeId === route.edge_id} />}
          </g>
        ))}
      </CanvasEdgeOverlay>

      {/* Overlay content (inspector, AI panel, etc.) */}
      {children}
    </Container>
  );
};
