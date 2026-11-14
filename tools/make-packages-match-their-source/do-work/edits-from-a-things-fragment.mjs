// packages/make-packages-match-their-source/do-work/edits-from-a-things-fragment.mjs
//
// PURPOSE: Turn a manifest FRAGMENT (a file holding `{ "things": [...] }`, or a bare
// array of things) into an edits list that `apply-declared-manifest-record-edits.mjs`
// applies to a real manifest. A fragment is a manifest that was never merged: it has
// the manifest's row shape, it was authored beside the manifest, and until it is
// merged nothing delivers it. This owner merges it without a person retyping rows.
//
// Each thing becomes ONE upsert selected by its own identity field (`address` for a
// record, `name` for anything addressed by name), written to its own file under the
// output folder and referenced by `record_from_file`, so a row can be excluded or
// replaced by touching one small file before the edits are applied.
//
// KEYS THAT ARE NOT PACKAGE DATA ARE DROPPED BY PATTERN, NEVER BY LIST. The caller
// names them: `--drop-keys-matching '^_'` removes author notes (the underscore
// convention the source rule `a-record-payload-may-not-carry-a-note-to-the-reader`
// already judges), `--drop-keys-matching '^partition_(key|label)$'` removes the
// partition a package must not name. This file knows no key name, no package and
// no record kind.
//
// NON-NEGOTIABLE INVARIANTS
// 1. A thing with neither `address` nor `name` is refused whole, before any file is
//    written. A row nothing can select is a row nothing can ever correct.
// 2. Dropping is recursive and reported: the readback prints every dropped key with
//    its count, so a caller sees exactly what left the rows.
// 3. Nothing here reads or writes a manifest. The edits list is the whole output; the
//    manifest editor is the one applier, and its refusals stay its own.
//
// Run: node edits-from-a-things-fragment.mjs --fragment <abs> --out-folder <abs>
//        [--drop-keys-matching <regex>]...

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function flag(name) {
  const at = process.argv.indexOf(name);
  if (at < 0 || at + 1 >= process.argv.length) {
    console.error(`${name} <value> is required`);
    process.exit(1);
  }
  return process.argv[at + 1];
}

function flags(name) {
  const values = [];
  for (let index = 0; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[index + 1]);
  }
  return values;
}

const fragmentPath = flag("--fragment");
const outFolder = flag("--out-folder");
const dropPatterns = flags("--drop-keys-matching").map((source) => {
  try {
    return new RegExp(source);
  } catch (error) {
    console.error(`refused: --drop-keys-matching ${source} is not a valid pattern: ${error.message}`);
    process.exit(1);
  }
});

const parsed = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
const things = Array.isArray(parsed) ? parsed : parsed?.things;
if (!Array.isArray(things)) throw new Error("refused: fragment holds neither a things array nor a bare array");

const dropped = new Map();
function withoutDroppedKeys(value) {
  if (Array.isArray(value)) return value.map(withoutDroppedKeys);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (dropPatterns.some((pattern) => pattern.test(key))) {
      dropped.set(key, (dropped.get(key) ?? 0) + 1);
      continue;
    }
    out[key] = withoutDroppedKeys(inner);
  }
  return out;
}

function selectorOf(thing, index) {
  if (typeof thing?.address === "string" && thing.address.length > 0) return { field: "address", equals: thing.address };
  if (typeof thing?.name === "string" && thing.name.length > 0) return { field: "name", equals: thing.name };
  throw new Error(`refused: things[${index}] has neither an address nor a name, so nothing could ever select it`);
}

// Refuse before any write: every selector must resolve first.
const selectors = things.map((thing, index) => selectorOf(thing, index));

fs.mkdirSync(outFolder, { recursive: true });
const edits = [];
things.forEach((thing, index) => {
  const selector = selectors[index];
  const slug = String(selector.equals).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const fileName = `${String(index + 1).padStart(2, "0")}-${slug}.json`;
  fs.writeFileSync(path.join(outFolder, fileName), `${JSON.stringify(withoutDroppedKeys(thing), null, 2)}\n`);
  edits.push({ kind: "upsert", match: selector, record_from_file: fileName, allow_insert: true });
});
const editsPath = path.join(outFolder, "edits.json");
fs.writeFileSync(editsPath, `${JSON.stringify(edits, null, 2)}\n`);
console.log(JSON.stringify({
  fragment: fragmentPath,
  edits: editsPath,
  thing_count: things.length,
  dropped_keys: Object.fromEntries([...dropped.entries()].sort()),
}, null, 1));
