#!/usr/bin/env node
// tools/move-code-between-trees/do-work/move-code.mjs
//
// tool:move-code-between-trees. One JSON request on standard input, one JSON answer as the last line of standard output:
//   { step: "plan" | "apply" | "check", row | row_file, source_folder, destination_folder,
//     source_commit?, only?, apply_groups?, source_after_folder?, folders?, run? }
// plan works out the move and changes nothing; apply plans and carries it out on both working copies; check proves the
// moved files from their receipts on a clean checkout of the destination. only narrows the groups planned; apply_groups
// carries out some of the planned groups, placing shared files as the whole plan would. The move row (see move-rows/) holds every
// choice: the two trees, the groups and their folders, what stays, and the provider calls to swap.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { applyMove } from '../read-data/apply-move.mjs';
import { checkMove } from '../read-data/check-move.mjs';
import { MoveRefusal, openTreeAt } from '../read-data/code-tree.mjs';
import { planMove } from '../read-data/plan-move.mjs';

const here = resolve(import.meta.dirname, '..');

export function moveCode(request) {
  if (!request || typeof request !== 'object') throw new MoveRefusal('request_not_json', 'Send one JSON object: { step, row_file or row, source_folder, destination_folder }.');
  const { step } = request;
  if (!['plan', 'apply', 'check'].includes(step)) throw new MoveRefusal('step_unknown', 'step is plan (work out the move), apply (carry it out) or check (prove a move from its receipts).');
  const row = request.row ?? (request.row_file ? JSON.parse(readFileSync(isAbsolute(request.row_file) ? request.row_file : join(here, request.row_file), 'utf8')) : null);
  if (!row) throw new MoveRefusal('row_missing', 'Name the move row: row (the row itself) or row_file (a path, relative to this tool folder, such as move-rows/<pair>.json).');
  for (const key of ['source_folder', 'destination_folder']) {
    if (typeof request[key] !== 'string' || !request[key]) throw new MoveRefusal('folder_missing', `Give ${key}: the working copy of the ${key.split('_')[0]} tree.`);
  }
  const sourceFolder = resolve(request.source_folder);
  const destinationFolder = resolve(request.destination_folder);
  const trees = new Map();
  const sourceAt = commit => { if (!trees.has(commit)) trees.set(commit, openTreeAt(sourceFolder, commit)); return trees.get(commit); };

  if (step === 'check') {
    return checkMove({ sources: sourceAt, destinationFolder, sourceAfterFolder: request.source_after_folder ? resolve(request.source_after_folder) : null, folders: request.folders, run: request.run !== false });
  }
  const chosen = { ...row, ...(request.only ? { only: request.only } : {}) };
  const source = sourceAt(request.source_commit ?? row.source?.commit ?? 'HEAD');
  const destination = openTreeAt(destinationFolder, 'HEAD');
  const plan = planMove(chosen, source, destination);
  if (step === 'plan') return plan;
  const applied = applyMove(plan, chosen, source, destination, { sourceFolder, destinationFolder, only: request.apply_groups ?? null });
  return { ...plan, applied };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    process.stdout.write(`${JSON.stringify({ result: moveCode(JSON.parse(input || 'null')) })}\n`);
  } catch (error) {
    const known = error instanceof MoveRefusal || error instanceof SyntaxError || error instanceof TypeError;
    process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? (error instanceof SyntaxError ? 'request_not_json' : 'refused'), message: known ? error.message : `The move stopped: ${error.message}` } })}\n`);
    process.exitCode = 1;
  }
}
