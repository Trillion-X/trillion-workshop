// packages/permission-lease/read-data/condition-node-pack.ts
//
// =============================================================================
// PURPOSE — a reference capability pack for the obligation-condition compiler
// =============================================================================
//
// `compileCondition`/`decideCapability` (sibling file) own ZERO node families
// and ZERO comparison verbs; they resolve every condition node through an
// INJECTED `ConditionPack`. This file is one such pack: the standard boolean
// combinators (`all`, `any`, `not`) and the measure-fact leaf (`measure`),
// plus the math-closed comparison verbs (gte/lte/gt/lt/eq/neq/exists/in). It
// is NOT owned by the dispatcher and the dispatcher never imports it — the
// OWNER composes a pack and passes it in (the exact `measureOps`/`deriveMeasure`
// injection contract). Swapping/extending this pack — a `k_of_n` combinator, a
// `sequence` temporal node, a `regex` verb — requires zero dispatcher change:
// new node family = one `nodes` entry, new verb = one `predicates` entry.
//
// Every compiler is pure and compiles to a direct closure (the hot path runs
// closures only). Fail-soft/total inside each family: missing facts, stale
// facts, unknown verbs, and non-finite numbers all yield "unmet" with a
// machine-readable reason — never a throw, never a silent allow.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type {
  CompiledCondition,
  ConditionPack,
  FactRecord,
  NodeCompilerMap,
  PredicateOpMap,
} from "./obligation-decision.ts";

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function bothFinite(a: unknown, b: unknown): boolean {
  return Number.isFinite(num(a)) && Number.isFinite(num(b));
}

function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The reference verb map: math-closed comparison verbs. Numeric verbs return
 *  false (never throw) when either side is not a finite number. */
export const predicateOps: PredicateOpMap = {
  gte: (a, e) => bothFinite(a, e) && num(a) >= num(e),
  lte: (a, e) => bothFinite(a, e) && num(a) <= num(e),
  gt: (a, e) => bothFinite(a, e) && num(a) > num(e),
  lt: (a, e) => bothFinite(a, e) && num(a) < num(e),
  eq: (a, e) => jsonEq(a, e),
  neq: (a, e) => !jsonEq(a, e),
  exists: (a) => a !== undefined && a !== null,
  in: (a, e) => Array.isArray(e) && e.some((x) => jsonEq(a, x)),
};

function getPath(fact: FactRecord | undefined, path: string[]): unknown {
  let cur: unknown = fact;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Compare two recorded_at keys: numeric when both finite, else string
 *  (ISO-8601 timestamps order correctly as strings). */
function newer(a: unknown, b: unknown): boolean {
  const na = num(a);
  const nb = num(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na >= nb;
  const sa = a == null ? "" : String(a);
  const sb = b == null ? "" : String(b);
  return sa >= sb;
}

/** The most recent measure-value fact for `measure`, by `recorded_at` (later
 *  position wins ties). A fact counts as a value for `measure` if EITHER:
 *   • `kind === measure` — a direct measure record (self-attested / legacy), OR
 *   • `kind === "measure.fact" && emit === measure` — the CANONICAL shape that
 *     the progression-evaluator reducer writes (derive-measure ->
 *     compute-and-write-measure emits `{kind:"measure.fact", emit:<measure>}`).
 *  The gate MUST read the canonical shape or every measure computed from real
 *  tracked facts is invisible to it (it would never satisfy a gate) — the root
 *  that forced the UI to write measures directly (Codex 2026-07-04). */
function latestMeasureFact(facts: FactRecord[], measure: string): FactRecord | null {
  let best: FactRecord | null = null;
  for (const f of facts) {
    const matches =
      f.kind === measure ||
      (f.kind === "measure.fact" && (f as { emit?: unknown }).emit === measure);
    if (!matches) continue;
    if (best === null || newer(f.recorded_at, best.recorded_at)) best = f;
  }
  return best;
}

/** The standard node-family registry. Each compiler receives the node DATA +
 *  the compile env ({predicates, compile}) and returns a direct closure. */
export const conditionNodes: NodeCompilerMap = {
  /** all — every child holds. Empty list = met (vacuous truth). */
  all: (node, env) => {
    const children = (Array.isArray(node.all) ? (node.all as unknown[]) : []).map(env.compile);
    return (facts, nowIso) => {
      const parts = children.map((c) => c(facts, nowIso));
      const basis = parts.flatMap((p) => p.basis);
      const failed = parts.find((p) => !p.satisfied);
      if (failed) return { satisfied: false, reason: failed.reason, basis };
      return { satisfied: true, reason: "all conditions met", basis };
    };
  },

  /** any — at least one child holds. Empty list = unmet (fail-closed). */
  any: (node, env) => {
    const raw = Array.isArray(node.any) ? (node.any as unknown[]) : [];
    const children = raw.map(env.compile);
    return (facts, nowIso) => {
      const parts = children.map((c) => c(facts, nowIso));
      const basis = parts.flatMap((p) => p.basis);
      const met = parts.find((p) => p.satisfied);
      if (met) return { satisfied: true, reason: met.reason, basis };
      return {
        satisfied: false,
        reason: raw.length === 0 ? "empty any: no way to satisfy" : (parts[0]?.reason ?? "no branch met"),
        basis,
      };
    };
  },

  /** not — inverts the child. */
  not: (node, env) => {
    const child = env.compile(node.not);
    return (facts, nowIso) => {
      const inner = child(facts, nowIso);
      return {
        satisfied: !inner.satisfied,
        reason: inner.satisfied ? `inverted: ${inner.reason}` : `inverted unmet: ${inner.reason}`,
        basis: inner.basis,
      };
    };
  },

  /** measure — read the LATEST fact of the named kind, apply a verb from the
   *  injected predicate map to the value at `path` (default ["value"]), with
   *  optional `within_ms` freshness vs nowIso. Fail-closed on missing fact,
   *  stale fact, and unknown verb. */
  measure: (node, env) => {
    const measure = String(node.measure);
    const path = Array.isArray(node.path) ? (node.path as string[]) : ["value"];
    const opName = String(node.op);
    const expected = node.value;
    const withinMs =
      typeof node.within_ms === "number" && Number.isFinite(node.within_ms)
        ? (node.within_ms as number)
        : null;
    const op = env.predicates[opName];
    return (facts, nowIso) => {
      const fact = latestMeasureFact(facts, measure);
      if (!fact) return { satisfied: false, reason: `measure missing: ${measure}`, basis: [] };
      const basis = typeof fact.id === "string" ? [fact.id] : [];
      if (withinMs !== null) {
        const factMs = Date.parse(String(fact.recorded_at ?? ""));
        const nowMs = Date.parse(nowIso);
        if (!Number.isFinite(factMs) || !Number.isFinite(nowMs) || nowMs - factMs > withinMs) {
          return { satisfied: false, reason: `measure stale: ${measure}`, basis };
        }
      }
      if (typeof op !== "function") {
        return { satisfied: false, reason: `unknown op: ${opName}`, basis };
      }
      const actual = getPath(fact, path);
      const satisfied = op(actual, expected) === true;
      return {
        satisfied,
        reason: satisfied
          ? `condition met: ${measure} ${opName}`
          : `condition not met: ${measure} ${opName}`,
        basis,
      };
    };
  },
};

/** The reference pack the OWNER injects into `decideCapability`. Extending it
 *  (or supplying a different pack) never touches the dispatcher. */
export const conditionPack: ConditionPack = {
  nodes: conditionNodes,
  predicates: predicateOps,
};

export type { CompiledCondition };
