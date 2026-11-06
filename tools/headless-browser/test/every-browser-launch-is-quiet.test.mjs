// Every Chromium a script, proof, test, harness or part starts on this computer starts with the switches in
// trillion-workshop/tools/headless-browser/quiet-switches.json, so macOS never asks for the login keychain ("Google Chrome for Testing
// wants to use your confidential information stored in 'Chromium Safe Storage'") on the person's screen. On
// 2026-09-30 that prompt came from the web page recorder, which starts Chromium itself over the DevTools protocol and
// so never got Playwright's own defaults. A Playwright launch must come through trillion-workshop/tools/headless-browser/launch.mjs; a
// browser started by hand must read quiet-switches.json. Untracked files are source too, so they are read as well.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// Here the browser part and the cloud tools that drive Chromium are this repository's own tools/ folders (old trillion
// read them from its pinned trillion-workshop package), and the code read is every tool's and the repository's tests.
const root = resolve(import.meta.dirname, '../../..');
const WORKSHOP = 'tools/';
const HELPER = `${WORKSHOP}headless-browser/launch.mjs`;
// The tests' own launcher puts the same quiet switches first (test-helpers/chromium.mjs), as HELPER does for a tool.
const TEST_HELPER = 'test-helpers/chromium.mjs';
const SELF = 'tools/headless-browser/test/every-browser-launch-is-quiet.test.mjs';
const ROOTS = ['tools', 'test', 'test-helpers'];
const CODE = /\.(mjs|cjs|js|ts|tsx)$/;

/** What is wrong with one file's launches, or an empty list. */
export function loudLaunches(text) {
  const wrong = [];
  if (/\bchromium\s*\.\s*launch(PersistentContext|Server)?\s*\(/.test(text)) wrong.push(`starts Chromium through Playwright directly; use trillion-workshop/tools/headless-browser/launch.mjs`);
  if (/\bfrom\s+['"]puppeteer(-core)?['"]/.test(text) && /\.launch\s*\(/.test(text)) wrong.push('starts a local browser through Puppeteer without the quiet switches');
  if (/['"`]--headless\b/.test(text) && !/quiet-switches\.json|headless-browser\/launch\.mjs/.test(text)) wrong.push('starts a browser by hand without reading trillion-workshop/tools/headless-browser/quiet-switches.json');
  return wrong;
}

const sourceFiles = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...ROOTS], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(path => CODE.test(path) && !path.includes('node_modules/') && path !== HELPER && path !== TEST_HELPER && path !== SELF);

test('the quiet switches keep the keychain out of it', () => {
  const { switches } = JSON.parse(readFileSync(resolve(root, `${WORKSHOP}headless-browser/quiet-switches.json`), 'utf8'));
  assert.ok(switches.includes('--use-mock-keychain'));
  assert.ok(switches.includes('--password-store=basic'));
});

test('no script, test, harness or part starts Chromium without the quiet switches', () => {
  const files = sourceFiles();
  assert.ok(files.length > 100, `only ${files.length} source files were read`);
  const loud = files.flatMap(path => {
    let text;
    try { text = readFileSync(resolve(root, path), 'utf8'); } catch { return []; }
    return loudLaunches(text).map(reason => `${path}: ${reason}`);
  });
  assert.deepEqual(loud, []);
});

test('the check catches each way a browser gets started', () => {
  assert.equal(loudLaunches("const browser = await chromium.launch({ headless: true });").length, 1);
  assert.equal(loudLaunches("await chromium.launchPersistentContext(dir, { channel: 'chromium' });").length, 1);
  assert.equal(loudLaunches("import puppeteer from 'puppeteer';\nawait puppeteer.launch();").length, 1);
  assert.equal(loudLaunches("spawn(executable, ['--headless=new', '--remote-debugging-port=0']);").length, 1);
  assert.deepEqual(loudLaunches("import { launchChromium } from '../launch.mjs';\nawait launchChromium();"), []);
  assert.deepEqual(loudLaunches("import puppeteer from '@cloudflare/puppeteer';\nawait puppeteer.launch(env.BROWSER);"), []);
  assert.deepEqual(loudLaunches("const quiet = read('headless-browser/quiet-switches.json');\nspawn(exe, [...quiet, '--headless=new']);"), []);
});

test('the helpers and the cloud tools really put the switches on the browser', () => {
  const helper = readFileSync(resolve(root, HELPER), 'utf8');
  assert.match(helper, /args: \[\.\.\.quietSwitches, \.\.\.\(options\.args \?\? \[\]\)\]/);
  const devtools = readFileSync(resolve(root, `${WORKSHOP}headless-browser/devtools.mjs`), 'utf8');
  assert.match(devtools, /spawn\(executable, \[\s*\.\.\.quietSwitches,/);
  // Each cloud tool that drives Chromium starts it through devtools.mjs and carries it, with the switch list, beside it.
  for (const [file, script, id] of [
    [`${WORKSHOP}record-a-web-page/tool-rows.json`, `${WORKSHOP}record-a-web-page/do-work/record-a-web-demo.mjs`, 'tool:record-a-web-demo'],
    [`${WORKSHOP}copy-a-site/tool-rows.json`, `${WORKSHOP}copy-a-site/do-work/copy-a-site.mjs`, 'tool:copy-a-site'],
  ]) {
    assert.match(readFileSync(resolve(root, script), 'utf8'), /from '\.\.\/\.\.\/headless-browser\/devtools\.mjs'/);
    const row = JSON.parse(readFileSync(resolve(root, file), 'utf8')).records.find(record => record.payload.id === id).payload;
    const carried = row.invoke.files.package_files.find(spec => spec.package === 'headless-browser' && spec.at === '/opt/headless-browser');
    // Here devtools.mjs reads quiet-switches.json and browser-places.json beside it (old trillion's read admission.mjs).
    for (const needed of ['devtools.mjs', 'quiet-switches.json', 'browser-places.json']) assert.ok(carried?.paths?.includes(needed), `${id} carries ${needed} of the browser part beside it`);
  }
});
