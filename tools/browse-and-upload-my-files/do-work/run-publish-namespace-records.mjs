#!/usr/bin/env node
// The front door for publishing namespace records into one running app.
//
// It lives in the package that owns the capability rather than beside the errand, which is the
// difference between a front door and the one-off the run guard refuses: a one-off is named
// after today's task and thrown away, so the next person writes another one.
//
// Transport is composed, never rebuilt. If this file ever grows its own fetch it has become
// the thing it replaced.
//
// Usage (every path absolute; the run guard matches the literal argv token, and the whole
// command must be ONE line because a continuation reads as a separate command):
//   node <pkg>/do-work/run-publish-namespace-records.mjs \
//     --table <tab-separated file> --name-root <absolute root the names hang from> \
//     --engine 127.0.0.1:<port> --scheme http --partition <label> \
//     [--name-column 0] [--identity-column 1] [--stored-path-column 2] \
//     [--batch-size 500] [--start-row 0] [--max-rows N] [--dry-run] \
//     [--kinds live-namespace.name] \
//     [--read-target local.files] [--read-reply-bytes-pointer /files/0/bytes_base64] [--read-reply-encoding base64] \
//     [--older-way-names-became-addresses <key>] [--older-name-root <absolute root>]
//
// The port ROTATES on every restart. Read the current one rather than reusing a number.

import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  runningAppTargetClient,
  startRunningAppSession,
  writeRecords,
} from "../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs";

import {
  OLDER_WAYS_A_NAME_BECAME_AN_ADDRESS,
  rowFromTabSeparatedLine,
} from "../read-data/namespace-records-from-a-name-and-identity-table.mjs";
import { publishNamespaceRecords } from "./publish-namespace-records.mjs";

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) throw new Error(`${name} is required`);
  const value = process.argv[index + 1];
  if (value == null || value.trim().length === 0) throw new Error(`${name} requires a value`);
  return value;
}

