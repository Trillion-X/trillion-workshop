#!/usr/bin/env node
// Golden byte-identity parity test: prepare-semantic-index-process-input.
//
// Runs the ORIGINAL python3 leaf and the ported node leaf on identical inputs and
// asserts every output file is byte-for-byte identical (L108 preserve-behavior).
// This is the acceptance oracle for the .py -> .mjs reroute: if the bytes match,
// the runner can dispatch `node <x>.mjs` in place of `python3 <x>.py` with zero
// downstream drift.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PY = path.join(HERE, "prepare-semantic-index-process-input.py");
const MJS = path.join(HERE, "prepare-semantic-index-process-input.mjs");

let failures = 0;
let cases = 0;

function bytesEqual(a, b) {
  return Buffer.compare(a, b) === 0;
}

// One parity case: `inputs` = {filename: contents-object-or-string}, `argvTail`
// = the CLI flags AFTER the two output flags, `outputs` = list of output flag
// destinations to compare. The runner substitutes each engine's own output dir.
function runCase(name, inputFiles, buildArgv, outputNames) {
  cases += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prep-parity-"));
  const pyDir = path.join(root, "py");
  const mjsDir = path.join(root, "mjs");
  fs.mkdirSync(pyDir);
  fs.mkdirSync(mjsDir);
  for (const dir of [pyDir, mjsDir]) {
    for (const [fname, contents] of Object.entries(inputFiles)) {
      const text = typeof contents === "string" ? contents : JSON.stringify(contents);
      fs.writeFileSync(path.join(dir, fname), text, "utf-8");
    }
  }
  const pyArgv = buildArgv(pyDir);
  const mjsArgv = buildArgv(mjsDir);
  let pyErr = null;
  let mjsErr = null;
  try {
    execFileSync("python3", [PY, ...pyArgv], { cwd: pyDir, stdio: "pipe" });
  } catch (e) {
    pyErr = e;
  }
  try {
    execFileSync("node", [MJS, ...mjsArgv], { cwd: mjsDir, stdio: "pipe" });
  } catch (e) {
    mjsErr = e;
  }
  if (Boolean(pyErr) !== Boolean(mjsErr)) {
    failures += 1;
    console.log(`FAIL ${name}: exit-status divergence py-error=${Boolean(pyErr)} mjs-error=${Boolean(mjsErr)}`);
    if (pyErr) console.log(`  py stderr: ${String(pyErr.stderr || "").trim().slice(0, 400)}`);
    if (mjsErr) console.log(`  mjs stderr: ${String(mjsErr.stderr || "").trim().slice(0, 400)}`);
    return;
  }
  if (pyErr && mjsErr) {
    // Both errored (expected-failure case): parity on the error class is enough;
    // stderr traceback text is not a preserve-behavior surface.
    console.log(`ok   ${name} (both rejected)`);
    return;
  }
  for (const out of outputNames) {
    const pyBytes = fs.readFileSync(path.join(pyDir, out));
    const mjsBytes = fs.readFileSync(path.join(mjsDir, out));
    if (!bytesEqual(pyBytes, mjsBytes)) {
      failures += 1;
      console.log(`FAIL ${name}: ${out} differs`);
      console.log(`  py : ${JSON.stringify(pyBytes.toString("utf-8")).slice(0, 400)}`);
      console.log(`  mjs: ${JSON.stringify(mjsBytes.toString("utf-8")).slice(0, 400)}`);
      return;
    }
  }
  console.log(`ok   ${name} (${outputNames.join(", ")} byte-identical)`);
}

const descriptorRow = { kind: "semantic-index-descriptor", index_id: "idx", ann_params: { seed: 1 } };
const stateValueJson = JSON.stringify({ index_id: "idx", vector_count: 120000 }); // pass-through raw string

// Case 1: with-plan (empty upserts) -> descriptor + state + empty request.
runCase(
  "with-plan-empty-upserts",
  {
    "d.json": { items: [{ payload: descriptorRow }] },
    "s.json": { items: [{ payload: { table: "attribute_fact", property_id: "prop:semantic-ann-index:idx", value_json: stateValueJson } }] },
    "plan.json": { upserts: [], retracts: [] },
  },
  (dir) => [
    "--index-id", "idx",
    "--descriptor-reply-json", path.join(dir, "d.json"),
    "--ann-state-reply-json", path.join(dir, "s.json"),
    "--plan-json", path.join(dir, "plan.json"),
    "--embedding-request-json", path.join(dir, "request.json"),
    "--output-state-json", path.join(dir, "state.json"),
    "--output-json", path.join(dir, "output.json"),
  ],
  ["output.json", "state.json", "request.json"],
);

// Case 2: without-plan -> descriptor + empty state only.
runCase(
  "without-plan",
  {
    "d.json": { items: [{ payload: descriptorRow }] },
    "s.json": '{"items":[]}',
  },
  (dir) => [
    "--index-id", "idx",
    "--descriptor-reply-json", path.join(dir, "d.json"),
    "--ann-state-reply-json", path.join(dir, "s.json"),
    "--output-state-json", path.join(dir, "state.json"),
    "--output-json", path.join(dir, "output.json"),
  ],
  ["output.json", "state.json"],
);

// Case 3: with-plan real upserts INCLUDING non-ASCII text -> exercises ensure_ascii
// escaping in the request output (the single most likely byte-divergence).
runCase(
  "with-plan-nonascii-upserts",
  {
    "d.json": { items: [{ payload: descriptorRow }] },
    "s.json": '{"items":[]}',
    "plan.json": {
      upserts: [
        { content_address: "a", content_text: "Alpha" },
        { content_address: "b", content_text: "Beta café é 中文 🚀" },
        { content_address: "c", content_text: "Gamma", content_vector_base64: "eyJ2ZWN0b3IiOlsxXX0=" },
      ],
    },
  },
  (dir) => [
    "--index-id", "idx",
    "--descriptor-reply-json", path.join(dir, "d.json"),
    "--ann-state-reply-json", path.join(dir, "s.json"),
    "--plan-json", path.join(dir, "plan.json"),
    "--embedding-request-json", path.join(dir, "request.json"),
    "--output-state-json", path.join(dir, "state.json"),
    "--output-json", path.join(dir, "output.json"),
  ],
  ["output.json", "state.json", "request.json"],
);

// Case 4: duplicate descriptor -> BOTH must reject (error-class parity).
runCase(
  "duplicate-descriptor-rejected",
  {
    "d.json": { items: [{ payload: descriptorRow }, { payload: descriptorRow }] },
    "s.json": '{"items":[]}',
  },
  (dir) => [
    "--index-id", "idx",
    "--descriptor-reply-json", path.join(dir, "d.json"),
    "--ann-state-reply-json", path.join(dir, "s.json"),
    "--output-state-json", path.join(dir, "state.json"),
    "--output-json", path.join(dir, "output.json"),
  ],
  ["output.json"],
);

console.log(`\n${cases - failures}/${cases} cases parity-passed`);
process.exit(failures === 0 ? 0 : 1);