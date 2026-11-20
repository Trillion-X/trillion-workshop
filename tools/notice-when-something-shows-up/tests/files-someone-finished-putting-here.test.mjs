// packages/notice-when-something-shows-up/tests/files-someone-finished-putting-here.test.mjs
//
// Hostile proof for the handover mechanism leaf, driven through the real emitter with a
// fake carrier and injected listing, so nothing here touches the host except a scratch
// directory for the one on-disk case.
//
// The proofs the plan's ledger names:
//   R5  a unit with no note is invisible; the note makes exactly one fact
//   R6  a unit nobody declared is a fact with empty matched_source_refs
//   R11 a second sender costs one predicate row, and both facts carry different refs
//   a note whose byte_length disagrees with the disk is a refused fact, never silence
//   a note that is not JSON is a refused fact, never silence
//   the leaf's declared identity matches the waiter row in the manifest

import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONDITIONS,
  readWaiterRow,
  resolveMechanism,
  runResidentEmitter,
} from "../do-work/emit-arrival-fact.mjs";
import * as handover from "../do-work/mechanisms/files-someone-finished-putting-here.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(path.join(packageRoot, "things-to-store-and-run.json"), "utf8"));
const ROW = MANIFEST.things
  .filter((thing) => thing.payload?.kind === "notice-when-something-shows-up.waiter-descriptor")
  .map((thing) => thing.payload)
  .find((row) => row.id === "waiter:handed-over-files");

function feedRow(sourceRef, handedOverBy) {
  return {
    payload: {
      value_json: JSON.stringify({
        source_ref: sourceRef,
        identity_predicate: {
          claims: [{ select: { from: "observed_identity", path: "handed_over_by" }, operator: "op:core.equals", value: handedOverBy }],
        },
      }),
    },
  };
}

function fakeCarrier({ feed = [] } = {}) {
  const writes = [];
  return {
    writes,
    async scanUnderPath(pathLabels) {
      const key = pathLabels.join("/");
      if (key === "packages/notice-when-something-shows-up/waiter-descriptor") {
        return { entries: [{ payload: ROW }] };
      }
      if (key === "prop:observed_content:source_descriptor") return { entries: feed };
      return { entries: [] };
    },
    async readCurrent() { throw new Error("not found"); },
    async writeRecord(write) { writes.push(write); return { ok: true }; },
  };
}

test("the manifest row names this leaf, and the leaf answers to the row", async () => {
  assert.ok(ROW, "waiter:handed-over-files row is declared");
  const declared = readWaiterRow(ROW);
  assert.equal(declared.mechanism_leaf, "files-someone-finished-putting-here.mjs");
  const resolved = await resolveMechanism(ROW, { loadModule: async () => handover });
  assert.equal(resolved.described.mechanism_ref, ROW.mechanism_capability_ref);
  assert.deepEqual(resolved.described.conditions, [CONDITIONS.reachable]);
  assert.deepEqual(resolved.described.detail_fields, []);
  // The place is a REFERENCE the owner resolves after admission, never text in DATA.
  // A literal here (especially ".") would resolve to this process's ephemeral working
  // directory, which lists cleanly and is permanently empty, so the waiter would look
  // healthy and report nothing forever. That is the silent success this package exists
  // to make impossible.
  assert.equal(ROW.is_active, true);
  assert.deepEqual(ROW.mechanism_settings.handover_place, {
    from: "environment",
    key: "BITFIELD_HANDOVER_PLACE",
  });
});

test("the place is required and unresolvable is a THROW, never a quiet empty directory", () => {
  assert.equal(
    handover.readSettings(ROW.mechanism_settings, { BITFIELD_HANDOVER_PLACE: "/owner/volume" })
      .handover_place,
    "/owner/volume",
  );
  // Absent, empty, and missing entirely all throw. None of them may fall back to ".".
  assert.throws(() => handover.readSettings(ROW.mechanism_settings, {}), /absent or empty/);
  assert.throws(
    () => handover.readSettings(ROW.mechanism_settings, { BITFIELD_HANDOVER_PLACE: "   " }),
    /absent or empty/,
  );
  assert.throws(() => handover.readSettings({}, {}), /handover_place is required/);
  assert.throws(
    () => handover.readSettings({ handover_place: { from: "environment" } }, {}),
    /no key/,
  );
});

test("a handover place that is not a directory is an error, never an empty listing", () => {
  assert.throws(
    () => handover.listCompletionNotes("/a/place/that/does/not/exist", ".handover-finished.json"),
    /is not a directory/,
    "an absent place must fail loudly; an empty answer is indistinguishable from a quiet host",
  );
});

