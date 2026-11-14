// packages/interaction-program/read-data/interaction-program-fold.test.mjs
//
// Run: node --test packages/interaction-program/read-data/interaction-program-fold.test.mjs
//
// Proves the descriptor fold is a blind, generic translation boundary: it validates the
// 10-ref shape, preserves unknown fields, NEVER enumerates community types, and folds any
// community (weekly matchmaker, book club, mentorship) identically from DATA.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldInteractionProgram,
  foldInteractionPrograms,
  interactionProgramAddress,
  PROGRAM_REFS,
} from "./interaction-program-fold.mjs";

const WEEKLY = {
  address: interactionProgramAddress("weekly-matchmaker"),
  payload: {
    kind: "interaction-program",
    id: "weekly-matchmaker",
    partition_key: "runtime-partition",
    label: "Weekly Matchmaker",
    pairing: { group_size: 2, order: "expected-value-desc", exclusion: "prior-cycles" },
    group_ref: "group:tribe-members",
    participant_source_ref: "person-list:opted-in",
    match_descriptor_ref: "semantic-index-descriptor:member-profiles",
    relationship_kind_ref: "relationship-graph.kind:pair",
    time_window_ref: "timed-action.window:7day",
    daily_context_sequence_ref: "context-feed.sequence:weekly-themes",
    ai_icebreaker_producer_ref: "ai-records-producer.recipe:icebreaker",
    access_rule_ref: "access-rule:tribe",
    score_measure_ref: "progression-evaluator.measure:connection-points",
    surface_ref: "documents.page:tribe-home",
  },
};

test("folds a valid interaction-program into a typed program with all 10 refs", () => {
  const p = foldInteractionProgram(WEEKLY);
  assert.equal(p.id, "weekly-matchmaker");
  assert.equal(p.label, "Weekly Matchmaker");
  for (const key of PROGRAM_REFS) {
    assert.equal(typeof p.refs[key], "string", `ref ${key} must be present`);
  }
  assert.equal(p.pairing.group_size, 2);
});

test("rejects non-descriptor records (returns null, never throws)", () => {
  assert.equal(foldInteractionProgram({ payload: { kind: "connection", id: "x" } }), null);
  assert.equal(foldInteractionProgram({ payload: null }), null);
  assert.equal(foldInteractionProgram({}), null);
});

test("parses JSON-text payloads (log-stored) identically to object payloads", () => {
  const asText = { address: WEEKLY.address, value_json: JSON.stringify(WEEKLY.payload) };
  const p = foldInteractionProgram(asText);
  assert.equal(p.id, "weekly-matchmaker");
  assert.equal(p.refs.match_descriptor_ref, "semantic-index-descriptor:member-profiles");
});

test("blind-tolerant: unknown extra fields are preserved on `extra`, not dropped", () => {
  const withExtra = { payload: { ...WEEKLY.payload, custom_knob: 42, season: "spring" } };
  const p = foldInteractionProgram(withExtra);
  assert.equal(p.extra.custom_knob, 42);
  assert.equal(p.extra.season, "spring");
});

test("NEVER enumerates community type — a book club folds identically from DATA", () => {
  const bookClub = {
    payload: {
      kind: "interaction-program",
      id: "book-club",
      label: "Monthly Book Club",
      pairing: { group_size: 2 },
      group_ref: "group:readers",
      participant_source_ref: "person-list:readers",
      match_descriptor_ref: "semantic-index-descriptor:reading-taste",
      relationship_kind_ref: "relationship-graph.kind:pair",
      time_window_ref: "timed-action.window:30day",
      daily_context_sequence_ref: "context-feed.sequence:chapter-prompts",
      ai_icebreaker_producer_ref: "ai-records-producer.recipe:book-icebreaker",
      access_rule_ref: "access-rule:book-club",
      score_measure_ref: "progression-evaluator.measure:pages-read",
      surface_ref: "documents.page:book-club-home",
    },
  };
  const p = foldInteractionProgram(bookClub);
  // Same code path, different DATA → a valid program. No `if (kind === 'book-club')`.
  assert.equal(p.id, "book-club");
  assert.equal(p.refs.time_window_ref, "timed-action.window:30day");
});

test("foldInteractionPrograms maps by id (latest wins)", () => {
  const map = foldInteractionPrograms([
    WEEKLY,
    { payload: { ...WEEKLY.payload, label: "Weekly Matchmaker v2" } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("weekly-matchmaker").label, "Weekly Matchmaker v2");
});
