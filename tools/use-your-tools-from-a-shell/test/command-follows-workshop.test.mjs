// tools/use-your-tools-from-a-shell/test/command-follows-workshop.test.mjs
//
// The installed `example` runs the Workshop copy the engine keeps current (command.json install.follow), so a Workshop update
// reaches every computer's command with no `example setup`: ~/.example/cli/program fell behind Workshop main (no --request-key)
// on 2026-11-13 because only `setup` copied the program. A copy run from anywhere else runs itself.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { workshopProgram, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const DO_WORK = fileURLToPath(new URL('../do-work/', import.meta.url));
const STUB = "export class CommandError extends Error {}\nexport const main = async argv => `FOLLOWED ${argv.join(' ')}`;\n";

/** A fake computer: the installed command folder (a copy of this program), and optionally an engine config whose persons
 *  folder holds one person (or `people` of them) whose current Workshop install holds `stub`. */
function computer({ stub = STUB, people = 1 } = {}) {
  const home = tempFolder(join(tmpdir(), 'example-follow-'));
  const installed = join(home, '.example/cli/program');
  mkdirSync(join(home, '.example/cli'), { recursive: true });
  cpSync(DO_WORK, installed, { recursive: true });
  if (stub !== null) {
    const persons = join(home, 'Library/Application Support/Example/computer/persons');
    for (let one = 0; one < people; one += 1) {
      const state = join(persons, `person-${one}`);
      const program = join(state, 'workshop-installs/abc123/tools/use-your-tools-from-a-shell/do-work');
      mkdirSync(program, { recursive: true });
      writeFileSync(join(program, 'command.mjs'), stub);
      writeFileSync(join(state, 'workshop-installs/state.json'), JSON.stringify({ current: 'abc123' }));
    }
    // The engine's own computer config names the persons folder, as the Mac app's engine writes it.
    writeFileSync(join(home, 'Library/Application Support/Example/computer/computer.json'), JSON.stringify({ persons }));
  }
  return { home, installed };
}
// The command is run as a person runs it: by the link named after it (the name is the site's command, here a made-up one).
const runInstalled = ({ home, installed }, ...argv) => {
  const link = join(home, '.local/bin/example');
  if (!existsSync(link)) { mkdirSync(join(home, '.local/bin'), { recursive: true }); symlinkSync(join(installed, 'command.mjs'), link); }
  return spawnSync(process.execPath, [link, ...argv], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
};

test('the installed command runs the Workshop copy the engine has installed', () => {
  const machine = computer();
  const run = runInstalled(machine, 'whatever', '--flag');
  assert.equal(run.stdout.trim(), 'FOLLOWED whatever --flag', run.stderr);
});

test('with no Workshop copy found the installed command runs itself', () => {
  const machine = computer({ stub: null });
  const run = runInstalled(machine, 'help');
  assert.match(run.stdout, /example setup/);
  assert.doesNotMatch(run.stdout, /FOLLOWED/);
});

test('a Workshop copy that cannot be loaded leaves the installed one to run', () => {
  const machine = computer({ stub: 'this is not javascript (' });
  const run = runInstalled(machine, 'help');
  assert.match(run.stdout, /example setup/);
});

test('a copy run from anywhere but the install folder never follows', () => {
  const machine = computer();
  assert.equal(workshopProgram({ home: machine.home, here: DO_WORK }), null);
  const real = workshopProgram({ home: machine.home, here: join(machine.home, '.example/cli/program'), self: join(machine.home, 'elsewhere.mjs') });
  assert.match(real, /workshop-installs\/abc123\/tools\/use-your-tools-from-a-shell\/do-work\/command\.mjs$/);
});

test('with two people on the computer the installed command runs itself rather than guess whose copy', () => {
  const machine = computer({ people: 2 });
  const run = runInstalled(machine, 'help');
  assert.doesNotMatch(run.stdout, /FOLLOWED/);
});
