// FIRE-AND-FORGET WRITES CARRY THE RUNTIME THEY CALL.
//
// When every send in an entry is rewritten into a generated write, nothing else
// uses the runtime kit, the bundler drops it, and the writes call functions that
// no longer exist. That shipped once (chat's part receiver) and failed on its
// first call with "getConnectionManager is not defined", while every build and
// test was green. The check below is what the builder now runs on each entry.
import { test } from "node:test";
import assert from "node:assert/strict";

import { noReplyRuntimeNamesMissingFrom } from "../do-work/package-entry-no-reply-lowering.mjs";

const writer = {
  name: "bitfieldGeneratedNoReplyWriteabc",
  key: "k",
  target: "slot::workflow",
  fixedDefinition: "action:somewhere.do-a-thing",
  inputObjectKeys: null,
  inputObjectFields: null,
};

test("an entry with no rewritten sends needs nothing from the runtime", () => {
  assert.deepEqual(noReplyRuntimeNamesMissingFrom([], ""), []);
});

test("a bundle that dropped the runtime is named as missing it", () => {
  const missing = noReplyRuntimeNamesMissingFrom([writer], "export function takePart() {}");
  assert.ok(missing.includes("getConnectionManager"), `expected getConnectionManager in ${JSON.stringify(missing)}`);
});

test("a bundle that defines what the writes call is complete", () => {
  const bundle = [
    "function getConnectionManager() {}",
    "function bindNoReplyBytesToBitfieldTarget() {}",
    "function bindNoReplyByteRangesToBitfieldTarget() {}",
  ].join("\n");
  assert.deepEqual(noReplyRuntimeNamesMissingFrom([writer], bundle), []);
});

test("a runtime binding in a shared var declaration is defined", () => {
  const bundle = [
    "function getConnectionManager() {}",
    "var first, bindNoReplyBytesToBitfieldTarget, bindNoReplyByteRangesToBitfieldTarget, last;",
  ].join("\n");
  assert.deepEqual(noReplyRuntimeNamesMissingFrom([writer], bundle), []);
});

test("a name that is only mentioned, never defined, still counts as missing", () => {
  const bundle = 'throw new Error("call getConnectionManager() first"); function bindNoReplyBytesToBitfieldTarget() {}';
  assert.ok(noReplyRuntimeNamesMissingFrom([writer], bundle).includes("getConnectionManager"));
});
