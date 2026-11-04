// src/own-records-pursuits.mjs
//
// PURPOSE
//   An independently addressed work resource (a case's own book, `work:…`) keeps its decisions, while the person's
//   pursuits live in the account's own records (`@own-records`, where pursuits:replace writes them). This gives a
//   resource's decision engine (src/engine.mjs) its decisions from its own store and its pursuits from the account's
//   own records, read at the moment the engine asks, so a case in its own book cites, weighs and counts the person's
//   current pursuits exactly as one in the account's records does.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pursuits are addressed, never copied: `readPursuits(ids)` asks the account's own records each time, and a write
//      of the engine's state here writes its decisions only, so no pursuit is ever kept in the work resource.
//   2. Everything else about the store is the resource's own store, unchanged.
//
//   INDEPENDENT_WORK_PREFIX, isIndependentWork(resource): the name every independently created work resource has
//     (src/native-own-consumer-context.mjs makes them), and whether a resource is one. Such a resource reads the
//     account's pursuits and published agents from its own records; a project (`project:…`) keeps its own.
//   decisionsWithOwnPursuits(store, readPursuits) → the store the decision engine is given
//     readPursuits(ids | null) → Promise<{ [pursuit id]: pursuit }>   (null: every current pursuit)

export const INDEPENDENT_WORK_PREFIX = 'work:';
export const isIndependentWork = resource => typeof resource === 'string' && resource.startsWith(INDEPENDENT_WORK_PREFIX);

export function decisionsWithOwnPursuits(store, readPursuits) {
  return {
    ...store,
    // The engine's paged pursuit read is the resource's own store's; its pursuits are read whole from the account instead.
    pursuitPage: null,
    async read(scope) {
      const { cases } = store.read({ cases: scope?.cases ?? undefined, pursuits: [] });
      return { cases, pursuits: await readPursuits(Array.isArray(scope?.pursuits) ? scope.pursuits : null) };
    },
    async readStep(id, stepId, citedRefs = null) {
      const found = store.readStep(id, stepId, []);
      if (!found || stepId === null) return found;
      return { ...found, pursuits: await readPursuits(citedRefs === null ? null : [...new Set(citedRefs)]) };
    },
    write(state, context) { return store.write({ cases: state.cases ?? {} }, context); },
  };
}
