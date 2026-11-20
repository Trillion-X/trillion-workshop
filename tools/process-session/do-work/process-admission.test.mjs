import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { processSnapshot } from './heavy-work.mjs';
import { identityOf, UNKNOWN_LIVE } from './process-admission.mjs';

// A ps that takes 3 seconds, the way ps answers on a busy Mac. It stands in front of the real ps on PATH.
function withSlowPs(run) {
  const dir = tempFolder(join(tmpdir(), 'slow-ps-'));
  writeFileSync(join(dir, 'ps'), '#!/bin/sh\nsleep 3\nexec /bin/ps "$@"\n');
  chmodSync(join(dir, 'ps'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  try { return run(); } finally { process.env.PATH = before; }
}

test('a slow ps still gives the real start time of another process', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const expected = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    const started = Date.now();
    const actual = withSlowPs(() => identityOf(child.pid));
    assert.ok(Date.now() - started >= 3000, 'the stub ps must have really been slow');
    assert.notEqual(actual, UNKNOWN_LIVE);
    assert.equal(actual, expected);
  } finally {
    child.kill();
  }
});

test('a slow ps still gives the real process table in the heavy-work snapshot', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const expected = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    const rows = withSlowPs(() => processSnapshot());
    assert.ok(rows, 'the snapshot must answer when ps is slow');
    assert.equal(rows.get(child.pid)?.started, expected);
    assert.equal(rows.get(child.pid)?.parent, process.pid);
  } finally {
    child.kill();
  }
});
