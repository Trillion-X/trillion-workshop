// The root package-lock.json holds no entry with `link: true`, and a file in a tool folder with its own package.json still
// reaches `trillion-workshop/...`. The engine on a person's Mac refuses a Workshop commit whose lock file has a link entry
// (tools_update_refused, trillion-rust src/tool_runs/tools/install/packages.rs), so the Workshop never installed after a
// link to itself ("trillion-workshop": "file:.") was added. The self-reference is the resolve hook of
// test-helpers/workshop-self-resolve.mjs (tests) and the web build's alias (tools/workspace-screens/web/scripts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { json, root } from '../test-helpers/tool-rows.mjs';
import { inThisWorkshop } from '../test-helpers/workshop-self-resolve.mjs';

test('no entry of package-lock.json is a link: the Mac engine refuses a Workshop lock file that has one', () => {
  const links = Object.entries(json(resolve(root, 'package-lock.json')).packages).filter(([, entry]) => entry.link === true).map(([path]) => path);
  assert.deepEqual(links, [], 'a link entry makes the engine refuse every Workshop commit (tools_update_refused)');
});

test('package.json does not depend on the Workshop itself: that dependency is what npm writes a link entry for', () => {
  const manifest = json(resolve(root, 'package.json'));
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal(manifest[kind]?.[manifest.name], undefined, `${kind} names ${manifest.name}`);
  }
});

test('trillion-workshop/<path> is this root\'s path, and nothing else is answered', () => {
  assert.equal(inThisWorkshop('trillion-workshop/tools/ui/show/x.tsx'), pathToFileURL(resolve(root, 'tools/ui/show/x.tsx')).href);
  assert.equal(inThisWorkshop('trillion-workshop/../outside.mjs'), undefined, 'no way out of the root');
  assert.equal(inThisWorkshop('trillion-workshop'), undefined);
  assert.equal(inThisWorkshop('trillion-workshopper/x.mjs'), undefined);
  assert.equal(inThisWorkshop('node:fs'), undefined);
});

test('a file under a tool folder with its own package.json imports trillion-workshop/... with no link in node_modules', () => {
  const printed = execFileSync(process.execPath, ['--import', resolve(root, 'test-helpers/own-tmpdir.mjs'), '--input-type=module', '-e',
    "const { measure } = await import('trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs'); console.log(typeof measure);"],
  { encoding: 'utf8', cwd: resolve(root, 'tools/organize-the-sidebar') }).trim();
  assert.equal(printed, 'function');
});

test('importing the helper starts no hooks worker: register() would run its hooks on one that the main thread waits on', () => {
  const script = `await import(process.argv[1]); const own = await import('trillion-workshop/test-helpers/tool-rows.mjs'); console.log(JSON.stringify({ worker: process.moduleLoadList.includes('NativeModule internal/modules/esm/hooks'), answered: typeof own.root }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(resolve(root, 'test-helpers/workshop-self-resolve.mjs')).href],
    { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' }));
  assert.deepEqual(out, { worker: false, answered: 'string' });
});
