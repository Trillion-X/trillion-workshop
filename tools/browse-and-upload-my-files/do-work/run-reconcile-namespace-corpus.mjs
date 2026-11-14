#!/usr/bin/env node
// Front door for one read-only namespace corpus reconciliation. It composes the package's pure
// reconciliation owner with caller-selected table streams and a volume measurement. It never
// writes records and never scans a directory tree.

import { createReadStream, statfsSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

import { rowFromTabSeparatedLine } from "../read-data/namespace-records-from-a-name-and-identity-table.mjs";
import { reconcileNamespaceCorpus } from "../read-data/reconcile-namespace-corpus.mjs";

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) throw new Error(`${name} is required`);
  const value = process.argv[index + 1];
  if (value == null || value.trim().length === 0) throw new Error(`${name} requires a value`);
  return value;
}

function optional(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value == null || value.trim().length === 0) throw new Error(`${name} requires a value`);
  return value;
}

function wholeNumber(name, fallback) {
  const raw = optional(name, null);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number`);
  return value;
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function rowStream(path, columns) {
  return async function* openRows() {
    const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber === 1) continue;
      if (line.length === 0) continue;
      yield rowFromTabSeparatedLine(line, lineNumber, columns);
    }
  };
}

try {
  const tablePath = required("--table");
  const volumeRoot = required("--volume-root");
  const columns = {
    nameColumn: wholeNumber("--name-column", 0),
    identityColumn: wholeNumber("--identity-column", 1),
    storedPathColumn: wholeNumber("--stored-path-column", 2),
  };
  const baselinePath = optional("--baseline-table");
  const outputPath = optional("--output");

  const [tableHash, baselineHash] = await Promise.all([
    sha256(tablePath),
    baselinePath == null ? Promise.resolve(null) : sha256(baselinePath),
  ]);
  const stats = statfsSync(volumeRoot);
  const totalBytes = Number(BigInt(stats.blocks) * BigInt(stats.bsize));
  const freeBytes = Number(BigInt(stats.bfree) * BigInt(stats.bsize));

  const report = await reconcileNamespaceCorpus({
    openRows: rowStream(tablePath, columns),
    baselineOpenRows: baselinePath == null ? null : rowStream(baselinePath, columns),
    baselineDescriptor: baselinePath == null ? null : {
      descriptor: `path=${baselinePath};sha256=${baselineHash}`,
    },
    fileFactsFor: (row) => {
      try {
        const fileStats = statSync(row.storedPath);
        return { exists: true, byteLength: fileStats.size, modifiedAtMs: Math.trunc(fileStats.mtimeMs) };
      } catch {
        return { exists: false };
      }
    },
    volumeFacts: {
      source: `statfs:${volumeRoot}`,
      filesystemType: stats.type,
      totalBytes,
      freeBytes,
    },
    futureGrowthPolicy: {
      policy: required("--future-growth-policy"),
    },
    protectionProfile: {
      profile: required("--protection-profile"),
    },
    tableDescriptor: { descriptor: `path=${tablePath};sha256=${tableHash}` },
  });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath == null) process.stdout.write(json);
  else writeFileSync(outputPath, json);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
