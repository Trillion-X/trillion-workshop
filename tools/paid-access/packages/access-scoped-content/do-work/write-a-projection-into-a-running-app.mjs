#!/usr/bin/env node
// packages/access-scoped-content/do-work/write-a-projection-into-a-running-app.mjs
//
// PURPOSE
// Turn one projection record set into the label-addressed write request the
// running-app writer already accepts. A record set authored beside a package set
// only reaches an installed app through that writer, and hand-assembling the
// request is where a wrong address or a dropped payload gets introduced.
//
// This prints the request. Sending it belongs to the writer that owns that
// effect, and naming the app belongs to whoever runs it.

import { readFileSync, writeFileSync } from 'node:fs';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} requires one value`);
  }
  return value.trim();
}

const recordSetFile = argumentValue('--record-set');
const outputFile = argumentValue('--output');

const parsed = JSON.parse(readFileSync(recordSetFile, 'utf8'));
const records = Array.isArray(parsed) ? parsed : parsed.records;
if (!Array.isArray(records) || records.length === 0) throw new Error('the record set holds no records');

const writes = records.map((record, index) => {
  const address = typeof record?.address === 'string' ? record.address.trim() : '';
  if (!address) throw new Error(`records[${index}] names no address`);
  if (!Object.hasOwn(record, 'payload')) throw new Error(`records[${index}] carries no payload`);
  return {
    address_label: address,
    ...(typeof record.address_mode === 'string' ? { address_mode: record.address_mode } : {}),
    payload: record.payload,
  };
});

writeFileSync(outputFile, `${JSON.stringify({
  operation_label: 'engine.operation.write-batch',
  writes,
}, null, 2)}\n`);

const rowCount = writes.reduce(
  (total, write) => total + (Array.isArray(write.payload) ? write.payload.length : 1),
  0,
);
process.stdout.write(`${writes.length} addresses, ${rowCount} rows, written to ${outputFile}\n`);
