import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { compilePresentationPlan } from "../do-work/compile-presentation-plan.mjs";

const checks = [];
function check(name, run) { run(); checks.push(name); }
const format = {
  id: "unseen-format", revision: "format-revision", title: "An explanation",
  requirements: [], execution: { adapter: "arbitrary-adapter" },
  beats: [
    { id: "first", template: "{arbitrary_a} {arbitrary_b}", claim_refs: ["claim:a"] },
    { id: "second", template: "{arbitrary_c}", claim_refs: ["claim:b"] },
  ],
};
const document = { formats: [format] };
const material = {
  id: "arbitrary-material", title: "Evidence", revision: "source-revision",
  claims: [
    { id: "claim:a", class: "observation", evidence_refs: ["span:a"] },
    { id: "claim:b", class: "inference", evidence_refs: ["span:b"], uncertainty: "Untested" },
  ],
  fields: { arbitrary_a: "Statement", arbitrary_b: 0, arbitrary_c: "Boundary" },
};
const compile = (input = material, selected = format) => compilePresentationPlan(input, selected.id, { formats: [selected] });
check("unseen field names and zero render from DATA", () => {
  assert.equal(compile().beats[0].text, "Statement 0");
});
check("all missing fields and absent claims are collected", () => {
  assert.throws(() => compile({ ...material, claims: [], fields: { arbitrary_c: {} } }), error => {
    assert.equal(error.diagnostic.issues.length, 5);
    assert.equal(error.diagnostic.material_revision, material.revision);
    assert.equal(error.diagnostic.format_revision, format.revision);
    return true;
  });
});
check("one missing field is rejected", () => {
  assert.throws(() => compile({ ...material, fields: { arbitrary_a: "a", arbitrary_b: 1 } }), error => error.diagnostic.issues.length === 1);
});
check("duplicate claim identity cannot silently overwrite evidence", () => {
  assert.throws(() => compile({ ...material, claims: [...material.claims, material.claims[0]] }), /selected format/);
});
check("claim classes and uncertainty survive compilation", () => {
  assert.deepEqual(compile().claim_snapshot, material.claims);
});
check("format and material revisions independently change plan identity", () => {
  const baseline = compile().id;
  assert.notEqual(compile({ ...material, revision: "corrected-source" }).id, baseline);
  assert.notEqual(compile(material, { ...format, revision: "corrected-format" }).id, baseline);
});
check("unknown format is not replaced by a default", () => {
  assert.throws(() => compilePresentationPlan(material, "absent", document), /unknown format/);
});
check("pairs and top-level material preserve their supported behavior", () => {
  assert.equal(compile({ ...material, fields: Object.entries(material.fields) }).beats[0].text, "Statement 0");
  const { fields, ...base } = material;
  assert.equal(compile({ ...base, ...fields }).beats[0].text, "Statement 0");
});
check("nested fields do not implicitly borrow unrelated metadata", () => {
  assert.throws(() => compile(material, { ...format, beats: [{ id: "x", template: "{title}" }] }), /selected format/);
});
check("non-text templates produce a contract error", () => {
  assert.throws(() => compile(material, { ...format, beats: [{ id: "x", template: {} }] }), error => error.diagnostic.issues[0].includes("template must be text"));
});
const materialArg = process.argv.indexOf("--material");
if (materialArg >= 0) {
  const sourceMaterial = JSON.parse(readFileSync(process.argv[materialArg + 1], "utf8"));
  const formatsArg = process.argv.indexOf("--formats");
  assert.ok(formatsArg >= 0, "supply the caller's --formats document");
  const formats = JSON.parse(readFileSync(process.argv[formatsArg + 1], "utf8"));
  check("real source material reports the complete mismatch without inventing text", () => {
    assert.throws(() => compilePresentationPlan(sourceMaterial, "F57-TEXT", formats), error => {
      for (const field of ["title", "scene", "mechanism", "boundary", "ending"]) {
        assert.ok(error.diagnostic.issues.some(issue => issue.includes(`field ${field}`)), field);
      }
      return true;
    });
  });
}
const collectionArg = process.argv.indexOf("--collection");
if (collectionArg >= 0) {
  const collection = JSON.parse(readFileSync(process.argv[collectionArg + 1], "utf8"));
  const selectionArg = process.argv.indexOf("--selection");
  assert.ok(selectionArg >= 0, "a selection identity must be supplied");
  const rows = collection.records.filter(row => row.selection_id === process.argv[selectionArg + 1]);
  check("saved selection resolves uniquely without a fallback", () => assert.equal(rows.length, 1));
  const selected = rows[0];
  const sourceMaterial = selected.production_material;
  check("selection retains source revisions and correlation", () => {
    assert.ok(selected.correlation_ref);
    assert.ok(selected.source_revision_refs?.length);
    assert.ok(sourceMaterial.source_refs?.length);
  });
  check("every material claim cites declared evidence locators", () => {
    const evidence = new Set(selected.evidence_locator_refs);
    assert.equal(new Set(sourceMaterial.claims.map(claim => claim.id)).size, sourceMaterial.claims.length);
    for (const claim of sourceMaterial.claims) {
      assert.ok(claim.class);
      assert.ok(claim.evidence_refs?.length);
      for (const ref of claim.evidence_refs) assert.ok(evidence.has(ref), ref);
    }
  });
  check("every selected format compiles without changing source material", () => {
    const before = JSON.stringify(selected);
    const formatsArg = process.argv.indexOf("--formats");
    assert.ok(formatsArg >= 0, "supply the caller's --formats document");
    const formats = JSON.parse(readFileSync(process.argv[formatsArg + 1], "utf8"));
    for (const id of new Set(Object.values(selected.requested_output_formats))) {
      const plan = compilePresentationPlan(sourceMaterial, id, formats);
      assert.ok(plan.beats.some(beat => beat.text.trim()));
      assert.deepEqual(plan.claim_snapshot, sourceMaterial.claims);
      assert.equal(plan.material_revision, sourceMaterial.revision);
    }
    assert.equal(JSON.stringify(selected), before);
  });
}
const report = { id: "presentation-input-contract", kind: "test-result", checks, passed: checks.length };
const outputArg = process.argv.indexOf("--out");
if (outputArg >= 0) writeFileSync(process.argv[outputArg + 1], JSON.stringify([report]));
console.log(JSON.stringify(report));
