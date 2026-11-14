// packages/ui/show/path-rail/index.ts
// Barrel for the winding learning-path primitives.

export { PathRail } from './PathRail';
export type { PathRailProps } from './PathRail';
export { PathNode } from './PathNode';
export type { PathNodeProps, PathNodeView } from './PathNode';
export { windingOffsets, connectorSegments } from './path-rail-geometry';
export type { WindingConfig, ConnectorSegment } from './path-rail-geometry';
export { PathConnector } from './PathConnector';
export type { PathConnectorProps } from './PathConnector';
export { decodePathNodes } from './decode-path-nodes';
export type {
  RawPathNode,
  PathStatusOverride,
  PathStatusOverrides,
  PathIconResolver,
  DecodePathNodesOptions,
} from './decode-path-nodes';
