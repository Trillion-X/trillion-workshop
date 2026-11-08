#!/usr/bin/env node
// The public command owns direct execution; the implementation remains importable and source-first.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import settings from './trillion.json' with { type: 'json' };
import { main, TrillionError } from './shell-program.mjs';
export * from './shell-program.mjs';

const command = basename(settings.install.link);
const startedAsProgram = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (startedAsProgram) {
  main(process.argv.slice(2)).then(text => { if (text) process.stdout.write(`${text}\n`); }, error => {
    process.stderr.write(`${error instanceof TrillionError ? error.message : `${command}: ${error.stack ?? error}`}\n`);
    process.exitCode = error instanceof TrillionError ? error.status : 1;
  });
}
