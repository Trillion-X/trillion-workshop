// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/rr01-relevance-rank.test.ts.
// packages/progression-evaluator/read-data/rr01-relevance-rank.test.ts
//
// =============================================================================
// RR01 — the generic CANDIDATE-RELEVANCE reduction primitive (L069) = the RANKING
// half of RAG (CJ-C.5)
// =============================================================================
//
// Given a candidate set already present as facts (resource/cue/drill records) and a
// DATA query, score each candidate by relevance and return the ranked top-k. This is
// the "pull a cue/drill from the corpus into a session" step — but it names NO domain
// and does NO I/O. The SAME op ranks a tennis serve cue, a `topic_tags` doc, or a
// `symptom_codes` row (the deletion test at the bottom), with ZERO code per domain.
//
// The hard boundary (Codex convergence /tmp/codex-cjc5-retrieval.md, Option A):
// progression-evaluator RANKS a provided candidate set (pure reduction over facts);
// knowledge-records RETRIEVES/ingests the corpus (store + index I/O, dispatched via
// Envelope — never re-owned here); verify-grounding is the OUTPUT guard AFTER
// selection. No god package. The precomputed-score mode (`scoreField`) ranks by an
// `embedding_score` supplied as DATA without this op doing any vector I/O (narrow-C).
//
// Run: ../../node_modules/.bin/vitest run read-data/rr01-relevance-rank.test.ts
// =============================================================================

import { test } from '../../../match-community-members/test/vitest-shim.mjs';
import assert from "node:assert/strict";

import { deriveMeasure, type FactRecord, type MeasureDefinition } from '../../read-data/derive-measure.ts';
import { measureOps } from '../../read-data/measure-ops.ts';

type Ranked = { ranked: Array<{ id: string; score: number }>; top: string | null; scores: Record<string, number> };

const rank = (facts: FactRecord[], params: Record<string, unknown>) =>
  deriveMeasure(
    facts,
    { id: "retrieve", op: "relevance-rank", emit: "measure.retrieved", inputs: [{ match: { kind: "resource" } }], params } as MeasureDefinition,
    measureOps,
  );

// A resource record: id, title (free text), skill_tags (string[]). Self-describing DATA.
const R = (id: string, title: string, skill_tags: string[], extra: Record<string, unknown> = {}): FactRecord =>
  ({ id, kind: "resource", title, skill_tags, ...extra });

// The athlete's #1 bottleneck skill drives the query (CJ-C.5: bottleneck → cue).
const SERVE_LIBRARY = [
  R("res_serve_toss", "Consistent serve toss", ["serve"]),
  R("res_topspin", "Topspin forehand fundamentals", ["forehand", "topspin"]),
  R("res_serve_speed", "Serve speed via leg drive", ["serve", "power"]),
  R("res_footwork", "Split-step timing", ["movement", "footwork"]),
];
const P = { queryTerms: ["serve"], candidateFields: [["skill_tags"], ["title"]], topK: 2 };

test("RR01 lexical relevance — a 'serve' query surfaces the serve resources top-k, drops the rest", () => {
  const out = rank(SERVE_LIBRARY, { ...P }).value as Ranked;
  const ids = out.ranked.map((r) => r.id);
  assert.equal(ids.length, 2, "topK=2 honoured");
  assert.ok(ids.includes("res_serve_toss") && ids.includes("res_serve_speed"), `serve resources ranked; got ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes("res_topspin") && !ids.includes("res_footwork"), "irrelevant resources excluded");
});

test("RR01 the single top cue — `top` is the highest-relevance resource (the one cue to pull into the session)", () => {
  const out = rank(SERVE_LIBRARY, { ...P, topK: 1 }).value as Ranked;
  assert.equal(out.ranked.length, 1);
  assert.ok(out.top === "res_serve_toss" || out.top === "res_serve_speed", `top is a serve resource; got ${out.top}`);
  assert.ok((out.scores["res_topspin"] ?? 0) === 0, "a non-matching resource scores 0");
});

test("RR01 weighted fields — a title-only match ranks below a tag match when tags are weighted higher", () => {
  const lib = [
    R("tag_hit", "Generic drill", ["serve"]),         // matches in skill_tags (weight 3)
    R("title_hit", "Serve rhythm drill", ["rhythm"]),  // matches only in title (weight 1)
  ];
  const out = rank(lib, { queryTerms: ["serve"], candidateFields: [["skill_tags"], ["title"]], weights: [3, 1] }).value as Ranked;
  assert.equal(out.ranked[0].id, "tag_hit", "tag match outranks title-only match under weights");
  assert.ok(out.scores["tag_hit"] > out.scores["title_hit"], "weighted scores ordered");
});

test("RR01 fail-soft — no relevant resource → empty ranked + confidence 0 (no fabricated pick, L117)", () => {
  const out = rank(SERVE_LIBRARY, { queryTerms: ["chess"], candidateFields: [["skill_tags"], ["title"]], minScore: 1 });
  const val = out.value as Ranked;
  assert.equal(val.ranked.length, 0, "nothing clears minScore for an off-corpus query");
  assert.equal(val.top, null);
  assert.equal(out.confidence, 0, "confidence 0 signals 'no cue found' to the session");
});

test("RR01 precomputed-score mode (narrow-C) — ranks by an embedding_score DATA field, ZERO vector I/O", () => {
  const lib = [
    R("a", "A", [], { embedding_score: 0.42 }),
    R("b", "B", [], { embedding_score: 0.91 }),
    R("c", "C", [], { embedding_score: 0.67 }),
  ];
  const out = rank(lib, { scoreField: ["embedding_score"], topK: 2 }).value as Ranked;
  assert.deepEqual(out.ranked.map((r) => r.id), ["b", "c"], "ranked by descending embedding_score");
  assert.equal(out.top, "b");
});

test("RR01 L069 deletion test — DROP tennis: the SAME op ranks support-tickets by symptom_codes, zero code", () => {
  // A completely different domain dropped in as DATA — no skill/serve/tennis anywhere.
  const tickets = [
    { id: "t1", kind: "resource", subject: "Login loop on iOS", symptom_codes: ["auth", "mobile"] },
    { id: "t2", kind: "resource", subject: "Export CSV fails", symptom_codes: ["export"] },
    { id: "t3", kind: "resource", subject: "Auth token expires early", symptom_codes: ["auth", "session"] },
  ] as FactRecord[];
  const out = rank(tickets, { queryTerms: ["auth"], candidateFields: [["symptom_codes"], ["subject"]], topK: 2 }).value as Ranked;
  const ids = out.ranked.map((r) => r.id);
  assert.ok(ids.includes("t1") && ids.includes("t3"), `auth tickets surface; got ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes("t2"), "the export ticket (no auth) is excluded — pure DATA, zero engine change");
});

test("RR01 confidence high when a real cue is found (session may present it)", () => {
  const out = rank(SERVE_LIBRARY, { ...P });
  assert.equal(out.confidence, 1, "a genuine relevant match → confidence 1");
});
