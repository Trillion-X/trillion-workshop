#!/usr/bin/env node
// tools/move-code-between-trees/index.js
//
// `node tools/move-code-between-trees check [--source <old tree checkout>] [--source-after <folder>] [--no-run]`
// from the root of a Workshop checkout. With no source, every receipt (moved-from.json, at any depth) is judged from
// this checkout alone (read-data/check-receipts.mjs): its shape, full commits, and the bytes here. With --source, the
// receipts named for that tree are also proved against it (read-data/check-move.mjs). Prints one JSON answer and exits
// 0 when every receipt is whole, 1 when not, 2 when it could not run. plan and apply take a JSON request on standard
// input: do-work/move-code.mjs.
import { resolve } from 'node:path';
import { checkReceipts } from './read-data/check-receipts.mjs';
import { checkMove } from './read-data/check-move.mjs';
import { openTreeAt } from './read-data/code-tree.mjs';

const [step, ...rest] = process.argv.slice(2);
const option = name => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : null; };
try {
  if (step !== 'check') {
    process.stdout.write(`${JSON.stringify({ error: { code: 'step_unknown', message: 'Run `check` here; plan and apply take a JSON request on standard input to do-work/move-code.mjs.' } })}\n`);
    process.exit(2);
  }
  const folder = resolve(option('--destination') ?? process.cwd());
  const whole = checkReceipts({ folder });
  const answer = { ok: whole.ok, receipts: whole.receipts, files: whole.files, not_whole: whole.results.filter(item => !item.ok), notes: whole.results.reduce((sum, item) => sum + item.notes.length, 0) };
  if (option('--source')) {
    const sourceFolder = resolve(option('--source'));
    const trees = new Map();
    const sources = commit => { if (!trees.has(commit)) trees.set(commit, openTreeAt(sourceFolder, commit)); return trees.get(commit); };
    const proved = checkMove({ sources, destinationFolder: folder, sourceAfterFolder: option('--source-after') ? resolve(option('--source-after')) : null, run: !rest.includes('--no-run') });
    answer.against_source = proved;
    answer.ok = answer.ok && proved.ok;
  }
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  process.exitCode = answer.ok ? 0 : 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'refused', message: error.message } })}\n`);
  process.exitCode = 2;
}
