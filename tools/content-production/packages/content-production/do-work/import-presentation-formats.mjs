#!/usr/bin/env node
/**
 * file: packages/content-production/do-work/import-presentation-formats.mjs
 *
 * PURPOSE: Import presentation-format DATA from an embedded JSON island in an
 * exported HTML document. This is deliberately an importer for DATA, not a
 * source-code importer: no script in the source document is executed.
 *
 * INVARIANTS:
 * 1. The source must contain a parsable application/json script island.
 * 2. Only the `formats` array is copied into the canonical package DATA file.
 * 3. Every format needs a unique non-empty id and a non-empty title.
 * 4. The importer never names a creator, domain, channel, or format family.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arguments_ = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  arguments_.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
}

const inputPath = required("input");
const outputPath = required("out");
const scriptId = arguments_.get("--script-id") ?? "seed";

const html = readFileSync(inputPath, "utf8");
const escapedScriptId = escapeRegExp(scriptId);
const match = html.match(
  new RegExp(
    `<script\\b[^>]*id=["']${escapedScriptId}["'][^>]*type=["']application/json["'][^>]*>([\\s\\S]*?)</script>`,
    "i",
  ),
);
if (!match) {
  fail(`no application/json script island with id "${scriptId}" was found`);
}

let source;
try {
  source = JSON.parse(match[1]);
} catch (error) {
  fail(`embedded JSON island is invalid: ${error.message}`);
}

const formats = source.formats;
if (!Array.isArray(formats) || formats.length === 0) {
  fail("embedded JSON island has no non-empty formats array");
}

const seenIds = new Set();
for (const format of formats) {
  if (!format || typeof format !== "object" || Array.isArray(format)) {
    fail("every format must be an object");
  }
  if (typeof format.id !== "string" || format.id.trim().length === 0) {
    fail("every format needs a non-empty id");
  }
  if (seenIds.has(format.id)) fail(`duplicate format id: ${format.id}`);
  seenIds.add(format.id);
  if (typeof format.title !== "string" || format.title.trim().length === 0) {
    fail(`format ${format.id} needs a non-empty title`);
  }
}

const output = {
  schema: "content-production.presentation-formats/self-describing",
  source_kind: "embedded-json-data-island",
  source_script_id: scriptId,
  formats,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  imported: formats.length,
  format_ids: [...seenIds],
  output: outputPath,
}));

function required(name) {
  const value = arguments_.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    console.error(`usage: import-presentation-formats.mjs --input <html> --out <json> [--script-id <id>]`);
    process.exit(2);
  }
  return value;
}

function fail(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
