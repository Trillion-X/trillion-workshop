// The verified environment owns interpreter selection; resolving its executable symlink would lose the environment.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonForTests } from '../test-helpers/python-environment.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const profiles = JSON.parse(readFileSync(new URL('../test-helpers/python-environment-profiles.json', import.meta.url)));
for (const [profile, declaration] of Object.entries(profiles)) {
  for (const { path, count } of declaration.test_files ?? []) {
    test(`${profile} runs every declared ${path} body without skips`, { timeout: 900000 }, () => {
      assert.ok(typeof path === 'string' && !path.split('/').includes('..'));
      assert.match(path, /(?:^|\/)test_[^/]+\.py$/);
      assert.ok(Number.isSafeInteger(count) && count > 0);
      const target = resolve(root, path);
      assert.ok(target.startsWith(resolve(root) + sep));
      assert.ok(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink());
      const result = spawnSync(pythonForTests(profile), ['-I', '-B', target],
        { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, timeout: 840000 });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, result.error?.message ?? output);
      assert.match(output, new RegExp(`Ran ${count} tests?\\b`));
      assert.match(output, /\nOK\s*$/);
      assert.doesNotMatch(output, /skipped=/);
    });
  }
  for (const { path, count } of declaration.node_test_files ?? []) {
    test(`${profile} runs every declared ${path} body without skips`, { timeout: 900000 }, () => {
      assert.ok(typeof path === 'string' && !path.split('/').includes('..'));
      assert.match(path, /(?:^|\/)[^/]+\.test\.mjs$/);
      assert.ok(Number.isSafeInteger(count) && count > 0);
      const target = resolve(root, path);
      assert.ok(target.startsWith(resolve(root) + sep));
      assert.ok(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink());
      // A fresh test runner must not inherit the parent's worker marker: Node otherwise executes no test bodies.
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', target], {
        encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, timeout: 840000,
        env: { ...environment, WORKSHOP_TEST_PYTHON: pythonForTests(profile) },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, result.error?.message ?? output);
      assert.match(output, new RegExp(`(?:^|\\n)# tests ${count}\\n`));
      assert.match(output, /(?:^|\n)# fail 0\n/);
      assert.match(output, /(?:^|\n)# skipped 0\n/);
      assert.match(output, /(?:^|\n)# cancelled 0\n/);
    });
  }
}
