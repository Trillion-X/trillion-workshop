// packages/permission-lease/read-data/obligation-decision.test.ts
import { describe, expect, it } from "../../../test-helpers/vitest-shim.mjs";
import {
  decideCapability,
  type CapabilityObligation,
  type ConditionPack,
  type FactRecord,
} from "./obligation-decision.ts";
import { conditionPack, predicateOps } from "./condition-node-pack.ts";

/** Every test decides through the injected reference pack (the dispatcher owns
 *  zero node kinds / verbs — the pack is the DATA-selected capability). */
const decide = (
  cap: string,
  obls: CapabilityObligation[],
  facts: FactRecord[],
  now: string,
  pack: ConditionPack = conditionPack,
) => decideCapability(cap, obls, facts, now, pack);

const NOW = "2026-07-02T12:00:00Z";

const fact = (kind: string, value: unknown, recordedAt = "2026-07-02T11:00:00Z", id?: string): FactRecord => ({
  id: id ?? `fact:${kind}:${recordedAt}`,
  kind,
  value,
  recorded_at: recordedAt,
});

const obligation = (
  ref: string,
  capability: string,
  condition: CapabilityObligation["condition"],
  extra: Partial<CapabilityObligation> = {},
): CapabilityObligation => ({
  kind: "capability-obligation",
  obligation_ref: ref,
  capability_ref: capability,
  condition,
  ...extra,
});

describe("predicate ops", () => {
  it("compares numerically and fails soft on non-finite", () => {
    expect(predicateOps.gte(2, 1)).toBe(true);
    expect(predicateOps.lte(1, 1)).toBe(true);
    expect(predicateOps.gt(2, 2)).toBe(false);
    expect(predicateOps.lt("1", 2)).toBe(true); // numeric coercion
    expect(predicateOps.gte("nope", 1)).toBe(false); // non-finite -> false, no throw
  });
  it("eq/neq/in are json-deep, exists is null-aware", () => {
    expect(predicateOps.eq({ a: 1 }, { a: 1 })).toBe(true);
    expect(predicateOps.neq("x", "y")).toBe(true);
    expect(predicateOps.in("tense", ["steady", "tense"])).toBe(true);
    expect(predicateOps.in("calm", ["steady", "tense"])).toBe(false);
    expect(predicateOps.exists(0, undefined)).toBe(true);
    expect(predicateOps.exists(null, undefined)).toBe(false);
  });
});

