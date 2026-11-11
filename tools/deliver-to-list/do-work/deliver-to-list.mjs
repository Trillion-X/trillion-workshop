#!/usr/bin/env node
// tools/deliver-to-list/do-work/deliver-to-list.mjs
//
// The sink a sign-up's code is delivered through when no mail tool is connected yet: the message is written as one row
// of a list in the sending account's own records, through the person's own door. The engine sends the input as one JSON
// object on standard input and reads one JSON answer from standard output, in the shape its delivery reads (`sent[0]`):
//
//   echo '{"config":"door.json","row_type":"sign-in-code","to":"a@example.com","subject":"Your code","text":"123456",
//          "kind":"sign-in-code","idempotencyKey":"k1"}' | node do-work/deliver-to-list.mjs
//
// The row's id is the idempotency key, so a send again with the same key writes the same row. A refusal answers
// { sent: [{ error }] } with unknown false; a write that may have happened answers { sent: [{ unknown: true }], unknown: true }.
// Exit 0 when the row is written, 2 otherwise.
import { readFile } from 'node:fs/promises';
import { openDoor } from '../../read-a-list-view/read-data/door.mjs';

const FIELDS = ['row_type', 'to', 'subject', 'text', 'kind', 'idempotencyKey'];

/** The row a send writes: its id is the idempotency key, its type is the list's row type, its value is the message. */
export function rowFor(input, at) {
  for (const field of FIELDS) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`${field} is required`);
  }
  return { id: input.idempotencyKey, type: `record:${input.row_type}`, value: { to: input.to, subject: input.subject, text: input.text, kind: input.kind, at } };
}

/** The answer the engine reads: the message id when written, the refusal's words otherwise. */
export function answerFor(outcome) {
  if (outcome.written) return { sent: [{ messageId: outcome.id }] };
  if (outcome.unknown) return { sent: [{ unknown: true }], unknown: true };
  return { sent: [{ error: outcome.error }], unknown: false };
}

async function main() {
  const input = JSON.parse(await readStdin());
  if (typeof input.config !== 'string' || !input.config) throw new Error('config is required: the person\'s door config file');
  const row = rowFor(input, new Date().toISOString());
  const door = await openDoor(JSON.parse(await readFile(input.config, 'utf8')));
  let refused;
  try {
    refused = await door.write([row], { key: input.idempotencyKey });
  } catch (error) {
    return finish({ written: false, unknown: true }, 2);
  }
  if (refused.length) return finish({ written: false, error: 'The records door refused the row.' }, 2);
  return finish({ written: true, id: row.id }, 0);
}

function finish(outcome, code) {
  process.stdout.write(`${JSON.stringify(answerFor(outcome))}\n`);
  process.exitCode = code;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stdout.write(`${JSON.stringify(answerFor({ written: false, error: error.message }))}\n`);
    process.exitCode = 2;
  });
}
