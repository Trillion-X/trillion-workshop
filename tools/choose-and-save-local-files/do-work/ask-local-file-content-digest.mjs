#!/usr/bin/env node
// packages/local-files/do-work/ask-local-file-content-digest.mjs
//
// PURPOSE
// Say what the digest of a local file's bytes IS. One job, no interpretation, no receipt.
// The algorithm is the caller's, defaulting to sha256; see the section on it below.
//
// WHY IT IS SEPARATE FROM verify-selected-addressed-evidence.mjs
// That one computes the same digest, but it can only CHECK a digest you already know: it takes
// a request naming the expected value and throws on mismatch. Asking "what is it?" and
// asserting "it is this" are different questions, and only the first one can be answered when
// the value is not known yet. The shared half is four lines, so this states them rather than
// building an indirection between two callers.
//
// WHY IT EXISTS AT ALL
// Contracts in this tree bind themselves to an exact text by carrying its sha256, and their
// validator refuses anything that is not 64 hex characters. There was no declared way to
// produce one: `shasum` is not a verb an agent may run, and `node -e` is refused as a one-off
// invoker, correctly, because a digest produced by a throwaway command is a digest nobody can
// reproduce. That left fabricating 64 hex characters, which defeats the whole point of binding
// a contract to a directive, or stopping. The gap was a missing CAPABILITY, not a missing
// permission, and it belongs to the package that already owns facts about local files.
//
// USAGE (one line; a continuation reads as a separate command to the run guard)
//   node <pkg>/do-work/ask-local-file-content-digest.mjs <absolute path> [algorithm]
//
// Prints one JSON object carrying `hex` and `prefixed` (`<algorithm>:<hex>`), because callers
// need both spellings and neither should be produced by trimming a label off the other.
//
// WHY THE ALGORITHM IS AN ARGUMENT AND ITS SET IS NOT WRITTEN DOWN HERE
// `sha256` is the default because that is what the contract validator's `/^[0-9a-f]{64}$/`
// accepts today. It is not the job. This answers "what is the digest of these bytes", and a
// caller binding to a store that speaks blake2 or sha512 needs the same answer under a different
// algorithm, not a second script. The permitted set is read from `getHashes()`, the runtime's own
// statement of what it serves, so a name this file has never heard of works the day the runtime
// offers it and a typo is refused by name with the truth quoted back. A hand-typed list here
// would be an enumeration of what one Node version happened to support the day it was written.

import { createHash, getHashes } from "node:crypto";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const algorithm = process.argv[3] ?? "sha256";
const reportedPath = process.argv[4] ?? path;
if (path == null || path.length === 0) {
  process.stderr.write("usage: ask-local-file-content-digest.mjs <absolute path> [algorithm]\n");
  process.exit(1);
}

const served = getHashes();
if (!served.includes(algorithm)) {
  // Named, with the real set, rather than a generic failure. A caller who guessed a spelling
  // needs to see the spellings that exist, and nothing else here knows them.
  process.stderr.write(`${JSON.stringify({
    error: `this runtime does not serve the digest algorithm ${algorithm}`,
    served,
  }, null, 2)}\n`);
  process.exit(1);
}

try {
  // The FILE's bytes, never a re-encoded string. A digest of text that was decoded and
  // re-encoded is a digest of something else, and the entire value of the field is that anyone
  // can recompute it from the artifact still sitting on disk.
  const bytes = readFileSync(path);
  const hex = createHash(algorithm).update(bytes).digest("hex");
  process.stdout.write(`${JSON.stringify({
    path: reportedPath,
    byte_length: bytes.byteLength,
    algorithm,
    hex,
    prefixed: `${algorithm}:${hex}`,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
  process.exit(1);
}
