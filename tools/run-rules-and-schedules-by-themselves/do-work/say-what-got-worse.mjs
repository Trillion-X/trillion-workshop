#!/usr/bin/env node
import { realpathSync } from 'node:fs';
// tools/run-rules-and-schedules-by-themselves/do-work/say-what-got-worse.mjs
//
// PURPOSE: tool:say-what-got-worse, run in the tool container: the reading (measures with now and before) on standard
// input, the answer on standard output as one JSON line. The comparison is compare-readings.mjs; this file only reads
// the input and writes the answer, so a workflow can hand it measures and take back `worse` and `said`.
//
// Usage: node do-work/say-what-got-worse.mjs < input.json
// Refusals (a measure with no label, a worse_when that is not higher or lower, a now or before that is not a number or a
// list) exit 1 with the reason on standard error, and nothing is written to standard output.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sayWhatGotWorse } from './compare-readings.mjs';

export function sayFrom(text) {
  return sayWhatGotWorse(JSON.parse(text));
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(sayFrom(readFileSync(0, 'utf8')))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
