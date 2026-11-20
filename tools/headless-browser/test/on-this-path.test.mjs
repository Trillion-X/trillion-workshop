// onThisPath finds a fetched program by its name on the run's PATH: the first runnable file of that name, else nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onThisPath } from '../launch.mjs';

test('a program is found by name in the first PATH folder that holds a runnable file of it', () => {
  const first = mkdtempSync(join(tmpdir(), 'on-path-'));
  const second = mkdtempSync(join(tmpdir(), 'on-path-'));
  writeFileSync(join(first, 'chrome-headless-shell'), 'not runnable: no execute bit');
  writeFileSync(join(second, 'chrome-headless-shell'), '#!/bin/sh\n');
  chmodSync(join(second, 'chrome-headless-shell'), 0o755);
  assert.equal(onThisPath('chrome-headless-shell', `${first}:${second}`), join(second, 'chrome-headless-shell'));
});

test('a name no PATH folder holds as a runnable file is not found', () => {
  const folder = mkdtempSync(join(tmpdir(), 'on-path-'));
  assert.equal(onThisPath('chrome-headless-shell', `${folder}::/nonexistent`), undefined);
  assert.equal(onThisPath('chrome-headless-shell', ''), undefined);
});
