// Vendored from bitfield-packages/packages/interaction-program/tests/stewardship-configuration-gauntlet.test.mjs; only import paths changed (and the select-pairs-cli process mount test dropped, since Trillion forms introductions in src/community-matching.mjs instead of a process mount).
import { test } from "node:test";
import assert from "node:assert/strict";

let selectionModule = null;
let selectionLoadError = null;
try {
  selectionModule = await import("../../../src/community-logic/match/select-configurations.mjs");
} catch (error) {
  selectionLoadError = error;
}
const configurationTestOptions = selectionModule
  ? {}
  : { skip: "blocked by missing generic configuration-selection owner" };

function requireSelector() {
  assert.ok(
    selectionModule && typeof selectionModule.selectConfigurations === "function",
    `generic intervention/configuration selector is required: ${selectionLoadError?.message ?? "export missing"}`,
  );
  return selectionModule.selectConfigurations;
}

function scope(pursuit, state = "state:current") {
  return {
    pursuit_ref: pursuit,
    system_ref: `system:${pursuit}`,
    timescale_ref: "timescale:current-session",
    state_ref: state,
  };
}

function configuration(id, kind, expectedValue, pursuit, extra = {}) {
  return {
    id,
    configuration_kind: kind,
    expected_value: expectedValue,
    scope: scope(pursuit),
    required_resource_refs: [],
    collision_refs: [],
    ...extra,
  };
}

function selectedIds(result) {
  assert.ok(Array.isArray(result?.selected), "selector must return selected[]");
  return result.selected.map((entry) => entry.id).sort();
}

test("OWNER / GENERATIVE PRIMITIVE: configuration selection exists above human pairing", () => {
  requireSelector();
});

test("ADVERSARIAL: a higher-value workflow beats a human match sharing the same irreducible resource", configurationTestOptions, () => {
  const selectConfigurations = requireSelector();
  const result = selectConfigurations({
    configurations: [
      configuration("human-match", "human-group", 0.3, "pursuit:business", {
        collision_refs: ["resource:one-hour-of-founder-attention"],
      }),
      configuration("workflow", "workflow-definition", 0.95, "pursuit:business", {
        collision_refs: ["resource:one-hour-of-founder-attention"],
      }),
    ],
  });
  assert.deepEqual(selectedIds(result), ["workflow"]);
});

test("ADVERSARIAL: software, EEAF, trigger, formula, tool, place, and resource outputs need no human", configurationTestOptions, () => {
  const selectConfigurations = requireSelector();
  const kinds = [
    "software-package",
    "eeaf-operation",
    "workflow-definition",
    "trigger-rule",
    "formula",
    "tool",
    "place",
    "resource",
  ];
  const configurations = kinds.map((kind, index) => (
    configuration(`config:${kind}`, kind, 0.9 - index / 100, `pursuit:${kind}`)
  ));
  const result = selectConfigurations({ configurations });
  assert.deepEqual(selectedIds(result), configurations.map((entry) => entry.id).sort());
  assert.ok(result.selected.every((entry) => entry.configuration_kind !== "human-group"));
});

test("FAIL-CLOSED: no human match is emitted when nonhuman evidence is stronger or all evidence is zero", configurationTestOptions, () => {
  const selectConfigurations = requireSelector();
  const strongerNonhuman = selectConfigurations({
    configurations: [
      configuration("person", "human-group", 0.2, "pursuit:tennis", {
        collision_refs: ["resource:court-hour"],
      }),
      configuration("video-analysis", "software-package", 0.8, "pursuit:tennis", {
        collision_refs: ["resource:court-hour"],
      }),
    ],
  });
  assert.deepEqual(selectedIds(strongerNonhuman), ["video-analysis"]);

  const noEvidence = selectConfigurations({
    configurations: [configuration("unsupported-human", "human-group", 0, "pursuit:tennis")],
  });
  assert.deepEqual(selectedIds(noEvidence), []);
});

test("SCOPE: needle-mover evidence is invalid without pursuit, system, timescale, and state", configurationTestOptions, () => {
  const selectConfigurations = requireSelector();
  for (const missing of ["pursuit_ref", "system_ref", "timescale_ref", "state_ref"]) {
    const invalid = configuration(`missing:${missing}`, "tool", 1, "pursuit:scope-test");
    delete invalid.scope[missing];
    assert.deepEqual(selectedIds(selectConfigurations({ configurations: [invalid] })), []);
  }
});

test("PARALLELISM: one pursuit's biggest needle mover never suppresses compatible work in another pursuit", configurationTestOptions, () => {
  const selectConfigurations = requireSelector();
  const result = selectConfigurations({
    configurations: [
      configuration("tennis:analyze", "software-package", 0.95, "pursuit:tennis"),
      configuration("business:test", "workflow-definition", 0.99, "pursuit:business"),
      configuration("relationship:prepare", "prepared-human-action", 0.7, "pursuit:relationship"),
    ],
  });
  assert.deepEqual(selectedIds(result), ["business:test", "relationship:prepare", "tennis:analyze"]);
});

test("PARALLELISM: compatible actions inside one pursuit can all proceed beside the gating action", configurationTestOptions, () => {
  const selectConfigurations = requireSelector();
  const result = selectConfigurations({
    configurations: [
      configuration("forehand:test-spacing", "human-action", 0.99, "pursuit:tennis"),
      configuration("forehand:organize-footage", "workflow-definition", 0.7, "pursuit:tennis"),
      configuration("forehand:prepare-analysis", "software-package", 0.8, "pursuit:tennis"),
    ],
  });
  assert.deepEqual(selectedIds(result), [
    "forehand:organize-footage",
    "forehand:prepare-analysis",
    "forehand:test-spacing",
  ]);
});

test("GENERICITY: hostile unseen configuration kinds stay DATA and do not require an engine branch", configurationTestOptions, () => {
  const selectConfigurations = requireSelector();
  const unseenKind = "💥/future-capability::not-a-person<script>";
  const result = selectConfigurations({
    configurations: [configuration("unseen", unseenKind, 0.9, "pursuit:future")],
  });
  assert.deepEqual(selectedIds(result), ["unseen"]);
  assert.equal(result.selected[0].configuration_kind, unseenKind);
});
