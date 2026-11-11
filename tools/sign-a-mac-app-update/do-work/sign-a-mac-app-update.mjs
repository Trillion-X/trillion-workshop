#!/usr/bin/env node
// tools/sign-a-mac-app-update/do-work/sign-a-mac-app-update.mjs
//
// Purpose
//   Signs the Mac app's update record text with the release key the person's vault holds under `mac-app-update-signing-key`,
//   through the engine's one signing operation `held-values:sign` on @held-values (src/secrets.rs). The key never leaves the
//   vault: the engine answers only the signature. The credential is this run's own capability, handed on fd 3 by the Rust run
//   (invoke.records.rights names that one key and that one operation); the engine refuses the call from anyone without a run.
//
// Non-Negotiable Invariants
//   1. The key name is the one the row's right names. A run never signs under any other name.
//   2. The payload is the UTF-8 text the release signs (the record's signed lines), at most 64 KiB, as the engine states.
//   3. The answer is { name, signature_base64 }: an Ed25519 signature over the payload bytes, base64 as App/AppUpdate.swift
//      reads it. The engine's hex signature is converted, never changed.
//   4. The capability is never printed, logged, put in an error or returned. Errors name the engine's fixed words only.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const KEY_NAME = 'mac-app-update-signing-key';
export const OPERATION = 'held-values:sign';
const MOST_PAYLOAD_BYTES = 64 * 1024;
const DESCRIPTOR_FD = 3;

export class SignError extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}

/** The run's door, from the descriptor the Rust run wrote on fd 3 (url, resource, capability). */
export function readDoor(descriptor = DESCRIPTOR_FD) {
  let door;
  try {
    door = JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch {
    throw new SignError('This run was not handed a records door.', 2);
  }
  if (typeof door.url !== 'string' || typeof door.resource !== 'string' || typeof door.capability !== 'string') {
    throw new SignError('This run was not handed a records door.', 2);
  }
  return door;
}

/** The answer's JSON-RPC result from a JSON or event-stream body. */
function resultOf(text, contentType) {
  const body = contentType?.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('')
    : text;
  const answer = JSON.parse(body);
  if (answer.error) throw new SignError('The records door refused the signing call.', 3);
  return answer.result ?? {};
}

/** Signs `payload` under the held key through the run's door. Answers { name, signature_base64 }. */
export async function signRecordText({ payload, door, fetchImpl = fetch }) {
  if (typeof payload !== 'string' || payload === '') throw new SignError('Give the text to sign: the record\'s signed lines, joined by newlines.', 2);
  if (Buffer.byteLength(payload, 'utf8') > MOST_PAYLOAD_BYTES) throw new SignError('The text to sign is larger than the engine takes (64 KiB).', 2);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'run_resource_operation', arguments: { address: '@held-values', method: OPERATION, request_key: `sign:${randomUUID()}`, input: { name: KEY_NAME, payload } } },
  });
  const response = await fetchImpl(door.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${door.capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body,
  });
  if (response.status === 401) throw new SignError('The records door refused this run: its capability is gone.', 4);
  if (!response.ok) throw new SignError(`The records door answered ${response.status}.`, 3);
  const result = resultOf(await response.text(), response.headers.get('content-type'));
  if (result.isError) throw new SignError(`The vault refused to sign: ${result.structuredContent?.code ?? 'refused'}.`, 3);
  const hex = result.structuredContent?.signature;
  if (typeof hex !== 'string' || !/^[0-9a-f]{128}$/.test(hex)) throw new SignError('The vault answered no Ed25519 signature.', 3);
  return { name: KEY_NAME, signature_base64: Buffer.from(hex, 'hex').toString('base64') };
}

async function main() {
  const payload = await new Promise((done, failed) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', failed);
  });
  const answer = await signRecordText({ payload, door: readDoor() });
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.status ?? 1;
  });
}

