// packages/workflow-canvas/show/workflow-canvas-types.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Shared show-layer node shape for the Workflow Canvas. A CanvasNode is a
// positioned projection of one real definition-store record (action or
// trigger) — frame geometry from graph-canvas plus the display payload from
// read-data. Ephemeral UI state only; durable truth stays in addressed feeds.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. `data` is the read-data display projection — components never re-derive
//    truth from raw feeds.
// 2. No Society copy here — labels and sentences are produced by read-data.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { WorkflowCanvasNodeDisplay } from '../read-data/read-workflow-canvas-layout';

/** A positioned, renderable canvas node. */
export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  data: WorkflowCanvasNodeDisplay;
}

/** Engine run state for one node, including transient pulses started on this canvas. */
export type CanvasRunState = 'running' | 'completed' | 'failed';
