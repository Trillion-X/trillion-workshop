#!/usr/bin/env node
// A stand-in for the `trillion` command: answers `op @own-records records:read` and `records:list` from the JSON file
// STAND_IN_RECORDS names ({ records: [{ id, type, value }] }), so a test never reaches a real account.
import { readFileSync } from 'node:fs';

const [, , , , method, body] = process.argv;
const { records } = JSON.parse(readFileSync(process.env.STAND_IN_RECORDS, 'utf8'));
const input = JSON.parse(body);
if (method === 'records:read') {
  const found = records.find(record => record.id === input.id && record.type === input.type);
  console.log(JSON.stringify(found ?? { id: input.id, type: input.type, value: null }));
} else if (method === 'records:list') {
  const all = records.filter(record => record.type === input.type && record.id.startsWith(input.prefix ?? ''));
  console.log(JSON.stringify({ records: all, next: null }));
} else {
  console.error(`stand-in: ${method} is not served`);
  process.exit(2);
}
