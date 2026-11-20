#!/usr/bin/env node
// Golden byte-identity parity test: embed-text-ollama.
//
// Runs the ORIGINAL python3 leaf and the ported node leaf against a SHARED local
// mock Ollama server (identical response bytes), then asserts every output file
// is byte-for-byte identical (L108 preserve-behavior). Uses async execFile so the
// in-process mock server stays responsive while each leaf runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PY = path.join(HERE, "embed-text-ollama.py");
const MJS = path.join(HERE, "embed-text-ollama.mjs");

let failures = 0;
let cases = 0;

function startServer(bodyString) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(bodyString);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function runOne(bin, script, dir, request, endpoint) {
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify(request), "utf-8");
  const argv = [
    script,
    "--request-json", path.join(dir, "request.json"),
    "--output-json", path.join(dir, "output.json"),
    "--model", "model-a",
    "--endpoint", endpoint,
  ];
  try {
    await run(bin, argv, { cwd: dir });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e };
  }
}

async function runCase(name, request, responseBody, compareOutput) {
  cases += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "embed-parity-"));
  const pyDir = path.join(root, "py");
  const mjsDir = path.join(root, "mjs");
  fs.mkdirSync(pyDir);
  fs.mkdirSync(mjsDir);
  const { server, port } = await startServer(responseBody == null ? "{}" : responseBody);
  const endpoint = `http://127.0.0.1:${port}`;
  const py = await runOne("python3", PY, pyDir, request, endpoint);
  const mjs = await runOne("node", MJS, mjsDir, request, endpoint);
  await new Promise((r) => server.close(r));

  if (py.ok !== mjs.ok) {
    failures += 1;
    console.log(`FAIL ${name}: exit-status divergence py-ok=${py.ok} mjs-ok=${mjs.ok}`);
    if (py.err) console.log(`  py : ${String(py.err.stderr || "").trim().slice(0, 300)}`);
    if (mjs.err) console.log(`  mjs: ${String(mjs.err.stderr || "").trim().slice(0, 300)}`);
    return;
  }
  if (!py.ok && !mjs.ok) {
    console.log(`ok   ${name} (both rejected)`);
    return;
  }
  if (compareOutput) {
    const a = fs.readFileSync(path.join(pyDir, "output.json"));
    const b = fs.readFileSync(path.join(mjsDir, "output.json"));
    if (Buffer.compare(a, b) !== 0) {
      failures += 1;
      console.log(`FAIL ${name}: output.json differs`);
      console.log(`  py : ${JSON.stringify(a.toString("utf-8")).slice(0, 300)}`);
      console.log(`  mjs: ${JSON.stringify(b.toString("utf-8")).slice(0, 300)}`);
      return;
    }
  }
  console.log(`ok   ${name} (output.json byte-identical)`);
}

async function main() {
  // Single: integer + negative-float elements -> "1.0","-2.5".
  await runCase("single-request", { content_text: "hello" }, '{"embedding":[1,-2.5]}', true);
  // Single: integer, one, and -0.0 -> proves pyFloat renders "0.0","1.0","-0.0".
  await runCase("single-zero-and-negzero", { content_text: "x" }, '{"embedding":[0,1,-0.0]}', true);
  // Batch: one owner call, mixed int/float across two ids.
  await runCase(
    "batch-request",
    { items: [{ id: "a", text: "first" }, { id: "b", text: "second" }] },
    '{"embeddings":[[1,2],[3.5,4]]}',
    true,
  );
  // Empty batch: no provider call, {"vectors":{},...}.
  await runCase("empty-batch", { items: [] }, null, true);
  // Non-ASCII id in batch -> exercises ensure_ascii escaping of the "vectors" key.
  await runCase(
    "batch-nonascii-id",
    { items: [{ id: "café", text: "premier" }] },
    '{"embeddings":[[0.1,0.2]]}',
    true,
  );
  // Duplicate ids -> BOTH reject before any call.
  await runCase(
    "batch-duplicate-ids",
    { items: [{ id: "a", text: "first" }, { id: "a", text: "second" }] },
    null,
    false,
  );
  // Shape mismatch (1 embedding for 2 items) -> BOTH reject.
  await runCase(
    "batch-shape-mismatch",
    { items: [{ id: "a", text: "first" }, { id: "b", text: "second" }] },
    '{"embeddings":[[1,2]]}',
    false,
  );

  console.log(`\n${cases - failures}/${cases} cases parity-passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
