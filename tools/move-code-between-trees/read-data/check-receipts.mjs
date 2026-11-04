// tools/move-code-between-trees/read-data/check-receipts.mjs
//
// Every receipt (moved-from.json) a checkout holds, at any depth, is whole, judged from this checkout alone, so it runs
// on a plain checkout of main with no source tree beside it:
// - it is one object whose `files` is a list (not a map of names);
// - each file names where it came from (`from`, or `from_path_identity` when the source path is private), the full
//   40-hex source `commit`, where it is here (`to`, which exists), and `source_identity`;
// - each file's bytes here are its `identity`; or, for a file changed here after its byte copy, it carries
//   `identity_at_move` and `byte_copy_commit`, the full commit of this checkout at which the file held those bytes
//   (read from git here), and `port_contract` when a contract in its tool's ports/ names it in targets[].path;
// - every other commit a receipt records (a `values` row's `commit`) is a full 40-hex commit too.
// A short `deleted_by` is reported as a note: it names the source's deleting commit for a reader, and no proof reads it.
// The source-side proof (same bytes as the source commit, imports reach the same files, it loads, its tests pass) is
// check-move.mjs, which needs the source tree.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const IDENTITY = /^1f:[0-9a-f]{64}$/;
const identity = bytes => makeHashCodeHexFromBytes(new Uint8Array(bytes));

/** Every moved-from.json git tracks in the checkout, as paths relative to it. */
export function receiptPaths(folder) {
  return execFileSync('git', ['-C', folder, 'ls-files', '-z', '--', 'moved-from.json', '*/moved-from.json'], { encoding: 'utf8' })
    .split('\0').filter(Boolean).sort();
}

// The paths port contracts in a tool's ports/ folder name as targets, each with the contract that names it.
function portTargets(folder, toolFolder, cache) {
  if (cache.has(toolFolder)) return cache.get(toolFolder);
  const named = new Map();
  const ports = join(folder, toolFolder, 'ports');
  if (existsSync(ports) && statSync(ports).isDirectory()) for (const name of readdirSync(ports).filter(one => one.endsWith('.json'))) {
    try { for (const target of JSON.parse(readFileSync(join(ports, name), 'utf8')).targets ?? []) if (target?.path) named.set(target.path, `${toolFolder}/ports/${name}`); } catch { /* an unreadable contract names nothing */ }
  }
  cache.set(toolFolder, named);
  return named;
}

/** The bytes of a path at a commit of the checkout, or null when that commit does not hold it. */
export function bytesAt(folder, commit, path) {
  try { return execFileSync('git', ['-C', folder, 'show', `${commit}:${path}`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

export function checkReceipts({ folder, paths = receiptPaths(folder) }) {
  const contracts = new Map();
  const results = paths.map(path => {
    const problems = [];
    const notes = [];
    let receipt;
    try { receipt = JSON.parse(readFileSync(join(folder, path), 'utf8')); } catch (error) { return { receipt: path, files: 0, ok: false, problems: [`${path} is not JSON: ${error.message}`], notes }; }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { receipt: path, files: 0, ok: false, problems: [`${path} is not one receipt object`], notes };
    if (!Array.isArray(receipt.files)) return { receipt: path, files: 0, ok: false, problems: [`${path}: files is ${receipt.files === undefined ? 'missing' : 'not a list'}; each file is { from, commit, to, source_identity, identity }`], notes };
    receipt.files.forEach((file, at) => {
      const name = file?.to ?? `files[${at}]`;
      if (!file?.from && !file?.from_path_identity) problems.push(`${name}: names no from (or from_path_identity)`);
      if (!FULL_COMMIT.test(file?.commit ?? '')) problems.push(`${name}: commit ${JSON.stringify(file?.commit)} is not a full 40-hex commit`);
      if (!IDENTITY.test(file?.source_identity ?? '')) problems.push(`${name}: source_identity is missing or not a 1f: identity`);
      if (file?.deleted_by && !FULL_COMMIT.test(file.deleted_by)) notes.push(`${name}: deleted_by ${file.deleted_by} is short`);
      if (!file?.to) { problems.push(`files[${at}]: names no to`); return; }
      const there = join(folder, file.to);
      if (!existsSync(there) || !statSync(there).isFile()) { problems.push(`${file.to} is missing`); return; }
      if (file.identity) {
        if (identity(readFileSync(there)) !== file.identity) problems.push(`${file.to} is not the bytes its receipt names`);
      } else if (file.identity_at_move) {
        if (!IDENTITY.test(file.identity_at_move)) problems.push(`${file.to}: identity_at_move is not a 1f: identity`);
        if (!FULL_COMMIT.test(file.byte_copy_commit ?? '')) problems.push(`${file.to}: changed after its byte copy, and byte_copy_commit ${JSON.stringify(file.byte_copy_commit)} is not a full 40-hex commit`);
        else {
          const copied = bytesAt(folder, file.byte_copy_commit, file.to);
          if (!copied) problems.push(`${file.to} is not in this checkout at byte_copy_commit ${file.byte_copy_commit.slice(0, 10)}`);
          else if (identity(copied) !== file.identity_at_move) problems.push(`${file.to} at byte_copy_commit ${file.byte_copy_commit.slice(0, 10)} is not the bytes identity_at_move names`);
        }
        const tool = file.to.split('/').slice(0, 2).join('/');
        const contract = portTargets(folder, tool, contracts).get(file.to) ?? null;
        if (file.port_contract && file.port_contract !== contract) problems.push(`${file.to}: port_contract ${file.port_contract} does not name it in targets[].path`);
        if (contract && !file.port_contract) notes.push(`${file.to}: ${contract} names it; the receipt could name it as port_contract`);
      } else problems.push(`${file.to}: names no identity (or identity_at_move with byte_copy_commit)`);
    });
    for (const [at, value] of (receipt.values ?? []).entries()) {
      if (!FULL_COMMIT.test(value?.commit ?? '')) problems.push(`values[${at}] (${value?.from ?? '?'}): commit ${JSON.stringify(value?.commit)} is not a full 40-hex commit`);
    }
    return { receipt: path, files: receipt.files.length, ok: problems.length === 0, problems, notes };
  });
  return { ok: results.every(item => item.ok), receipts: results.length, files: results.reduce((sum, item) => sum + item.files, 0), results };
}
