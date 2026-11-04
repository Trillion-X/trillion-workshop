// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/derive-measure.test.ts.
// packages/progression-evaluator/read-data/derive-measure.test.ts
//
// DMG01 proof suite. Run: node --test (after tsc/ts-node) OR via the package's
// configured test runner. Verifies the Measure primitive:
//   1. EMERGENCE (L069): one engine + DATA rows yields a tennis score, a heat
//      cell, and an elbow angle — each from a measure-definition + 0 new code.
//   2. GOLDEN: the `band` op reproduces evaluateProgression's band membership.
//   3. ADVERSARIAL / DELETION: a measure the engine never "saw" (a hip angle, a
//      padel score from a different graph row, a composed ratio) works for free.
//   4. CONFORMANCE: every MeasureFact carries provenance + confidence + basis.
//   5. FAIL-CLOSED: an unknown op yields ok:false, never a throw or wrong number.

import { test } from '../../../match-community-members/test/vitest-shim.mjs';
import assert from "node:assert/strict";
import { deriveMeasure, deriveMeasures, type FactRecord, type MeasureDefinition } from '../../read-data/derive-measure.ts';
import { measureOps } from '../../read-data/measure-ops.ts';
import { evaluateProgression } from '../../read-data/evaluate-progression.ts';

// --- 1. EMERGENCE: three unrelated measures from three DATA rows, one engine ---

test("emergence: tennis score, heat cell, and elbow angle from DATA + zero code", () => {
  const facts: FactRecord[] = [
    // a rally of won points (tennis score)
    { id: "p1", kind: "point", event: "won" },
    { id: "p2", kind: "point", event: "won" },
    { id: "p3", kind: "point", event: "won" },
    // ball landing x-coordinates (heat cell)
    { id: "l1", kind: "landing", landing: { x: 1 } },
    { id: "l2", kind: "landing", landing: { x: 2 } },
    { id: "l3", kind: "landing", landing: { x: 4 } },
    { id: "l4", kind: "landing", landing: { x: 7 } },
    // arm joints (elbow angle: shoulder-elbow-wrist = 90 degrees)
    { id: "j1", joint: "shoulder", pt: [0, 1] },
    { id: "j2", joint: "elbow", pt: [0, 0] },
    { id: "j3", joint: "wrist", pt: [1, 0] },
  ];

  const defs: MeasureDefinition[] = [
    {
      id: "tennis-score",
      op: "reduce-graph",
      emit: "measure.score",
      inputs: [{ match: { kind: "point" } }],
      params: {
        eventField: ["event"],
        graph: {
          start: "0",
          transitions: [
            { from: "0", on: "won", to: "15" },
            { from: "15", on: "won", to: "30" },
            { from: "30", on: "won", to: "40" },
            { from: "40", on: "won", to: "game" },
          ],
        },
      },
    },
    {
      id: "landing-heat",
      op: "bin",
      emit: "measure.heatcell",
      inputs: [{ match: { kind: "landing" }, field: ["landing", "x"] }],
      params: { edges: [0, 3, 6, 9] },
    },
    {
      id: "elbow-angle",
      op: "angle",
      emit: "measure.angle",
      inputs: [
        { match: { joint: "shoulder" }, field: ["pt"] },
        { match: { joint: "elbow" }, field: ["pt"] },
        { match: { joint: "wrist" }, field: ["pt"] },
      ],
    },
  ];

  const [score, heat, elbow] = deriveMeasures(facts, defs, measureOps);

  assert.equal((score.value as { state: string }).state, "40"); // 3 won points: 0->15->30->40
  assert.deepEqual((heat.value as { counts: number[] }).counts, [2, 1, 1]); // [0,3):1,2  [3,6):4  [6,9):7
  assert.ok(Math.abs((elbow.value as number) - 90) < 1e-9); // right angle at the elbow
});

// --- 2. GOLDEN: band op == evaluateProgression membership (no regression) ---

test("golden: band op reproduces evaluateProgression band membership", () => {
  const bands = [
    { min: undefined, max: 0.5, payload: { direction: "downshift" } },
    { min: 0.5, max: 0.8, payload: { direction: "hold" } },
    { min: 0.8, max: undefined, payload: { direction: "progress" } },
  ];
  for (const value of [0.3, 0.65, 0.95]) {
    // legacy evaluator
    const legacy = evaluateProgression({
      signals: [{ metricRef: "session.success_rate", value }],
      rules: bands.map((b, i) => ({
        id: `r${i}`,
        metricRef: "session.success_rate",
        band: { min: b.min, max: b.max },
        adjustment: b.payload,
      })),
    });
    // measure reducer, band op
    const measure = deriveMeasure(
      [{ id: "s1", kind: "signal", value }],
      { id: "progression", op: "band", inputs: [{ match: { kind: "signal" }, field: ["value"] }], params: { bands } },
      measureOps
    );
    assert.equal(legacy.fired.length, 1);
    assert.deepEqual(measure.value, legacy.fired[0].rule.adjustment);
  }
});

