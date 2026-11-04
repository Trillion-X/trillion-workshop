// packages/addressed-marks/show/MarkInputLayer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE single drawing input surface. One interactive layer captures pointer
// strokes; the SPACE OWNER that mounts it supplies resolvePointerSpace, which
// answers — for the point where a stroke starts — "which addressed space is
// under the pointer, and how do client pixels map into its coordinate frame?"
//
// This is the seam that makes "draw on anything" a closed category (L063):
// - addressed-marks owns ink physics: capture, tool point-mappers, draft
//   preview, erase-by-reference, append-only operation writes.
// - the mounting owner owns space resolution: tabs, floating windows, PIP
//   boxes, the canvas world, the arrangement frame — or a PDF page, a video
//   frame, a 3D object in some future package. New drawable space = new
//   resolver entry in the SPACE OWNER. Zero changes here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The layer never knows what a tab/window/world IS — only MarkPointerSpace
// 2. One stroke = one addressed space, resolved once at pointer-down
// 3. Coordinates are never clamped — ink may extend past its space's bounds
// 4. Erase appends effects.hide_refs operations; nothing is mutated/deleted
// 5. Tool behavior comes from tool RECORDS (mapper/mode data), never branches
//    on tool ids
// 6. Draft preview renders in client pixels; recorded points use the space's
//    coordinate frame (mappers are affine-stable, so preview matches result)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import React from 'react';
import {
  mapPointsForTool,
  materializeMarkRecords,
  nearestMarkPathRef,
  readMarkOperationRecords,
  toolEmitsClosedSet,
  toolErases,
  type MarkCoordinatePoint,
  type MarkStyleRecord,
  type MarkTarget,
} from '../read-data/addressed-marks';
import { recordMarkOperation, type MarkOperationWrite } from '../do-work/record-mark-operation';
import { useMarkSession } from './MarkSessionContext';
import { useMarkOperations, useMarkStyles, useMarkTools } from './use-mark-data';
import { cn } from '../../ui/show/cn';

/** One addressed space under the pointer, supplied by the mounting owner. */
export interface MarkPointerSpace {
  /** The addressed target operations will reference. */
  target: MarkTarget;
  /** Map a client-pixel point into the target's coordinate frame. */
  toCoordinate: (clientX: number, clientY: number) => MarkCoordinatePoint;
  /** Erase hit radius in the target's coordinate units (e.g. 0.02 normalized, 8/zoom world px). */
  hitRadius: number;
}

export interface MarkInputLayerProps {
  /** Resolve the addressed space at a client point; null ignores the stroke. */
  resolvePointerSpace: (clientX: number, clientY: number) => MarkPointerSpace | null;
  className?: string;
}

function strokeColorFor(style: MarkStyleRecord | undefined): string {
  if (style?.stroke) return style.stroke;
  if (style?.strokeToken) return `var(${style.strokeToken})`;
  return 'var(--color-info)';
}