test("pure: the note's fields travel verbatim, disk length wins, and disagreement is a refusal", () => {
  const good = handover.observedIdentityFromNote({
    noteRelativePath: "CLIP/C0001.MP4.handover-finished.json",
    suffix: ".handover-finished.json",
    noteText: JSON.stringify({ content_identity: "1f:00", byte_length: 3, media_type: "video/mp4", handed_over_by: "h:a", a_field_invented_later: true }),
    unitByteLength: 3,
  });
  assert.equal(good.relative_name, "CLIP/C0001.MP4");
  assert.equal(good.handover_note_name, "CLIP/C0001.MP4.handover-finished.json");
  assert.equal(good.a_field_invented_later, true, "a producer's new fact needs no code here");
  assert.equal(good.refused, undefined);

  const disagree = handover.observedIdentityFromNote({ noteRelativePath: "x.handover-finished.json", suffix: ".handover-finished.json", noteText: JSON.stringify({ byte_length: 4 }), unitByteLength: 3 });
  assert.equal(disagree.refused, true);
  assert.equal(disagree.refusal_reason, "completion-note-byte-length-disagrees-with-disk");

  const missing = handover.observedIdentityFromNote({ noteRelativePath: "x.handover-finished.json", suffix: ".handover-finished.json", noteText: "{}", unitByteLength: null });
  assert.equal(missing.refusal_reason, "unit-missing-beside-its-note");

  const notJson = handover.observedIdentityFromNote({ noteRelativePath: "x.handover-finished.json", suffix: ".handover-finished.json", noteText: "{nope", unitByteLength: 3 });
  assert.equal(notJson.refusal_reason, "completion-note-not-json");
});

test("R5 on disk: a unit with no note is invisible; the note makes exactly one fact", async () => {
  const place = tempFolder(path.join(tmpdir(), "handover-mechanism-test."));
  try {
    await mkdir(path.join(place, "CLIP"), { recursive: true });
    await writeFile(path.join(place, "CLIP", "C0001.MP4"), Buffer.alloc(10, 7));
    assert.deepEqual(handover.listCompletionNotes(place, ".handover-finished.json"), []);
    await writeFile(path.join(place, "CLIP", "C0001.MP4.handover-finished.json"), JSON.stringify({ content_identity: "1f:aa", byte_length: 10, handed_over_by: "h:a" }));
    assert.deepEqual(handover.listCompletionNotes(place, ".handover-finished.json"), ["CLIP/C0001.MP4.handover-finished.json"]);
    // A note-shaped file with nothing before the suffix is not a note.
    await writeFile(path.join(place, ".handover-finished.json"), "{}");
    assert.deepEqual(handover.listCompletionNotes(place, ".handover-finished.json"), ["CLIP/C0001.MP4.handover-finished.json"]);
  } finally {
    await rm(place, { recursive: true, force: true });
  }
});

test("R6 and R11 through the emitter: declared senders match by identity, an undeclared one is a fact with no refs", async () => {
  const carrier = fakeCarrier({ feed: [feedRow("source:one", "h:one"), feedRow("source:two", "h:two")] });
  const controller = new AbortController();
  const notes = {
    "a.bin.handover-finished.json": JSON.stringify({ content_identity: "1f:01", byte_length: 1, handed_over_by: "h:one" }),
    "b.bin.handover-finished.json": JSON.stringify({ content_identity: "1f:02", byte_length: 1, handed_over_by: "h:two" }),
    "c.bin.handover-finished.json": JSON.stringify({ content_identity: "1f:03", byte_length: 1, handed_over_by: "h:nobody" }),
    "d.bin.handover-finished.json": "{not json",
  };
  const mechanism = {
    describeMechanism: handover.describeMechanism,
    async watchForTransitions(settings, handlers) {
      await handover.watchForTransitions(settings, {
        ...handlers,
        // The owner resolves this from the readable private volume root after admission.
        environment: { BITFIELD_HANDOVER_PLACE: "/owner/volumes/handover" },
        listNotes: () => Object.keys(notes).sort(),
        noteOptions: {
          readNote: async (file) => notes[path.basename(file)],
          stat: () => ({ isFile: () => true, size: 1 }),
        },
        watchPlace: () => ({ close() {} }),
        setInterval: () => null,
      });
    },
  };
  // watchForTransitions reports on start, then waits for the signal; abort after the first pass.
  const run = runResidentEmitter({
    env: {},
    carrier,
    loadModule: async () => mechanism,
    signal: controller.signal,
    nowMs: () => 1_800_000_000_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await run;

  const facts = carrier.writes.map((write) => write.payload);
  assert.equal(facts.length, 4, "three units and one refused note, each a fact");
  const byNote = Object.fromEntries(facts.map((fact) => [fact.observed_identity.handover_note_name, fact]));
  assert.deepEqual(byNote["a.bin.handover-finished.json"].matched_source_refs, ["source:one"]);
  assert.deepEqual(byNote["b.bin.handover-finished.json"].matched_source_refs, ["source:two"]);
  assert.deepEqual(byNote["c.bin.handover-finished.json"].matched_source_refs, [], "R6: undeclared is a fact, not an error");
  assert.equal(byNote["d.bin.handover-finished.json"].observed_identity.refused, true);
  assert.equal(byNote["d.bin.handover-finished.json"].observed_identity.refusal_reason, "completion-note-not-json");
  assert.equal(byNote["a.bin.handover-finished.json"].observed_identity.relative_name, "a.bin");
  assert.equal(byNote["a.bin.handover-finished.json"].observed_identity.content_identity, "1f:01");
  for (const fact of facts) {
    assert.equal(fact.condition, CONDITIONS.reachable);
    assert.equal(carrier.writes.find((w) => w.payload === fact).addressLabel, "something-showed-up::handed-over-files");
  }
  assert.deepEqual(facts.map((fact) => fact.sequence), [0, 1, 2, 3]);
});
