// packages/service-connections/do-work/apply-declared-manifest-record-edits.mjs
//
// PURPOSE: Apply a declared list of record edits to a package manifest
// (`things-to-store-and-run.json`). The manifest is one JSON line too large
// for a text editor to hold; this owner parses it, applies each edit to the
// row its `match` selects, and writes it back in the same single-line shape.
// The edit list is DATA; this file knows no package, no record kind, no field
// name. A row is selected by `match: { field, equals }`; when `match` is
// absent it is `{ field: "address", equals: edit.address }`, so an edits file
// written before `match` existed behaves exactly as it did. A `stored_bytes`
// row has no address and is selected by `{ field: "name", equals: ... }`.
//
// NON-NEGOTIABLE INVARIANTS
// 1. An edit whose `match` selects no row is refused whole, before any write,
//    unless it is an `upsert` with `allow_insert`. A silent no-op is worse than
//    a refusal.
// 2. `upsert` replaces the whole selected row, or appends the record when
//    nothing is selected and `allow_insert` is true. The record must carry the
//    matched field with the matched value, so an edit cannot file a row under
//    one key and select it by another.
// 3. `set_payload_path` sets one dotted path inside `payload` and `delete_payload_path`
//    removes one; both refuse when nothing is selected.
// 4. The output is byte-stable for untouched records: the file is re-serialised
//    with the same compact separators it already uses.
// 5. Readback: prints each selector touched and the record count before/after.
//
// EDITS (JSON file):
//   [
//     { "kind": "upsert", "address": "...", "record": { ...whole record... }, "allow_insert": true },
//     { "kind": "upsert", "match": { "field": "name", "equals": "..." }, "record": { ...stored_bytes row... }, "allow_insert": true },
//     { "kind": "set_payload_path", "address": "...", "path": "acquire.redirect", "value": {...} },
//     { "kind": "delete_payload_path", "address": "...", "path": "acquire.process" }
//   ]
//
// Run: node apply-declared-manifest-record-edits.mjs --manifest <path> --edits <path>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function flag(name) {
  const at = process.argv.indexOf(name);
  if (at < 0 || at + 1 >= process.argv.length) {
    console.error(`${name} <path> is required`);
    process.exit(1);
  }
  return process.argv[at + 1];
}

const manifestPath = flag("--manifest");
const editsPath = flag("--edits");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const edits = JSON.parse(fs.readFileSync(editsPath, "utf8"));
if (!Array.isArray(manifest.things)) throw new Error("manifest has no things array");
if (!Array.isArray(edits)) throw new Error("edits must be an array");

const before = manifest.things.length;
// The selector is DATA on the edit. Absent, it is the address, so every edits
// file written before `match` existed selects exactly what it always did.
const selectorOf = (edit) => {
  if (edit.match && typeof edit.match === "object") {
    if (typeof edit.match.field !== "string" || !("equals" in edit.match)) {
      throw new Error("refused: match must carry a string field and an equals value");
    }
    return { field: edit.match.field, equals: edit.match.equals };
  }
  return { field: "address", equals: edit.address };
};
const indexOf = (selector) => manifest.things.findIndex((t) => t && t[selector.field] === selector.equals);
const labelOf = (selector) => (selector.field === "address" ? String(selector.equals) : `${selector.field}=${String(selector.equals)}`);

function setPath(root, path, value) {
  const parts = path.split(".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (cursor[part] === undefined || cursor[part] === null || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function deletePath(root, path) {
  const parts = path.split(".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object") return false;
    cursor = cursor[part];
  }
  if (!cursor || typeof cursor !== "object" || !(parts[parts.length - 1] in cursor)) return false;
  delete cursor[parts[parts.length - 1]];
  return true;
}

const touched = [];
for (const edit of edits) {
  const selector = selectorOf(edit);
  const label = labelOf(selector);
  const at = indexOf(selector);
  if (edit.kind === "upsert") {
    if (at < 0 && !edit.allow_insert) throw new Error(`refused: ${label} is absent and allow_insert is not set`);
    // `record_from_file` names a JSON file beside the edits file holding the
    // whole record, so a large record is authored once, in its own file.
    const record = edit.record_from_file
      ? JSON.parse(fs.readFileSync(path.resolve(path.dirname(editsPath), edit.record_from_file), "utf8"))
      : edit.record;
    if (!record || record[selector.field] !== selector.equals) throw new Error(`refused: record ${selector.field} does not match ${label}`);
    if (at < 0) manifest.things.push(record);
    else manifest.things[at] = record;
    touched.push({ selected: label, kind: at < 0 ? "inserted" : "replaced" });
  } else if (edit.kind === "set_payload_path") {
    if (at < 0) throw new Error(`refused: ${label} is absent`);
    setPath(manifest.things[at].payload, edit.path, edit.value);
    touched.push({ selected: label, kind: "set", path: edit.path });
  } else if (edit.kind === "append_payload_list") {
    // Append one value to a list at `path`; refused when the path is not a
    // list; a value already present is left alone (idempotent).
    if (at < 0) throw new Error(`refused: ${label} is absent`);
    const parts = edit.path.split(".");
    let cursor = manifest.things[at].payload;
    for (const part of parts.slice(0, -1)) cursor = cursor?.[part];
    const list = cursor?.[parts[parts.length - 1]];
    if (!Array.isArray(list)) throw new Error(`refused: ${label} ${edit.path} is not a list`);
    const present = list.some((item) => JSON.stringify(item) === JSON.stringify(edit.value));
    if (!present) list.push(edit.value);
    touched.push({ selected: label, kind: present ? "already-present" : "appended", path: edit.path });
  } else if (edit.kind === "delete_payload_path") {
    if (at < 0) throw new Error(`refused: ${label} is absent`);
    if (!deletePath(manifest.things[at].payload, edit.path)) throw new Error(`refused: ${label} has no ${edit.path}`);
    touched.push({ selected: label, kind: "deleted", path: edit.path });
  } else {
    throw new Error(`refused: unknown edit kind ${String(edit.kind)}`);
  }
}

// Keep the shape the file already had: a multi-line manifest stays readable
// in a diff, a single-line one stays single-line. `--format pretty|compact`
// overrides when a caller wants to normalise.
const formatFlag = process.argv.indexOf("--format");
const format = formatFlag >= 0 ? process.argv[formatFlag + 1] : (fs.readFileSync(manifestPath, "utf8").includes("\n  ") ? "pretty" : "compact");
fs.writeFileSync(manifestPath, format === "pretty" ? `${JSON.stringify(manifest, null, 2)}\n` : JSON.stringify(manifest));
console.log(JSON.stringify({ manifest: manifestPath, before, after: manifest.things.length, touched }, null, 1));
