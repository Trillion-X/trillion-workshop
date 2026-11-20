// packages/make-packages-match-their-source/tests/an-edit-may-select-a-row-by-any-field.test.mjs
//
// The manifest editor used to select a row by `address` only, so a `stored_bytes`
// row, which has a `name` and no address, could not be upserted at all and a
// person edited the one-line manifest by hand. An edit now carries
// `match: { field, equals }`; absent, it is the address. These tests pin that
// the default selects exactly what it always did, that a row can be selected by
// any field, and that a selector matching nothing refuses before any write.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const EDITOR = fileURLToPath(new URL("../do-work/apply-declared-manifest-record-edits.mjs", import.meta.url));

function fixture(things) {
  const dir = tempFolder(path.join(os.tmpdir(), "manifest-editor-"));
  const manifest = path.join(dir, "things-to-store-and-run.json");
  fs.writeFileSync(manifest, JSON.stringify({ package: "fixture", things }));
  return { dir, manifest };
}

function run(dir, manifest, edits) {
  const editsPath = path.join(dir, "edits.json");
  fs.writeFileSync(editsPath, JSON.stringify(edits));
  const result = spawnSync(process.execPath, [EDITOR, "--manifest", manifest, "--edits", editsPath], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, things: JSON.parse(fs.readFileSync(manifest, "utf8")).things };
}

const RECORD_ROW = { type: "record", address: "fixture:one", path: ["current-item", "published-record"], payload: { a: 1 }, remove: false };
const BYTES_ROW = { type: "stored_bytes", name: "one-py", source_path: "do-work/one.py" };

test("an edit with no match selects by address, exactly as before", () => {
  const { dir, manifest } = fixture([RECORD_ROW, BYTES_ROW]);
  const replaced = { ...RECORD_ROW, payload: { a: 2 } };
  const out = run(dir, manifest, [{ kind: "upsert", address: "fixture:one", record: replaced }]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.things[0], replaced);
  assert.deepEqual(out.things[1], BYTES_ROW);
  assert.match(out.stdout, /"selected": "fixture:one"/);
});

test("an edit may select a stored_bytes row by name and insert one that is absent", () => {
  const { dir, manifest } = fixture([RECORD_ROW, BYTES_ROW]);
  const rebuilt = { ...BYTES_ROW, source_path: "do-work/one-renamed.py" };
  const fresh = { type: "stored_bytes", name: "two-py", source_path: "do-work/two.py" };
  const out = run(dir, manifest, [
    { kind: "upsert", match: { field: "name", equals: "one-py" }, record: rebuilt },
    { kind: "upsert", match: { field: "name", equals: "two-py" }, record: fresh, allow_insert: true },
  ]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.things, [RECORD_ROW, rebuilt, fresh]);
  assert.match(out.stdout, /"selected": "name=one-py"/);
  assert.match(out.stdout, /"selected": "name=two-py"/);
});

test("a selector that matches nothing refuses the whole run before any write", () => {
  const { dir, manifest } = fixture([RECORD_ROW, BYTES_ROW]);
  const bytesBefore = fs.readFileSync(manifest);
  const out = run(dir, manifest, [
    { kind: "upsert", address: "fixture:one", record: { ...RECORD_ROW, payload: { a: 3 } } },
    { kind: "upsert", match: { field: "name", equals: "missing-py" }, record: { ...BYTES_ROW, name: "missing-py" } },
  ]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /name=missing-py is absent and allow_insert is not set/);
  assert.ok(bytesBefore.equals(fs.readFileSync(manifest)), "the manifest bytes must be untouched after a refusal");
});

test("a record filed under one key cannot be selected by another", () => {
  const { dir, manifest } = fixture([RECORD_ROW, BYTES_ROW]);
  const out = run(dir, manifest, [
    { kind: "upsert", match: { field: "name", equals: "one-py" }, record: { ...BYTES_ROW, name: "other-py" } },
  ]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /record name does not match name=one-py/);
});