function operationId(): string {
  return `mark:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function MarkInputLayer({ resolvePointerSpace, className }: MarkInputLayerProps) {
  const session = useMarkSession();
  const operations = useMarkOperations();
  const styles = useMarkStyles();
  const tools = useMarkTools();
  const [draftClientPoints, setDraftClientPoints] = React.useState<readonly MarkCoordinatePoint[]>([]);
  const strokeRef = React.useRef<{
    space: MarkPointerSpace;
    coordinatePoints: MarkCoordinatePoint[];
  } | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  const activeTool = React.useMemo(
    () => tools.find((tool) => tool.id === session?.toolRef) ?? tools[0],
    [tools, session?.toolRef],
  );
  const activeStyle = React.useMemo(
    () => styles.find((style) => style.id === session?.styleRef) ?? styles[0],
    [styles, session?.styleRef],
  );
  const enabled = session?.enabled ?? false;
  const erasing = toolErases(activeTool);

  const mergedOperations = React.useMemo(() => {
    const feedIds = new Set(operations.map((operation) => operation.id));
    const optimistic = (session?.optimisticOperations ?? []).filter((operation) => !feedIds.has(operation.id));
    return [...operations, ...optimistic];
  }, [operations, session?.optimisticOperations]);

  const record = React.useCallback((write: MarkOperationWrite) => {
    const echo = readMarkOperationRecords([{
      id: write.id,
      target: write.target,
      tool_ref: write.toolRef,
      style_ref: write.styleRef,
      created_at: write.createdAt,
      sequence: write.sequence,
      body: write.body,
    }])[0];
    if (echo) session?.addOptimisticOperation(echo);
    session?.setLastTarget(write.target);
    recordMarkOperation(write).catch((error) => {
      console.error('[AddressedMarks] save failed', error);
    });
  }, [session]);

  const endStroke = React.useCallback((clientX: number, clientY: number) => {
    const stroke = strokeRef.current;
    strokeRef.current = null;
    setDraftClientPoints([]);
    if (!stroke) return;
    const points = [...stroke.coordinatePoints, stroke.space.toCoordinate(clientX, clientY)];

    if (erasing) {
      const material = materializeMarkRecords({
        operations: mergedOperations,
        styles,
        target: stroke.space.target,
      });
      const hideRefs = new Set<string>();
      for (const point of points) {
        const ref = nearestMarkPathRef(material, point, stroke.space.hitRadius);
        if (ref) hideRefs.add(ref);
      }
      if (!hideRefs.size) return;
      record({
        id: operationId(),
        target: stroke.space.target,
        toolRef: activeTool?.id,
        createdAt: new Date().toISOString(),
        body: { coordinate_sets: [], effects: { hide_refs: [...hideRefs] } },
      });
      return;
    }

    const mapped = mapPointsForTool(activeTool, points);
    if (mapped.length < 2) return;
    const strokeWidthOverride = session?.strokeWidth ?? null;
    const operationStyle: Record<string, unknown> = {};
    if (strokeWidthOverride !== null) operationStyle.stroke_width = strokeWidthOverride;
    if (session?.fillEnabled) {
      operationStyle.fill = strokeColorFor(activeStyle);
      operationStyle.fill_opacity = 0.3;
    }
    record({
      id: operationId(),
      target: stroke.space.target,
      toolRef: activeTool?.id,
      styleRef: activeStyle?.id,
      createdAt: new Date().toISOString(),
      body: {
        coordinate_sets: [
          {
            id: 'path:0',
            closed: toolEmitsClosedSet(activeTool),
            points: mapped.map((point) => ({ values: [...point.values] })),
          },
        ],
        effects: {},
        ...(Object.keys(operationStyle).length > 0 ? { style: operationStyle } : {}),
      },
    });
  }, [erasing, mergedOperations, styles, activeTool, activeStyle, session?.strokeWidth, session?.fillEnabled, record]);

  // Escape hatch: the toolbar must never be the only exit from draw mode.
  // If anything covers or hides the toolbar, Escape always releases the
  // pointer-capturing layer.
  React.useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      strokeRef.current = null;
      setDraftClientPoints([]);
      session?.setEnabled(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, session]);

  if (!session) return null;

  const draftPreviewPoints = erasing ? [] : mapPointsForTool(activeTool, draftClientPoints);
  const rootRect = rootRef.current?.getBoundingClientRect();
  const previewStrokeWidth = session.strokeWidth ?? activeStyle?.strokeWidth ?? 3;

  return (
    <div
      ref={rootRef}
      data-testid="mark-input-layer"
      className={cn(
        'absolute inset-0',
        enabled ? 'pointer-events-auto touch-none' : 'pointer-events-none',
        enabled && (erasing ? 'cursor-cell' : 'cursor-crosshair'),
        className,
      )}
      onPointerDown={enabled ? (event) => {
        if (event.button !== 0) return;
        const space = resolvePointerSpace(event.clientX, event.clientY);
        if (!space) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        strokeRef.current = {
          space,
          coordinatePoints: [space.toCoordinate(event.clientX, event.clientY)],
        };
        setDraftClientPoints([{ values: [event.clientX, event.clientY] }]);
      } : undefined}
      onPointerMove={enabled ? (event) => {
        const stroke = strokeRef.current;
        if (!stroke) return;
        stroke.coordinatePoints.push(stroke.space.toCoordinate(event.clientX, event.clientY));
        setDraftClientPoints((current) => [...current, { values: [event.clientX, event.clientY] }]);
      } : undefined}
      onPointerUp={enabled ? (event) => {
        if (!strokeRef.current) return;
        endStroke(event.clientX, event.clientY);
      } : undefined}
      onPointerCancel={enabled ? () => {
        strokeRef.current = null;
        setDraftClientPoints([]);
      } : undefined}
    >
      {enabled && draftPreviewPoints.length > 1 && rootRect ? (
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`${rootRect.left} ${rootRect.top} ${rootRect.width} ${rootRect.height}`}
          preserveAspectRatio="none"
        >
          <path
            d={draftPreviewPoints
              .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.values[0]} ${point.values[1]}`)
              .join(' ')
              .concat(toolEmitsClosedSet(activeTool) ? ' Z' : '')}
            fill={session.fillEnabled ? strokeColorFor(activeStyle) : 'none'}
            fillOpacity={session.fillEnabled ? 0.3 : 1}
            stroke={strokeColorFor(activeStyle)}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={previewStrokeWidth}
            strokeOpacity={activeStyle?.strokeOpacity ?? 1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
    </div>
  );
}
