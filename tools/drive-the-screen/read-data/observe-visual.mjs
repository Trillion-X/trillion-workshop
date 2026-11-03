// tools/drive-the-screen/read-data/observe-visual.mjs
//
// The parts of Trillion-X/trillion computer/observe-visual.mjs the screen driver uses, moved one to one: `run` (one
// program to its end, with input on standard input, a timeout and a cap on what it prints) and `ocrPixels` (the text in
// image bytes, with normalized bounds and the decoded image's own size, read by observe-visual.swift under its
// read-data/helper-sandbox.json profile). The video, caption and title parts stay with that file's other callers.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confined } from './helper-sandbox.mjs';

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
export const ocrPixels = bytes => {
  const { program, args } = confined('image-text', '/usr/bin/swift', [path.join(HERE, 'observe-visual.swift')]);
  return run(program, args, { input: bytes }).then(value => JSON.parse(value));
};
