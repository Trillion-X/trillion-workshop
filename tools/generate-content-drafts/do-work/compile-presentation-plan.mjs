#!/usr/bin/env node
import { realpathSync } from 'node:fs';
/**
 * file: tools/generate-content-drafts/do-work/compile-presentation-plan.mjs
 *
 * PURPOSE: Compile one source material object and one presentation-format DATA
 * row into an executable production plan. A format is DATA; this compiler never
 * name-dispatches to a presentation family.
 *
 * NON-GOALS:
 * - no camera access
 * - no sensor observation
 * - no permission grant
 * - no publish authority
 * - no format-specific branch
 */

import { makeHashCodeHexFromBytes } from "../../content-identity/read-data/identity.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function compilePresentationPlan(material, formatId, formatDocument) {
if (!formatDocument || !Array.isArray(formatDocument.formats)) fail("formats must contain a formats array");
const format = (formatDocument.formats ?? []).find((candidate) => candidate.id === formatId);
if (!format) fail(`unknown format "${formatId}"`);

if (!material || typeof material !== "object" || Array.isArray(material)) {
  fail("material must be an object");
}
if (typeof material.id !== "string" || material.id.trim().length === 0) {
  fail("material needs a non-empty id");
}
if (!Array.isArray(material.claims)) fail("material needs a claims array");

const claims = new Map(material.claims.map((claim) => {
  if (!claim || typeof claim !== "object" || typeof claim.id !== "string") {
    fail("every material claim needs an id");
  }
  return [claim.id, claim];
}));
const fields = materialFields(material);

if (!Array.isArray(format.beats) || format.beats.length === 0) {
  fail(`format ${format.id} needs beats`);
}
if (!Array.isArray(format.requirements)) {
  fail(`format ${format.id} needs a requirements array`);
}
if (!format.execution || typeof format.execution.adapter !== "string") {
  fail(`format ${format.id} needs execution.adapter`);
}

// Inspect the complete selected contract before rendering any beat. Field names
// belong to the format DATA; missing content must never be guessed here.
const inputIssues = [];
for (const requiredClaimId of material.required_claims ?? []) {
  if (!claims.has(requiredClaimId)) inputIssues.push(`material is missing required claim ${requiredClaimId}`);
}
const claimIds = new Set();
for (const claim of material.claims) {
  if (claimIds.has(claim.id)) inputIssues.push(`duplicate material claim ${claim.id}`);
  claimIds.add(claim.id);
}
for (const [index, beat] of format.beats.entries()) {
  if (!beat || typeof beat !== "object") {
    inputIssues.push(`beat ${index} in ${format.id} must be an object`);
    continue;
  }
  if (typeof beat.id !== "string" || beat.id.trim().length === 0) {
    inputIssues.push(`beat ${index} in ${format.id} needs an id`);
  }
  for (const claimId of beat.claim_refs ?? []) {
    if (!claims.has(claimId)) inputIssues.push(`beat ${beat.id} references absent material claim ${claimId}`);
  }
  if (beat.template != null && typeof beat.template !== "string") {
    inputIssues.push(`beat ${beat.id} template must be text`);
    continue;
  }
  for (const [, fieldId] of (beat.template ?? "").matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    if (!fields.has(fieldId)) {
      inputIssues.push(`beat ${beat.id} references absent material field ${fieldId}`);
    } else if (typeof fields.get(fieldId) !== "string" && typeof fields.get(fieldId) !== "number") {
      inputIssues.push(`material field ${fieldId} must be text or a number`);
    }
  }
}
if (inputIssues.length) {
  const diagnostic = {
    error: "material does not satisfy the selected format",
    material_id: material.id,
    material_revision: material.revision ?? 1,
    format_id: format.id,
    format_revision: format.revision ?? 1,
    issues: [...new Set(inputIssues)],
  };
  throw Object.assign(new Error(diagnostic.error), { diagnostic });
}

const compiledBeats = format.beats.map((beat) => {
  return {
    ...beat,
    template: beat.template ?? "",
    text: renderTemplate(beat.template ?? ""),
    origin_format: format.id,
    key: `${format.id}:${beat.id}`,
  };
});

