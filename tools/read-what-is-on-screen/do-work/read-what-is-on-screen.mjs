// tools/read-what-is-on-screen/do-work/read-what-is-on-screen.mjs
//
// The Workshop tool "Read what is on my screen": runs read.swift beside it for a short watch and returns its one JSON
// line ({ captures }, { needs_access, said } or { error }). Run as a function by tools/records-door/do-work/run-an-export.mjs
// on the person's own Mac.
//
// Invariants:
// - The watch length and the re-read interval are the request's, inside the bounds below; a request outside them is
//   refused with the bounds, never quietly changed.
// - The reader is given the rules file (read-data/rules.json) and nothing else to decide what may be read.
// - Whatever the reader fails with comes back as { error } in words, never as a silent empty answer.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const READER = fileURLToPath(new URL('./read.swift', import.meta.url));
export const RULES = fileURLToPath(new URL('../read-data/rules.json', import.meta.url));
export const SWIFT = '/usr/bin/swift';

export const BOUNDS = {
  watch_seconds: { least: 5, most: 240, otherwise: 50 },
  tick_seconds: { least: 10, most: 600, otherwise: 60 },
};
// The time the reader may take beyond its watch to start (the compiler runs first) before it is stopped.
const START_ALLOWANCE_MS = 60_000;

function seconds(input, name) {
  const { least, most, otherwise } = BOUNDS[name];
  const value = input?.[name] ?? otherwise;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < least || value > most) {
    throw new Error(`${name} must be a number from ${least} to ${most}.`);
  }
  return value;
}

// The command that runs the reader with its rules, for a request.
export function readerArguments(input) {
  return [READER, '--rules', RULES, '--watch-seconds', String(seconds(input, 'watch_seconds')), '--tick-seconds', String(seconds(input, 'tick_seconds'))];
}

// The last line of what the reader printed, as the answer.
export function answerOf(stdout, stderr = '') {
  const lines = String(stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (last) {
    try { return JSON.parse(last); } catch { /* said below */ }
  }
  const why = String(stderr).trim().split('\n').slice(-3).join(' ').slice(0, 300);
  return { error: `The reader gave no answer.${why ? ` It said: ${why}` : ''}` };
}

export function read(input, { swift = SWIFT } = {}) {
  const request = input ?? {};
  const args = readerArguments(request);
  const watch = seconds(request, 'watch_seconds');
  return new Promise(resolve => {
    execFile(swift, args, { encoding: 'utf8', timeout: watch * 1000 + START_ALLOWANCE_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error?.killed) resolve({ error: 'The reader did not finish in time and was stopped.' });
      else resolve(answerOf(stdout, stderr || error?.message));
    });
  });
}

export const readWhatIsOnScreen = input => read(input);
