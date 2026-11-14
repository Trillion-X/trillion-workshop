// packages/permission-lease/read-data/obligation-decision.ts
//
// Decide whether a capability may be exercised right now, given the obligation
// records that name it and the measure facts currently on the log.
//
// An obligation is a durable DATA record: "capability C requires this condition
// to hold over tracked measure values." The condition is a recursive node tree
// of SELF-DESCRIBING DATA: each node's property name IS its discriminant, and
// the node family is resolved through an INJECTED NodeCompilerMap — this file
// owns ZERO node kinds and ZERO comparison verbs (the exact `deriveMeasure` /
// `measureOps` injection contract). Which combinators exist (all/any/not/...),
// which leaf families exist (measure/...), which verbs exist (gte/...) — all of
// that is a capability pack the OWNER composes and passes in (see the sibling
// `condition-node-pack.ts` reference pack). Adding a node family or a verb is
// one pack/registry entry; this dispatcher never changes (enum dissolution).
//
// Hot path is COMPILED: `compileCondition` resolves every node through the
// registry ONCE into a tree of direct function closures; evaluation then runs
// closure calls only — no registry lookups, no per-kind branching, no shape
// re-inspection per evaluation.
//
// Fail-closed rules (Physics — the dispatcher's own semantics, not a domain):
// a malformed node (not an object), a node whose properties match no compiler
// in the registry, or a compiler throw all compile to "unmet" with a
// machine-readable reason — never allow, never throw. Pure and total.

export type FactRecord = Record<string, unknown> & { id?: string };

/** A comparison verb: actual value (from a fact) vs expected (DATA). */
export type PredicateOp = (actual: unknown, expected: unknown) => boolean;

/** The injected verb map. Adding a verb = one entry; nothing here changes. */
export type PredicateOpMap = Record<string, PredicateOp>;

/** A condition node is self-describing DATA. Its discriminant is the property
 *  name resolved through the injected NodeCompilerMap — no closed union. */
export type ConditionNode = Record<string, unknown>;

export type EvalOutcome = { satisfied: boolean; reason: string; basis: string[] };

/** A compiled condition: direct closure, evaluated against a fact snapshot. */
export type CompiledCondition = (facts: FactRecord[], nowIso: string) => EvalOutcome;

/** Compile-time environment handed to node compilers: the verb map plus the
 *  recursive compile callback (so combinator packs recurse WITHOUT importing
 *  this file — the same inversion as measure-ops). */
export type NodeCompileEnv = {
  predicates: PredicateOpMap;
  compile: (child: unknown) => CompiledCondition;
};

/** One node family: compiles its node DATA into a direct closure. */
export type NodeCompiler = (node: ConditionNode, env: NodeCompileEnv) => CompiledCondition;

/** The injected node-family registry: discriminant property -> compiler. */
export type NodeCompilerMap = Record<string, NodeCompiler>;

/** The full injected capability pack. */
export type ConditionPack = {
  nodes: NodeCompilerMap;
  predicates: PredicateOpMap;
};

/** The obligation DATA record shape (kind "capability-obligation"). */
export type CapabilityObligation = {
  kind: "capability-obligation";
  obligation_ref: string;
  capability_ref: string;
  condition: ConditionNode;
  label?: string;
  subject_ref?: string;
  taxonomy_ref?: string;
  /** false = record kept but not enforced; default true. */
  active?: boolean;
};

export type ObligationVerdict = {
  obligation_ref: string;
  satisfied: boolean;
  /** plain, explicit reason a reader can act on ("measure missing: X", ...). */
  reason: string;
  /** ids of the facts this verdict read. */
  basis: string[];
};

/** The emitted decision fact (kind "obligation-decision"). */
export type CapabilityDecision = {
  kind: "obligation-decision";
  capability_ref: string;
  allowed: boolean;
  verdicts: ObligationVerdict[];
  evaluated_at: string;
  basis: string[];
};

const unmet = (reason: string): CompiledCondition => () => ({ satisfied: false, reason, basis: [] });

/** Compile one condition node through the injected registry. The node's
 *  discriminant is the FIRST own property that names a registered compiler —
 *  payload-shape discrimination: the data describes itself, the dispatcher
 *  enumerates nothing. Unknown/malformed nodes compile fail-closed. */
export function compileCondition(node: unknown, pack: ConditionPack): CompiledCondition {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return unmet("malformed condition node");
  }
  const rec = node as ConditionNode;
  const key = Object.keys(rec).find((k) => Object.prototype.hasOwnProperty.call(pack.nodes, k));
  if (!key) return unmet(`unknown condition node: {${Object.keys(rec).join(",")}}`);
  const env: NodeCompileEnv = {
    predicates: pack.predicates,
    compile: (child) => compileCondition(child, pack),
  };
  try {
    const compiled = pack.nodes[key](rec, env);
    // Guard the evaluation too: a throwing pack closure is a DATA/pack error
    // and must read as unmet, never as a crash of the dispatcher.
    return (facts, nowIso) => {
      try {
        return compiled(facts, nowIso);
      } catch (e) {
        return { satisfied: false, reason: `condition evaluation failed: ${String(e)}`, basis: [] };
      }
    };
  } catch (e) {
    return unmet(`condition compile failed: ${String(e)}`);
  }
}

/** Decide one capability: every ACTIVE obligation naming it must be satisfied.
 *  No obligations for the capability => allowed (nothing is owed). The node
 *  families and verbs arrive as the injected `pack` — this function owns none.
 *  Pure, deterministic, never throws. */
export function decideCapability(
  capabilityRef: string,
  obligations: CapabilityObligation[],
  measureFacts: FactRecord[],
  nowIso: string,
  pack: ConditionPack,
): CapabilityDecision {
  const relevant = (Array.isArray(obligations) ? obligations : []).filter(
    (o) => o && o.capability_ref === capabilityRef && o.active !== false,
  );
  const facts = Array.isArray(measureFacts) ? measureFacts : [];
  const verdicts: ObligationVerdict[] = relevant.map((o) => {
    const outcome = compileCondition(o.condition, pack)(facts, nowIso);
    return {
      obligation_ref: o.obligation_ref,
      satisfied: outcome.satisfied,
      reason: outcome.reason,
      basis: outcome.basis,
    };
  });
  const basis = Array.from(new Set(verdicts.flatMap((v) => v.basis)));
  return {
    kind: "obligation-decision",
    capability_ref: capabilityRef,
    allowed: verdicts.every((v) => v.satisfied),
    verdicts:
      verdicts.length > 0
        ? verdicts
        : [{ obligation_ref: "", satisfied: true, reason: "no obligations", basis: [] }],
    evaluated_at: nowIso,
    basis,
  };
}
