import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserProblem, browserExecutable } from '../devtools.mjs';

// A made-up home with a runnable file where the cache place names it.
function homeWith(...versions) {
  const home = mkdtempSync(join(tmpdir(), 'browser-home-'));
  for (const version of versions) {
    const folder = join(home, 'Library/Caches/ms-playwright', `chromium-${version}`, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'Google Chrome for Testing');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
  }
  return home;
}

test('a path is used as given and a bare name is looked for on the computer', () => {
  assert.equal(browserExecutable('/somewhere/my-browser', '/nowhere'), '/somewhere/my-browser');
  const home = homeWith('1200', '1248', '1234');
  const found = browserExecutable('chromium', home);
  // The highest cache version wins when no installed browser is found first; an installed app (if this computer has one) wins before it.
  assert.ok(found.endsWith('/Contents/MacOS/Google Chrome for Testing') || found.includes('/Applications/') || found.startsWith('/usr/bin/'), found);
  if (found.startsWith(home)) assert.ok(found.includes('chromium-1248'), found);
  assert.equal(browserExecutable(undefined, home), found);
});

test('no browser found says what to do', () => {
  const empty = mkdtempSync(join(tmpdir(), 'browser-home-'));
  let found;
  try { found = browserExecutable('chromium', empty); } catch (error) { assert.ok(error instanceof BrowserProblem); assert.match(error.message, /Install Chrome|name one with --browser/); return; }
  assert.ok(found.startsWith('/'), 'this computer has an installed browser: ' + found);
});
