#!/usr/bin/env node
// packages/make-packages-match-their-source/do-work/write-built-entry-bytes-into-a-running-app.mjs
//
// PURPOSE
// Turn a package's freshly built stored-bytes blobs into the label-addressed
// write request the running-app writer already accepts.
//
// WHY THIS EXISTS
// `build-entry-bytes-for-chosen-packages.mjs` writes bytes to
// `built-stored-bytes/<name>` beside the package. Those bytes only become the
// thing a person sees once they replace the same-named blob in a running app's
// log. Between those two steps there was nothing: the convergence front door
// covers it for an INSTALLED app, but it reads its source authority from
// `runtime-kit/app-open-source-bundles/`, which a hosted application does not
// have, so convergence there refuses with "found 0" and always will. Without
// this step a corrected surface can be built, committed and proven by its tests
// while every live viewer keeps seeing the previous build, which is the most
// expensive shape of done a change can have.
//
// NON-NEGOTIABLE INVARIANTS
// - Blob names come from the package's own manifest. This mints no name and
//   knows no package.
// - A declared blob whose bytes were never built refuses the whole run before
//   any request is written, because a partial entry is a half-replaced surface.
// - This WRITES A REQUEST. Sending it stays with the writer that owns that
//   effect, and naming the app stays with whoever runs it.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} requires one value`);
  }
  return value.trim();
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} requires one value`);
    values.push(value.trim());
  }
  return values;
}

const packageRoot = argumentValue('--package-root');
const packageName = argumentValue('--package');
const outputFile = argumentValue('--output');
const partitionLabel = argumentValue('--partition');
const chosenBlobs = new Set(argumentValues('--stored-bytes'));

const manifest = JSON.parse(readFileSync(join(packageRoot, 'things-to-store-and-run.json'), 'utf8'));
const things = Array.isArray(manifest) ? manifest : manifest.things ?? manifest.records;
if (!Array.isArray(things)) throw new Error('the package manifest holds no things array');

// A stored-bytes row is the one that names a `source_path` under the built
// folder. Selecting by that shape rather than by a name pattern keeps this
// working for a blob nobody has invented yet.
const declared = things
  .map((thing) => (thing && typeof thing === 'object' && thing.payload ? thing.payload : thing))
  .filter((thing) => thing && typeof thing === 'object')
  .filter((thing) => typeof thing.name === 'string' && typeof thing.source_path === 'string')
  .filter((thing) => chosenBlobs.size === 0 || chosenBlobs.has(thing.name));

if (declared.length === 0) throw new Error('the package declares no stored bytes to write');

const missing = [];
const writes = declared.map((blob) => {
  const path = join(packageRoot, blob.source_path);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    missing.push(blob.source_path);
    return null;
  }
  if (size === 0) {
    missing.push(blob.source_path);
    return null;
  }
  return {
    address_label: `package::${packageName}::stored-bytes::${blob.name}`,
    address_mode: 'identity_text',
    partition_label: partitionLabel,
    payload_base64: readFileSync(path).toString('base64'),
    __bytes: size,
  };
});

if (missing.length > 0) {
  throw new Error(`these declared bytes were never built, so nothing was written: ${missing.join(', ')}`);
}

writeFileSync(outputFile, `${JSON.stringify({
  operation_label: 'engine.operation.write-batch',
  partition_label: partitionLabel,
  writes: writes.map(({ __bytes, ...write }) => write),
}, null, 2)}\n`);

for (const write of writes) {
  process.stdout.write(`${write.address_label} ${write.__bytes} bytes\n`);
}
process.stdout.write(`${writes.length} addresses written to ${outputFile}\n`);
