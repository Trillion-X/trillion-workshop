// tools/start-a-computer/test/keep-recent-builds.test.mjs
//
// A unit built from source keeps the builds its links run and the newest few; the older ones are a difference the apply removes
// before it builds the next, with the logs beside them. The listing runs through a real shell on a made-up builds folder; the
// apply is answered by a made-up computer.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyWhatItRuns, runsDifferences } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';
import { dropSurplusBuilds, keepOf, surplusBuilds } from '../do-work/keep-recent-builds.mjs';

const SCRIPT = fileURLToPath(new URL('../do-work/keep-recent-builds.sh', import.meta.url));
const commitOf = number => String(number).padStart(2, '0').repeat(20);
const listed = (builds, keep) => execFileSync('sh', ['-s', '--', builds, String(keep)], { input: readFileSync(SCRIPT), encoding: 'utf8' }).split('\n').filter(Boolean);

// Ten builds, the number naming its age (10 is the newest). `current-a` runs the oldest, `current-b` the sixth.
const madeUpBuilds = () => {
  const builds = tempFolder(join(tmpdir(), 'keep-builds-'));
  for (let number = 1; number <= 10; number++) {
    mkdirSync(join(builds, commitOf(number)));
    writeFileSync(join(builds, `build-${commitOf(number)}.log`), '');
    utimesSync(join(builds, commitOf(number)), 1_700_000_000 + number * 100, 1_700_000_000 + number * 100);
  }
  symlinkSync(commitOf(1), join(builds, 'current-a'));
  symlinkSync(commitOf(6), join(builds, 'current-b'));
  return builds;
};

test('the builds beyond the newest KEEP are listed, except the ones a current link runs', () => {
  const builds = madeUpBuilds();
  assert.deepEqual(listed(builds, 3).sort(), [2, 3, 4, 5, 7].map(commitOf).sort(), 'the newest three (8, 9, 10) and the two builds a link runs (1, 6) stay');
});

test('a name that is not a commit, a link named like one and a missing folder are never listed', () => {
  const builds = madeUpBuilds();
  mkdirSync(join(builds, 'repository'));
  mkdirSync(join(builds, 'npm-cache'));
  mkdirSync(join(builds, `source-${commitOf(2)}`));
  symlinkSync(commitOf(3), join(builds, 'f'.repeat(40)));
  assert.deepEqual(listed(builds, 3).sort(), [2, 3, 4, 5, 7].map(commitOf).sort());
  assert.deepEqual(listed(join(builds, 'absent'), 3), []);
  assert.deepEqual(listed(builds, 50), [], 'a folder with fewer builds than it keeps loses none');
});

test('a KEEP that is not a whole number is refused', () => {
  assert.throws(() => listed(madeUpBuilds(), 'five'), /KEEP must be a whole number/);
});

test('a unit keeps its own keep_builds, else the settings number, and refuses less than one', () => {
  assert.equal(keepOf({ unit: 'a.service', keep_builds: 2 }, 5), 2);
  assert.equal(keepOf({ unit: 'a.service' }, 5), 5);
  assert.throws(() => keepOf({ unit: 'a.service', keep_builds: 0 }, 5), /keep_builds must be a whole number of at least 1/);
  assert.throws(() => keepOf({ unit: 'a.service', keep_builds: '3' }, 5), /keep_builds/);
});

const COMMIT = 'c'.repeat(40);
const runs = {
  health_listen: '127.0.0.1:7199',
  units: [{
    unit: 'example-place.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', description: 'Example place', user: 'example-place',
    state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine',
    settings_file: '/etc/example-place/computer.json', settings: { listen: '127.0.0.1:7199' }, writable: '/var/lib/example-place',
    drop_ins: ['tools/start-a-computer/read-data/unit-templates/nofile.conf'],
    source: { repository: 'https://git.example.test/example-engine.git', commit: COMMIT, build: ['cargo', 'build', '--release'], output: '{builds}/target/release/example-engine', environment: ['HOME={state}'] },
  }],
  unmanaged: [],
};
const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const old = [1, 2, 3].map(commitOf);

// A computer that runs its row as rendered, whose builds folder holds `old` beyond what it keeps.
const computerWith = leftOver => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('sh -s -- ')) return leftOver.map(commit => `${commit}\n`).join('');
    if (command.startsWith('readlink ')) return COMMIT;
    if (command.startsWith('pid=$(systemctl show')) return '';
    if (command.includes('sha256sum')) return '';
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.startsWith('ufw status')) return 'Status: active\n\nTo Action From\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
    if (command.startsWith('getent') || command.startsWith('test -') || command.startsWith('if [ -d ')) return '';
    return command.includes('curl') ? '200' : '';
  };
  return { run, commands };
};

test('builds beyond what a unit keeps are a difference, and the apply removes them with their logs', async () => {
  const { run, commands } = computerWith(old);
  assert.deepEqual(await runsDifferences(machine, runs, run), old.map(commit => ({
    path: `/var/lib/example-place/builds/${commit}`, reason: 'a build beyond the newest 5 its unit keeps, and no link runs it',
  })));
  const answer = await applyWhatItRuns(machine, runs, run);
  assert.deepEqual(answer.builds_removed, old.map(commit => `/var/lib/example-place/builds/${commit}`));
  assert.deepEqual(answer.restarted, [], 'removing old builds restarts nothing');
  const removal = commands.find(({ command }) => command.includes('rm -rf --'));
  assert.match(removal.command, /^cd '\/var\/lib\/example-place\/builds' && while IFS= read -r commit; do rm -rf -- "\$commit" "build-\$commit\.log" "build-\$commit\.memory-events" "source-\$commit"; done$/);
  assert.equal(removal.input, `${old.join('\n')}\n`);
  const asked = commands.find(({ command }) => command.startsWith('sh -s -- '));
  assert.equal(asked.command, "sh -s -- '/var/lib/example-place/builds' 5");
});

test('a computer with no builds beyond the ones it keeps removes nothing and answers as it did', async () => {
  const { run, commands } = computerWith([]);
  assert.deepEqual(await runsDifferences(machine, runs, run), []);
  assert.deepEqual(await applyWhatItRuns(machine, runs, run), { written: [], restarted: [] });
  assert.equal(commands.some(({ command }) => command.includes('rm -rf --')), false);
});

test('a unit\'s own keep_builds is what the listing is asked for, and slots that share a folder are asked once with the larger', async () => {
  const { run, commands } = computerWith([]);
  const slotted = [{ ...runs.units[0], keep_builds: 2 }, { ...runs.units[0], unit: 'example-place-b.service', keep_builds: 7 }, { ...runs.units[0], unit: 'plain.service', builds: '/var/lib/plain/builds', source: undefined }];
  assert.deepEqual(await surplusBuilds(machine, slotted, run, 5), []);
  assert.deepEqual(commands.map(({ command }) => command), ["sh -s -- '/var/lib/example-place/builds' 7"]);
});

test('a listed name that is not a commit is refused and nothing is removed', async () => {
  const { run, commands } = computerWith(['../../etc']);
  await assert.rejects(surplusBuilds(machine, runs.units, run, 5), /not a commit/);
  assert.equal(commands.some(({ command }) => command.includes('rm -rf --')), false);
  await dropSurplusBuilds(machine, [], run);
  assert.equal(commands.some(({ command }) => command.includes('rm -rf --')), false);
});
