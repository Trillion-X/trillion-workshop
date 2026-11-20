import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { joinDeclaredSources } from '../do-work/join-declared-sources.mjs';

test('joins declared package-owned sources in authored order', async () => {
  const root = tempFolder(path.join(tmpdir(), 'join-declared-sources-'));
  await mkdir(path.join(root, 'show'));
  await writeFile(path.join(root, 'show', 'renderer.js'), 'const renderer = true;');
  await writeFile(path.join(root, 'show', 'mount.js'), 'mount(renderer);');
  const output = path.join(root, 'joined.js');
  await joinDeclaredSources({
    packageRoot: root,
    sourceFiles: ['show/renderer.js', 'show/mount.js'],
    outputFile: output,
  });
  assert.equal(await readFile(output, 'utf8'), 'const renderer = true;\nmount(renderer);');
});

test('refuses any source outside the package owner', async () => {
  const root = tempFolder(path.join(tmpdir(), 'join-declared-sources-owner-'));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.js`);
  await writeFile(outside, 'stolen');
  await assert.rejects(
    joinDeclaredSources({ packageRoot: root, sourceFiles: [outside], outputFile: path.join(root, 'out') }),
    /outside the package owner/,
  );
});