describe("decideCapability core", () => {
  it("no obligations => allowed with explicit reason", () => {
    const d = decide("capability:deep-work", [], [], NOW);
    expect(d.allowed).toBe(true);
    expect(d.verdicts[0].reason).toBe("no obligations");
  });

  it("denies when the measure fact is missing (fail-closed)", () => {
    const obl = obligation("obl:walk", "capability:deep-work", {
      measure: "measure.walk-count-today",
      op: "gte",
      value: 1,
    });
    const d = decide("capability:deep-work", [obl], [], NOW);
    expect(d.allowed).toBe(false);
    expect(d.verdicts[0].reason).toContain("measure missing");
  });

  it("allows when the latest measure value satisfies the predicate", () => {
    const obl = obligation("obl:walk", "capability:deep-work", {
      measure: "measure.walk-count-today",
      op: "gte",
      value: 1,
    });
    const facts = [fact("measure.walk-count-today", 1)];
    const d = decide("capability:deep-work", [obl], facts, NOW);
    expect(d.allowed).toBe(true);
    expect(d.basis).toEqual([facts[0].id]);
  });

  it("satisfies from the CANONICAL measure.fact/emit shape (progression-evaluator output)", () => {
    // progression-evaluator's compute-and-write-measure writes
    // {kind:"measure.fact", emit:<measure_id>, value:<n>} — NOT {kind:<measure_id>}.
    // The gate must read that canonical shape, otherwise a real tracked fact ->
    // reduced measure never satisfies the predicate and the gate is a facade.
    const obl = obligation("obl:walk", "capability:deep-work", {
      measure: "measure.walk-count-today",
      op: "gte",
      value: 1,
    });
    const canonical: FactRecord = {
      id: "measure.fact:walk:1",
      kind: "measure.fact",
      emit: "measure.walk-count-today",
      value: 1,
      recorded_at: "2026-07-02T11:00:00Z",
    } as FactRecord;
    const d = decide("capability:deep-work", [obl], [canonical], NOW);
    expect(d.allowed).toBe(true);
    expect(d.basis).toEqual(["measure.fact:walk:1"]);
  });

  it("prefers the latest across MIXED shapes (bare kind + measure.fact/emit)", () => {
    const obl = obligation("obl:walk", "capability:deep-work", {
      measure: "measure.walk-count-today",
      op: "gte",
      value: 1,
    });
    const facts: FactRecord[] = [
      fact("measure.walk-count-today", 1, "2026-07-02T09:00:00Z", "bare-old"),
      {
        id: "canonical-new",
        kind: "measure.fact",
        emit: "measure.walk-count-today",
        value: 0,
        recorded_at: "2026-07-02T11:30:00Z",
      } as FactRecord,
    ];
    const d = decide("capability:deep-work", [obl], facts, NOW);
    expect(d.allowed).toBe(false); // latest (canonical) says 0
    expect(d.verdicts[0].basis).toEqual(["canonical-new"]);
  });

  it("uses the LATEST fact per measure kind (recorded_at ordering)", () => {
    const obl = obligation("obl:walk", "capability:deep-work", {
      measure: "measure.walk-count-today",
      op: "gte",
      value: 1,
    });
    const facts = [
      fact("measure.walk-count-today", 1, "2026-07-02T09:00:00Z", "old"),
      fact("measure.walk-count-today", 0, "2026-07-02T11:30:00Z", "new"),
    ];
    const d = decide("capability:deep-work", [obl], facts, NOW);
    expect(d.allowed).toBe(false); // latest says 0
    expect(d.verdicts[0].basis).toEqual(["new"]);
  });

  it("denies a stale measure via within_ms (fail-closed)", () => {
    const obl = obligation("obl:water", "capability:deep-work", {
      measure: "measure.water-ml-today",
      op: "gte",
      value: 2000,
      within_ms: 60 * 60 * 1000, // 1h freshness
    });
    const facts = [fact("measure.water-ml-today", 2500, "2026-07-02T09:00:00Z")]; // 3h old
    const d = decide("capability:deep-work", [obl], facts, NOW);
    expect(d.allowed).toBe(false);
    expect(d.verdicts[0].reason).toContain("measure stale");
  });

  it("denies on an unknown op (fail-closed, never throws)", () => {
    const obl = obligation("obl:x", "cap", { measure: "m", op: "approximately", value: 1 });
    const d = decide("cap", [obl], [fact("m", 1)], NOW);
    expect(d.allowed).toBe(false);
    expect(d.verdicts[0].reason).toContain("unknown op");
  });

  it("skips inactive obligations, ignores other capabilities", () => {
    const off = obligation("obl:off", "cap", { measure: "m", op: "gte", value: 99 }, { active: false });
    const other = obligation("obl:other", "cap2", { measure: "m", op: "gte", value: 99 });
    const d = decide("cap", [off, other], [], NOW);
    expect(d.allowed).toBe(true);
  });

  it("empty all => met (vacuous); empty any => unmet (fail-closed); malformed => unmet", () => {
    expect(decide("c", [obligation("o1", "c", { all: [] })], [], NOW).allowed).toBe(true);
    expect(decide("c", [obligation("o2", "c", { any: [] })], [], NOW).allowed).toBe(false);
    expect(
      decide("c", [obligation("o3", "c", {} as never)], [], NOW).allowed,
    ).toBe(false);
  });

  it("not inverts; deep nesting folds correctly", () => {
    const condition = {
      all: [
        { any: [{ measure: "m.a", op: "gte", value: 1 }, { measure: "m.b", op: "gte", value: 1 }] },
        { not: { measure: "m.blocked", op: "eq", value: true } },
      ],
    };
    const facts = [fact("m.b", 1), fact("m.blocked", false)];
    const d = decide("c", [obligation("o", "c", condition)], facts, NOW);
    expect(d.allowed).toBe(true);
  });
});

