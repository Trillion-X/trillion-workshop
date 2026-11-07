#!/usr/bin/env node
// A stand-in for the native engine's `held-values` command, for the reader's tests: it answers
// `names` from the holders below and writes a `read` value only to descriptor 3, refusing when
// descriptor 3 is not a pipe (a FIFO or the socket pair Node.js hands a child), as the engine does. Every operation asked is appended to the file
// named by STAND_IN_VAULT_ASKED, so a test can prove which operations ran.
import { appendFileSync, fstatSync, writeSync } from 'node:fs';

const held = { 'service-a': '{"key-id":"public","application-key":"private"}', 'bare-token': 'private' };
const [word, store, account, operation, name] = process.argv.slice(2);
if (process.env.STAND_IN_VAULT_ASKED) appendFileSync(process.env.STAND_IN_VAULT_ASKED, `${word} ${store} ${account} ${operation}${name ? ` ${name}` : ''}\n`);

if (operation === 'names-only') {
  for (const one of Object.keys(held).sort()) process.stdout.write(`${JSON.stringify({ name: one })}\n`);
} else if (operation === 'names' || operation === 'describe') {
  if (operation === 'describe' && !(name in held)) {
    process.stderr.write(`no value is held under ${name}\n`);
    process.exit(1);
  }
  for (const one of operation === 'describe' ? [name] : Object.keys(held).sort()) {
    let shape = 'bare';
    try {
      const value = JSON.parse(held[one]);
      if (value && typeof value === 'object') shape = { fields: Object.keys(value) };
    } catch {}
    process.stdout.write(`${JSON.stringify({ name: one, held: shape })}\n`);
  }
} else if (operation === 'read') {
  if (!(name in held)) {
    process.stderr.write(`no value is held under ${name}\n`);
    process.exit(1);
  }
  const pipe = fstatSync(3);
  if (!pipe.isFIFO() && !pipe.isSocket()) {
    process.stderr.write('descriptor 3 is not a pipe\n');
    process.exit(1);
  }
  writeSync(3, held[name]);
} else {
  process.stderr.write('usage\n');
  process.exit(1);
}
