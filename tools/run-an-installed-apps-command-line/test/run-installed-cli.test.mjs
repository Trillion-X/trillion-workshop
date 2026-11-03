// Runs the launcher for real against a made-up installed app built here: a bundle folder holding a JavaScript entry and
// a plain executable. Checks the arguments and exit code pass through, Node runs a JavaScript entry, a program runs as
// itself, and a missing app or entry is refused with what to pass instead. Needs sh and node (both are here when node
// runs this test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const script = join(folder, 'do-work', 'run-installed-cli');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const skip = process.platform === 'win32' ? 'needs a POSIX sh' : false;

// A made-up app: Zorblet.app with its command line deep inside, as an installed app keeps it.
const app = join(mkdtempSync(join(tmpdir(), 'run-installed-cli-')), 'Zorblet.app');
const inside = 'Contents/Resources/app.asar.unpacked/node_modules/zorblet/bin';
mkdirSync(join(app, inside), { recursive: true });
writeFileSync(join(app, inside, 'zorblet.mjs'), 'console.log(JSON.stringify({ argv: process.argv.slice(2) }));\nprocess.exit(Number(process.env.ZORBLET_EXIT ?? 0));\n');
writeFileSync(join(app, inside, 'zorblet-native'), '#!/bin/sh\necho "native $*"\nexit 3\n');
chmodSync(join(app, inside, 'zorblet-native'), 0o755);
writeFileSync(join(app, inside, 'notes.txt'), 'not a program\n');

const run = (args, env = {}) => spawnSync('sh', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('the row runs on the person\'s computer and names the launcher that exists', () => {
  assert.equal(row.id, 'tool:run-an-installed-apps-command-line');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.match(row.invoke.run, /tools\/run-an-installed-apps-command-line\/do-work\/run-installed-cli \{app\} \{entry\}/);
  assert.ok(existsSync(script));
  assert.deepEqual(row.placements, ['placement:your-computer']);
});

test('a JavaScript entry runs under node with every argument passed through as given', { skip }, () => {
  const done = run([app, `${inside}/zorblet.mjs`, 'render', '--out', 'a file with spaces.mp4', '']);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout).argv, ['render', '--out', 'a file with spaces.mp4', '']);
});

test('the app\'s exit code comes back as the launcher\'s', { skip }, () => {
  assert.equal(run([app, `${inside}/zorblet.mjs`], { ZORBLET_EXIT: '7' }).status, 7);
});

test('an executable entry runs as itself', { skip }, () => {
  const done = run([app, `${inside}/zorblet-native`, 'one', 'two']);
  assert.equal(done.status, 3);
  assert.equal(done.stdout, 'native one two\n');
});

test('a missing app, a missing entry, a file that is not a program and too few arguments are refused with what to pass', { skip }, () => {
  const refusals = [
    [[], /pass the installed app/],
    [[app], /pass the installed app/],
    [[join(app, '..', 'Nowhere.app'), 'x.mjs'], /is not there/],
    [[app, `${inside}/gone.mjs`], /is not in .*look inside the app/],
    [[app, `${inside}/notes.txt`], /is not executable/],
  ];
  for (const [args, message] of refusals) {
    const done = run(args);
    assert.equal(done.status, 2, args.join(' '));
    assert.match(JSON.parse(done.stderr.trim()).error, message);
  }
});
