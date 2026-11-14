#!/usr/bin/env node
/**
 * file: packages/content-production/do-work/generate-derived.mjs
 *
 * PURPOSE: The generate.derived capability (plan §15 T07) — turns a cleaned
 * transcript into one derived text deliverable (blog / newsletter / thread /
 * caption / anything) using the LOCAL CLI model. The format's full generation
 * spec (length, voice, structure) is DATA in derived-formats.json — this file
 * never names a format.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Formats are data rows; adding a deliverable type = one row, zero code here
 * 2. Local CLI only (the argv comes from the formats file or --cli) — no HTTP API key
 * 3. The transcript's words are the source of truth — the spec governs shape, not content
 * 4. Output: the deliverable text to --out, machine-readable report JSON on stdout
 *
 * Usage: node generate-derived.mjs --format <id> --transcript <file> --out <file>
 *        [--formats derived-formats.json] [--cli '<argv json>']
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const FORMAT_ID = args.get('format');
const TRANSCRIPT = args.get('transcript');
const OUT = args.get('out');
if (!FORMAT_ID || !TRANSCRIPT || !OUT) {
  console.error('usage: generate-derived.mjs --format <id> --transcript <file> --out <file>');
  process.exit(2);
}

// --formats / --cli are optional DATA passthroughs. A workflow that always renders
// the flag (binding + if_null) sends the literal string "null" when the input is
// absent; treat "null"/"" as absent so a caller may supply its OWN format-spec doc
// and its OWN cli argv as opaque DATA, without this engine knowing or naming what
// that cli is. This engine never resolves or selects a cli — it runs whatever argv
// array it is handed on whatever format-spec it is handed.
const formatsArg = args.get('formats');
const formatsPath = formatsArg && formatsArg !== 'null' ? formatsArg : join(here, '..', 'derived-formats.json');
const formatsDoc = JSON.parse(readFileSync(formatsPath, 'utf8'));
const execution = formatsDoc.execution ?? {};
const format = (formatsDoc.formats ?? []).find((f) => f.id === FORMAT_ID);
if (!format) {
  console.error(`unknown format "${FORMAT_ID}" — known: ${(formatsDoc.formats ?? []).map((f) => f.id).join(', ')}`);
  process.exit(3);
}

// Transcript: accept word-timed JSON ({words:[{text,...}]}) or plain text.
const raw = readFileSync(TRANSCRIPT, 'utf8');
let text;
try {
  const parsed = JSON.parse(raw);
  const words = Array.isArray(parsed) ? parsed : parsed.words;
  text = words.map((w) => w.text ?? w.t ?? '').join(' ');
} catch {
  text = raw;
}

if (text.trim().length === 0) {
  console.error('the transcript is empty — nothing to derive from');
  process.exit(5);
}

const cliArg = args.get('cli');
const cli = cliArg && cliArg !== 'null' ? JSON.parse(cliArg) : execution.argv;
if (!Array.isArray(cli) || cli.length === 0 || typeof cli[0] !== 'string') {
  console.error(JSON.stringify({ error: 'missing_execution_argv', required: 'execution.argv or --cli' }));
  process.exit(6);
}
const timeoutMs = Number(args.get('timeout-ms') ?? execution.timeout_ms);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(JSON.stringify({ error: 'missing_timeout_ms', required: 'execution.timeout_ms or --timeout-ms' }));
  process.exit(6);
}
const maxBufferBytes = Number(execution.max_buffer_bytes);
if (!Number.isFinite(maxBufferBytes) || maxBufferBytes <= 0) {
  console.error(JSON.stringify({ error: 'missing_max_buffer_bytes', required: 'execution.max_buffer_bytes' }));
  process.exit(6);
}

const prompt = `${format.spec}

Transcript:
${text}`;

const reply = execFileSync(cli[0], [...cli.slice(1), prompt], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: maxBufferBytes });

// codex exec echoes the session banner + reasoning; the deliverable is the final
// assistant block. Take everything after the last "codex" marker line when
// present; otherwise the whole reply.
const marker = reply.lastIndexOf('\ncodex\n');
const deliverable = (marker >= 0 ? reply.slice(marker + 7) : reply)
  .replace(/\ntokens used\n[\s\S]*$/, '')
  .trim();

if (deliverable.length === 0) {
  console.error('the model returned an empty deliverable');
  process.exit(4);
}

writeFileSync(OUT, deliverable + '\n');
console.log(`[generate.derived] format=${FORMAT_ID} -> ${deliverable.length} chars`);
console.log(JSON.stringify({ format: FORMAT_ID, content_type: format.content_type, output: OUT, chars: deliverable.length }));
