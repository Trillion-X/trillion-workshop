#!/usr/bin/env node
// Derive completion from one exact running target. The request names the
// accepted package revision(s) and the durable behavior-evidence address; the
// verifier reads both back and refuses every mismatch.

import { readFileSync } from "node:fs";

import {
  runningAppTargetClient,
  startRunningAppSession,
} from "../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs";
import {
  verifyProductCorrectionChangeSetCompletion,
  verifyProductCorrectionCompletion,
} from "./make-one-package-match-its-source.mjs";

function requiredOption(name) {
  const matches = process.argv.flatMap((value, index) => value === name ? [process.argv[index + 1]] : []);
  if (matches.length !== 1 || matches[0] == null || matches[0].startsWith("--") || matches[0].trim() === "") {
    throw new Error(`${name} is required exactly once`);
  }
  return matches[0].trim();
}

async function main() {
  const statusFile = requiredOption("--status-file");
  const requestFile = requiredOption("--request-file");
  const request = JSON.parse(readFileSync(requestFile, "utf8"));
  const session = await startRunningAppSession({ statusFile });
  const client = runningAppTargetClient(session);
  const result = Array.isArray(request.changes)
    ? await verifyProductCorrectionChangeSetCompletion({ client, ...request })
    : await verifyProductCorrectionCompletion({ client, ...request });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
