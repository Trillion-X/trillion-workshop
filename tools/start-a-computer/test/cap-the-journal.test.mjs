// tools/start-a-computer/test/cap-the-journal.test.mjs
//
// The journal is restarted only when the cap drop-in's words change: the first run writes it and restarts once, a second run
// with the same cap restarts nothing and leaves the file as it was, a new cap writes and restarts again. Run through a real
// shell on a made-up root, with systemctl and journalctl stood in for on PATH so each call is counted.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../do-work/cap-the-journal.sh', import.meta.url));

test('the journal is restarted only when the cap changes', () => {
  const root = tempFolder(join(tmpdir(), 'cap-journal-'));
  const bin = tempFolder(join(tmpdir(), 'cap-journal-bin-'));
  const calls = join(root, 'calls');
  for (const name of ['systemctl', 'journalctl']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const run = max => execFileSync('sh', ['-s'], { input: readFileSync(SCRIPT), env: { PATH: `${bin}:/usr/bin:/bin`, ROOT: root, JOURNAL_MAX: max } });
  const restarts = () => readFileSync(calls, 'utf8').split('\n').filter(line => line === 'systemctl restart systemd-journald').length;
  const cap = join(root, 'etc/systemd/journald.conf.d/99-journal-cap.conf');

  run('500M');
  assert.equal(readFileSync(cap, 'utf8'), '[Journal]\nSystemMaxUse=500M\nForwardToSyslog=no\n');
  assert.equal(restarts(), 1);
  const written = statSync(cap).mtimeMs;
  run('500M');
  assert.equal(restarts(), 1, 'the same cap restarts nothing');
  assert.equal(statSync(cap).mtimeMs, written, 'and leaves the file as it was');
  run('800M');
  assert.equal(readFileSync(cap, 'utf8'), '[Journal]\nSystemMaxUse=800M\nForwardToSyslog=no\n');
  assert.equal(restarts(), 2, 'a new cap restarts once');
  assert.equal(readFileSync(calls, 'utf8').split('\n').filter(line => line.startsWith('journalctl --vacuum-size=')).length, 3, 'every run trims to the cap');
});
