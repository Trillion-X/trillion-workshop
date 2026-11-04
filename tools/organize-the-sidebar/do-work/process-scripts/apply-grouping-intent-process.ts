// packages/group/do-work/process-scripts/apply-grouping-intent-process.ts
//
// PURPOSE
// The process-shaped face of `applyGroupingIntent`. Reads a containment
// projection and a grouping intent, writes the changed projection, prints a
// receipt. Files in, files out, exit status, nothing else.
//
// WHY THIS SHAPE
// This is what `compute.process` consumes: an argv, a cwd, declared inputs and
// outputs. Writing the entrypoint this way means the step can be declared as
// DATA in a workflow, exactly like the other process scripts in the package set,
// instead of needing a bespoke runner. The pure function stays pure and testable;
// this file owns only the boundary.
//
// usage:
//   apply-grouping-intent-process.ts <records.json> <intent.json> <out.json>
//
// The identity minter lives HERE rather than in the pure function, because
// minting is the one impure act and it belongs at the boundary.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { applyGroupingIntent, type GroupingIntent } from '../apply-grouping-intent.ts';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const [, , recordsPath, intentPath, outPath] = process.argv;
if (!recordsPath || !intentPath || !outPath) {
  process.stderr.write(
    'usage: apply-grouping-intent-process.ts <records.json> <intent.json> <out.json>\n',
  );
  process.exit(2);
}

const recordsInput = readJson(recordsPath) as
  | { records?: unknown[] }
  | unknown[];
const records = Array.isArray(recordsInput)
  ? recordsInput
  : (recordsInput.records ?? []);

const intentInput = readJson(intentPath) as GroupingIntent | GroupingIntent[];
const intent = Array.isArray(intentInput) ? intentInput[0] : intentInput;

// Identity policy for a materialized parent. Uppercase because this tree's
// existing identities are uppercase, and a projection that mixes cases makes
// every later comparison a guess. Nothing else here knows what the tree is.
const mint = (): string => randomUUID().toUpperCase();

const result = applyGroupingIntent(records as never, intent, mint);

writeFileSync(outPath, JSON.stringify({ records: result.records }, null, 0));

const receipt = {
  records_in: (records as unknown[]).length,
  records_out: result.records.length,
  moved_count: result.moved.length,
  created: result.created,
  untouched: result.untouched,
  refusals: result.refusals,
};
process.stderr.write(JSON.stringify(receipt, null, 2) + '\n');

// A refusal is information, not a crash: the good rows still applied. Exit 0 so
// a caller reads the receipt, and let the caller decide what an unrouted row means.
process.exitCode = 0;
