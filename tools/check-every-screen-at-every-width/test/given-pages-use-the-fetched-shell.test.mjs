// check-given-pages opens its browser from the headless shell a row fetched when that shell is on the run's PATH. The engine puts
// the folder of a fetched program on the run's PATH; the test does the same with the shell's own folder (a link to the shell would
// not find its data files beside it) and runs the check on one given page, so the launch has to find the shell there.
// It needs a real headless shell: set CHROME_HEADLESS_SHELL to its file (the Chrome for Testing headless shell, the build the
// row pins); without it the test is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { checkGivenPages } from '../check-given-pages.mjs';

const shell = process.env.CHROME_HEADLESS_SHELL;

test('a given page is checked in the headless shell found on PATH', { skip: !shell && 'CHROME_HEADLESS_SHELL names no headless shell' }, async () => {
  const before = process.env.PATH;
  process.env.PATH = `${dirname(shell)}:${before}`;
  try {
    const result = await checkGivenPages({ screens: [{ id: 'hello', html: '<!doctype html><html lang="en"><title>hello</title><h1>hello</h1></html>' }] });
    assert.equal(typeof result.passed, 'boolean');
    assert.ok(result.report, 'the check reported what it looked at');
  } finally {
    process.env.PATH = before;
  }
});
