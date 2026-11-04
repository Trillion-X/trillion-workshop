// packages/addressed-marks/show/AddressedMarkOverlay.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Display overlay for one addressed target: reads admitted mark records from
// current log state, merges the live session's optimistic operations, and
// materializes the target's visible paths. Pointer INPUT belongs to
// MarkInputLayer (one capture layer per space owner); this overlay can still
// capture strokes itself for standalone hosts (`interactive`), e.g. the
// Marks surface, but display-only is the default integration mode.
//
// Reads require the mounting entry to declare the addressed-marks read scope
// as data (entry-read-scope-packages.json). Entries without the declaration
// degrade to empty data instead of crashing — degradation is tolerance, not
// the contract.
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
  readMarkOperationRecords,
  markTargetKey,
  type MarkCoordinatePoint,
  type MarkOperationRecord,
  type MarkTarget,
} from '../read-data/addressed-marks';
import { recordMarkOperation, type MarkOperationWrite } from '../do-work/record-mark-operation';
import { AddressedMarkLayer } from './AddressedMarkLayer';
import { useMarkSession } from './MarkSessionContext';
import { useMarkOperations, useMarkStyles, useMarkTools } from './use-mark-data';
import { cn } from '../../ui/show/cn';

export interface AddressedMarkOverlayProps {
  target: MarkTarget;
  /** Capture strokes directly (standalone hosts only — MarkInputLayer owns input otherwise). */
  enabled: boolean;
  className?: string;
  coordinateFromPointer?: (event: React.PointerEvent<SVGSVGElement>) => MarkCoordinatePoint;
  viewBox?: string;
}

function operationRecordFromWrite(operation: MarkOperationWrite): MarkOperationRecord {
  return readMarkOperationRecords([{
    id: operation.id,
    target: operation.target,
    tool_ref: operation.toolRef,
    style_ref: operation.styleRef,
    created_at: operation.createdAt,
    sequence: operation.sequence,
    body: operation.body,
  }])[0]!;
}

export function AddressedMarkOverlay({
  target,
  enabled,
  className,
  coordinateFromPointer,
  viewBox,
}: AddressedMarkOverlayProps) {
  const session = useMarkSession();
  const feedOperations = useMarkOperations();
  const styles = useMarkStyles();
  const tools = useMarkTools();
  const [localOperations, setLocalOperations] = React.useState<readonly MarkOperationRecord[]>([]);

  const targetKey = React.useMemo(() => markTargetKey(target), [target]);
  const operations = React.useMemo(() => {
    const feedIds = new Set(feedOperations.map((operation) => operation.id));
    const sessionOperations = (session?.optimisticOperations ?? [])
      .filter((operation) => !feedIds.has(operation.id) && markTargetKey(operation.target) === targetKey);
    const local = localOperations.filter((operation) => !feedIds.has(operation.id));
    return [...feedOperations, ...sessionOperations, ...local];
  }, [feedOperations, session?.optimisticOperations, localOperations, targetKey]);

  const selectedStyleRef = (session?.styleRef || undefined) ?? styles[0]?.id ?? 'style:primary-line';
  const selectedToolRef = (session?.toolRef || undefined) ?? tools[0]?.id ?? 'tool:draw';

  const recordOperation = React.useCallback((operation: MarkOperationWrite) => {
    setLocalOperations((current) => [...current, operationRecordFromWrite(operation)]);
    recordMarkOperation(operation).catch((error) => {
      console.error('[AddressedMarks] save failed', error);
    });
  }, []);

  // Session display toggle: ink stays in the log, only rendering pauses.
  if (session && !session.marksVisible) return null;

  return (
    <AddressedMarkLayer
      target={target}
      operations={operations}
      styles={styles}
      selectedStyleRef={selectedStyleRef}
      selectedToolRef={selectedToolRef}
      onRecordOperation={recordOperation}
      coordinateFromPointer={coordinateFromPointer}
      interactive={enabled}
      viewBox={viewBox}
      ariaLabel="Draw on addressed space"
      className={cn(
        'absolute inset-0 h-full w-full touch-none',
        enabled ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none',
        className,
      )}
    />
  );
}
