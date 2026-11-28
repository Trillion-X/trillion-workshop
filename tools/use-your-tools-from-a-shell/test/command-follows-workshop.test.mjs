// tools/use-your-tools-from-a-shell/test/command-follows-workshop.test.mjs
//
// The installed `example` runs the Workshop copy the engine reads where it stands (command.json install.follow), so a Workshop update
// reaches every computer's command with no `example setup`: ~/.example/cli/program fell behind Workshop main (no --request-key)
// on 2026-11-13 because only `setup` copied the program. A copy run from anywhere else runs itself.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
 *  folder holds one person (or `people` of them), each with their own place file naming a Workshop folder that holds `stub`.
 *  The shipped seed lists no Workshop, so the product settings list `launcher` (empty by default). */
function computer({ stub = STUB, people = 1, launcher = [] } = {}) {
  const home = tempFolder(join(tmpdir(), 'example-follow-'));
  const installed = join(home, '.example/cli/program');
  mkdirSync(join(home, '.example/cli'), { recursive: true });
  cpSync(DO_WORK, installed, { recursive: true });
  if (stub !== null) {
    const folder = join(home, 'Library/Application Support/Example/computer');
    const persons = join(folder, 'persons');
    for (let one = 0; one < people; one += 1) {
      const person = join(persons, `person-${one}`);
      const checkout = join(person, 'checkout');
      const program = join(checkout, 'tools/use-your-tools-from-a-shell/do-work');
      mkdirSync(program, { recursive: true });
      writeFileSync(join(program, 'command.mjs'), stub);
      // The decoy: an install an earlier engine kept, whose copy would answer differently. It is never read.
      const old = join(person, 'workshop-installs/abc123/tools/use-your-tools-from-a-shell/do-work');
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, 'command.mjs'), "export class CommandError extends Error {}\nexport const main = async () => 'STALE INSTALL';\n");
      writeFileSync(join(person, 'workshop-installs/state.json'), JSON.stringify({ current: 'abc123' }));
      placeFile(person, 'workshop.json', { label: 'workshop', place: { at: checkout } });
    }
    // The engine's own computer config names the persons folder and the product settings, as the Mac app's engine writes it.
    const productSettings = join(folder, 'product-settings.json');
    writeFileSync(productSettings, JSON.stringify({ tool_sources: launcher }));
    writeFileSync(join(folder, 'computer.json'), JSON.stringify({ persons, product_settings: productSettings }));
  }
  return { home, installed };
}
/** One of a person's own places, as the engine's `tools:place` keeps it: `<person folder>/tool-places/<file>`. */
function placeFile(person, file, entry) {
  mkdirSync(join(person, 'tool-places'), { recursive: true });
  writeFileSync(join(person, 'tool-places', file), JSON.stringify(entry));
}
const personOf = machine => join(machine.home, 'Library/Application Support/Example/computer/persons/person-0');
const settingsOf = machine => join(machine.home, 'Library/Application Support/Example/computer/product-settings.json');
const follow = machine => workshopProgram({ home: machine.home, here: join(machine.home, '.example/cli/program'), self: join(machine.home, 'other.mjs') });
// The command is run as a person runs it: by the link named after it (the name is the site's command, here a made-up one).
const runInstalled = ({ home, installed }, ...argv) => {
  const link = join(home, '.local/bin/example');
  if (!existsSync(link)) { mkdirSync(join(home, '.local/bin'), { recursive: true }); symlinkSync(join(installed, 'command.mjs'), link); }
  return spawnSync(process.execPath, [link, ...argv], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
};

test('with an empty seed, the installed command runs the Workshop an account place file names, never a stale install', () => {
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
  assert.match(real, /person-0\/checkout\/tools\/use-your-tools-from-a-shell\/do-work\/command\.mjs$/);
});

test('a place by home or by an absolute folder is followed, whether the launcher lists it or the account keeps it', () => {
  for (const named of [home => ({ home: 'checkout' }), home => ({ at: join(home, 'elsewhere') })]) {
    for (const keptBy of ['launcher', 'account']) {
      const machine = computer();
      const place = named(machine.home);
      const folder = place.at ?? join(machine.home, place.home);
      mkdirSync(join(folder, 'tools/use-your-tools-from-a-shell/do-work'), { recursive: true });
      writeFileSync(join(folder, 'tools/use-your-tools-from-a-shell/do-work/command.mjs'), STUB);
      rmSync(join(personOf(machine), 'tool-places/workshop.json'));
      if (keptBy === 'launcher') writeFileSync(settingsOf(machine), JSON.stringify({ tool_sources: [{ label: 'workshop', place }] }));
      else placeFile(personOf(machine), 'workshop.json', { label: 'workshop', place });
      assert.equal(follow(machine), join(realpathSync(folder), 'tools/use-your-tools-from-a-shell/do-work/command.mjs'), keptBy);
    }
  }
});

test('a file whose name starts with a dot is never read, and labels are read in order', () => {
  const machine = computer();
  const person = personOf(machine);
  rmSync(join(person, 'tool-places/workshop.json'));
  placeFile(person, '.workshop.json', { label: '.workshop', place: { at: join(person, 'checkout') } });
  assert.equal(follow(machine), null);
  const first = join(machine.home, 'first');
  mkdirSync(join(first, 'tools/use-your-tools-from-a-shell/do-work'), { recursive: true });
  writeFileSync(join(first, 'tools/use-your-tools-from-a-shell/do-work/command.mjs'), STUB);
  placeFile(person, 'z-late.json', { label: 'z-late', place: { at: join(person, 'checkout') } });
  placeFile(person, 'a-first.json', { label: 'a-first', place: { at: first } });
  assert.equal(follow(machine), join(realpathSync(first), 'tools/use-your-tools-from-a-shell/do-work/command.mjs'));
});

test('a place that climbs out or names two ways is never followed', () => {
  const machine = computer();
  const person = personOf(machine);
  rmSync(join(person, 'tool-places/workshop.json'));
  const checkout = join(person, 'checkout');
  for (const entry of [{ place: { state: '../x' } }, { place: { home: 'a', at: checkout } }, { place: { home: '/etc' } }, { place: { at: 'relative' } }, { place: {} },
    { place: { at: checkout }, packages: '../checkout/tools' }, { place: { at: checkout }, packages: 'nothing-here' }]) {
    placeFile(person, 'workshop.json', { label: 'workshop', ...entry });
    assert.equal(follow(machine), null, JSON.stringify(entry));
  }
});

test('a place whose packages link leads out of it is never followed', () => {
  const machine = computer();
  const person = personOf(machine);
  const outside = join(machine.home, 'outside');
  mkdirSync(join(outside, 'tools/use-your-tools-from-a-shell/do-work'), { recursive: true });
  writeFileSync(join(outside, 'tools/use-your-tools-from-a-shell/do-work/command.mjs'), STUB);
  const inner = join(machine.home, 'inner');
  mkdirSync(inner);
  symlinkSync(join(outside, 'tools'), join(inner, 'tools'));
  placeFile(person, 'workshop.json', { label: 'workshop', place: { at: inner } });
  assert.equal(follow(machine), null);
});

test('with two people on the computer the installed command runs itself rather than guess whose copy', () => {
  const machine = computer({ people: 2 });
  const run = runInstalled(machine, 'help');
  assert.doesNotMatch(run.stdout, /FOLLOWED/);
});
