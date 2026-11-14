#!/usr/bin/env node
// packages/send-requests-to-an-engine/do-work/explain-a-missing-record-by-running-its-producer.mjs
//
// PURPOSE: when a record a caller required is absent, RUN THE THING THAT WRITES IT and report what
// that thing said, instead of reporting the absence again.
//
// ⛔ PRESENCE OF EVERY INPUT IS NOT EVIDENCE THAT THE PRODUCER RUNS. This file exists because of a
// measured failure, and the numbers are the whole argument.
//
// Six ship-proof runs, about seven minutes each, investigated a screen that never painted. Every one
// asked the same KIND of question: does this record exist. All the answers were correct and green.
// The trigger record was present. It was at the exact path its consumer walks. The action it
// dispatches was admitted. The lifecycle event it listens for was in use by two other rules that
// work. The only red was the OUTPUT, and one red output is produced by at least six different
// causes, so thirty-five minutes of runs narrowed nothing.
//
// Executing the producer once took seconds and returned, in its own receipt:
//
//     "outcome": "forward-compensation-required",
//     "failed_operation": {
//       "error": "compiler-materialized local destination is absent or mismatched at ...",
//       "kind": "local-thing", "phase": "upsert" }
//
// The producer had been stating exactly what was wrong, in a field named `failed_operation`, on
// every run. Nothing read it, because reading it requires RUNNING the thing rather than inspecting
// what surrounds it. **A producer that reports its own failure is worth more than any number of
// existence checks around it.**
//
// ⛔ WHAT IT PRODUCES IS A RERUN, NOT THE STARTUP ATTEMPT, AND IT SAYS SO IN EVERY ROW. The app
// already tried to write the record on its own; this executes the producer AGAIN, later, on purpose.
// The two can disagree, and a receipt read as "what happened at startup" diagnoses the wrong moment.
// Each row carries `explanation_kind: "deliberate-rerun"` and the time it ran, and the untouched
// observation remains the absence recorded BEFORE this ran, because this writes.
//
// ⛔ WHICH PRODUCER WRITES WHICH RECORD IS DATA, NEVER A LIST IN HERE. The caller hands over a
// document whose rows may carry `produced_by`, and this file runs whatever they name. A second
// caller ships its own document and this file does not change. There is no map of known producers
// in this file, and adding one would turn it into a catalogue of today's callers.
//
// ⛔ IT RUNS ONLY WHAT IS ALREADY RED, AND IT IS A WRITE. Executing a producer changes the app. That
// is exactly why this is a separate owner from anything that MEASURES: a measurement tool that also
// writes cannot be trusted to say what it found, and a caller bug must stay distinguishable from a
// finding. Nothing here runs speculatively.
//
// Exit 0 when every missing row was explained, 69 when a missing row declares no producer or the
// app cannot be reached, 2 on usage, 3 on a defect in this file.

import fs from "node:fs";
import {
  executeDefinition,
  startRunningAppSession,
} from "../read-data/find-the-running-app-and-send-requests-to-it.mjs";

