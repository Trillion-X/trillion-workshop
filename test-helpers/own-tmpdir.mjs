// Preloaded into every test process (`node --import ./test-helpers/own-tmpdir.mjs --test ...`, package.json "test"): the process gets
// a temp folder of its own and removes it when it exits, so a test that makes a temp folder and never removes it leaves nothing behind.
// It also registers the one resolve hook that answers `trillion-workshop/...` from files whose own package.json hides the root's
// (test-helpers/workshop-self-resolve.mjs), so the lock file needs no link to the Workshop itself.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './workshop-self-resolve.mjs';

const own = mkdtempSync(join(realpathSync(tmpdir()), 'own-tmpdir-'));
process.env.TMPDIR = own;
process.on('exit', () => rmSync(own, { recursive: true, force: true }));
