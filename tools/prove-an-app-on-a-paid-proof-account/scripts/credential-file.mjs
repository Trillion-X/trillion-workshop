// A credential kept in its file under ~/.bitfield/credentials/<name> and read into memory only: never argv, logs or other
// files, and never the login keychain. The file must be the owner's alone (mode 600).
//   const key = readCredentialFile('trillion-marketplace-publisher-key');
//   writeCredentialFile('trillion-customer-proof:<account id>', key);   forgetCredentialFile('trillion-customer-proof:<account id>');
// `dir` is for a test's temporary folder; production callers leave it out.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const folder = dir => dir ?? join(homedir(), '.bitfield', 'credentials');
function fileFor(name, dir) {
  if (!/^[a-z0-9:_-]+$/i.test(name)) throw new Error('A credential is named by its file name only.');
  return join(folder(dir), name);
}

export function readCredentialFile(name, { dir } = {}) {
  const file = fileFor(name, dir);
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`Refusing ${name}: its file is readable by others (mode ${mode.toString(8)}); it must be 600.`);
  const key = readFileSync(file, 'utf8').trim();
  if (!key) throw new Error(`The credential file for ${name} is empty.`);
  return key;
}

/** Replaces one credential atomically with a mode-600 file; existing links and readers never receive its new value. */
export function writeCredentialFile(name, value, { dir } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`The credential for ${name} is empty.`);
  const file = fileFor(name, dir);
  mkdirSync(folder(dir), { recursive: true, mode: 0o700 });
  const temporary = join(folder(dir), `.credential-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${value.trim()}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

/** Removes one credential's file; a file that is already gone is done. */
export function forgetCredentialFile(name, { dir } = {}) {
  try { unlinkSync(fileFor(name, dir)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
