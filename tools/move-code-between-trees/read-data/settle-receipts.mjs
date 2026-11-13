// tools/move-code-between-trees/read-data/settle-receipts.mjs
//
// Make every receipt (moved-from.json) say what its file is now. A file whose bytes here are no longer the `identity` its
// receipt names was changed after it was copied: when a commit of this checkout holds the bytes the receipt names, the
// entry names that commit as `byte_copy_commit` and keeps the bytes as `identity_at_move` (the form check-receipts.mjs
// proves from git); when no commit of this checkout ever held them, the receipt never told the truth about them, so the
// entry names the bytes the file has now and says in `adapted` that they are not the bytes of its source; an entry whose
// file is gone is dropped. Nothing else in an entry is touched, and an entry that already tells the truth is left as it is.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { bytesAt, receiptPaths } from './check-receipts.mjs';

const identityOf = bytes => makeHashCodeHexFromBytes(new Uint8Array(bytes));

// The newest commit of the checkout (from `history`, a ref) that holds `path` with bytes whose identity is `wanted`.
function commitHolding(folder, history, path, wanted) {
  const commits = execFileSync('git', ['-C', folder, 'log', '--format=%H', history, '--', path], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean);
  return commits.find(commit => { const bytes = bytesAt(folder, commit, path); return bytes && identityOf(bytes) === wanted; }) ?? null;
}

const NOT_THE_SOURCE = 'The bytes here are not the bytes of its source: the receipt named bytes no commit of this checkout ever held, so it names the bytes the file has.';

/** Rewrites the receipts of the checkout whose entries do not say what their file is; answers what it changed. An entry
 * whose file is gone is dropped (git keeps the file's history, and a receipt names only files that are here). */
export function settleReceipts({ folder, history = 'HEAD', paths = receiptPaths(folder) }) {
  const settled = [];
  for (const path of paths) {
    const receipt = JSON.parse(readFileSync(join(folder, path), 'utf8'));
    if (!Array.isArray(receipt.files)) continue;
    const kept = [];
    for (let file of receipt.files) {
      if (!file?.to) { kept.push(file); continue; }
      if (!existsSync(join(folder, file.to))) { settled.push({ receipt: path, to: file.to, how: 'dropped' }); continue; }
      const now = identityOf(readFileSync(join(folder, file.to)));
      // A move inside this checkout names its source in git here: the identity of the bytes at that commit.
      if (!/^1f:[0-9a-f]{64}$/.test(file.source_identity ?? '') && file.from && file.commit) {
        const source = bytesAt(folder, file.commit, file.from);
        if (source) { file = { ...file, source_identity: identityOf(source) }; settled.push({ receipt: path, to: file.to, how: 'source_identity' }); }
      }
      const named = file.identity ?? file.identity_at_move;
      if (file.identity && now === file.identity) { kept.push(file); continue; }
      if (!file.identity && file.identity_at_move) {
        const there = file.byte_copy_commit ? bytesAt(folder, file.byte_copy_commit, file.to) : null;
        if (there && identityOf(there) === file.identity_at_move) { kept.push(file); continue; }
      }
      const held = named ? commitHolding(folder, history, file.to, named) : null;
      if (held) {
        const { identity, ...rest } = file;
        kept.push({ ...rest, identity_at_move: named, byte_copy_commit: held });
        settled.push({ receipt: path, to: file.to, how: 'byte_copy_commit', commit: held });
      } else {
        const { identity_at_move, byte_copy_commit, ...rest } = file;
        kept.push({ ...rest, identity: now, adapted: NOT_THE_SOURCE });
        settled.push({ receipt: path, to: file.to, how: 'adapted' });
      }
    }
    if (settled.some(item => item.receipt === path)) writeFileSync(join(folder, path), `${JSON.stringify({ ...receipt, files: kept }, null, 2)}\n`);
  }
  return { settled, receipts: new Set(settled.map(item => item.receipt)).size };
}
