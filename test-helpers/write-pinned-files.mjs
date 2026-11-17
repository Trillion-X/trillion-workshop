// test-helpers/write-pinned-files.mjs
//
// Usage: node test-helpers/write-pinned-files.mjs
// Makes pinned-files.json at the top of this tree agree with package-lock.json (test-helpers/pinned-files.mjs): an npm
// package already pinned at the lockfile's address and version is kept, a new one is read from its address, checked against
// the lockfile's sha512 and pinned by its BLAKE3. It also writes each tool row's `uses_tools` (test-helpers/tool-closures.mjs):
// the other tools its folder's files use. Run it when the lockfile changes, and commit both. The publish step
// refuses a commit whose pinned files do not agree with its lockfile.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PINNED_FILES, writePinnedFiles } from './pinned-files.mjs';
import { writeUses } from './tool-closures.mjs';

const top = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(top, 'package-lock.json'), 'utf8'));
const previous = JSON.parse(readFileSync(resolve(top, PINNED_FILES), 'utf8'));
const fetchBytes = async address => {
  const answer = await fetch(address);
  if (!answer.ok) throw new Error(`${address} answered ${answer.status}`);
  return new Uint8Array(await answer.arrayBuffer());
};
const next = await writePinnedFiles({ lock, previous, fetchBytes });
writeFileSync(resolve(top, PINNED_FILES), `${JSON.stringify(next, null, 1)}\n`);
console.log(`${writeUses(top).length} tool row files changed`);
console.log(`${Object.keys(next.packages).length} packages pinned`);