// L124 emergent features — the SAME leaf, new DATA only. Zero engine changes.
describe("emergent", () => {
  it("(a) monk taxonomy deletion test: swap every measure kind, zero code change", () => {
    const monk = obligation("obl:prayer", "capability:reading", {
      all: [
        { measure: "measure.prayer-count-today", op: "gte", value: 3 },
        { measure: "measure.fasting-hours", op: "gte", value: 12 },
        { measure: "measure.service-acts-week", op: "gte", value: 1 },
      ],
    });
    const facts = [
      fact("measure.prayer-count-today", 3),
      fact("measure.fasting-hours", 14),
      fact("measure.service-acts-week", 2),
    ];
    expect(decide("capability:reading", [monk], facts, NOW).allowed).toBe(true);
    expect(decide("capability:reading", [monk], facts.slice(0, 2), NOW).allowed).toBe(false);
  });

  it("(b) gates gating gates: a decision fact is a measure input to another gate", () => {
    // upstream gate's decision fact written back as a fact of its own kind
    const upstream = fact("obligation-decision:capability:deep-work", true);
    (upstream as Record<string, unknown>).value = true;
    const meta = obligation("obl:meta", "capability:publish", {
      measure: "obligation-decision:capability:deep-work",
      op: "eq",
      value: true,
    });
    expect(decide("capability:publish", [meta], [upstream], NOW).allowed).toBe(true);
  });

  it("(c) balance-opposite pair: strength fact today obliges a vulnerability fact", () => {
    // opposite-pair row: when strong-count >= 1, require weak-count >= 1 to unlock evening work
    const pair = obligation("obl:balance", "capability:evening-work", {
      any: [
        { not: { measure: "measure.strong-acts-today", op: "gte", value: 1 } }, // no strength act => nothing owed
        { measure: "measure.weak-acts-today", op: "gte", value: 1 },
      ],
    });
    const strongOnly = [fact("measure.strong-acts-today", 1), fact("measure.weak-acts-today", 0)];
    const balanced = [fact("measure.strong-acts-today", 1), fact("measure.weak-acts-today", 1)];
    expect(decide("capability:evening-work", [pair], strongOnly, NOW).allowed).toBe(false);
    expect(decide("capability:evening-work", [pair], balanced, NOW).allowed).toBe(true);
  });

  it("(d) honest attestation OR tracker: any-branch over two fact families", () => {
    const walk = obligation("obl:walk", "capability:deep-work", {
      any: [
        { measure: "measure.walk-count-today", op: "gte", value: 1 },
        { measure: "measure.walk-attested-today", op: "gte", value: 1 },
      ],
    });
    expect(
      decide("capability:deep-work", [walk], [fact("measure.walk-attested-today", 1)], NOW).allowed,
    ).toBe(true);
    expect(decide("capability:deep-work", [walk], [], NOW).allowed).toBe(false);
  });

  it("(e) schedule window: a clock measure fact gates by category membership", () => {
    const window = obligation("obl:window", "capability:deep-work", {
      measure: "measure.schedule-block-now",
      op: "in",
      value: ["deep-work", "study"],
      within_ms: 15 * 60 * 1000,
    });
    const inWindow = [fact("measure.schedule-block-now", "deep-work", "2026-07-02T11:55:00Z")];
    const outWindow = [fact("measure.schedule-block-now", "rest", "2026-07-02T11:55:00Z")];
    expect(decide("capability:deep-work", [window], inWindow, NOW).allowed).toBe(true);
    expect(decide("capability:deep-work", [window], outWindow, NOW).allowed).toBe(false);
  });

  it("(f) anti-gate: LOCK further work after 2h studied (not + gte)", () => {
    const cap = obligation("obl:stop", "capability:more-study", {
      not: { measure: "measure.studied-minutes-today", op: "gte", value: 120 },
    });
    expect(
      decide("capability:more-study", [cap], [fact("measure.studied-minutes-today", 130)], NOW).allowed,
    ).toBe(false);
    expect(
      decide("capability:more-study", [cap], [fact("measure.studied-minutes-today", 90)], NOW).allowed,
    ).toBe(true);
  });
});

// L090 extensibility proof: a NEW node family + a NEW verb arrive as a PACK
// extension (DATA-composed by the owner) — the dispatcher is untouched.
describe("enum dissolution (injected pack extensibility)", () => {
  it("a new `k_of_n` combinator works with zero dispatcher change", () => {
    const extended: ConditionPack = {
      predicates: conditionPack.predicates,
      nodes: {
        ...conditionPack.nodes,
        k_of_n: (node, env) => {
          const k = Number((node as Record<string, unknown>).k ?? 0);
          const children = (Array.isArray((node as Record<string, unknown>).k_of_n)
            ? ((node as Record<string, unknown>).k_of_n as unknown[])
            : []
          ).map(env.compile);
          return (facts, nowIso) => {
            const parts = children.map((c) => c(facts, nowIso));
            const met = parts.filter((p) => p.satisfied).length;
            return {
              satisfied: met >= k,
              reason: `${met}/${children.length} met (need ${k})`,
              basis: parts.flatMap((p) => p.basis),
            };
          };
        },
      },
    };
    const obl = obligation("obl:kn", "cap", {
      k_of_n: [
        { measure: "m.a", op: "gte", value: 1 },
        { measure: "m.b", op: "gte", value: 1 },
        { measure: "m.c", op: "gte", value: 1 },
      ],
      k: 2,
    } as never);
    const facts = [fact("m.a", 1), fact("m.b", 1), fact("m.c", 0)];
    expect(decide("cap", [obl], facts, NOW, extended).allowed).toBe(true);
    expect(decide("cap", [obl], [fact("m.a", 1)], NOW, extended).allowed).toBe(false);
  });

  it("a new `between` verb works with zero dispatcher change", () => {
    const extended: ConditionPack = {
      nodes: conditionPack.nodes,
      predicates: {
        ...conditionPack.predicates,
        between: (a, e) =>
          Array.isArray(e) && e.length === 2 && Number(a) >= Number(e[0]) && Number(a) <= Number(e[1]),
      },
    };
    const obl = obligation("obl:bt", "cap", { measure: "m", op: "between", value: [5, 10] });
    expect(decide("cap", [obl], [fact("m", 7)], NOW, extended).allowed).toBe(true);
    expect(decide("cap", [obl], [fact("m", 12)], NOW, extended).allowed).toBe(false);
    // and the SAME condition against the base pack fail-closes (unknown op), never throws
    expect(decide("cap", [obl], [fact("m", 7)], NOW).allowed).toBe(false);
  });
});
