// packages/ui/show/node-actions/index.ts
export {
  NODE_REF_ATTR,
  serializeNodeRef,
  parseNodeRef,
  sameNodeRef,
  closestNodeRef,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';
export type { NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';
export {
  acceptedNodeActions,
  indexNodeActions,
} from './node-action-types';
export type { NodeActionCapability, NodeActionPack } from './node-action-types';
export {
  acceptedBatchActions,
  indexBatchActions,
} from './batch-action-types';
export type { BatchActionCapability, BatchActionPack, BatchRunContext } from './batch-action-types';
export { useNodeContextMenu } from './NodeContextMenu';
export type { NodeContextMenuHandle } from './NodeContextMenu';
export { contributeNodeActions, contributedNodeActions } from './contributed-node-actions';