/** Absent means absent, never a substituted default. */
function optional(name, fallback) {
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

try {
  const dryRun = process.argv.includes("--dry-run");
  const partitionLabel = required("--partition");
  const nameRoot = required("--name-root");
  const tablePath = required("--table");
  const columns = {
    nameColumn: wholeNumber("--name-column", 0),
    identityColumn: wholeNumber("--identity-column", 1),
    storedPathColumn: wholeNumber("--stored-path-column", 2),
  };

  // Lines off disk, one at a time. Reading the file whole would put the entire table in memory
  // before the first record is written, which is the exact thing a namespace covering every
  // file someone owns cannot afford.
  const openRows = async function* openRows() {
    const lines = createInterface({ input: createReadStream(tablePath, "utf8"), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber === 1) continue; // header
      if (line.length === 0) continue;
      yield rowFromTabSeparatedLine(line, lineNumber, columns);
    }
  };

  // The session is opened only when something will actually be written, so a dry run needs no
  // running app and can be checked anywhere.
  let writeBatch = async () => {};
  if (!dryRun) {
    // An app reached only over its local socket is named by id; one with a TCP shell by address.
    const appId = optional("--app-id", null);
    const open = async () => {
      const session = await startRunningAppSession(appId
        ? { appId }
        : { url: `${optional("--scheme", "http")}://${required("--engine")}` });
      const client = runningAppTargetClient(session);
      return client.session ?? session;
    };
    let session = await open();
    // A long run outlives app restarts: when the app is briefly gone or answers with a server error, wait and send
    // the same group again through a fresh session, for up to ten minutes, rather than stopping part-way.
    writeBatch = async (writes) => {
      for (let attempt = 1; ; attempt += 1) {
        try { return await writeRecords(session, writes); }
        catch (error) {
          if (attempt >= 30 || !/not running|ECONNREFUSED|ECONNRESET|socket|fetch failed|returned 5\d\d/i.test(String(error?.message ?? error))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20000));
          session = await open().catch(() => session);
        }
      }
    };
  }

  // Ask the filesystem how big each distinct set of bytes is, ONCE per identity. A mount that
  // reports length 0 shows Finder an empty file and makes Premiere refuse to open it, so this
  // is not decoration; it is the difference between a listing and a usable library. A file the
  // table names but the disk does not have is recorded as unavailable rather than skipped or
  // asserted present.
  let missingFiles = 0;
  let peakResidentBytes = 0;
  // A COUNT of missing files cannot be acted on. Which ones are missing is the answer to
  // "is all of my stuff here?", so a bounded sample of the actual paths is carried out with it.
  const missingSample = [];
  const fileFactsFor = (row) => {
    try {
      const stats = statSync(row.storedPath);
      return { exists: true, byteLength: stats.size, modifiedAtMs: Math.trunc(stats.mtimeMs) };
    } catch {
      missingFiles += 1;
      if (missingSample.length < 60) missingSample.push({ name: row.name, stored_path: row.storedPath });
      return { exists: false };
    }
  };

  // Which record kinds to write. Absent means both. Present, it lets an addressing correction
  // rewrite names without re-writing tens of thousands of unchanged locators, because an
  // append-only log charges for every redundant write forever.
  const kindsRaw = optional("--kinds", null);
  const publishKinds = kindsRaw == null ? null : kindsRaw.split(",").map((value) => value.trim()).filter(Boolean);

  // The older way of writing a name down, chosen by DATA from the owner's list. Naming one asks
  // for the OLD addresses to be taken back wherever they differ from the current way.
  const olderWayKey = optional("--older-way-names-became-addresses", null);
  if (olderWayKey != null && !(olderWayKey in OLDER_WAYS_A_NAME_BECAME_AN_ADDRESS)) {
    throw new Error(`unknown --older-way-names-became-addresses ${JSON.stringify(olderWayKey)}; known: ${Object.keys(OLDER_WAYS_A_NAME_BECAME_AN_ADDRESS).join(", ")}`);
  }

  const result = await publishNamespaceRecords({
    openRows,
    partitionLabel,
    nameRootAbsolutePath: nameRoot,
    readTargetName: optional("--read-target", "local.files"),
    buildReadRequest: (row) => ({ operation: "read_file_range", path: row.storedPath }),
    // How local.files answers read_file_range: JSON with the window at /files/0/bytes_base64.
    // Another target states its own reply shape here; the resolver reads it off the row.
    readReplyContract: {
      response_bytes_pointer: optional("--read-reply-bytes-pointer", "/files/0/bytes_base64"),
      response_encoding: optional("--read-reply-encoding", "base64"),
    },
    writeBatch,
    fileFactsFor,
    batchSize: wholeNumber("--batch-size", 500),
    startRow: wholeNumber("--start-row", 0),
    maxRows: wholeNumber("--max-rows", undefined),
    publishKinds,
    olderAbsolutePathFrom: olderWayKey == null ? null : OLDER_WAYS_A_NAME_BECAME_AN_ADDRESS[olderWayKey],
    olderNameRootAbsolutePath: optional("--older-name-root", null),
    onProgress: (progress) => {
      // Measured, not asserted. The claim this run makes is that memory stays flat while the
      // corpus grows, and a claim like that is worth exactly the number beside it.
      peakResidentBytes = Math.max(peakResidentBytes, process.memoryUsage.rss());
      process.stderr.write(`${JSON.stringify({ ...progress, resident_bytes: process.memoryUsage.rss() })}\n`);
    },
  });

  // Rejected rows are REPORTED, never summarised away. A population that quietly drops rows
  // cannot answer the only question anyone asks of it.
  process.stdout.write(`${JSON.stringify({
    dry_run: dryRun,
    ...result,
    files_not_on_disk: missingFiles,
    files_not_on_disk_sample: missingSample,
    peak_resident_bytes: Math.max(peakResidentBytes, process.memoryUsage.rss()),
  }, null, 2)}\n`);
  if (result.rejected_count > 0) process.stderr.write(`REJECTED ${result.rejected_count} row(s); see rejected[]\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
