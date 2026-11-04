// packages/documents/do-work/build-resize-transaction.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The PURE resize→engine-transaction decision, extracted from the surface so it
// is testable without React, the engine, or async. Given a node, a candidate
// rect, the active handle, and the current tree, it produces the exact
// CompositionTransaction the engine should apply:
//
//   - ALWAYS a UPDATE_PROPS writing props.style.width/height (the engine sizes
//     from props — convergence F1/F2). Idempotent: re-sending the same rect is a
//     no-op converging write.
//   - A layout_patch (origin) ONLY when the handle moves the top-left
//     (handleMovesOrigin: a west/north grip) AND the node's parent positions
//     children absolutely so the origin is author-owned (nodeAuthorsOrigin).
//     Both are read STRUCTURALLY — from the handle and the tree — never by
//     diffing async engine-snapshot coordinates, which rounding + reply latency
//     could defeat (convergence 2026-06-20 Q1 FAIL → this function is the fix).
//
// Keeping this pure is also the structural guard that caught the class of bug
// where the surface referenced a deleted variable: the decision now has a typed
// return and a test, so a wrong reference fails the suite, not production.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { handleMovesOrigin, type SceneResizeHandleId, type SceneResizeRect } from '../../ui';
import {
  nodeAuthorsOrigin,
  type CompositionTransaction,
  type SceneNode,
} from '../read-data/documents';

export type ResizeTransactionInput = {
  nodeId: string;
  rect: SceneResizeRect;
  handle: SceneResizeHandleId;
  tree: SceneNode | null;
  /** The node's current props (so the resize merges, never clobbers, siblings of style). */
  existingProps: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function buildResizeTransaction(input: ResizeTransactionInput): CompositionTransaction {
  const { nodeId, rect, handle, tree, existingProps } = input;
  const existingStyle = isRecord(existingProps.style) ? existingProps.style : {};
  const shouldPatchOrigin = handleMovesOrigin(handle) && nodeAuthorsOrigin(tree, nodeId);
  return {
    scene_patches: [
      {
        type: 'UPDATE_PROPS',
        node_id: nodeId,
        changes: {
          props: {
            ...existingProps,
            style: { ...existingStyle, width: Math.round(rect.w), height: Math.round(rect.h) },
          },
        },
      },
    ],
    ...(shouldPatchOrigin
      ? { layout_patches: [{ node_id: nodeId, x: Math.round(rect.x), y: Math.round(rect.y) }] }
      : {}),
  };
}
