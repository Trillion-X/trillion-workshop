// packages/make-packages-match-their-source/tests/a-things-fragment-becomes-edits-without-retyping.test.mjs
//
// A `.things.json` fragment is a manifest that was never merged. These tests pin that
// the converter turns every row into one selectable upsert, that dropped keys are
// removed at every depth and reported, that a row with no identity refuses before
// any file is written, and that the produced edits apply cleanly through the editor.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CONVERTER = fileURLToPath(new URL("../do-work/edits-from-a-things-fragment.mjs", import.meta.url));
const EDITOR = fileURLToPath(new URL("../do-work/apply-declared-manifest-record-edits.mjs", import.meta.url));

function tmp() {
  return tempFolder(path.join(os.tmpdir(), "things-fragment-"));
}

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const FRAGMENT = {
  package: "fixture",
  _comment: "top-level note",
  things: [
    { type: "stored_bytes", name: "one-py", source_path: "do-work/one.py", _comment: "row note" },
    {
      type: "record",
      address: "package::fixture::workflow-action::go",
      address_mode: "identity_text",
      path: ["current-item", "published-record", "workflow-definition"],
      payload: { id: "action:go", partition_key: "runtime-partition", steps: [{ id: "a", _comment: "deep note", config: { partition_label: "runtime-partition", x: 1 } }] },
      remove: false,
    },
  ],
};

test("every row becomes one upsert selected by its own identity, with dropped keys removed at every depth and reported", () => {
  const dir = tmp();
  const fragment = path.join(dir, "fixture.things.json");
  fs.writeFileSync(fragment, JSON.stringify(FRAGMENT));
  const out = path.join(dir, "out");
  const result = run(CONVERTER, ["--fragment", fragment, "--out-folder", out, "--drop-keys-matching", "^_", "--drop-keys-matching", "^partition_(key|label)$"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.thing_count, 2);
  assert.deepEqual(report.dropped_keys, { _comment: 2, partition_key: 1, partition_label: 1 });
  const edits = JSON.parse(fs.readFileSync(path.join(out, "edits.json"), "utf8"));
  assert.deepEqual(edits.map((edit) => edit.match), [
    { field: "name", equals: "one-py" },
    { field: "address", equals: "package::fixture::workflow-action::go" },
  ]);
  const record = JSON.parse(fs.readFileSync(path.join(out, edits[1].record_from_file), "utf8"));
  assert.equal("partition_key" in record.payload, false);
  assert.equal("partition_label" in record.payload.steps[0].config, false);
  assert.equal("_comment" in record.payload.steps[0], false);
  assert.equal(record.payload.steps[0].config.x, 1);
});

test("a row with neither address nor name refuses before any file is written", () => {
  const dir = tmp();
  const fragment = path.join(dir, "bad.things.json");
  fs.writeFileSync(fragment, JSON.stringify({ things: [{ type: "record", payload: {} }] }));
  const out = path.join(dir, "out");
  const result = run(CONVERTER, ["--fragment", fragment, "--out-folder", out]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /neither an address nor a name/);
  assert.equal(fs.existsSync(out), false);
});

test("the produced edits apply through the manifest editor and insert both rows", () => {
  const dir = tmp();
  const fragment = path.join(dir, "fixture.things.json");
  fs.writeFileSync(fragment, JSON.stringify(FRAGMENT));
  const out = path.join(dir, "out");
  assert.equal(run(CONVERTER, ["--fragment", fragment, "--out-folder", out, "--drop-keys-matching", "^_"]).status, 0);
  const manifest = path.join(dir, "things-to-store-and-run.json");
  fs.writeFileSync(manifest, JSON.stringify({ package: "fixture", things: [] }));
  const applied = run(EDITOR, ["--manifest", manifest, "--edits", path.join(out, "edits.json")]);
  assert.equal(applied.status, 0, applied.stderr);
  const things = JSON.parse(fs.readFileSync(manifest, "utf8")).things;
  assert.equal(things.length, 2);
  assert.equal(things[0].name, "one-py");
  assert.equal(things[1].address, "package::fixture::workflow-action::go");
});