// --- 3. ADVERSARIAL / DELETION: measures the engine never "saw" work for free ---

test("deletion test: a HIP angle (never coded) emerges from the same angle op + DATA", () => {
  const facts: FactRecord[] = [
    { id: "h1", joint: "torso", pt: [0, 2] },
    { id: "h2", joint: "hip", pt: [0, 0] },
    { id: "h3", joint: "knee", pt: [2, 0] },
  ];
  const def: MeasureDefinition = {
    id: "hip-angle",
    op: "angle",
    inputs: [
      { match: { joint: "torso" }, field: ["pt"] },
      { match: { joint: "hip" }, field: ["pt"] },
      { match: { joint: "knee" }, field: ["pt"] },
    ],
  };
  const m = deriveMeasure(facts, def, measureOps);
  assert.ok(Math.abs((m.value as number) - 90) < 1e-9);
});

test("deletion test: PADEL scoring is a different graph DATA row, zero code change", () => {
  // a deliberately different ladder (golden-point at 40-40): 0->15->30->40->game on 'won'
  const facts: FactRecord[] = [
    { id: "a", kind: "point", event: "won" },
    { id: "b", kind: "point", event: "won" },
    { id: "c", kind: "point", event: "won" },
    { id: "d", kind: "point", event: "won" },
  ];
  const def: MeasureDefinition = {
    id: "padel-score",
    op: "reduce-graph",
    inputs: [{ match: { kind: "point" } }],
    params: {
      eventField: ["event"],
      graph: {
        start: "0",
        transitions: [
          { from: "0", on: "won", to: "15" },
          { from: "15", on: "won", to: "30" },
          { from: "30", on: "won", to: "40" },
          { from: "40", on: "won", to: "game" },
        ],
      },
    },
  };
  const m = deriveMeasure(facts, def, measureOps);
  assert.equal((m.value as { state: string }).state, "game"); // 4 won -> game
});

test("adversarial: a composed ratio (winners / unforced errors) from DATA", () => {
  const facts: FactRecord[] = [
    { id: "w1", kind: "shot", outcome: "winner" },
    { id: "w2", kind: "shot", outcome: "winner" },
    { id: "w3", kind: "shot", outcome: "winner" },
    { id: "e1", kind: "shot", outcome: "error" },
    { id: "e2", kind: "shot", outcome: "error" },
  ];
  const m = deriveMeasure(
    facts,
    {
      id: "winner-error-ratio",
      op: "ratio",
      inputs: [{ match: { kind: "shot", outcome: "winner" } }, { match: { kind: "shot", outcome: "error" } }],
      params: { mode: "count" },
    },
    measureOps
  );
  assert.equal(m.value, 1.5); // 3 winners / 2 errors
});

// --- 4. CONFORMANCE: every measure carries provenance + confidence + basis ---

test("conformance: every MeasureFact carries provenance, confidence, basis", () => {
  const facts: FactRecord[] = [{ id: "x1", kind: "n", value: 5 }, { id: "x2", kind: "n", value: 7 }];
  const m = deriveMeasure(
    facts,
    { id: "total", op: "sum", emit: "measure.sum", inputs: [{ match: { kind: "n" }, field: ["value"] }] },
    measureOps
  );
  assert.equal(m.value, 12);
  assert.equal(m.ok, true);
  assert.equal(m.emit, "measure.sum");
  assert.equal(m.confidence, 1);
  assert.equal(m.provenance[0].op, "sum");
  assert.equal(m.provenance[0].inputCount, 2);
  assert.deepEqual(m.basis, ["x1", "x2"]);
});

// --- 5. FAIL-CLOSED: unknown op never throws, never emits a wrong number ---

test("fail-closed: an op absent from the injected map yields ok:false, no throw", () => {
  const m = deriveMeasure(
    [{ id: "z", kind: "n", value: 1 }],
    { id: "mystery", op: "op-that-does-not-exist", inputs: [{ match: { kind: "n" } }] },
    measureOps
  );
  assert.equal(m.ok, false);
  assert.equal(m.value, null);
  assert.equal(m.confidence, 0);
  assert.match(m.error ?? "", /op_not_in_opmap/);
});

