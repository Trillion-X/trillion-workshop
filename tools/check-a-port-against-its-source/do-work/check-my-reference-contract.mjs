// tools/check-a-project-for-drift-and-broken-promises/do-work/check-my-reference-contract.mjs
//
// A contract says what was taken from a reference (a source to port, a behaviour, a visual replica, an
// inspiration, an anti-reference), what must be preserved and what proves it. Run by the Workshop tool
// `tool:check-a-reference-adaptation-contract` on the person's computer, in the folder they granted:
//
//   node do-work/check-my-reference-contract.mjs <the granted folder> < { "contract" | "contract_file", "stage"?, "target"? }
//
// `contract` is the contract itself, or `contract_file` a path inside the granted folder to it. Paths the contract
// names (its source, targets, pixel lock and pictures) are read relative to the granted folder, and every identity in
// it is the BLAKE3 identity `1f:<64 hex>` of tools/content-identity. `stage` is `pre-edit` or `completion` (the
// default), `target` a path the contract must own. Prints the validator's answer { valid, errors, id, mode, status,
// measurements } as { result } on its last line, with a non-zero status when the contract is not valid.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { validateReferenceAdaptationContract } from './validate-reference-adaptation-contract.mjs';

const folder = process.argv[2];
try {
  if (!folder || !path.isAbsolute(folder) || !statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('the granted folder was not given as an absolute path to a folder');
  }
  const input = JSON.parse((await text(process.stdin)) || '{}');
  process.chdir(folder);
  let contract = input.contract;
  if (contract === undefined) {
    if (typeof input.contract_file !== 'string' || !input.contract_file) throw new Error('give contract, or contract_file: a path inside the granted folder');
    const file = path.resolve(folder, input.contract_file);
    if (!file.startsWith(folder + path.sep)) throw new Error('contract_file is not a path inside the granted folder');
    contract = JSON.parse(readFileSync(file, 'utf8'));
  }
  const result = validateReferenceAdaptationContract(contract, { stage: input.stage ?? 'completion', target: input.target });
  console.log(JSON.stringify({ result }));
  process.exitCode = result.valid ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 2;
}
