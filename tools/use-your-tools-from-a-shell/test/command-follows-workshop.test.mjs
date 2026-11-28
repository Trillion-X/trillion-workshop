// tools/use-your-tools-from-a-shell/test/command-follows-workshop.test.mjs
//
// The installed `example` runs the Workshop copy the engine reads where it stands (command.json install.follow), so a Workshop update
// reaches every computer's command with no `example setup`: ~/.example/cli/program fell behind Workshop main (no --request-key)
// on 2026-11-13 because only `setup` copied the program. A copy run from anywhere else runs itself.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
 *  folder holds one person (or `people` of them) whose Workshop place holds `stub`, as its product settings name it. */
function computer({ stub = STUB, people = 1, place = { state: 'workshop' } } = {}) {
  const home = tempFolder(join(tmpdir(), 'example-follow-'));
  const installed = join(home, '.example/cli/program');
  mkdirSync(join(home, '.example/cli'), { recursive: true });
  cpSync(DO_WORK, installed, { recursive: true });
  if (stub !== null) {
    const folder = join(home, 'Library/Application Support/Example/computer');
    const persons = join(folder, 'persons');
    for (let one = 0; one < people; one += 1) {
      const program = join(persons, `person-${one}`, 'workshop/tools/use-your-tools-from-a-shell/do-work');
      mkdirSync(program, { recursive: true });
      writeFileSync(join(program, 'command.mjs'), stub);
      // The decoy: an install an earlier engine kept, whose copy would answer differently. It is never read.
      const old = join(persons, `person-${one}`, 'workshop-installs/abc123/tools/use-your-tools-from-a-shell/do-work');
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, 'command.mjs'), "export class CommandError extends Error {}\nexport const main = async () => 'STALE INSTALL';\n");
      writeFileSync(join(persons, `person-${one}`, 'workshop-installs/state.json'), JSON.stringify({ current: 'abc123' }));
    }
    // The engine's own computer config names the persons folder and the product settings, as the Mac app's engine writes it.
    const productSettings = join(folder, 'product-settings.json');
    writeFileSync(productSettings, JSON.stringify({ tool_sources: [{ label: 'workshop', place }] }));
    writeFileSync(join(folder, 'computer.json'), JSON.stringify({ persons, product_settings: productSettings }));
  }
  return { home, installed };
}
// The command is run as a person runs it: by the link named after it (the name is the site's command, here a made-up one).
const runInstalled = ({ home, installed }, ...argv) => {
  const link = join(home, '.local/bin/example');
  if (!existsSync(link)) { mkdirSync(join(home, '.local/bin'), { recursive: true }); symlinkSync(join(installed, 'command.mjs'), link); }
  return spawnSync(process.execPath, [link, ...argv], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
};

test('the installed command runs the Workshop copy the engine reads where it stands, never a stale install', () => {
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
  assert.match(real, /person-0\/workshop\/tools\/use-your-tools-from-a-shell\/do-work\/command\.mjs$/);
});

test('a place the product settings name by home or by an absolute folder is followed too', () => {
  for (const named of [home => ({ home: 'checkout' }), home => ({ at: join(home, 'elsewhere') })]) {
    const machine = computer();
    const place = named(machine.home);
    const folder = place.at ?? join(machine.home, place.home);
    mkdirSync(join(folder, 'tools/use-your-tools-from-a-shell/do-work'), { recursive: true });
    writeFileSync(join(folder, 'tools/use-your-tools-from-a-shell/do-work/command.mjs'), STUB);
    writeFileSync(join(machine.home, 'Library/Application Support/Example/computer/product-settings.json'), JSON.stringify({ tool_sources: [{ label: 'workshop', place }] }));
    const followed = workshopProgram({ home: machine.home, here: join(machine.home, '.example/cli/program'), self: join(machine.home, 'other.mjs') });
    assert.equal(followed, join(realpathSync(folder), 'tools/use-your-tools-from-a-shell/do-work/command.mjs'));
  }
});

test('a place that climbs out or names two ways is never followed', () => {
  const machine = computer();
  const settings = join(machine.home, 'Library/Application Support/Example/computer/product-settings.json');
  for (const place of [{ state: '../x' }, { state: 'workshop', at: '/tmp' }, { home: '/etc' }, { at: 'relative' }, {}]) {
    writeFileSync(settings, JSON.stringify({ tool_sources: [{ label: 'workshop', place }] }));
    assert.equal(workshopProgram({ home: machine.home, here: join(machine.home, '.example/cli/program'), self: join(machine.home, 'other.mjs') }), null, JSON.stringify(place));
  }
});

test('with two people on the computer the installed command runs itself rather than guess whose copy', () => {
  const machine = computer({ people: 2 });
  const run = runInstalled(machine, 'help');
  assert.doesNotMatch(run.stdout, /FOLLOWED/);
});
