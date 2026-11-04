#!/usr/bin/env node
// scripts/compare-arms.mjs
//
// Purpose
//   Scores two recorded traces against the trap battery (src/behavior-evals.json) and prints the comparison.
//     node scripts/compare-arms.mjs <arm-a.json> <arm-b.json>
//   Each file is { arm, runs: [{ task_id, state, calls: [{ tool }] }] }, written from the calls a run recorded.
import { readFileSync } from 'node:fs';
import { compareArms } from '../src/behavior-compare.mjs';

const [left, right] = process.argv.slice(2);
if (!left || !right) { process.stderr.write('Give two trace files.\n'); process.exit(1); }
process.stdout.write(`${JSON.stringify(compareArms(JSON.parse(readFileSync(left, 'utf8')), JSON.parse(readFileSync(right, 'utf8'))), null, 2)}\n`);
