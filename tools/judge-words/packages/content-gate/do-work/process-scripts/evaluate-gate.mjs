#!/usr/bin/env node
import { build } from 'esbuild';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

let bundledRuntime;
async function loadRuntime() {
  if (!bundledRuntime) {
    const result = await build({
      stdin: {
        contents: `
          import { evaluateGate } from '../evaluate-gate';
          import { standardEvaluators } from '../standard-evaluators';
          export const evaluate = (subject, spec) => evaluateGate(subject, spec, standardEvaluators);
        `,
        resolveDir: repoRoot,
        sourcefile: 'content-gate-local-consumer.ts',
        loader: 'ts',
      },
      absWorkingDir: repoRoot,
      alias: { '@': repoRoot },
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
    });
    if (result.outputFiles.length !== 1) throw new Error('Expected one in-memory evaluator bundle.');
    const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
    bundledRuntime = import(`data:text/javascript;base64,${encoded}`);
  }
  return bundledRuntime;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRequest(value) {
  if (!isRecord(value) || !isRecord(value.subject) || !Array.isArray(value.subject.blocks)
    || !isRecord(value.spec) || typeof value.spec.id !== 'string' || !Array.isArray(value.spec.rules)) {
    throw new Error('Request must contain subject.blocks and spec.id/spec.rules.');
  }
  if (value.subject.blocks.some((block) => !isRecord(block) || typeof block.kind !== 'string' || typeof block.text !== 'string')) {
    throw new Error('Every subject block must contain string kind and text fields.');
  }
  if (value.spec.rules.some((rule) => !isRecord(rule) || typeof rule.id !== 'string'
    || typeof rule.evaluator !== 'string' || !isRecord(rule.config ?? {}))) {
    throw new Error('Every spec rule must contain string id/evaluator fields and an object config.');
  }
}

export async function evaluateGateRequest(value) {
  validateRequest(value);
  const runtime = await loadRuntime();
  return runtime.evaluate(value.subject, value.spec);
}

async function readBoundedStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error(`Request exceeds ${MAX_REQUEST_BYTES} bytes.`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function sameFile(left, right) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);
}

export async function readGateRequestFile(filePath, { afterDescriptorRead } = {}) {
  const beforePath = await lstat(filePath, { bigint: true });
  if (!beforePath.isFile()) throw new Error('Request must be a regular non-symlink file.');
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFile(beforePath, before)) throw new Error('Request file changed before reading.');
    if (before.size > BigInt(MAX_REQUEST_BYTES)) throw new Error(`Request exceeds ${MAX_REQUEST_BYTES} bytes.`);
    const chunks = [];
    let size = 0;
    while (size <= MAX_REQUEST_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_REQUEST_BYTES + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > MAX_REQUEST_BYTES) throw new Error(`Request exceeds ${MAX_REQUEST_BYTES} bytes.`);
    if (afterDescriptorRead) await afterDescriptorRead();
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    if (BigInt(size) !== before.size || !afterPath.isFile()
      || !sameFile(before, after) || !sameFile(before, afterPath)) {
      throw new Error('Request file changed during reading.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally {
    await handle.close();
  }
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--request-file' || !args[1])) {
      throw new Error('Usage: evaluate-gate.mjs [--request-file <request.json>]');
    }
    const requestText = args.length ? await readGateRequestFile(args[1]) : await readBoundedStdin();
    const result = await evaluateGateRequest(JSON.parse(requestText));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown evaluation error.';
    process.stderr.write(`content-gate: ${message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
