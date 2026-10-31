#!/usr/bin/env node
// tools/pin-files-by-content/do-work/pin-files.mjs
//
// The command line of pin-files-by-content:
//
//   node do-work/pin-files.mjs (check | write) --root DIR --pin-file PATH --folder PATH [--match GLOB] [--unpinned-ok PATH ...] [--shape FILE]
//
// PATH values are under DIR. Prints { ok, pinned, added, changed, gone, unchanged, written } as JSON. Exit 0 when the
// pins match the files (check) or were brought up to them (write), 1 when check found a difference, 2 with the reason on
// standard error when a path or the pin file could not be read.
import { readFile } from 'node:fs/promises';
import { pinFiles } from '../read-data/pins.mjs';

const [command, ...rest] = process.argv.slice(2);
const flags = { 'unpinned-ok': [] };
for (let index = 0; index < rest.length; index += 2) {
  const name = rest[index].replace(/^--/, '');
  if (name === 'unpinned-ok') flags[name].push(rest[index + 1]);
  else flags[name] = rest[index + 1];
}

try {
  if (command !== 'check' && command !== 'write') throw new Error('usage: pin-files.mjs (check | write) --root DIR --pin-file PATH --folder PATH (see the top of this file)');
  const shape = flags.shape ? (held => held.shape ?? held)(JSON.parse(await readFile(flags.shape, 'utf8'))) : {};
  const answer = await pinFiles({ root: flags.root, pin_file: flags['pin-file'], folder: flags.folder, match: flags.match,
    unpinned_ok: flags['unpinned-ok'], shape, write: command === 'write' });
  console.log(JSON.stringify(answer));
  process.exitCode = command === 'check' && !answer.ok ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
