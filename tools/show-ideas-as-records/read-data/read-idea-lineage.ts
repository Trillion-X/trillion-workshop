// package-set://bitfield-studio/packages/ideas/read-data/read-idea-lineage.ts
//
// Relationship projection adapter. Lineage is not a package-specific backend
// shape; it is a descriptor-selected link field over generic records.

import {
  relationshipTreeFor,
  type IdeasRelationshipDescriptor,
} from './read-ideas.ts';
import type {
  VisualDatabaseFieldDescriptor,
  VisualDatabaseRecord,
} from '../../keep-lists-of-rows/read-data/visual-database.ts';

export interface IdeasRelationshipProjection {
  relationship: IdeasRelationshipDescriptor;
  rootCount: number;
  nodeCount: number;
}

function countNodes(nodes: readonly { children: readonly unknown[] }[]): number {
  return nodes.reduce((total, node) => {
    const children = node.children as readonly { children: readonly unknown[] }[];
    return total + 1 + countNodes(children);
  }, 0);
}

export function projectIdeasRelationship(
  records: readonly VisualDatabaseRecord[],
  fields: readonly VisualDatabaseFieldDescriptor[],
  relationship: IdeasRelationshipDescriptor,
): IdeasRelationshipProjection {
  const tree = relationshipTreeFor(records, fields, relationship);
  return {
    relationship,
    rootCount: tree.roots.length,
    nodeCount: countNodes(tree.roots),
  };
}
