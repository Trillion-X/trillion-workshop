import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Import the actual declared setup closure outside the checkout. A dependency
// available in the developer's node_modules must not mask an incomplete row.
test('the packed native setup controller imports with only its declared files and modules', async () => {
  const tools = fileURLToPath(new URL('../..', import.meta.url));
  const workshop = dirname(tools);
  const row = JSON.parse(await readFile(join(tools, 'ai-tool-catalog/tool-rows.json'), 'utf8')).records[0].payload;
  const packed = await mkdtemp(join(tmpdir(), 'native-controller-closure-'));
  try {
    for (const item of row.invoke.files.package_files) {
      const from = item.packages ? join(workshop, item.packages[0]) : item.module ? join(workshop, 'node_modules', item.module) : join(tools, item.package);
      const target = item.packages ? join(packed, item.packages[0]) : item.module ? join(packed, 'node_modules', item.module) : join(packed, item.package);
      for (const path of item.paths) {
        await mkdir(dirname(join(target, path)), { recursive: true });
        await cp(join(from, path), join(target, path), { recursive: true });
      }
    }
    const controller = join(packed, 'ai-tool-catalog/do-work/tool-server-native-child.mjs');
    const imported = () => spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', controller], {
      cwd: packed, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
    });
    const complete = imported();
    assert.equal(complete.status, 0, complete.stderr);
    await rm(join(packed, 'node_modules/tldts'), { recursive: true });
    const incomplete = imported();
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /tldts/);
  } finally {
    await rm(packed, { recursive: true, force: true });
  }
});
