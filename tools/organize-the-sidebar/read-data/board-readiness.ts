// packages/group/read-data/board-readiness.ts
//
// DEPENDENCY READINESS — the blind Physics engine behind "what can I actually start RIGHT NOW?". Given the
// board's dependency edges (A depends-on B => B must finish before A) and each card's completion, every card
// is one of three ALGEBRAIC states, fully determined by a truth-table over two facts (is the card itself
// done? does it still have a prerequisite that is measurably unfinished?):
//
//     done    — the card's own completion signal is >= 1 (nothing left to do here)
//     ready   — NOT done, and NO prerequisite is measurably unfinished (actionable now — the frontier)
//     blocked — NOT done, and at least one prerequisite is measurably unfinished (must wait — `blockedBy`)
//
// This is NOT a Society enum (no user could add a 4th status — it is the closed set of a two-boolean truth
// table, like Option/Result), so the status stays a fixed algebraic value; the status -> label/tone map for
// DISPLAY is the caller's DATA (the display twin of statusView), never a branch in this engine.
//
// It is distinct from every existing board readout: `board-agenda` orders by DATE, `board-critical-path`
// finds the LONGEST effort chain, `board-bottlenecks` finds graph cut-vertices, `board-forecast` predicts
// pace. Readiness is the intersection of the DEPENDENCY graph and COMPLETION state — the GTD/kanban "next
// actions" frontier — which none of those answer.
//
// GATE semantics (consistent with the `boardCompletion` SSOT — only TRACKED cards count): a prerequisite
// gates ONLY when it is MEASURABLY incomplete (`completionOf(id)` is a number AND < 1). An UNTRACKED
// prerequisite (no metric, no checklist -> undefined) contributes no "unfinished" signal, exactly as it
// contributes nothing to `boardCompletion`'s fraction — so it does NOT eternally block its dependents. A
// card is never "done" on an undefined signal either (you cannot prove an untracked card finished).
//
// Pure, deterministic (blockedBy de-duped + sorted), no I/O, no graph/completion imports — the graph +
// completion accessors are INJECTED (mirrors `criticalPathOf` taking `childrenOf`/`durationHoursOf`), so
// this stays a read-data leaf with zero import cycle. The do-work bridge (board-readiness-actions) builds
// the accessors from the relationship graph + `cardCompletion`.

/** The closed, Physics-determined status of a card under its dependencies. */
export type ReadinessStatus = 'done' | 'ready' | 'blocked';

/** One card's readiness verdict. `blockedBy` is empty unless `status === 'blocked'` (the prerequisite ids
 *  that are measurably unfinished, de-duped + sorted). */
export interface CardReadiness {
  readonly cardId: string;
  readonly status: ReadinessStatus;
  readonly blockedBy: readonly string[];
}

/**
 * Classify each card id from injected accessors.
 * @param cardIds       the content cards to classify (connectors/sections excluded by the caller)
 * @param completionOf  a card's unified completion in [0,1], or undefined when untracked
 * @param prerequisitesOf  the card ids that must finish before this one (its dependency children)
 */
export function classifyReadiness(
  cardIds: readonly string[],
  completionOf: (id: string) => number | undefined,
  prerequisitesOf: (id: string) => readonly string[],
): CardReadiness[] {
  const isDone = (id: string): boolean => {
    const c = completionOf(id);
    return c !== undefined && c >= 1;
  };
  // A prerequisite GATES only when it is measurably incomplete — tracked AND below done. Untracked (undefined)
  // is not a gate (same universe rule as boardCompletion), and a done prerequisite is cleared.
  const gates = (id: string): boolean => {
    const c = completionOf(id);
    return c !== undefined && c < 1;
  };
  return cardIds.map((cardId) => {
    if (isDone(cardId)) return { cardId, status: 'done', blockedBy: [] };
    const blockedBy = [...new Set(prerequisitesOf(cardId))].filter(gates).sort();
    return { cardId, status: blockedBy.length === 0 ? 'ready' : 'blocked', blockedBy };
  });
}

/** The READY frontier — the ids of cards actionable right now (not done, nothing gating them). Sorted. */
export function readyIds(readiness: readonly CardReadiness[]): string[] {
  return readiness.filter((r) => r.status === 'ready').map((r) => r.cardId).sort();
}

/** The BLOCKED rows — cards waiting on a measurably-unfinished prerequisite (each carries its blockers). */
export function blockedReadiness(readiness: readonly CardReadiness[]): CardReadiness[] {
  return readiness.filter((r) => r.status === 'blocked');
}
