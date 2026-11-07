#!/usr/bin/env node
// A stand-in for the native engine's `held-values` command, for the reader's tests: it answers
// `names` from the holders below and writes a `read` value only to descriptor 3, refusing when
// descriptor 3 is not a pipe (a FIFO or the socket pair Node.js hands a child), as the engine does. Every operation asked is appended to the file
// named by STAND_IN_VAULT_ASKED, so a test can prove which operations ran.
import { appendFileSync, fstatSync, readFileSync, writeSync } from 'node:fs';

const held = { 'service-a': '{"key-id":"public","application-key":"private"}', 'bare-token': 'private' };
const [word, store, account, operation, name] = process.argv.slice(2);
if (word === 'secrets' && store === 'where') {
  if (process.env.STAND_IN_VAULT_ASKED) appendFileSync(process.env.STAND_IN_VAULT_ASKED, 'secrets where\n');
  if (process.env.STAND_IN_VAULT_WHERE_REFUSED) process.exit(1);
  process.stdout.write(process.env.STAND_IN_VAULT_WHERE ?? '{}');
  process.exit(0);
}
if (process.env.STAND_IN_VAULT_SETTINGS && process.env.FIXTURE_PRODUCT_SETTINGS !== process.env.STAND_IN_VAULT_SETTINGS) {
  process.stderr.write('the resolved settings binding was not passed\n');
  process.exit(1);
}
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
} else if (operation === 'put') {
  readFileSync(process.argv[7]);
  process.stdout.write(JSON.stringify({ saved: name }));
} else {
  process.stderr.write('usage\n');
  process.exit(1);
}
