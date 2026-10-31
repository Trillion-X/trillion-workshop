// tools/calendar/do-work/command.mjs
//
// How each command of this folder runs: one JSON input on stdin, one JSON line on stdout, a refusal as one line on
// stderr with exit code 1. Used by every command here, never by anything else.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function runCommand(metaUrl, work) {
  if (process.argv[1] !== fileURLToPath(metaUrl)) return;
  (async () => {
    let input = {};
    try {
      const text = readFileSync(0, 'utf8').trim();
      input = text ? JSON.parse(text) : {};
    } catch { throw new Error('The input must be one JSON object.'); }
    process.stdout.write(`${JSON.stringify(await work(input))}\n`);
  })().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

/** Refuses with every problem at once. */
export function refuse(problems) {
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
}
