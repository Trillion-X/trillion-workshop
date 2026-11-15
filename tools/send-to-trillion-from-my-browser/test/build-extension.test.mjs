// test/build-extension.test.mjs
//
// The extension builds from this tool and the Workshop's shared parts into a folder a Chromium browser loads: its
// manifest, every page it declares, a script per page under the weight budgets.json allows, the one stylesheet and the
// icons. The build needs the packages the shared parts import (react, lucide-react, tailwind); the Workshop does not
// hold them, so the test runs when EXTENSION_NODE_MODULES names a node_modules that has them and says it skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('..', import.meta.url));
const modules = process.env.EXTENSION_NODE_MODULES;
const hasPackages = modules && ['react', 'lucide-react', '@tailwindcss/node'].every(name => existsSync(join(modules, name)));
const PAGES = ['popup', 'signed-in', 'reply', 'markup', 'attach', 'allow-microphone', 'recorder'];

test('the build writes the manifest, every page, a script for each under budget, the look and the icons', { skip: hasPackages ? false : 'set EXTENSION_NODE_MODULES to a node_modules holding react, lucide-react and @tailwindcss/node' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'send-to-trillion-extension-'));
  execFileSync('node', [join(tool, 'scripts/build-extension.mjs')], { env: { ...process.env, EXTENSION_OUT: out, EXTENSION_NODE_MODULES: modules }, stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  const budget = JSON.parse(readFileSync(join(tool, 'budgets.json'), 'utf8')).page_script_bytes;
  for (const page of PAGES) {
    assert.ok(existsSync(join(out, `${page}.html`)), `${page}.html is built`);
    assert.ok(statSync(join(out, `${page}.js`)).size <= budget, `${page}.js is within the ${budget} bytes a page may weigh`);
  }
  for (const file of ['background.js', 'right-clicked.js', 'look.css', 'icons/icon-128.png']) assert.ok(existsSync(join(out, file)), `${file} is built`);
  assert.equal(manifest.background.service_worker, 'background.js');
});
