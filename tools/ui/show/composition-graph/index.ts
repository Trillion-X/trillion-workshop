// packages/ui/show/composition-graph/index.ts
//
// Public surface of the Recursive NodeRef Composition Graph — the one primitive
// container/tab-group/layout/group/board/archive are all configurations of.
// Membership is the `members` facet; every other behavior (layers, chrome,
// actions, drops, renderers) resolves through the uniform FacetRegistry.

export type { CompositionNode, GroupMember, CompositionGraph, FoldVisit } from './composition-node'
export {
  EMPTY_COMPOSITION_GRAPH,
  nodeKey,
  getNode,
  orderedMembers,
  ensureNode,
  addMember,
  removeMember,
  moveMember,
  foldGroup,
  flattenGroup,
} from './composition-node'

export type { FacetRegistry } from './facet-registry'
export { facetRegistryFromMap, facetRegistryFromGetter, resolveFacet } from './facet-registry'
