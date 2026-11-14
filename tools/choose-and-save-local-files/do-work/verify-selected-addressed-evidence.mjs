#!/usr/bin/env node
// Verify immutable staged bytes and emit the Local Files custody receipt.

import { createHash, getHashes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [requestPath, evidencePath, receiptPath] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const raw = readFileSync(evidencePath);

// The expected digest already carries its algorithm as a prefix, so read it from there rather
// than assuming. This used to compute sha256 unconditionally, which was invisible while sha256
// was the only thing anything produced. Its sibling `ask-local-file-content-digest.mjs` now takes
// the algorithm from the caller, so an expectation written under any other one would have arrived
// here and been reported as a digest MISMATCH: a message that says the bytes were tampered with
// when the truth is that this file never computed the digest being compared. A verifier that
// answers the wrong question confidently is worse than one that refuses.
const [declaredAlgorithm, expectedHex] = String(request.content_digest ?? '').split(':');
if (!expectedHex) {
  throw new Error('selected evidence content_digest must be <algorithm>:<hex>');
}
if (!getHashes().includes(declaredAlgorithm)) {
  throw new Error(
    `selected evidence content_digest names ${declaredAlgorithm}, which this runtime does not serve`,
  );
}
const actual = `${declaredAlgorithm}:${createHash(declaredAlgorithm).update(raw).digest('hex')}`;

// Separated, because these are different facts about the artifact and a caller repairs them
// differently. One says the bytes are not the bytes; the other says the file grew or was truncated.
if (raw.byteLength !== request.byte_length) {
  throw new Error(
    `selected evidence byte length is ${raw.byteLength}, expected ${request.byte_length}`,
  );
}
if (actual !== request.content_digest) {
  throw new Error('selected evidence digest mismatch');
}
const artifact = request.artifact_ref;
if (!artifact || typeof artifact !== 'object' || !(artifact.cas_address || artifact.multihash)) {
  throw new Error('selected evidence artifact ref missing');
}
if (typeof request.source_ref !== 'string' || request.source_ref.length === 0) {
  throw new Error('selected evidence source ref missing');
}

writeFileSync(receiptPath, JSON.stringify({
  kind: 'local-files.selected-addressed-evidence',
  evidence_ref: request.evidence_ref,
  source_ref: request.source_ref,
  artifact_ref: artifact,
  content_digest: actual,
  byte_length: raw.byteLength,
  media_type_ref: request.media_type_ref,
}));
