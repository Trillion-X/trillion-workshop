// parts/graph-canvas/show/types.ts
//
// PURPOSE
//   Generic canvas type primitives, from bitfield-packages packages/graph-canvas/show/types.ts. Zero application
//   vocabulary: any 2D graph (a workflow's steps, a funnel's stages, the arrangement's panes) is drawn from these.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Positions are world-space; the canvas transform applies pan and zoom.
//   2. Nothing here names what a node or an edge means.

/**
 * Camera state for the canvas: pan offset and zoom level. The world layer is drawn with
 * translate(pan_x px, pan_y px) scale(zoom). Zoom 1.0 = 100%, clamped to [0.1, 4.0] during interaction.
 */
export interface CanvasCamera {
  /** Horizontal pan offset in pixels (world-space) */
  pan_x: number;
  /** Vertical pan offset in pixels (world-space) */
  pan_y: number;
  /** Zoom multiplier (1.0 = 100%, 0.5 = 50%, 2.0 = 200%) */
  zoom: number;
}

/**
 * A renderable node on the canvas. Position (x, y) is the top-left of its bounding box in world-space; width and
 * height bound it for edge endpoints and hit testing.
 */
export interface CanvasNodeFrame {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A directed connection between two nodes as a routed path of world-space points, computed by the consumer. */
export interface EdgeRoute {
  edge_id: string;
  points: Array<{ x: number; y: number }>;
}

/** The canvas's lifecycle states, for its loading, error and empty display. */
export type EngineState =
  | 'uninitialized'
  | 'booting'
  | 'setting_scene'
  | 'ready'
  | 'error';

/** An error shown as it is; opaque to the canvas. */
export interface EngineError {
  type: string;
  message: string;
}