const requirementKeys = new Set();
const requirements = format.requirements.map((requirement, index) => {
  if (!requirement || typeof requirement !== "object") {
    fail(`requirement ${index} in ${format.id} must be an object`);
  }
  if (typeof requirement.id !== "string" || requirement.id.trim().length === 0) {
    fail(`requirement ${index} in ${format.id} needs an id`);
  }
  const key = `${format.id}:${requirement.id}`;
  if (requirementKeys.has(key)) fail(`duplicate requirement key ${key}`);
  requirementKeys.add(key);
  if (!Array.isArray(requirement.methods) || requirement.methods.length === 0) {
    fail(`requirement ${key} needs accepted evidence methods`);
  }
  return {
    ...requirement,
    key,
    expected: requirement.expected ?? true,
  };
});

const identity = JSON.stringify({
  material_id: material.id,
  material_revision: material.revision ?? 1,
  format_id: format.id,
  format_revision: format.revision ?? 1,
});
const planId = `PLAN-${makeHashCodeHexFromBytes(Buffer.from(identity))}`;
const adapter = format.execution.adapter;
const capabilities = [...new Set([...(format.capabilities ?? []), adapter])];

const plan = {
  id: planId,
  title: `${material.title} — ${format.title}`,
  material_id: material.id,
  material_revision: material.revision ?? 1,
  format_id: format.id,
  format_revision: format.revision ?? 1,
  medium: format.medium,
  style: format.style ?? {},
  series_policy: format.series_policy ?? "none",
  roles: format.roles ?? [],
  acquisitions: format.acquisitions ?? [],
  beats: compiledBeats,
  requirements,
  capabilities,
  execution: format.execution,
  claim_snapshot: material.claims,
  projection_losses: [],
  status: "awaiting_setup",
  observations: {},
  armed: false,
  grant_until: null,
  countdown_until: null,
  command: null,
  receipt: null,
  verification: "Declared projection; setup and execution require their own evidence.",
  source_refs: [...new Set([...(material.source_refs ?? []), ...(format.source_refs ?? [])])],
  revision: 1,
};

return plan;

function renderTemplate(template) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, fieldId) => String(fields.get(fieldId)));
}
}

function materialFields(material) {
  if (Array.isArray(material.fields)) {
    return new Map(material.fields.map((field) => {
      if (!Array.isArray(field) || field.length !== 2 || typeof field[0] !== "string") {
        fail("material fields must be [id, value] pairs");
      }
      return field;
    }));
  }
  if (material.fields && typeof material.fields === "object") {
    return new Map(Object.entries(material.fields));
  }
  const reservedMaterialFields = new Set([
    "schema",
    "revision",
    "required_claims",
    "claims",
    "source_refs",
    "provenance_note",
  ]);
  const fields = new Map();
  for (const [id, value] of Object.entries(material)) {
    if (reservedMaterialFields.has(id)) continue;
    if (typeof value === "string" || typeof value === "number") fields.set(id, value);
  }
  if (fields.size > 0) return fields;
  fail("material needs a fields object, [id, value] pairs, or self-describing top-level text fields");
}

function required(arguments_, name) {
  const value = arguments_.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    console.error(
      "usage: compile-presentation-plan.mjs --material <json> --format <id> --formats <json> --out <json>",
    );
    process.exit(2);
  }
  return value;
}

function fail(message) {
  throw new Error(message);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    if (process.argv.includes("--json")) {
      const input = JSON.parse(readFileSync(0, "utf8"));
      const formats = input.formats;
      console.log(JSON.stringify({ result: compilePresentationPlan(input.material, input.format_id, formats) }));
    } else {
    const arguments_ = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      arguments_.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
    }
    const materialPath = required(arguments_, "material");
    const formatId = required(arguments_, "format");
    const outputPath = required(arguments_, "out");
    const formatsPath = required(arguments_, "formats");
    const material = JSON.parse(readFileSync(materialPath, "utf8"));
    const plan = compilePresentationPlan(material, formatId, JSON.parse(readFileSync(formatsPath, "utf8")));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ plan_id: plan.id, format: plan.format_id, material: plan.material_id,
      beats: plan.beats.length, requirements: plan.requirements.length, capabilities: plan.capabilities, output: outputPath }));
    }
  } catch (error) {
    console.error(JSON.stringify(error.diagnostic ?? { error: error.message }));
    process.exitCode = 1;
  }
}
