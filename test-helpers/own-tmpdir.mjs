// Preloaded into every test process (`node --import ./test-helpers/own-tmpdir.mjs --test ...`, package.json "test"): the process gets
// a temp folder of its own and removes it when it exits, so a test that makes a temp folder and never removes it leaves nothing behind.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const own = mkdtempSync(join(realpathSync(tmpdir()), 'own-tmpdir-'));
process.env.TMPDIR = own;
process.on('exit', () => rmSync(own, { recursive: true, force: true }));