test("fail-closed: divide-by-zero ratio yields confidence 0, not Infinity/NaN", () => {
  const m = deriveMeasure(
    [{ id: "w", kind: "shot", outcome: "winner" }],
    { id: "r", op: "ratio", inputs: [{ match: { outcome: "winner" } }, { match: { outcome: "error" } }] },
    measureOps
  );
  assert.equal(m.value, 0);
  assert.equal(m.confidence, 0);
});

// --- 6. PURITY/TOTALITY: empty + malformed inputs yield a well-formed fact ---

test("totality: empty facts and empty defs never throw", () => {
  assert.equal(deriveMeasures([], [], measureOps).length, 0);
  const m = deriveMeasure([], { id: "e", op: "count", inputs: [{ match: { kind: "x" } }] }, measureOps);
  assert.equal(m.value, 0);
  assert.equal(m.ok, true);
});

// --- 6. ROLLUP: grouped aggregation (per-zone shot counts) from DATA + zero code ---

test("rollup: per-zone shot counts and per-opponent avg from one op + DATA", () => {
  const facts: FactRecord[] = [
    { id: "s1", kind: "shot", zone: "deuce", opp: "A", speed: 100 },
    { id: "s2", kind: "shot", zone: "deuce", opp: "A", speed: 110 },
    { id: "s3", kind: "shot", zone: "ad", opp: "B", speed: 90 },
    { id: "s4", kind: "shot", zone: "deuce", opp: "B", speed: 80 },
  ];
  // per-zone shot COUNT (heat pivot) — group by zone, default count reduction
  const byZone = deriveMeasure(
    facts,
    { id: "zone-counts", op: "rollup", emit: "measure.pivot", inputs: [{ match: { kind: "shot" } }], params: { groupBy: ["zone"] } },
    measureOps
  );
  assert.equal(byZone.ok, true);
  assert.deepEqual((byZone.value as { groups: Record<string, number> }).groups, { deuce: 3, ad: 1 });
  assert.equal(byZone.confidence, 1);
  assert.ok(byZone.basis.length === 4); // provenance/basis conformance

  // per-opponent AVG speed — group by opp, avg over the speed field
  const byOpp = deriveMeasure(
    facts,
    { id: "opp-avg-speed", op: "rollup", inputs: [{ match: { kind: "shot" }, field: ["speed"] }], params: { groupBy: ["opp"], reduce: "avg" } },
    measureOps
  );
  assert.deepEqual((byOpp.value as { groups: Record<string, number> }).groups, { A: 105, B: 85 });
});

// --- 7. FORMULA: a derived number (win-probability-style) from a structured AST ---

test("formula: win-rate = won / (won + lost) from a structured arithmetic AST + DATA", () => {
  const facts: FactRecord[] = [
    { id: "p1", kind: "point", event: "won" },
    { id: "p2", kind: "point", event: "won" },
    { id: "p3", kind: "point", event: "won" },
    { id: "p4", kind: "point", event: "lost" },
  ];
  const m = deriveMeasure(
    facts,
    {
      id: "win-rate",
      op: "formula",
      emit: "measure.rate",
      inputs: [{ match: { event: "won" } }, { match: { event: "lost" } }],
      params: {
        // won / (won + lost) = 3 / (3 + 1) = 0.75 — input reductions default to count
        expr: { op: "div", args: [{ input: 0 }, { op: "add", args: [{ input: 0 }, { input: 1 }] }] },
      },
    },
    measureOps
  );
  assert.equal(m.ok, true);
  assert.equal(m.value, 0.75);

  // divide-by-zero fails SOFT (no Infinity/NaN escapes): confidence 0, value null
  const z = deriveMeasure(
    [],
    { id: "win-rate-empty", op: "formula", inputs: [{ match: { event: "won" } }, { match: { event: "lost" } }], params: { expr: { op: "div", args: [{ input: 0 }, { input: 1 }] } } },
    measureOps
  );
  assert.equal(z.value, null);
  assert.equal(z.confidence, 0);
});

// --- 8. ADVERSARIAL: compositions the engine never "saw" work for free (L069) ---

