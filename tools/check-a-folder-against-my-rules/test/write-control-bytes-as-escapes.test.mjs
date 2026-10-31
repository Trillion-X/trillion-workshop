// tools/check-a-folder-against-my-rules/test/write-control-bytes-as-escapes.test.mjs
//
// A raw control byte in a source file makes every plain `grep` over it answer with SILENCE, so a
// search returns a confident absence. These pin that the repair is a REPRESENTATION change and
// never a deletion: the byte carries meaning in every file it was found in (a composite-key
// separator), so a rewrite that loses it would silently collide keys.
//
// The refusal directions matter more than the success here, because the failure mode of a tool that
// edits source is that it edits source. Both are asserted: a rewrite that cannot be reversed exactly
// is refused, and a rewrite whose result does not parse is refused with the file untouched.

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  candidateBeside,
  escapeFor,
  nodeCanParse,
  rawControlCharacterCodes,
  theOnlyChangeIsTheseEscapes,
  withControlBytesAsEscapes,
  writeControlBytesAsEscapesIn,
} from "../do-work/write-control-bytes-as-escapes.mjs";

const NUL = String.fromCodePoint(0);
const somewhere = () => mkdtempSync(join(tmpdir(), "control-bytes-"));

test("the structure of a text file is left alone, so this does not rewrite every file there is", () => {
  const ordinary = "a\tb\nc\r\nd";
  assert.deepEqual(rawControlCharacterCodes(ordinary), []);
  assert.equal(withControlBytesAsEscapes(ordinary), ordinary);
});

test("every raw control character is reported, in order, as the code it is", () => {
  assert.deepEqual(rawControlCharacterCodes(`const key = \`\${a}${NUL}\${b}\`;`), [0]);
  // Two of them, and a repeat, because "how many" and "which distinct" are both read from this
  // and a set-returning version would answer the first one wrongly.
  const two = `a${NUL}b${String.fromCodePoint(0x1f)}c${NUL}d`;
  assert.deepEqual(rawControlCharacterCodes(two), [0, 0x1f, 0]);
});

test("the escape is the long form, because the short one is only almost always right", () => {
  // `\0` followed by a digit is a legacy octal escape and means something else, so a tool that
  // wrote the short form would be correct on most files and silently wrong on the rest.
  assert.equal(escapeFor(0), "\\u0000");
  assert.equal(escapeFor(0x1f), "\\u001f");
});

test("the rewrite changes exactly the control characters and nothing else", () => {
  const before = `const key = \`\${a}${NUL}\${b}\`;\n`;
  const after = withControlBytesAsEscapes(before);
  assert.ok(!after.includes(NUL), "no raw byte survives");
  assert.ok(after.includes("\\u0000"), "the escape is written");
  assert.equal(theOnlyChangeIsTheseEscapes(before, after), true);
});

test("the verifier catches a transform that changed something else as well", () => {
  const before = `const a = "${NUL}";\n`;
  assert.equal(theOnlyChangeIsTheseEscapes(before, withControlBytesAsEscapes(before) + "x"), false);
  assert.equal(theOnlyChangeIsTheseEscapes(before, before.split(NUL).join("")), false,
    "deleting the byte is the wrong repair and must not verify");
});

test("A FILE THAT ALREADY CONTAINS THE TEXT \\u0000 still verifies", () => {
  // ⛔ THE CASE THAT KILLED THE FIRST VERIFIER, found on a real file rather than imagined.
  // group/read-data/board-crosstab.ts carries the six characters \\u0000 as ordinary text. The
  // first verifier reversed escapes GLOBALLY and compared, so it turned that pre-existing escape
  // into a raw byte, the comparison failed, and a correct rewrite was refused. A global replace
  // cannot tell an escape this owner just wrote from one that was always there; position can.
  const before = `const already = "\\u0000";\nconst raw = "${NUL}";\n`;
  const after = withControlBytesAsEscapes(before);

  assert.equal(theOnlyChangeIsTheseEscapes(before, after), true);
  // The pre-existing text is untouched, and the raw one became an escape, so the result now holds
  // two identical-looking escapes that arrived by completely different routes.
  assert.equal(after, 'const already = "\\u0000";\nconst raw = "\\u0000";\n');
});

test("an escape that was ALWAYS an escape is not turned into a raw byte", () => {
  const untouched = 'const already = "\\u0041";\n';
  assert.equal(withControlBytesAsEscapes(untouched), untouched);
  assert.equal(theOnlyChangeIsTheseEscapes(untouched, untouched), true);
});

test("a file is rewritten in place and still parses", () => {
  const where = join(somewhere(), "keys.mjs");
  writeFileSync(where, `export const key = (a, b) => \`\${a}${NUL}\${b}\`;\n`);

  const said = writeControlBytesAsEscapesIn(where);

  assert.equal(said.changed, true, said.why);
  assert.equal(said.found, 1);
  assert.deepEqual(said.codes, ["\\u0000"]);
  const after = readFileSync(where, "utf8");
  assert.ok(!after.includes(NUL));
  assert.equal(nodeCanParse(where, where), true);
});

