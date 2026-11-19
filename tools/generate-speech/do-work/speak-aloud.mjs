// tools/generate-speech/do-work/speak-aloud.mjs
//
// Purpose
//   The Trillion Mac app's road to say one notice out loud (macos/App/SpeakAloud.swift, through ComputerReader, which
//   starts this file by the role it fills, `role:speak-aloud` in this tool's part.json), with the request as one JSON
//   line on standard input. The app hands in the person's own rows (their Voices and places lists, read from their
//   store by the app) inside the request:
//
//     speak-aloud.mjs --out <file.wav> --answer <file.json>   then { text, voice?, place?, voices?, places? } as one JSON line
//
//   writes { out, seconds, voice, engine, produced_by, speed } to the answer file (and prints it) and exits 0, or writes
//   and prints { error } and exits 1, so the app keeps the notice and makes its sound again later. A notice whose sound
//   could never be made before it was too old to say is handed back instead, as the tool and input to report it with:
//
//     speak-aloud.mjs --unsaid                                 then { notice, title, why, hours } as one JSON line
//
//   prints { tool, input } (read-data/speak.json `unsaid.tool` and its input, worded by that row); the caller runs that
//   tool and keeps its answer as failed work.
//   Moved from the app's computer/speak.mjs, whose main road this was; the speaking itself is read-data/speak.mjs.
//
// Non-negotiable invariants
//   1. The voice, its speed and every word are read-data/speak.json and the person's own rows (read-data/speak.mjs
//      invariants 1 and 2); this file names none of them.
//   2. This road reads and writes no store and holds no key: the rows a request needs come in with it, and what it
//      makes goes out as the answer.
//   3. Every road ends in one JSON answer on the last line of standard output: the made sound, or { error } and exit 1.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { personFromRows, sayHere, speakSettings } from '../read-data/speak.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const argument = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : ''; };

const out = argument('--out');
const answer = argument('--answer');
let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const request = JSON.parse(input || '{}');
  if (process.argv.includes('--unsaid')) {
    const { unsaid } = speakSettings();
    const values = { notice: request.notice ?? '', title: request.title ?? '', why: request.why ?? '', hours: request.hours ?? '' };
    const told = { tool: unsaid.tool, input: { key: fill(unsaid.key, values), kind: unsaid.kind, state: unsaid.state, title: fill(unsaid.title, values), body: fill(unsaid.body, values), source: os.hostname() } };
    process.stdout.write(`${JSON.stringify(told)}\n`);
  } else {
    if (!out) throw new Error('Give --out, the sound file to write.');
    const person = personFromRows({ voices: request.voices, places: request.places }, speakSettings(), { place: request.place ?? null });
    const made = await sayHere({ text: request.text, voice: request.voice ?? null, place: request.place ?? null, out }, { person });
    if (answer) writeFileSync(answer, JSON.stringify(made), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(made)}\n`);
  }
} catch (error) {
  const said = JSON.stringify({ error: String(error?.message ?? error) });
  if (answer) try { writeFileSync(answer, said, { mode: 0o600 }); } catch {}
  process.stdout.write(`${said}\n`);
  process.exitCode = 1;
}
