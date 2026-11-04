// tools/drive-the-screen/read-data/observe-visual.mjs
//
// The two parts of Trillion-X/trillion computer/observe-visual.mjs the screen driver uses, moved as they were: `run`
// (one program to its end, its standard output as bytes) and `ocrPixels` (recognized text with normalized bounds, and
// the decoded image's own size, from image bytes, by ./observe-visual.swift). The rest of that file (video frames,
// captions, titles) stays with its own callers there.
//
// What changed in the move: the Mac host started the reader under its own Seatbelt profile (computer/helper-sandbox.mjs
// `confined('image-text', ...)`). A `computer` run is already started deny-default by the engine with only the rules of
// its row's capabilities (src/runtime/workshop/computer.rs in Trillion-X/trillion-rust), so the reader is started as
// itself inside that sandbox.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const run = (program, args, { input = null, timeout = 90_000, maxBuffer = 24 * 1024 * 1024 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [], errors = [];
  let bytes = 0;
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxBuffer) child.kill('SIGTERM'); else chunks.push(chunk); });
  child.stderr.on('data', chunk => errors.push(chunk));
  child.on('error', reject);
  child.on('close', code => { clearTimeout(timer); if (code || bytes > maxBuffer) reject(new Error(Buffer.concat(errors).toString().trim() || 'visual reader failed')); else resolve(Buffer.concat(chunks)); });
  if (input?.pipe) input.pipe(child.stdin);
  else child.stdin.end(input ?? undefined);
});

/** Recognized text with normalized bounds (and the decoded image's own size) from image bytes: the one reader of pixels on this Mac. */
export const ocrPixels = bytes => run('/usr/bin/swift', [path.join(HERE, 'observe-visual.swift')], { input: bytes }).then(value => JSON.parse(value));
