#!/usr/bin/env node
// Direct byte-identity parity test for pyjson.mjs vs python3 json.dumps.
//
// Encodes append-not-current's exact fixture values (2026-08-14 convergence):
//  A) int vs float type erasure in the SAME object (skipped:3 int, min_score:0.0 float)
//  B) small-magnitude exponent band (1e-5 -> "1e-05", 1e-7 -> "1e-07", 1e-4 -> "0.0001")
//  C) ensure_ascii non-ASCII + astral escaping (café / naïve / 日本語 / 😀)
//  invariants: 1e16 -> "1e+16", 1e15 -> "...0" (fixed), -0.0 -> "-0.0"
// Each case runs real python3 json.dumps and asserts pyDumps produces IDENTICAL bytes.
import { execFileSync } from "node:child_process";
import { pyDumps, pyFloat } from "./pyjson.mjs";

let failures = 0;
let cases = 0;

function pyExpect(pyExpr, ensureAscii) {
  const code = `import json,sys;sys.stdout.write(json.dumps(${pyExpr}, separators=(",",":"), ensure_ascii=${ensureAscii ? "True" : "False"}))`;
  return execFileSync("python3", ["-c", code], { encoding: "utf-8" });
}

function check(name, pyExpr, jsValue, ensureAscii = true) {
  cases += 1;
  const expected = pyExpect(pyExpr, ensureAscii);
  const got = pyDumps(jsValue, { ensureAscii });
  if (expected !== got) {
    failures += 1;
    console.log(`FAIL ${name}: py=${JSON.stringify(expected)} mjs=${JSON.stringify(got)}`);
  } else {
    console.log(`ok   ${name}  ->  ${got}`);
  }
}

// B) small-exponent band + basic floats. Each pair: python float literal / pyFloat(js).
const floatCases = [
  ["f-1.0", "1.0", 1.0],
  ["f-0.0", "0.0", 0.0],
  ["f-neg0", "-0.0", -0],
  ["f-neg1.0", "-1.0", -1.0],
  ["f-0.1", "0.1", 0.1],
  ["f-third", "0.333333", 0.333333],
  ["f-cos", "0.866025", 0.866025],
  ["f-2.5", "-2.5", -2.5],
  ["f-123.456", "123.456", 123.456],
  ["band-1e-5", "1e-05", 1e-5],
  ["band-1e-6", "1e-06", 1e-6],
  ["band-1e-7", "1e-07", 1e-7],
  ["band-2e-5", "2e-05", 2e-5],
  ["band-9.999e-5", "9.999e-05", 9.999e-5],
  ["band-edge-1e-4", "1e-4", 1e-4],
  ["band-edge-0.0001", "0.0001", 0.0001],
  ["band-1.5e-5", "1.5e-05", 1.5e-5],
  ["inv-1e16", "1e16", 1e16],
  ["inv-1e15", "1e15", 1e15],
];
for (const [name, pyExpr, v] of floatCases) check(name, pyExpr, pyFloat(v));

// int rendering (no ".0"): plain JS numbers.
check("int-3", "3", 3);
check("int-0", "0", 0);
check("int-neg1", "-1", -1);
check("int-120000", "120000", 120000);

// A) type erasure in the SAME object: skipped is int, min_score is float.
check("type-erasure", '{"skipped":3,"min_score":0.0}', { skipped: 3, min_score: pyFloat(0.0) });
check("type-erasure-score1", '{"items":[{"score":1.0}],"considered":2,"skipped":0,"min_score":-0.0}',
  { items: [{ score: pyFloat(1.0) }], considered: 2, skipped: 0, min_score: pyFloat(-0) });

// C) ensure_ascii non-ASCII + astral (True escapes, False raw).
for (const [name, s] of [["cafe", "café"], ["naive", "naïve"], ["jp", "日本語"], ["emoji", "😀"], ["mix", "a café 😀 z"]]) {
  check(`ascii-true-${name}`, JSON.stringify(s), s, true);
  check(`ascii-false-${name}`, JSON.stringify(s), s, false);
}

// control-char escapes match (\n \t \b \f \r + \u00XX).
check("controls", JSON.stringify("a\tb\nc\r\b\f\u0001d"), "a\tb\nc\r\b\f\u0001d", true);

console.log(`\n${cases - failures}/${cases} pyjson cases parity-passed`);
process.exit(failures === 0 ? 0 : 1);