test("THE VALUE IS UNCHANGED, which is the whole claim and the one worth executing", async () => {
  // A test that only checks the bytes proves the file changed shape. This runs both versions and
  // compares what they COMPUTE, because the risk being guarded is a separator quietly disappearing
  // and collapsing two different keys into one.
  const folder = somewhere();
  const raw = join(folder, "before.mjs");
  const escaped = join(folder, "after.mjs");
  const body = `export const key = (a, b) => \`\${a}${NUL}\${b}\`;\n`;
  writeFileSync(raw, body);
  writeFileSync(escaped, body);
  const said = writeControlBytesAsEscapesIn(escaped);

  // ⛔ WITHOUT THESE TWO LINES THIS TEST CANNOT FAIL. Both files start identical, so if the rewrite
  // silently did nothing the value comparison below still passes and reports success about work
  // that never happened. The rewrite has to be shown to have happened before its result means
  // anything, which is the same rule as proving a probe's target exists.
  assert.equal(said.changed, true, said.why);
  assert.ok(!readFileSync(escaped, "utf8").includes(NUL), "the raw byte is gone from the source");

  const one = await import("file://" + raw);
  const two = await import("file://" + escaped);

  assert.equal(two.key("x", "yz"), one.key("x", "yz"));
  // And the property the separator exists for survives, which is the thing deleting it would break.
  assert.notEqual(two.key("x", "yz"), two.key("xy", "z"));
});

test("a file with nothing raw in it is left alone and says so", () => {
  const where = join(somewhere(), "clean.mjs");
  writeFileSync(where, "export const a = 1;\n");
  const said = writeControlBytesAsEscapesIn(where);
  assert.equal(said.changed, false);
  assert.match(said.why, /no raw control character/);
});

test("REFUSED: a result that does not parse leaves the file exactly as it was", () => {
  // A control byte OUTSIDE a literal is real corruption wearing this defect's clothes. Escaping it
  // would turn a file that fails loudly into one that fails somewhere else later.
  const folder = somewhere();
  const where = join(folder, "broken.mjs");
  const before = `export const a${NUL} = 1;\n`;
  writeFileSync(where, before);

  const said = writeControlBytesAsEscapesIn(where);

  assert.equal(said.changed, false);
  assert.match(said.why, /does not parse/);
  // ⛔ AND IT MUST REFUSE FOR THE RIGHT REASON. The first version of this test passed while the
  // parse check was rejecting the candidate's EXTENSION rather than reading it, so every file
  // reported "does not parse" and the guard looked like it worked. Asserting the reason names a
  // syntax error is what tells the two apart.
  assert.match(said.why, /SyntaxError|Invalid or unexpected|Unexpected/,
    "the refusal cites the source, not the file name: " + said.why);
  assert.equal(readFileSync(where, "utf8"), before, "the file on disk is untouched");
  assert.equal(existsSync(candidateBeside(where)), true,
    "the candidate stays beside it as evidence rather than being silently discarded");
});

test("the candidate keeps the original extension, because node reads mode from it", () => {
  assert.equal(candidateBeside("/a/b/keys.mjs"), "/a/b/keys.checking.mjs");
  assert.equal(candidateBeside("/a/b/thing.test.ts"), "/a/b/thing.test.checking.ts");
  // A dot in a FOLDER name is not an extension on the file.
  assert.equal(candidateBeside("/a/b.c/Makefile"), "/a/b.c/Makefile.checking");
});

test("REFUSED: a rewrite that cannot be reversed exactly is not written", () => {
  // THE DEFECT THIS OWNER WAS BUILT TO AVOID, executed rather than described: a transform that
  // DELETES the byte instead of re-spelling it. That is the plausible wrong repair, since the byte
  // looks like corruption, and it silently collides composite keys. The round-trip guard is the
  // only thing standing between the two, so it gets run.
  const where = join(somewhere(), "lossy.mjs");
  const before = `export const a = "${NUL}";\n`;
  writeFileSync(where, before);

  const said = writeControlBytesAsEscapesIn(where, {
    parseWith: () => true,
    escapeWith: (text) => text.split(NUL).join(""),
  });

  assert.equal(said.changed, false);
  assert.match(said.why, /not lossless/);
  assert.equal(readFileSync(where, "utf8"), before, "the file on disk is untouched");
});

test("the runner REFUSES a flag rather than ignoring it", () => {
  // It names the files it rewrites rather than discovering them, so a flag that looks like it
  // narrows the run would not, and a caller typing --dry-run out of habit would get a real
  // rewrite and a report indistinguishable from a dry one. Both directions run: a refusal that
  // also refuses the working call is a wall rather than a guard.
  const runner = new URL("../do-work/run-write-control-bytes-as-escapes.mjs", import.meta.url);
  const where = join(somewhere(), "keys.mjs");
  writeFileSync(where, `export const key = (a, b) => \`\${a}${NUL}\${b}\`;\n`);

  const refused = spawnSync(process.execPath, [runner.pathname, "--dry-run", where],
    { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--dry-run/);
  assert.ok(readFileSync(where, "utf8").includes(NUL), "and it did not touch the file");

  const ran = spawnSync(process.execPath, [runner.pathname, where], { encoding: "utf8" });
  assert.equal(ran.status, 0);
  assert.ok(!readFileSync(where, "utf8").includes(NUL));
});

test("a file node cannot parse is not called broken by this owner", () => {
  // TypeScript has no parser here, and a checker that guessed at it would be a second TypeScript.
  // Those files are proven by their package's own declared checks instead.
  assert.equal(nodeCanParse("/does/not/matter", "something.ts"), true);
  assert.equal(nodeCanParse("/does/not/matter", "something.tsx"), true);
});
