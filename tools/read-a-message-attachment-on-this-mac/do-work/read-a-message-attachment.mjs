#!/usr/bin/env node
// do-work/read-a-message-attachment.mjs
//
// Run on the person's Mac by its computer program: the request JSON comes on stdin, and argv[2] is the home folder the
// person granted for reading. Prints one JSON answer. It reads only the one attachment the request names.
import { readAttachment } from '../read-data/attachment-read.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString('utf8');
let input = {};
try {
  input = text.trim() ? JSON.parse(text) : {};
} catch {
  input = null;
}
const answer = await readAttachment(input, { home: process.argv[2] });
process.stdout.write(`${JSON.stringify(answer)}\n`);