function optionValue(argv, name) {
  const at = argv.indexOf(name);
  if (at < 0) return null;
  const value = argv[at + 1];
  if (value == null || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/// Everything this file can get wrong about ITSELF leaves by this door, never dressed as a fact
/// about the app. Same discipline as the measurement tools it sits beside, for the same reason: an
/// instrument defect that reads as a finding about the subject costs a whole run to discover, and
/// that has already happened once in this lane.
function checkerFailed(error) {
  process.stdout.write(`${JSON.stringify({
    status: "checker-failed",
    explained: null,
    detail: String(error?.message ?? error),
    stack: String(error?.stack ?? ""),
    what_this_says_about_the_app: "nothing. This verdict is about the instrument, not the subject.",
  }, null, 2)}\n`);
  process.exit(3);
}
process.on("uncaughtException", checkerFailed);
process.on("unhandledRejection", checkerFailed);

const argv = process.argv.slice(2);
const statusFile = optionValue(argv, "--status-file");
const producersFile = optionValue(argv, "--producers-file");
const rowsKey = optionValue(argv, "--rows-key") ?? "required_current_records";
const verdictFile = optionValue(argv, "--missing-records-from");

if (!statusFile || !producersFile || verdictFile == null) {
  process.stderr.write(
    "Usage: explain-a-missing-record-by-running-its-producer.mjs --status-file <path> "
      + "--producers-file <document with rows carrying address and produced_by> "
      + "--missing-records-from <verdict document carrying a missingRecords array> "
      + "[--rows-key <key>]\n",
  );
  process.exit(2);
}

/// ⛔ THE ADDRESSES ARRIVE AS JSON, NEVER AS A JOINED STRING, AND THE FIRST DRAFT LEARNED WHY TWICE.
///
/// The caller used to flatten the verdict and pull addresses out with `grep -o`, then join them with
/// commas for this file to split again. Two silent failures live in that round trip and neither
/// announces itself: a line-based `grep` cannot match a pretty-printed array at all (it returned an
/// EMPTY list against a real failing verdict, which reads here as "nothing was missing"), and an
/// address containing a comma, a quote or a JSON escape survives the encode and comes apart on the
/// decode, producing addresses that were never in the file. Reading the array with `JSON.parse`
/// deletes both: the value that arrives is the exact value the verifier wrote.
const verdict = JSON.parse(fs.readFileSync(verdictFile, "utf8"));
if (!Array.isArray(verdict?.missingRecords)) {
  process.stderr.write(`${verdictFile} has no array at missingRecords\n`);
  process.exit(2);
}
const missing = verdict.missingRecords.filter((value) => typeof value === "string" && value !== "");
if (missing.length === 0) {
  process.stdout.write(`${JSON.stringify({
    status: "nothing-to-explain",
    explained: [],
    unexplained: [],
    note: "nothing was missing, so no producer ran. This never runs a producer speculatively.",
  }, null, 2)}\n`);
  process.exit(0);
}

const declared = JSON.parse(fs.readFileSync(producersFile, "utf8"));
const rows = declared[rowsKey];
if (!Array.isArray(rows)) {
  process.stderr.write(`${producersFile} has no list at ${rowsKey}\n`);
  process.exit(2);
}
const producerFor = new Map(
  rows.filter((row) => row?.address && row?.produced_by).map((row) => [row.address, row.produced_by]),
);

/// ⛔ THE ROWS ARE SORTED BEFORE ANYTHING IS DIALLED, AND THE ORDER IS THE POINT.
///
/// "This row declares no producer" is a fact about the CALLER'S DATA. It is knowable with no app
/// running at all, it is true whether or not the app is up, and answering it needs no session.
/// Opening the session first made a dead socket swallow it: a producerless row came back
/// `unreachable`, which blames the transport for a gap in a document, and it would have hidden the
/// one finding a commit-time check could act on.
///
/// Found by the tests for this file rather than by a run, which is the whole argument for writing
/// them: both failing cases used an app that cannot be reached, and the tool answered about the
/// socket when the answer was in the file it had already read.
const explained = [];
const unexplained = [];
const toRun = [];
for (const address of missing) {
  const producer = producerFor.get(address);
  if (!producer) {
    // ⛔ NAMED, NEVER SILENTLY SKIPPED. This gap is precisely why a future run would be back to
    // reporting a bare absence with nothing to say about it.
    unexplained.push({
      address,
      why: "this row declares no produced_by, so nothing here knows what was supposed to write it",
    });
    continue;
  }
  toRun.push({ address, producer });
}

/// No producer to run means no reason to dial. A tool that WRITES must not open a session it has no
/// work for, and this also keeps the DATA-gap answer available on a machine with nothing running.
if (toRun.length > 0) {
  let session;
  try {
    session = await startRunningAppSession({ statusFile });
  } catch (error) {
    // Not reachable is not unexplained. They are different findings and they leave by different
    // doors, because reporting these rows as unexplained would blame the caller's DATA for a dead
    // socket, the same mistranslation as calling a stopped app an empty one.
    process.stdout.write(`${JSON.stringify({
      status: "unreachable",
      explained: [],
      unexplained: [],
      detail: String(error?.message ?? error),
      note: `${toRun.length} row(s) had a producer to run and none of them ran`,
    }, null, 2)}\n`);
    process.exit(69);
  }
  for (const { address, producer } of toRun) {
    // ⛔ EVERY RECEIPT IS STAMPED AS A DELIBERATE RERUN, BECAUSE IT IS NOT THE STARTUP ATTEMPT.
    //
    // The app already tried to write this record on its own and the result of THAT attempt is
    // whatever the app kept. What this file produces is a SECOND, later execution asked for by a
    // human-run diagnostic, and the two can disagree: the startup attempt may have failed on a
    // condition this one no longer meets, or met one this one does not. An unlabelled receipt
    // sitting beside an absence reads as "this is what happened at startup", which it is not, and a
    // diagnosis built on that mistake points at the wrong moment in the app's life.
    //
    // It also CHANGES the app. The fresh-install result that reported the absence stays the
    // untouched observation; anything after this ran is a repaired app, not a fresh one, and the
    // timestamp below is what lets a later reader tell which side of that line a fact came from.
    const ranAt = new Date().toISOString();
    explained.push({
      address,
      producer: producer.definition_id,
      explanation_kind: "deliberate-rerun",
      ran_at: ranAt,
      what_this_is_not:
        "the app's own startup attempt. This is a later execution asked for by this diagnostic, "
        + "and it wrote to the app. Absence of the record before this ran does NOT mean the earlier "
        + "attempt had no effect.",
      // The receipt is reported WHOLE. Summarising here would be this file choosing which field
      // matters, and the field that mattered last time was one nobody had thought to look at.
      receipt: await executeDefinition(session, producer.definition_id, producer.input ?? {}, {
        includeSteps: true,
        includeOutput: true,
      }),
    });
  }
}

process.stdout.write(`${JSON.stringify({
  status: unexplained.length === 0 ? "explained" : "partly-explained",
  explained,
  unexplained,
  how_to_read_this:
    "each explanation is the FULL receipt from a DELIBERATE RERUN of the thing that writes the "
    + "missing record, executed by this diagnostic after the absence was observed. It is not the "
    + "app's own startup attempt and it does not prove what that attempt did. Read its outcome and "
    + "any failed_operation first: that is the producer stating its own failure, which is worth "
    + "more than any number of existence checks around it. Note that this run WROTE to the app, so "
    + "the only untouched observation is the one taken before it.",
}, null, 2)}\n`);
process.exit(unexplained.length === 0 ? 0 : 69);
