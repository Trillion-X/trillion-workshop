import { tempFolder } from '../test-helpers/temp-folder.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {chromiumEnvironment} from '../test-helpers/chromium.mjs';

test('a private sample HOME uses only the installed public Chromium dependency paths', t => {
  const cache = tempFolder(join(tmpdir(), 'browser-dependency-'));
  const folder = join(cache, 'chromium-123', 'chrome-platform');
  mkdirSync(folder, {recursive: true});
  const executable = join(folder, 'chrome');
  writeFileSync(executable, 'synthetic executable path', {mode: 0o755});
  const home = process.env.HOME, chrome = process.env.CHROME_PATH;
  t.mock.method(chromium, 'executablePath', () => executable);
  assert.deepEqual(chromiumEnvironment(), {CHROME_PATH: executable, PLAYWRIGHT_BROWSERS_PATH: cache});
  assert.equal(process.env.HOME, home);
  assert.equal(process.env.CHROME_PATH, chrome);
});

test('missing or unrecognized browser installations fail instead of guessing another home', t => {
  const folder = tempFolder(join(tmpdir(), 'browser-dependency-refusal-'));
  let executable = join(folder, 'absent');
  t.mock.method(chromium, 'executablePath', () => executable);
  assert.throws(() => chromiumEnvironment(), /installed Playwright Chromium/);
  executable = join(folder, 'chrome');
  writeFileSync(executable, 'synthetic executable path', {mode: 0o755});
  assert.throws(() => chromiumEnvironment(), /no declared browser-cache build folder/);
});
