// tools/use-trillion-from-a-shell/test/trillion-follows-workshop.test.mjs
//
// The installed `trillion` runs the Workshop copy the engine keeps current (trillion.json install.follow), so a Workshop update
// reaches every computer's command with no `trillion setup`: ~/.trillion/cli/program fell behind Workshop main (no --request-key)
// on 2026-11-13 because only `setup` copied the program. A copy run from anywhere else runs itself.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { workshopProgram } from '../do-work/trillion.mjs';

const DO_WORK = fileURLToPath(new URL('../do-work/', import.meta.url));
const STUB = "export class TrillionError extends Error {}\nexport const main = async argv => `FOLLOWED ${argv.join(' ')}`;\n";

/** A fake computer: the installed command folder (a copy of this program), and optionally an engine state folder whose current Workshop install holds `stub`. */
function computer({ stub = STUB } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'trillion-follow-'));
  const installed = join(home, '.trillion/cli/program');
  mkdirSync(join(home, '.trillion/cli'), { recursive: true });
  cpSync(DO_WORK, installed, { recursive: true });
  if (stub !== null) {
    const state = join(home, 'state');
    const program = join(state, 'workshop-installs/abc123/tools/use-trillion-from-a-shell/do-work');
    mkdirSync(program, { recursive: true });
    writeFileSync(join(program, 'trillion.mjs'), stub);
    writeFileSync(join(state, 'workshop-installs/state.json'), JSON.stringify({ current: 'abc123' }));
    mkdirSync(join(home, 'Library/Application Support/Trillion'), { recursive: true });
    writeFileSync(join(home, 'Library/Application Support/Trillion/local-runtime.json'), JSON.stringify({ state }));
  }
  return { home, installed };
}
const runInstalled = ({ home, installed }, ...argv) => spawnSync(process.execPath, [join(installed, 'trillion.mjs'), ...argv], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });

test('the installed command runs the Workshop copy the engine has installed', () => {
  const machine = computer();
  const run = runInstalled(machine, 'whatever', '--flag');
  assert.equal(run.stdout.trim(), 'FOLLOWED whatever --flag', run.stderr);
});

test('with no Workshop copy found the installed command runs itself', () => {
  const machine = computer({ stub: null });
  const run = runInstalled(machine, 'help');
  assert.match(run.stdout, /trillion setup/);
  assert.doesNotMatch(run.stdout, /FOLLOWED/);
});

test('a Workshop copy that cannot be loaded leaves the installed one to run', () => {
  const machine = computer({ stub: 'this is not javascript (' });
  const run = runInstalled(machine, 'help');
  assert.match(run.stdout, /trillion setup/);
});

test('a copy run from anywhere but the install folder never follows', () => {
  const machine = computer();
  assert.equal(workshopProgram({ home: machine.home, here: DO_WORK }), null);
  const real = workshopProgram({ home: machine.home, here: join(machine.home, '.trillion/cli/program'), self: join(machine.home, 'elsewhere.mjs') });
  assert.match(real, /workshop-installs\/abc123\/tools\/use-trillion-from-a-shell\/do-work\/trillion\.mjs$/);
});
