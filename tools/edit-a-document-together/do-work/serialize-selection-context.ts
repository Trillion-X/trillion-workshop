// packages/documents/do-work/serialize-selection-context.ts
//
// Serializes a selected scene subtree into a self-describing payload any
// action reference can consume as input. The serializer never names or
// branches on consumers.

import type { SceneNode } from '../read-data/documents';
import { visibleTextLines } from './project-scene-to-file-request';

export type SelectionContextPayload = {
  kind: 'composition-selection-context';
  scene_address: string;
  node_id: string;
  authored_thing_ref?: string;
  text: string;
  node_count: number;
  nodes: SceneNode[];
};

function countNodes(node: SceneNode): number {
  return 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

export function serializeSelectionContext(input: {
  subtree: SceneNode;
  sceneAddress: string;
  authoredThingRef?: string;
}): SelectionContextPayload {
  const { subtree, sceneAddress, authoredThingRef } = input;
  const payload: SelectionContextPayload = {
    kind: 'composition-selection-context',
    scene_address: sceneAddress,
    node_id: subtree.id,
    text: visibleTextLines(subtree).join('\n'),
    node_count: countNodes(subtree),
    nodes: [subtree],
  };
  if (authoredThingRef) {
    payload.authored_thing_ref = authoredThingRef;
  }
  return payload;
}