test("adversarial: rollup + formula + reduce-graph compose with zero new engine code", () => {
  const facts: FactRecord[] = [
    { id: "r1", kind: "rally", surface: "clay", len: 8 },
    { id: "r2", kind: "rally", surface: "clay", len: 12 },
    { id: "r3", kind: "rally", surface: "grass", len: 3 },
    { id: "g1", kind: "pt", on: "win" },
    { id: "g2", kind: "pt", on: "win" },
  ];
  // a per-surface AVERAGE rally length (rollup avg) — never authored before
  const surfaceAvg = deriveMeasure(
    facts,
    { id: "surface-avg-rally", op: "rollup", inputs: [{ match: { kind: "rally" }, field: ["len"] }], params: { groupBy: ["surface"], reduce: "avg" } },
    measureOps
  );
  assert.deepEqual((surfaceAvg.value as { groups: Record<string, number> }).groups, { clay: 10, grass: 3 });

  // a padel-style 2-point game graph (different DATA row, same engine)
  const padel = deriveMeasure(
    facts,
    { id: "padel-game", op: "reduce-graph", inputs: [{ match: { kind: "pt" } }], params: { eventField: ["on"], graph: { start: "0", transitions: [{ from: "0", on: "win", to: "1" }, { from: "1", on: "win", to: "game" }] } } },
    measureOps
  );
  assert.equal((padel.value as { state: string }).state, "game");

  // a composed index: avg(clay) * 2 + count(grass-rally) via formula — emergent
  const index = deriveMeasure(
    facts,
    {
      id: "clay-index",
      op: "formula",
      inputs: [{ match: { surface: "clay" }, field: ["len"] }, { match: { surface: "grass" } }],
      params: { expr: { op: "add", args: [{ op: "mul", args: [{ input: 0, reduce: "sum" }, { const: 1 }] }, { input: 1 }] } },
    },
    measureOps
  );
  // sum(clay len 8+12=20) * 1 + count(grass rally=1) = 21
  assert.equal(index.value, 21);
  // every emergent measure still carries the conformance contract
  for (const m of [surfaceAvg, padel, index]) {
    assert.ok(Array.isArray(m.provenance) && m.provenance.length >= 1);
    assert.equal(typeof m.confidence, "number");
    assert.ok(Array.isArray(m.basis));
  }
});

// --- 9. RECODE: categorical + numeric compose into a session-quality measure (APK03) ---

test("recode: session_quality = focus_rating + goals-met (categorical→numeric via DATA map), zero per-category code", () => {
  // A finished session's answer-facts: numeric focus-rating + categorical goals-met.
  const session = (focus: number, goalsMet: string): FactRecord[] => [
    { id: "fr", kind: "answer-fact", questionId: "focus-rating", value: focus },
    { id: "gm", kind: "answer-fact", questionId: "post-goals-met", value: goalsMet },
  ];
  // session_quality = focus_rating/10 * 0.6  +  recode(goals-met){yes:1,partially:0.5,no:0} * 0.4
  const SESSION_QUALITY: MeasureDefinition = {
    id: "measure:ethos.session_quality",
    op: "formula",
    emit: "measure.session_quality",
    inputs: [
      { match: { questionId: "focus-rating" }, field: ["value"] },
      { match: { questionId: "post-goals-met" }, field: ["value"] },
    ],
    params: {
      expr: {
        op: "add",
        args: [
          { op: "mul", args: [{ op: "div", args: [{ input: 0, reduce: "sum" }, { const: 10 }] }, { const: 0.6 }] },
          { op: "mul", args: [{ recode: 1, map: { yes: 1, partially: 0.5, no: 0 }, default: 0 }, { const: 0.4 }] },
        ],
      },
    },
  };

  // focus 9 + goals "yes" -> 0.9*0.6 + 1*0.4 = 0.94
  const great = deriveMeasure(session(9, "yes"), SESSION_QUALITY, measureOps);
  assert.equal(great.ok, true);
  assert.ok(Math.abs((great.value as number) - 0.94) < 1e-9, `expected 0.94, got ${great.value}`);

  // focus 4 + goals "no" -> 0.4*0.6 + 0*0.4 = 0.24
  const poor = deriveMeasure(session(4, "no"), SESSION_QUALITY, measureOps);
  assert.ok(Math.abs((poor.value as number) - 0.24) < 1e-9, `expected 0.24, got ${poor.value}`);

  // focus 7 + goals "partially" -> 0.7*0.6 + 0.5*0.4 = 0.62
  const mid = deriveMeasure(session(7, "partially"), SESSION_QUALITY, measureOps);
  assert.ok(Math.abs((mid.value as number) - 0.62) < 1e-9, `expected 0.62, got ${mid.value}`);

  // an UNKNOWN category falls back to default (0), never NaN — fail-soft + zero new code
  const unknown = deriveMeasure(session(8, "skipped"), SESSION_QUALITY, measureOps);
  assert.ok(Math.abs((unknown.value as number) - 0.48) < 1e-9, `expected 0.48, got ${unknown.value}`);
});
